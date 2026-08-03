import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  QuarantineOperationError,
  VOIDFALL_QUARANTINE_MANIFEST_FORMAT,
  VOIDFALL_QUARANTINE_MANIFEST_SCHEMA_VERSION,
  type ArtifactQuarantineOptions,
  type QuarantineArtifactManifest,
  type QuarantineArtifactPlan,
  type QuarantineArtifactReceipt,
  type QuarantineExtension,
} from './types.js';

const IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FILENAME = /^[^\\/\u0000-\u001f\u007f]{1,255}$/u;
const SUPPORTED_EXTENSIONS = new Set<QuarantineExtension>(['.jar', '.zip']);
const ZIP_SIGNATURES = new Set(['504b0304', '504b0506', '504b0708']);
const MAXIMUM_CONFIGURED_BYTES = 4 * 1_024 * 1_024 * 1_024;

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareOrdinal);
  const wanted = [...expected].sort(compareOrdinal);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function normalizeFilesystemPath(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function pathContained(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return result === '' || (!result.startsWith('..') && !isAbsolute(result));
}

function canonicalJson(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map((child) => visit(child));
    if (!isRecord(item)) return item;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(item).sort(compareOrdinal)) {
      const child = item[key];
      if (child !== undefined) result[key] = visit(child);
    }
    return result;
  };
  return `${JSON.stringify(visit(value))}\n`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function requirePlainDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new QuarantineOperationError('unsafe-root', 'layout');
  }
}

async function createOrRequirePlainDirectory(path: string): Promise<void> {
  if (!(await exists(path))) {
    await mkdir(path, { recursive: false, mode: 0o700 });
  }
  await requirePlainDirectory(path);
}

async function requirePlainFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new QuarantineOperationError('unsafe-root', 'validate');
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (result.bytesWritten < 1) {
      throw new QuarantineOperationError('storage-failure', 'stream');
    }
    offset += result.bytesWritten;
  }
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

export class ArtifactQuarantineService {
  readonly #root: string;
  readonly #stagingRoot: string;
  readonly #artifactsRoot: string;
  readonly #allowedExtensions: ReadonlySet<QuarantineExtension>;
  readonly #maximumArtifactBytes: number;

  public constructor(options: ArtifactQuarantineOptions) {
    if (
      !isRecord(options) ||
      !exactKeys(options, ['quarantineRoot', 'allowedExtensions', 'maximumArtifactBytes']) ||
      typeof options.quarantineRoot !== 'string' ||
      !isAbsolute(options.quarantineRoot) ||
      options.quarantineRoot.includes('\u0000') ||
      dirname(resolve(options.quarantineRoot)) === resolve(options.quarantineRoot) ||
      !Array.isArray(options.allowedExtensions) ||
      options.allowedExtensions.length === 0 ||
      !Number.isSafeInteger(options.maximumArtifactBytes) ||
      options.maximumArtifactBytes < 4 ||
      options.maximumArtifactBytes > MAXIMUM_CONFIGURED_BYTES
    ) {
      throw new QuarantineOperationError('invalid-options', 'options');
    }
    const extensions = new Set<QuarantineExtension>();
    for (const extension of options.allowedExtensions) {
      if (!SUPPORTED_EXTENSIONS.has(extension) || extensions.has(extension)) {
        throw new QuarantineOperationError('invalid-options', 'options');
      }
      extensions.add(extension);
    }
    this.#root = resolve(options.quarantineRoot);
    this.#stagingRoot = join(this.#root, 'staging');
    this.#artifactsRoot = join(this.#root, 'artifacts');
    this.#allowedExtensions = extensions;
    this.#maximumArtifactBytes = options.maximumArtifactBytes;
  }

