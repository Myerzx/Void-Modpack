import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import {
  ArtifactQuarantineService,
  QuarantineOperationError,
} from '@voidfall/artifact-quarantine';
import {
  runArtifactWorkerOnce,
  type CompatibilityPlanFactory,
  type QuarantinedArtifactReader,
} from '@voidfall/build-worker';
import type { ArtifactCompatibilityPlan } from '@voidfall/contracts';
import type { Database, Repositories, ServerInstance } from '@voidfall/database';

import type { ArtifactQuarantineStore } from './artifact-routes.js';

const MAXIMUM_ARTIFACT_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

function quarantineIdFor(sha256: string): string {
  if (!SHA256.test(sha256)) throw new Error('local-artifact-invalid-sha256');
  // The quarantine identifier is bounded to 64 characters. The full digest is
  // still verified on every read, so a prefix collision is refused, not used.
  return `artifact-${sha256.slice(0, 55)}`;
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith('../');
}

/**
 * Local durable quarantine plus an opaque content reader for the worker and
 * installer. Locations never cross either interface; callers only hold a hash.
 */
export class LocalArtifactStore implements ArtifactQuarantineStore, QuarantinedArtifactReader {
  readonly #root: string;
  readonly #service: ArtifactQuarantineService;

  public constructor(stateDirectory: string) {
    this.#root = resolve(stateDirectory, 'artifact-quarantine');
    this.#service = new ArtifactQuarantineService({
      quarantineRoot: this.#root,
      allowedExtensions: ['.jar', '.zip'],
      maximumArtifactBytes: MAXIMUM_ARTIFACT_BYTES,
    });
  }

  public async quarantineStream(input: Parameters<ArtifactQuarantineStore['quarantineStream']>[0]) {
    const plan = {
      quarantineId: quarantineIdFor(input.expectedSha256),
      filename: input.filename,
      kind: input.filename.toLocaleLowerCase('en-US').endsWith('.jar') ? ('mod' as const) : ('other' as const),
      receivedAt: input.receivedAt.toISOString(),
      declaredSizeBytes: input.declaredSizeBytes,
      expectedSha256: input.expectedSha256,
    };
    try {
      const receipt = await this.#service.quarantine(plan, input.content);
      return { sha256: receipt.sha256, sizeBytes: receipt.sizeBytes };
    } catch (error) {
      // Upload replay is idempotent only after the immutable existing bytes are
      // re-read and match the complete declared digest and size.
      if (!(error instanceof QuarantineOperationError) || error.code !== 'artifact-conflict') {
        throw error;
      }
      const existing = await this.read(input.expectedSha256);
      if (existing.byteLength !== input.declaredSizeBytes) {
        throw new Error('local-artifact-replay-size-mismatch');
      }
      return { sha256: input.expectedSha256, sizeBytes: existing.byteLength };
    }
  }

  public async read(sha256: string): Promise<Uint8Array> {
    const artifactRoot = join(this.#root, 'artifacts', quarantineIdFor(sha256));
    const payloadPath = join(artifactRoot, 'payload.bin');
    const canonicalRoot = await realpath(this.#root);
    const canonicalArtifact = await realpath(artifactRoot);
    if (!isWithin(canonicalRoot, canonicalArtifact) || dirname(payloadPath) !== artifactRoot) {
      throw new Error('local-artifact-unsafe-path');
    }
    const directory = await lstat(artifactRoot);
    const before = await lstat(payloadPath);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size < 4 ||
      before.size > MAXIMUM_ARTIFACT_BYTES
    ) {
      throw new Error('local-artifact-unsafe-entry');
    }
    const handle = await open(payloadPath, 'r');
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
        throw new Error('local-artifact-concurrent-change');
      }
      const content = await handle.readFile();
      const after = await handle.stat();
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== content.byteLength) {
        throw new Error('local-artifact-concurrent-change');
      }
      if (createHash('sha256').update(content).digest('hex') !== sha256) {
        throw new Error('local-artifact-integrity-mismatch');
      }
      return content;
    } finally {
      await handle.close();
    }
  }
}

function runtimeFor(instance: ServerInstance): ArtifactCompatibilityPlan['contexts'][number]['runtime'] {
  const family = instance.runtime?.family;
  if (family !== 'forge' && family !== 'neoforge' && family !== 'fabric') {
    throw new Error('local-artifact-target-loader-unavailable');
  }
  const entryVersion = /\/(?:forge|neoforge)\/([^/]+)\//u.exec(instance.runtime?.entry ?? '')?.[1];
  const detectedMinecraft = entryVersion?.split('-')[0];
  const minecraftVersion =
    instance.minecraftVersion === 'desconhecida'
      ? detectedMinecraft
      : instance.minecraftVersion;
  const loaderVersion =
    instance.loaderVersion === 'desconhecida' ? entryVersion : instance.loaderVersion;
  if (minecraftVersion === undefined || loaderVersion === undefined) {
    throw new Error('local-artifact-target-version-unavailable');
  }
  return { minecraftVersion, loader: family, loaderVersion };
}

