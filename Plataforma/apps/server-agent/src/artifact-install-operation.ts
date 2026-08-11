import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import type { AgentWorkLease } from '@voidfall/contracts';
import { ConfigurationPersistenceError, type Repositories } from '@voidfall/database';
import type { MinecraftProcessAdapter } from '@voidfall/minecraft-process';

import type { LeaseHandlerResult } from './supervisor.js';

const LOCK_NAME = 'minecraft-exclusive';
const DEFAULT_LOCK_SECONDS = 300;
const SAFE_JAR = /^[^<>:"/\\|?*\u0000-\u001f]{1,251}\.jar$/iu;

/** Resolves immutable quarantine bytes without exposing their host location. */
export interface ApprovedArtifactPayloadReader {
  read(sha256: string): Promise<Uint8Array>;
}

export interface ArtifactInstallCapabilityOptions {
  readonly repositories: Repositories;
  readonly reader: ApprovedArtifactPayloadReader;
  readonly processAdapter: MinecraftProcessAdapter;
  readonly serverInstanceId: string;
  /** Trusted local server root; never populated from a lease or API request. */
  readonly serverRoot: string;
  readonly lockSeconds?: number;
  readonly clock?: () => Date;
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith('../'));
}

async function hashPlainFile(path: string): Promise<string | null> {
  const before = await lstat(path).catch(() => undefined);
  if (before === undefined) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error('artifact-install-unsafe-existing-target');
  }
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
      throw new Error('artifact-install-target-changed');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== bytes.byteLength) {
      throw new Error('artifact-install-target-changed');
    }
    return createHash('sha256').update(bytes).digest('hex');
  } finally {
    await handle.close();
  }
}

/** Installs a reviewed server-side JAR under one exclusive offline window. */
export function createArtifactInstallHandler(
  options: ArtifactInstallCapabilityOptions,
): (lease: AgentWorkLease) => Promise<LeaseHandlerResult> {
  const clock = options.clock ?? (() => new Date());

  return async (lease): Promise<LeaseHandlerResult> => {
    if (
      lease.jobType !== 'artifact.install' ||
      lease.parameters.resourceType !== 'server-instance' ||
      lease.parameters.resourceId !== options.serverInstanceId
    ) {
      return { outcome: 'failed', failureCode: 'unsupported-parameters' };
    }

    const operation = await options.repositories.operations.findByJobId(lease.jobId);
    if (
      operation === undefined ||
      operation.kind !== 'artifact.install' ||
      operation.status !== 'running' ||
      operation.serverInstanceId !== options.serverInstanceId ||
      operation.artifactSubmissionId === null
    ) {
      return { outcome: 'failed', failureCode: 'precondition-not-met' };
    }

    const submissionId = operation.artifactSubmissionId;
    const [submission, owner] = await Promise.all([
      options.repositories.artifactReview.findById(submissionId),
      options.repositories.artifactReview.serverInstanceIdFor(submissionId),
    ]);
    if (
      submission === undefined ||
      owner !== options.serverInstanceId ||
      submission.state !== 'approved' ||
      submission.decision?.decision !== 'approved' ||
      submission.decision.analyzedSha256 !== submission.sha256 ||
      (submission.reviewedSide !== 'server' && submission.reviewedSide !== 'both') ||
      !submission.analysis.inspected ||
      !submission.analysis.analyzed ||
      submission.analysis.provenBlockerCount !== 0 ||
      !SAFE_JAR.test(submission.filename) ||
      basename(submission.filename) !== submission.filename
    ) {
      return { outcome: 'failed', failureCode: 'precondition-not-met' };
    }

    const bytes = await options.reader.read(submission.sha256).catch(() => undefined);
    if (
      bytes === undefined ||
      bytes.byteLength !== submission.sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== submission.sha256
    ) {
      return { outcome: 'failed', failureCode: 'precondition-not-met' };
    }

    const ownerId = randomUUID();
    const now = clock();
    try {
      await options.repositories.operationalLocks.acquire({
        serverInstanceId: options.serverInstanceId,
        lockName: LOCK_NAME,
        ownerId,
        operation: 'artifact.install',
        acquiredAt: now.toISOString(),
        leaseExpiresAt: new Date(
          now.getTime() + (options.lockSeconds ?? DEFAULT_LOCK_SECONDS) * 1_000,
        ).toISOString(),
      });
    } catch (error) {
      if (error instanceof ConfigurationPersistenceError) {
        return { outcome: 'failed', failureCode: 'precondition-not-met' };
      }
      throw error;
    }

    let temporaryPath: string | undefined;
    try {
      if ((await options.processAdapter.inspect()).state !== 'offline') {
        return { outcome: 'failed', failureCode: 'precondition-not-met' };
      }

      const serverRoot = resolve(options.serverRoot);
      const rootEntry = await lstat(serverRoot);
      const canonicalRoot = await realpath(serverRoot);
      if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink() || canonicalRoot !== serverRoot) {
        return { outcome: 'failed', failureCode: 'precondition-not-met' };
      }

      const modsRoot = join(serverRoot, 'mods');
      await mkdir(modsRoot).catch((error: unknown) => {
        const code = (error as { readonly code?: unknown }).code;
        if (code !== 'EEXIST') throw error;
      });
      const modsEntry = await lstat(modsRoot);
      const canonicalMods = await realpath(modsRoot);
      if (
        !modsEntry.isDirectory() ||
        modsEntry.isSymbolicLink() ||
        dirname(modsRoot) !== serverRoot ||
        !isWithin(canonicalRoot, canonicalMods)
      ) {
        return { outcome: 'failed', failureCode: 'precondition-not-met' };
      }

      const targetPath = join(modsRoot, submission.filename);
      if (dirname(targetPath) !== modsRoot) {
        return { outcome: 'failed', failureCode: 'precondition-not-met' };
      }
      const existingHash = await hashPlainFile(targetPath);
      if (existingHash !== null) {
        return existingHash === submission.sha256
          ? { outcome: 'succeeded', observedLifecycle: 'offline' }
          : { outcome: 'failed', failureCode: 'precondition-not-met' };
      }

      temporaryPath = join(modsRoot, `.voidfall-${operation.operationId}.tmp`);
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if ((await options.processAdapter.inspect()).state !== 'offline') {
        return { outcome: 'failed', failureCode: 'precondition-not-met' };
      }

      // A hard link is an atomic no-overwrite promotion on the same volume.
      // A concurrent target wins with EEXIST and is never replaced.
      await link(temporaryPath, targetPath);
      await unlink(temporaryPath);
      temporaryPath = undefined;
      return { outcome: 'succeeded', observedLifecycle: 'offline' };
    } catch {
      return { outcome: 'failed', failureCode: 'operation-failed' };
    } finally {
      if (temporaryPath !== undefined) await unlink(temporaryPath).catch(() => undefined);
      await options.repositories.operationalLocks
        .release({ serverInstanceId: options.serverInstanceId, lockName: LOCK_NAME, ownerId })
        .catch(() => undefined);
    }
  };
}
