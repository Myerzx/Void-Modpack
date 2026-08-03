import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  validateLauncherChannel,
  validateReleaseManifest,
  type LauncherChannel,
  type ReleaseManifest,
} from '@voidfall/contracts';
import { canonicalJsonBytes, sha256Bytes, type CanonicalJsonValue } from './canonical-json.js';
import { signLauncherChannel, type UnsignedLauncherChannel } from './channel-signing.js';
import {
  ReleaseRepositoryError,
  type ChannelPromotionPlan,
  type ChannelRollbackPlan,
  type FilesystemReleaseRepositoryOptions,
  type PublishReleaseInput,
  type ReleaseChannel,
  type ReleaseExternalGates,
  type ReleaseRepository,
  type StoredArtifact,
  type StoredRelease,
} from './types.js';

const DEFAULT_MAXIMUM_MANIFEST_BYTES = 16 * 1_024 * 1_024;

interface RepositoryLayout {
  readonly root: string;
  readonly artifacts: string;
  readonly releases: string;
  readonly channels: string;
}

interface ChannelMutationTarget {
  readonly channel: ReleaseChannel;
  readonly expectedRevision: number | null;
  readonly releaseVersion: string;
  readonly buildId: string;
  readonly manifestUrl: string;
  readonly publishedAt: string;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function validateAbsolutePath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\u0000')) {
    throw new ReleaseRepositoryError('invalid-options', 'options');
  }
}

function validateReleaseIdentity(version: string, buildId: string): void {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version) ||
    !/^build-[0-9]{8}-[0-9]{6}(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/u.test(buildId)
  ) {
    throw new ReleaseRepositoryError('invalid-document', 'manifest');
  }
}

function validateHash(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new ReleaseRepositoryError('invalid-document', 'artifact');
  }
}

function stableEligible(gates: ReleaseExternalGates): boolean {
  return (
    gates.clientBaseApproved &&
    gates.distributionChainApproved &&
    gates.cleanImportPassed &&
    gates.launchCompatibilityPassed &&
    gates.dependencyBlockerCount === 0
  );
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') return false;
      throw error;
    },
  );
}

async function requirePlainRoot(root: string): Promise<string> {
  try {
    const direct = await lstat(root);
    if (!direct.isDirectory() || direct.isSymbolicLink()) {
      throw new ReleaseRepositoryError('unsafe-path', 'layout');
    }
    const canonical = await realpath(root);
    const observed = await lstat(canonical);
    if (!observed.isDirectory() || observed.isSymbolicLink()) {
      throw new ReleaseRepositoryError('unsafe-path', 'layout');
    }
    return canonical;
  } catch (error) {
    if (error instanceof ReleaseRepositoryError) throw error;
    throw new ReleaseRepositoryError('unsafe-path', 'layout');
  }
}

async function readBoundedFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  try {
    const observed = await lstat(path);
    if (
      !observed.isFile() ||
      observed.isSymbolicLink() ||
      observed.nlink > 1 ||
      observed.size < 1 ||
      observed.size > maximumBytes
    ) {
      throw new ReleaseRepositoryError('unsafe-path', 'manifest');
    }
    return await readFile(path);
  } catch (error) {
    if (error instanceof ReleaseRepositoryError) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new ReleaseRepositoryError('not-found', 'manifest');
    }
    throw new ReleaseRepositoryError('storage-failure', 'manifest');
  }
}

async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new ReleaseRepositoryError('immutable-conflict', 'manifest');
    }
    throw new ReleaseRepositoryError('storage-failure', 'manifest');
  }
}