interface InventoryMod {
  readonly modId: string;
  readonly version: string | null;
  readonly archivePath: string;
  readonly archiveSha256: string;
}

function installedFrom(document: unknown): ArtifactCompatibilityPlan['installed'] {
  if (document === null || typeof document !== 'object') return [];
  const mods = (document as { readonly mods?: unknown }).mods;
  if (!Array.isArray(mods)) return [];
  const grouped = new Map<string, { filename: string; sha256: string; mods: InventoryMod[] }>();
  for (const value of mods) {
    if (value === null || typeof value !== 'object') continue;
    const mod = value as Partial<InventoryMod>;
    if (
      typeof mod.modId !== 'string' ||
      (mod.version !== null && typeof mod.version !== 'string') ||
      typeof mod.archivePath !== 'string' ||
      typeof mod.archiveSha256 !== 'string' ||
      !SHA256.test(mod.archiveSha256)
    ) {
      continue;
    }
    const current = grouped.get(mod.archiveSha256) ?? {
      filename: basename(mod.archivePath),
      sha256: mod.archiveSha256,
      mods: [],
    };
    current.mods.push(mod as InventoryMod);
    grouped.set(mod.archiveSha256, current);
  }
  return [...grouped.values()].map((artifact) => ({
    artifactId: `installed-${artifact.sha256.slice(0, 16)}`,
    filename: artifact.filename,
    sha256: artifact.sha256,
    contextIds: ['server-active'],
    mods: artifact.mods.map((mod) => ({ modId: mod.modId, version: mod.version })),
  }));
}

/** Builds compatibility only from the target instance and its latest stored scan. */
export class LocalArtifactCompatibilityPlanFactory implements CompatibilityPlanFactory {
  public constructor(
    private readonly repositories: Repositories,
    private readonly javaVersion: string | null,
  ) {}

  public async build(input: Parameters<CompatibilityPlanFactory['build']>[0]) {
    const instance = await this.repositories.servers.findById(input.serverInstanceId);
    if (instance === undefined) throw new Error('local-artifact-target-missing');
    const workspace = await this.repositories.workspaces.findServerByInstanceId(instance.id);
    const inventory =
      workspace === undefined
        ? undefined
        : await this.repositories.workspaces.latestInventory(workspace.workspaceId);
    return {
      schemaVersion: 1,
      analysisId: `local-${input.submissionId.replaceAll('-', '').slice(0, 20)}`,
      generatedAt: new Date().toISOString(),
      contexts: [
        {
          contextId: 'server-active',
          kind: 'server_active',
          side: 'server',
          runtime: runtimeFor(instance),
          javaVersion: this.javaVersion,
        },
      ],
      candidates: [
        {
          artifactId: `submission-${input.submissionId.replaceAll('-', '').slice(0, 16)}`,
          filename: input.filename,
          inspection: input.inspection,
          reviewedSide: null,
          targetContextIds: ['server-active'],
          distributionReviewed: false,
        },
      ],
      installed: installedFrom(inventory?.document),
      explicitConflicts: [],
    } satisfies ArtifactCompatibilityPlan;
  }
}

function waitForWork(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => {
    if (signal.aborted) return resolveWait();
    const timer = setTimeout(resolveWait, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolveWait();
      },
      { once: true },
    );
  });
}

/** Runs the existing durable artifact worker inside the single PGlite owner process. */
export async function runLocalArtifactWorker(input: {
  readonly database: Database;
  readonly reader: QuarantinedArtifactReader;
  readonly planFactory: CompatibilityPlanFactory;
  readonly signal: AbortSignal;
  readonly onFailure?: (reason: string) => void;
}): Promise<void> {
  const workerId = randomUUID();
  while (!input.signal.aborted) {
    try {
      const result = await runArtifactWorkerOnce({
        database: input.database,
        workerId,
        reader: input.reader,
        planFactory: input.planFactory,
      });
      if (result.processed) continue;
    } catch (error) {
      input.onFailure?.(error instanceof Error ? error.message : 'unknown');
    }
    await waitForWork(input.signal, 1_000);
  }
}