  async #prepareLayout(): Promise<void> {
    try {
      const parent = dirname(this.#root);
      await requirePlainDirectory(parent);
      const canonicalParent = await realpath(parent);
      if (normalizeFilesystemPath(canonicalParent) !== normalizeFilesystemPath(parent)) {
        throw new QuarantineOperationError('unsafe-root', 'layout');
      }
      await createOrRequirePlainDirectory(this.#root);
      const canonicalRoot = await realpath(this.#root);
      if (normalizeFilesystemPath(canonicalRoot) !== normalizeFilesystemPath(this.#root)) {
        throw new QuarantineOperationError('unsafe-root', 'layout');
      }
      await createOrRequirePlainDirectory(this.#stagingRoot);
      await createOrRequirePlainDirectory(this.#artifactsRoot);
    } catch (error) {
      if (error instanceof QuarantineOperationError) throw error;
      throw new QuarantineOperationError('unsafe-root', 'layout');
    }
  }

  #validatePlan(input: QuarantineArtifactPlan): QuarantineArtifactPlan {
    if (
      !isRecord(input) ||
      !exactKeys(input, [
        'quarantineId',
        'filename',
        'kind',
        'receivedAt',
        'declaredSizeBytes',
        'expectedSha256',
      ]) ||
      typeof input.quarantineId !== 'string' ||
      !IDENTIFIER.test(input.quarantineId) ||
      typeof input.filename !== 'string' ||
      !FILENAME.test(input.filename) ||
      input.filename === '.' ||
      input.filename === '..' ||
      !['mod', 'resource-pack', 'shader-pack', 'datapack', 'other'].includes(input.kind) ||
      !canonicalTimestamp(input.receivedAt) ||
      !Number.isSafeInteger(input.declaredSizeBytes) ||
      input.declaredSizeBytes < 4 ||
      input.declaredSizeBytes > this.#maximumArtifactBytes ||
      typeof input.expectedSha256 !== 'string' ||
      !SHA256.test(input.expectedSha256)
    ) {
      throw new QuarantineOperationError('invalid-plan', 'plan');
    }
    const extension = extname(input.filename).toLocaleLowerCase('en-US') as QuarantineExtension;
    if (!this.#allowedExtensions.has(extension)) {
      throw new QuarantineOperationError('invalid-plan', 'plan');
    }
    return Object.freeze({ ...input });
  }

  public async quarantine(
    input: QuarantineArtifactPlan,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<QuarantineArtifactReceipt> {
    const plan = this.#validatePlan(input);
    if (
      content === null ||
      typeof content !== 'object' ||
      (!(Symbol.asyncIterator in content) && !(Symbol.iterator in content))
    ) {
      throw new QuarantineOperationError('invalid-plan', 'plan');
    }
    await this.#prepareLayout();

    const stagingDirectory = join(this.#stagingRoot, plan.quarantineId);
    const artifactDirectory = join(this.#artifactsRoot, plan.quarantineId);
    if (
      !pathContained(this.#stagingRoot, stagingDirectory) ||
      dirname(stagingDirectory) !== this.#stagingRoot ||
      !pathContained(this.#artifactsRoot, artifactDirectory) ||
      dirname(artifactDirectory) !== this.#artifactsRoot
    ) {
      throw new QuarantineOperationError('unsafe-root', 'layout');
    }

    try {
      if ((await exists(stagingDirectory)) || (await exists(artifactDirectory))) {
        throw new QuarantineOperationError('artifact-conflict', 'layout');
      }
      await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error instanceof QuarantineOperationError) throw error;
      if (isRecord(error) && error.code === 'EEXIST') {
        throw new QuarantineOperationError('artifact-conflict', 'layout');
      }
      throw new QuarantineOperationError('storage-failure', 'layout');
    }

    const payloadPath = join(stagingDirectory, 'payload.bin');
    let handle: FileHandle | undefined;
    let published = false;
    try {
      handle = await open(payloadPath, 'wx', 0o600);
      const digest = createHash('sha256');
      const prefix: number[] = [];
      let sizeBytes = 0;
      for await (const chunk of content) {
        if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
          throw new QuarantineOperationError('invalid-chunk', 'stream');
        }
        sizeBytes += chunk.byteLength;
        if (sizeBytes > this.#maximumArtifactBytes || sizeBytes > plan.declaredSizeBytes) {
          throw new QuarantineOperationError('content-too-large', 'stream');
        }
        for (let index = 0; index < chunk.byteLength && prefix.length < 4; index += 1) {
          const byte = chunk[index];
          if (byte !== undefined) prefix.push(byte);
        }
        digest.update(chunk);
        await writeAll(handle, chunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await requirePlainFile(payloadPath);

      if (sizeBytes !== plan.declaredSizeBytes) {
        throw new QuarantineOperationError('size-mismatch', 'validate');
      }
      const sha256 = digest.digest('hex');
      if (sha256 !== plan.expectedSha256) {
        throw new QuarantineOperationError('hash-mismatch', 'validate');
      }
      const signature = Buffer.from(prefix).toString('hex');
      if (!ZIP_SIGNATURES.has(signature)) {
        throw new QuarantineOperationError('invalid-container-signature', 'validate');
      }

      const manifest: QuarantineArtifactManifest = {
        format: VOIDFALL_QUARANTINE_MANIFEST_FORMAT,
        schemaVersion: VOIDFALL_QUARANTINE_MANIFEST_SCHEMA_VERSION,
        quarantineId: plan.quarantineId,
        filename: plan.filename,
        kind: plan.kind,
        receivedAt: plan.receivedAt,
        sizeBytes,
        sha256,
        payload: 'payload.bin',
        validation: { status: 'quarantined', strategy: 'zip-signature-v1' },
      };
      const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
      const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
      await writeFile(join(stagingDirectory, 'manifest.json'), manifestBytes, {
        flag: 'wx',
        mode: 0o600,
        flush: true,
      });
      await requirePlainFile(join(stagingDirectory, 'manifest.json'));
      await requirePlainDirectory(stagingDirectory);
      await rename(stagingDirectory, artifactDirectory);
      published = true;

      return freezeDeep({
        quarantineId: plan.quarantineId,
        storageReference: `artifacts/${plan.quarantineId}`,
        sizeBytes,
        sha256,
        manifestSha256,
        status: 'quarantined',
      });
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      if (!published) {
        try {
          await rm(stagingDirectory, { recursive: true, force: true });
        } catch {
          throw new QuarantineOperationError('cleanup-failed', 'cleanup');
        }
      }
      if (error instanceof QuarantineOperationError) throw error;
      throw new QuarantineOperationError('storage-failure', 'publish');
    }
  }
}