async function verifyPlainArtifact(path: string, size: number, sha256: string): Promise<void> {
  try {
    const observed = await lstat(path);
    if (
      !observed.isFile() ||
      observed.isSymbolicLink() ||
      observed.nlink > 1 ||
      observed.size !== size
    ) {
      throw new ReleaseRepositoryError('artifact-integrity', 'artifact');
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    if (hash.digest('hex') !== sha256) {
      throw new ReleaseRepositoryError('artifact-integrity', 'artifact');
    }
  } catch (error) {
    if (error instanceof ReleaseRepositoryError) throw error;
    throw new ReleaseRepositoryError('storage-failure', 'artifact');
  }
}

export class FilesystemReleaseRepository implements ReleaseRepository {
  readonly #configuredRoot: string;
  readonly #signer: FilesystemReleaseRepositoryOptions['signer'];
  readonly #maximumManifestBytes: number;

  public constructor(options: FilesystemReleaseRepositoryOptions) {
    validateAbsolutePath(options.root);
    if (
      (options.signer !== undefined &&
        (typeof options.signer.sign !== 'function' || typeof options.signer.keyId !== 'string')) ||
      (options.maximumManifestBytes !== undefined &&
        (!Number.isSafeInteger(options.maximumManifestBytes) || options.maximumManifestBytes < 1))
    ) {
      throw new ReleaseRepositoryError('invalid-options', 'options');
    }
    this.#configuredRoot = resolve(options.root);
    this.#signer = options.signer;
    this.#maximumManifestBytes = options.maximumManifestBytes ?? DEFAULT_MAXIMUM_MANIFEST_BYTES;
  }

  async #layout(): Promise<RepositoryLayout> {
    const root = await requirePlainRoot(this.#configuredRoot);
    const layout = {
      root,
      artifacts: resolve(root, 'artifacts', 'sha256'),
      releases: resolve(root, 'releases'),
      channels: resolve(root, 'channels'),
    };
    try {
      await Promise.all([
        mkdir(layout.artifacts, { recursive: true }),
        mkdir(layout.releases, { recursive: true }),
        mkdir(layout.channels, { recursive: true }),
      ]);
    } catch {
      throw new ReleaseRepositoryError('storage-failure', 'layout');
    }
    return Object.freeze(layout);
  }

  #artifactPath(layout: RepositoryLayout, sha256: string): string {
    validateHash(sha256);
    const target = resolve(layout.artifacts, sha256.slice(0, 2), sha256);
    if (!isWithin(layout.artifacts, target) || target === layout.artifacts) {
      throw new ReleaseRepositoryError('unsafe-path', 'artifact');
    }
    return target;
  }

  #releasePath(layout: RepositoryLayout, version: string, buildId: string): string {
    validateReleaseIdentity(version, buildId);
    const target = resolve(layout.releases, version, buildId, 'manifest.json');
    if (!isWithin(layout.releases, target) || target === layout.releases) {
      throw new ReleaseRepositoryError('unsafe-path', 'manifest');
    }
    return target;
  }

  async #publishArtifact(
    layout: RepositoryLayout,
    source: string,
    size: number,
    sha256: string,
  ): Promise<void> {
    if (!isAbsolute(source)) throw new ReleaseRepositoryError('unsafe-path', 'artifact');
    await verifyPlainArtifact(source, size, sha256);
    const target = this.#artifactPath(layout, sha256);
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    if (await pathExists(target)) {
      await verifyPlainArtifact(target, size, sha256);
      return;
    }
    const partial = resolve(parent, `${sha256}-${randomUUID()}.partial`);
    try {
      await copyFile(source, partial, constants.COPYFILE_EXCL);
      await verifyPlainArtifact(partial, size, sha256);
      try {
        await rename(partial, target);
      } catch (error) {
        if (!isNodeError(error) || (error.code !== 'EEXIST' && error.code !== 'EPERM')) throw error;
        await verifyPlainArtifact(target, size, sha256);
      }
    } catch (error) {
      if (error instanceof ReleaseRepositoryError) throw error;
      throw new ReleaseRepositoryError('storage-failure', 'artifact');
    } finally {
      await rm(partial, { force: true }).catch(() => undefined);
    }
  }

  public async publishRelease(input: PublishReleaseInput): Promise<void> {
    const validation = validateReleaseManifest(input.manifest);
    if (
      !validation.success ||
      (this.#signer !== undefined && validation.value.signature.keyId !== this.#signer.keyId)
    ) {
      throw new ReleaseRepositoryError('invalid-document', 'manifest');
    }
    const manifestBytes = canonicalJsonBytes(validation.value as CanonicalJsonValue);
    if (manifestBytes.byteLength > this.#maximumManifestBytes || sha256Bytes(manifestBytes) !== input.manifestSha256) {
      throw new ReleaseRepositoryError('invalid-document', 'manifest');
    }
    if (input.artifacts.length !== validation.value.files.length) {
      throw new ReleaseRepositoryError('invalid-document', 'artifact');
    }
    const stagedByPath = new Map(
      input.artifacts.map((artifact) => [artifact.path.normalize('NFC').toLocaleLowerCase('en-US'), artifact]),
    );
    for (const file of validation.value.files) {
      const staged = stagedByPath.get(file.path.normalize('NFC').toLocaleLowerCase('en-US'));
      if (staged === undefined || staged.sha256 !== file.sha256 || staged.size !== file.size) {
        throw new ReleaseRepositoryError('invalid-document', 'artifact');
      }
    }

    const layout = await this.#layout();
    for (const artifact of input.artifacts) {
      await this.#publishArtifact(layout, artifact.stagedPath, artifact.size, artifact.sha256);
    }

    const manifestPath = this.#releasePath(
      layout,
      validation.value.release.version,
      validation.value.release.buildId,
    );
    await mkdir(dirname(manifestPath), { recursive: true });
    if (await pathExists(manifestPath)) {
      const existing = await readBoundedFile(manifestPath, this.#maximumManifestBytes);
      if (sha256Bytes(existing) === input.manifestSha256) return;
      throw new ReleaseRepositoryError('immutable-conflict', 'manifest');
    }
    await writeExclusive(manifestPath, manifestBytes);
  }

  public async readRelease(version: string, buildId: string): Promise<StoredRelease | undefined> {
    const layout = await this.#layout();
    const path = this.#releasePath(layout, version, buildId);
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedFile(path, this.#maximumManifestBytes);
    } catch (error) {
      if (error instanceof ReleaseRepositoryError && error.code === 'not-found') return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    } catch {
      throw new ReleaseRepositoryError('invalid-document', 'manifest');
    }
    const validation = validateReleaseManifest(value);
    if (!validation.success) throw new ReleaseRepositoryError('invalid-document', 'manifest');
    const canonical = canonicalJsonBytes(validation.value as CanonicalJsonValue);
    if (!Buffer.from(canonical).equals(Buffer.from(bytes))) {
      throw new ReleaseRepositoryError('invalid-document', 'manifest');
    }
    return Object.freeze({ manifest: validation.value, manifestSha256: sha256Bytes(bytes) });
  }

  public async readArtifact(sha256: string): Promise<StoredArtifact | undefined> {
    const layout = await this.#layout();
    const path = this.#artifactPath(layout, sha256);
    try {
      const observed = await lstat(path);
      if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink > 1) {
        throw new ReleaseRepositoryError('artifact-integrity', 'artifact');
      }
      await verifyPlainArtifact(path, observed.size, sha256);
      return Object.freeze({ path, size: observed.size, sha256 });
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined;
      if (error instanceof ReleaseRepositoryError) throw error;
      throw new ReleaseRepositoryError('storage-failure', 'artifact');
    }
  }

  async #readChannelFromPath(path: string): Promise<LauncherChannel | undefined> {
    if (!(await pathExists(path))) return undefined;
    const bytes = await readBoundedFile(path, this.#maximumManifestBytes);
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    } catch {
      throw new ReleaseRepositoryError('invalid-document', 'channel');
    }
    const validation = validateLauncherChannel(value);
    if (!validation.success) throw new ReleaseRepositoryError('invalid-document', 'channel');
    if (!Buffer.from(canonicalJsonBytes(validation.value as CanonicalJsonValue)).equals(Buffer.from(bytes))) {
      throw new ReleaseRepositoryError('invalid-document', 'channel');
    }
    return validation.value;
  }

  public async readChannel(channel: ReleaseChannel): Promise<LauncherChannel | undefined> {
    const layout = await this.#layout();
    const channelRoot = resolve(layout.channels, channel);
    return this.#readChannelFromPath(resolve(channelRoot, 'current.json'));
  }

  async #wasPublished(
    channelRoot: string,
    currentRevision: number,
    releaseVersion: string,
    buildId: string,
  ): Promise<boolean> {
    for (let revision = 1; revision <= currentRevision; revision += 1) {
      const event = await this.#readChannelFromPath(resolve(channelRoot, 'events', `${revision}.json`));
      if (event?.releaseVersion === releaseVersion && event.buildId === buildId) return true;
    }
    return false;
  }

  async #mutateChannel(
    target: ChannelMutationTarget,
    operation: 'promotion' | 'rollback',
  ): Promise<LauncherChannel> {
    if (this.#signer === undefined) {
      throw new ReleaseRepositoryError('invalid-options', 'channel');
    }
    if (!['beta', 'stable'].includes(target.channel)) {
      throw new ReleaseRepositoryError('invalid-document', 'channel');
    }
    const layout = await this.#layout();
    const stored = await this.readRelease(target.releaseVersion, target.buildId);
    if (stored === undefined) throw new ReleaseRepositoryError('not-found', 'manifest');
    const channelRoot = resolve(layout.channels, target.channel);
    const eventsRoot = resolve(channelRoot, 'events');
    await mkdir(eventsRoot, { recursive: true });
    const lockPath = resolve(channelRoot, '.lock');
    let lock: Awaited<ReturnType<typeof open>>;
    try {
      lock = await open(lockPath, 'wx');
    } catch {
      throw new ReleaseRepositoryError('channel-conflict', 'channel');
    }

    let eventPath: string | undefined;
    let temporaryPath: string | undefined;
    try {
      const currentPath = resolve(channelRoot, 'current.json');
      const current = await this.#readChannelFromPath(currentPath);
      if (
        (target.expectedRevision === null && current !== undefined) ||
        (target.expectedRevision !== null && current?.revision !== target.expectedRevision)
      ) {
        throw new ReleaseRepositoryError('channel-conflict', 'channel');
      }
      if (
        operation === 'rollback' &&
        (current === undefined ||
          !(await this.#wasPublished(
            channelRoot,
            current.revision,
            target.releaseVersion,
            target.buildId,
          )))
      ) {
        throw new ReleaseRepositoryError('invalid-document', 'channel');
      }
      const revision = (current?.revision ?? 0) + 1;
      const unsigned: UnsignedLauncherChannel = {
        schemaVersion: 1,
        product: { id: 'voidfall', displayName: 'VoidFall' },
        channel: target.channel,
        revision,
        operation,
        releaseVersion: target.releaseVersion,
        buildId: target.buildId,
        manifestSha256: stored.manifestSha256,
        manifestUrl: target.manifestUrl,
        publishedAt: target.publishedAt,
        ...(current === undefined
          ? {}
          : {
              previous: {
                revision: current.revision,
                releaseVersion: current.releaseVersion,
                buildId: current.buildId,
              },
            }),
      };
      const next = signLauncherChannel(unsigned, this.#signer);
      const bytes = canonicalJsonBytes(next as CanonicalJsonValue);
      eventPath = resolve(eventsRoot, `${revision}.json`);
      temporaryPath = resolve(channelRoot, `current-${randomUUID()}.partial`);
      await writeExclusive(eventPath, bytes);
      await writeExclusive(temporaryPath, bytes);
      try {
        await rename(temporaryPath, currentPath);
      } catch {
        throw new ReleaseRepositoryError('storage-failure', 'channel');
      }
      temporaryPath = undefined;
      eventPath = undefined;
      return next;
    } catch (error) {
      if (temporaryPath !== undefined) await unlink(temporaryPath).catch(() => undefined);
      if (eventPath !== undefined) await unlink(eventPath).catch(() => undefined);
      throw error;
    } finally {
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  public async promoteChannel(plan: ChannelPromotionPlan): Promise<LauncherChannel> {
    if (plan.channel === 'stable' && !stableEligible(plan.gates)) {
      throw new ReleaseRepositoryError('stable-gate-blocked', 'channel');
    }
    return this.#mutateChannel(plan, 'promotion');
  }

  public async rollbackChannel(plan: ChannelRollbackPlan): Promise<LauncherChannel> {
    return this.#mutateChannel(plan, 'rollback');
  }
}
