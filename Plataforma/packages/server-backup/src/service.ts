import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  backupManifestSha256,
  compareManifestPaths,
  parseBackupManifest,
  serializeBackupManifest,
  validateManifestPath,
  type BackupManifest,
  type BackupManifestEntry,
} from './manifest.js';
import {
  BackupOperationError,
  DEFAULT_BACKUP_LIMITS,
  DEFAULT_BACKUP_QUOTA,
  DEFAULT_RETENTION_POLICY,
  VOIDFALL_BACKUP_FORMAT,
  VOIDFALL_BACKUP_SCHEMA_VERSION,
  type BackupConsistencyLease,
  type BackupFileCopier,
  type BackupLimits,
  type BackupReceipt,
  type BackupSourceDirectory,
  type BackupTotals,
  type CreateBackupPlan,
  type FilesystemBackupServiceOptions,
  type RestoreBackupPlan,
  type RestoreReceipt,
} from './types.js';
import {
  decryptBytes,
  encryptBytes,
  encryptedSizeFor,
  readWholeFile,
  validateEncryptionKey,
  MAXIMUM_ENCRYPTABLE_BYTES,
  type BackupEncryptionKey,
} from './encryption.js';
import {
  assertQuotaAllows,
  selectExpiredBackups,
  validateQuota,
  validateRetentionPolicy,
  type BackupQuota,
  type RetentionPolicy,
  type StoredBackupSummary,
} from './retention.js';
import {
  createBackupSeal,
  parseBackupSeal,
  serializeBackupSeal,
  validateSealKey,
  verifyBackupSeal,
  type BackupSealKey,
} from './seal.js';
import {
  clockTimestamp,
  parseCanonicalTimestamp,
  resolveLimits,
  validateBackupId,
  validateIdentifier,
  validateLogicalName,
  validateServerRelease,
} from './validation.js';

interface ResolvedSource {
  readonly logicalName: string;
  readonly path: string;
}

interface InventoryDirectory {
  readonly path: string;
  readonly type: 'directory';
  readonly sourcePath: string;
}

interface InventoryFile {
  readonly path: string;
  readonly type: 'file';
  readonly sourcePath: string;
  readonly sizeBytes: number;
}

type InventoryEntry = InventoryDirectory | InventoryFile;

interface Inventory {
  readonly entries: readonly InventoryEntry[];
  readonly totals: BackupTotals;
}

class NodeBackupFileCopier implements BackupFileCopier {
  async copyFile(source: string, destination: string): Promise<void> {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') return false;
      throw error;
    },
  );
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function unsafePath(stage: 'preflight' | 'verify' | 'cleanup'): never {
  throw new BackupOperationError('unsafe-path', stage);
}

function validateRelativeEntryPath(path: string, stage: 'preflight' | 'verify'): void {
  try {
    validateManifestPath(path);
  } catch {
    unsafePath(stage);
  }
}

function safeTarget(root: string, relativePath: string, stage: 'copy' | 'verify'): string {
  validateRelativeEntryPath(relativePath, 'verify');
  const target = resolve(root, ...relativePath.split('/'));
  if (!isWithin(root, target) || target === root) unsafePath(stage === 'copy' ? 'preflight' : 'verify');
  return target;
}

function validateSafePathInput(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || /\u0000/u.test(path)) {
    throw new BackupOperationError('invalid-plan', 'plan');
  }
}

function validatePlan(plan: CreateBackupPlan): CreateBackupPlan {
  try {
    validateBackupId(plan.backupId);
    validateIdentifier(plan.serverInstanceId);
    validateServerRelease(plan.serverRelease);
    validateIdentifier(plan.retentionPolicyId);
  } catch {
    throw new BackupOperationError('invalid-plan', 'plan');
  }
  if (!['world', 'configurations', 'complete'].includes(plan.scope)) {
    throw new BackupOperationError('invalid-plan', 'plan');
  }
  if (!Array.isArray(plan.sources) || plan.sources.length < 1 || plan.sources.length > 16) {
    throw new BackupOperationError('invalid-plan', 'plan');
  }
  const sources = plan.sources.map((source) => {
    try {
      validateLogicalName(source.logicalName);
      validateSafePathInput(source.path);
    } catch {
      throw new BackupOperationError('invalid-plan', 'plan');
    }
    return Object.freeze({ logicalName: source.logicalName, path: source.path });
  });
  return Object.freeze({ ...plan, sources: Object.freeze(sources) });
}

function validateRestorePlan(plan: RestoreBackupPlan): RestoreBackupPlan {
  try {
    validateBackupId(plan.backupId);
    validateLogicalName(plan.targetName);
    validateSafePathInput(plan.isolatedParentRoot);
  } catch {
    throw new BackupOperationError('invalid-plan', 'plan');
  }
  return Object.freeze({ ...plan });
}

async function requirePlainDirectory(path: string, stage: 'preflight' | 'verify'): Promise<string> {
  try {
    const directStat = await lstat(path);
    if (directStat.isSymbolicLink() || !directStat.isDirectory()) unsafePath(stage);
    const canonical = await realpath(path);
    const canonicalStat = await lstat(canonical);
    if (canonicalStat.isSymbolicLink() || !canonicalStat.isDirectory()) unsafePath(stage);
    return canonical;
  } catch (error) {
    if (error instanceof BackupOperationError) throw error;
    throw new BackupOperationError('unsafe-path', stage);
  }
}

async function resolveSources(
  sources: readonly BackupSourceDirectory[],
  repositoryRoot: string,
): Promise<readonly ResolvedSource[]> {
  const resolvedSources: ResolvedSource[] = [];
  const logicalNames = new Set<string>();
  for (const source of sources) {
    const logicalKey = source.logicalName.toLocaleLowerCase('en-US');
    if (logicalNames.has(logicalKey)) {
      throw new BackupOperationError('invalid-plan', 'plan');
    }
    logicalNames.add(logicalKey);
    resolvedSources.push({
      logicalName: source.logicalName,
      path: await requirePlainDirectory(source.path, 'preflight'),
    });
  }

  for (const source of resolvedSources) {
    if (isWithin(repositoryRoot, source.path) || isWithin(source.path, repositoryRoot)) {
      unsafePath('preflight');
    }
  }
  for (let index = 0; index < resolvedSources.length; index += 1) {
    const left = resolvedSources[index];
    if (left === undefined) continue;
    for (let otherIndex = index + 1; otherIndex < resolvedSources.length; otherIndex += 1) {
      const right = resolvedSources[otherIndex];
      if (right === undefined) continue;
      if (isWithin(left.path, right.path) || isWithin(right.path, left.path)) {
        unsafePath('preflight');
      }
    }
  }
  resolvedSources.sort((left, right) => compareManifestPaths(left.logicalName, right.logicalName));
  return Object.freeze(resolvedSources.map((source) => Object.freeze(source)));
}

function incrementTotals(
  totals: { files: number; directories: number; bytes: number },
  type: 'file' | 'directory',
  sizeBytes: number,
  limits: BackupLimits,
): void {
  if (type === 'file') {
    totals.files += 1;
    totals.bytes += sizeBytes;
  } else {
    totals.directories += 1;
  }
  if (
    totals.files > limits.maximumFiles ||
    totals.directories > limits.maximumFiles ||
    totals.bytes > limits.maximumTotalBytes
  ) {
    throw new BackupOperationError('limit-exceeded', 'preflight');
  }
}

async function inventorySources(
  sources: readonly ResolvedSource[],
  limits: BackupLimits,
): Promise<Inventory> {
  const entries: InventoryEntry[] = [];
  const pathKeys = new Set<string>();
  const totals = { files: 0, directories: 0, bytes: 0 };

  const addEntry = (entry: InventoryEntry): void => {
    validateRelativeEntryPath(entry.path, 'preflight');
    const key = entry.path.toLocaleLowerCase('en-US');
    if (pathKeys.has(key)) unsafePath('preflight');
    pathKeys.add(key);
    entries.push(entry);
    incrementTotals(
      totals,
      entry.type,
      entry.type === 'file' ? entry.sizeBytes : 0,
      limits,
    );
  };

  const walk = async (
    sourceRoot: string,
    directory: string,
    logicalPath: string,
    depth: number,
  ): Promise<void> => {
    if (depth > limits.maximumDepth) {
      throw new BackupOperationError('limit-exceeded', 'preflight');
    }
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      throw new BackupOperationError('filesystem-failure', 'preflight');
    }
    children.sort((left, right) => compareManifestPaths(left.name, right.name));
    for (const child of children) {
      const sourcePath = resolve(directory, child.name);
      if (!isWithin(sourceRoot, sourcePath)) unsafePath('preflight');
      const entryPath = `${logicalPath}/${child.name}`;
      let stat;
      try {
        stat = await lstat(sourcePath);
      } catch {
        throw new BackupOperationError('filesystem-failure', 'preflight');
      }
      if (stat.isSymbolicLink()) {
        throw new BackupOperationError('unsupported-entry', 'preflight');
      }
      if (stat.isDirectory()) {
        addEntry({ path: entryPath, type: 'directory', sourcePath });
        await walk(sourceRoot, sourcePath, entryPath, depth + 1);
      } else if (stat.isFile()) {
        if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.nlink > 1) {
          throw new BackupOperationError('unsupported-entry', 'preflight');
        }
        if (stat.size > limits.maximumFileBytes) {
          throw new BackupOperationError('limit-exceeded', 'preflight');
        }
        addEntry({ path: entryPath, type: 'file', sourcePath, sizeBytes: stat.size });
      } else {
        throw new BackupOperationError('unsupported-entry', 'preflight');
      }
    }
  };

  for (const source of sources) {
    addEntry({ path: source.logicalName, type: 'directory', sourcePath: source.path });
    await walk(source.path, source.path, source.logicalName, 1);
  }
  entries.sort((left, right) => compareManifestPaths(left.path, right.path));
  return Object.freeze({
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
    totals: Object.freeze(totals),
  });
}

async function ensureFreeSpace(
  repositoryRoot: string,
  bytesToCopy: number,
  minimumFreeBytesAfterCopy: number,
): Promise<void> {
  try {
    const filesystem = await statfs(repositoryRoot, { bigint: true });
    const available = filesystem.bavail * filesystem.bsize;
    const required =
      BigInt(bytesToCopy) + BigInt(minimumFreeBytesAfterCopy) + BigInt(1_024 ** 2);
    if (available < required) {
      throw new BackupOperationError('insufficient-space', 'preflight');
    }
  } catch (error) {
    if (error instanceof BackupOperationError) throw error;
    throw new BackupOperationError('filesystem-failure', 'preflight');
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } catch {
    throw new BackupOperationError('filesystem-failure', 'verify');
  }
  return hash.digest('hex');
}

/**
 * Writes one file, encrypting it when the repository has a key.
 *
 * The digest recorded is always the **plaintext** digest, taken from the source
 * before encryption and re-derived from the destination by decrypting it. That
 * is what makes a later verification prove the backup still restores to the
 * same bytes, rather than proving only that the ciphertext is unchanged.
 */
async function writePayloadFile(
  entry: InventoryFile,
  destination: string,
  copier: BackupFileCopier,
  encryptionKey: BackupEncryptionKey | undefined,
): Promise<string> {
  if (encryptionKey === undefined) {
    try {
      await copier.copyFile(entry.sourcePath, destination);
    } catch (error) {
      if (error instanceof BackupOperationError) throw error;
      throw new BackupOperationError('filesystem-failure', 'copy');
    }
    return sha256File(destination);
  }

  const plaintext = await readWholeFile(entry.sourcePath, MAXIMUM_ENCRYPTABLE_BYTES);
  const plaintextHash = createHash('sha256').update(plaintext).digest('hex');
  try {
    await writeFile(destination, encryptBytes(encryptionKey, plaintext), { flag: 'wx' });
  } catch (error) {
    if (error instanceof BackupOperationError) throw error;
    throw new BackupOperationError('filesystem-failure', 'copy');
  }
  // Read it back through decryption: a write that landed wrong, or a key that
  // does not round-trip, is caught here rather than on the day of a restore.
  const stored = await readWholeFile(destination, MAXIMUM_ENCRYPTABLE_BYTES + 1_024);
  const roundTripped = decryptBytes(encryptionKey, stored);
  const roundTrippedHash = createHash('sha256').update(roundTripped).digest('hex');
  if (roundTrippedHash !== plaintextHash) {
    throw new BackupOperationError('integrity-mismatch', 'verify');
  }
  return plaintextHash;
}

async function copyInventory(
  inventory: Inventory,
  payloadRoot: string,
  copier: BackupFileCopier,
  encryptionKey?: BackupEncryptionKey,
): Promise<readonly BackupManifestEntry[]> {
  const manifestEntries: BackupManifestEntry[] = [];
  for (const entry of inventory.entries) {
    const destination = safeTarget(payloadRoot, entry.path, 'copy');
    if (entry.type === 'directory') {
      try {
        await mkdir(destination, { recursive: true });
      } catch {
        throw new BackupOperationError('filesystem-failure', 'copy');
      }
      manifestEntries.push(Object.freeze({ path: entry.path, type: 'directory' }));
      continue;
    }
    const plaintextHash = await writePayloadFile(entry, destination, copier, encryptionKey);
    let destinationStat;
    try {
      destinationStat = await lstat(destination);
    } catch {
      throw new BackupOperationError('filesystem-failure', 'verify');
    }
    const expectedStoredSize =
      encryptionKey === undefined ? entry.sizeBytes : encryptedSizeFor(entry.sizeBytes);
    if (
      !destinationStat.isFile() ||
      destinationStat.isSymbolicLink() ||
      destinationStat.nlink > 1 ||
      destinationStat.size !== expectedStoredSize
    ) {
      throw new BackupOperationError('integrity-mismatch', 'verify');
    }
    const sourceHash = await sha256File(entry.sourcePath);
    if (sourceHash !== plaintextHash) {
      throw new BackupOperationError('integrity-mismatch', 'verify');
    }
    manifestEntries.push(
      Object.freeze({
        path: entry.path,
        type: 'file',
        sizeBytes: entry.sizeBytes,
        sha256: plaintextHash,
      }),
    );
  }
  return Object.freeze(manifestEntries);
}

/**
 * Writes a snapshot back out as plaintext.
 *
 * Restoration is not a copy when the snapshot is encrypted, and treating it as
 * one would put ciphertext where a server expects its world. Decryption also
 * authenticates, so a payload file altered in the repository fails here rather
 * than becoming a corrupt world nobody notices until it is loaded.
 */
async function restoreInventory(input: {
  readonly manifest: BackupManifest;
  readonly payloadRoot: string;
  readonly destinationRoot: string;
  readonly copier: BackupFileCopier;
  readonly encryptionKey?: BackupEncryptionKey;
}): Promise<void> {
  const encrypted = input.manifest.encryption !== null;
  if (encrypted && input.encryptionKey === undefined) {
    throw new BackupOperationError('integrity-mismatch', 'verify');
  }
  for (const entry of input.manifest.entries) {
    const source = safeTarget(input.payloadRoot, entry.path, 'verify');
    const destination = safeTarget(input.destinationRoot, entry.path, 'copy');
    if (entry.type === 'directory') {
      try {
        await mkdir(destination, { recursive: true });
      } catch {
        throw new BackupOperationError('filesystem-failure', 'copy');
      }
      continue;
    }
    if (!encrypted || input.encryptionKey === undefined) {
      try {
        await input.copier.copyFile(source, destination);
      } catch (error) {
        if (error instanceof BackupOperationError) throw error;
        throw new BackupOperationError('filesystem-failure', 'copy');
      }
      continue;
    }
    const stored = await readWholeFile(source, MAXIMUM_ENCRYPTABLE_BYTES + 1_024);
    const plaintext = decryptBytes(input.encryptionKey, stored);
    try {
      await writeFile(destination, plaintext, { flag: 'wx' });
    } catch {
      throw new BackupOperationError('filesystem-failure', 'copy');
    }
  }
}

/**
 * Checks a tree against a manifest.
 *
 * `form` says what is on disk, and it is a parameter rather than something
 * inferred from the manifest because both forms are legitimate: a stored
 * snapshot holds ciphertext, and a freshly restored tree holds plaintext. The
 * manifest describes the plaintext either way, so guessing would silently check
 * the wrong thing exactly once — on the restore that mattered.
 */
async function verifyPayload(
  payloadRoot: string,
  manifest: BackupManifest,
  limits: BackupLimits,
  options: {
    readonly form: 'as-stored' | 'plaintext';
    readonly encryptionKey?: BackupEncryptionKey;
  } = { form: 'plaintext' },
): Promise<void> {
  let activeKey: BackupEncryptionKey | undefined;
  if (options.form === 'as-stored' && manifest.encryption !== null) {
    // A manifest that says it is encrypted cannot be verified without the key.
    // Pretending otherwise would let a stored backup be declared good on the
    // strength of never having been read.
    if (
      options.encryptionKey === undefined ||
      manifest.encryption.keyId !== options.encryptionKey.keyId
    ) {
      throw new BackupOperationError('integrity-mismatch', 'verify');
    }
    activeKey = options.encryptionKey;
  }
  const resolvedSources: ResolvedSource[] = [];
  for (const source of manifest.sources) {
    const sourcePath = safeTarget(payloadRoot, source.logicalName, 'verify');
    resolvedSources.push({ logicalName: source.logicalName, path: sourcePath });
  }
  const inventory = await inventorySources(resolvedSources, limits);
  if (inventory.entries.length !== manifest.entries.length) {
    throw new BackupOperationError('integrity-mismatch', 'verify');
  }
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const expected = manifest.entries[index];
    const observed = inventory.entries[index];
    if (
      expected === undefined ||
      observed === undefined ||
      expected.path !== observed.path ||
      expected.type !== observed.type
    ) {
      throw new BackupOperationError('integrity-mismatch', 'verify');
    }
    if (expected.type === 'file') {
      const expectedStoredSize =
        activeKey === undefined ? expected.sizeBytes : encryptedSizeFor(expected.sizeBytes);
      if (observed.type !== 'file' || observed.sizeBytes !== expectedStoredSize) {
        throw new BackupOperationError('integrity-mismatch', 'verify');
      }
      if (activeKey === undefined) {
        if ((await sha256File(observed.sourcePath)) !== expected.sha256) {
          throw new BackupOperationError('integrity-mismatch', 'verify');
        }
        continue;
      }
      // Decryption authenticates the ciphertext; the digest then proves it is
      // the plaintext this manifest actually describes.
      const stored = await readWholeFile(observed.sourcePath, MAXIMUM_ENCRYPTABLE_BYTES + 1_024);
      const plaintext = decryptBytes(activeKey, stored);
      if (
        plaintext.byteLength !== expected.sizeBytes ||
        createHash('sha256').update(plaintext).digest('hex') !== expected.sha256
      ) {
        throw new BackupOperationError('integrity-mismatch', 'verify');
      }
    }
  }
}

async function acquireLock(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    return await open(path, 'wx');
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new BackupOperationError('destination-conflict', 'preflight');
    }
    throw new BackupOperationError('filesystem-failure', 'preflight');
  }
}

async function releaseLock(
  lock: Awaited<ReturnType<typeof open>>,
  lockPath: string,
): Promise<void> {
  try {
    await lock.close();
    await unlink(lockPath);
  } catch {
    throw new BackupOperationError('cleanup-failed', 'cleanup');
  }
}

async function cleanPartial(path: string, expectedParent: string): Promise<void> {
  if (dirname(path) !== expectedParent || !path.endsWith('.partial')) {
    throw new BackupOperationError('cleanup-failed', 'cleanup');
  }
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    throw new BackupOperationError('cleanup-failed', 'cleanup');
  }
}

function validateLease(lease: BackupConsistencyLease): Date {
  if (lease.method !== 'offline-exclusive-v1') {
    throw new BackupOperationError('consistency-unavailable', 'guard');
  }
  try {
    return parseCanonicalTimestamp(lease.acquiredAt);
  } catch {
    throw new BackupOperationError('consistency-unavailable', 'guard');
  }
}

export class FilesystemBackupService {
  readonly #repositoryRoot: string;
  readonly #guard: FilesystemBackupServiceOptions['guard'];
  readonly #limits: BackupLimits;
  readonly #clock: () => Date;
  readonly #fileCopier: BackupFileCopier;
  readonly #sealKey: BackupSealKey;
  readonly #encryptionKey: BackupEncryptionKey | undefined;
  readonly #quota: BackupQuota;
  readonly #retentionPolicy: RetentionPolicy;

  constructor(options: FilesystemBackupServiceOptions) {
    validateSafePathInput(options.repositoryRoot);
    if (
      options.guard === undefined ||
      typeof options.guard.runWithExclusiveOfflineAccess !== 'function'
    ) {
      throw new BackupOperationError('invalid-plan', 'plan');
    }
    this.#repositoryRoot = options.repositoryRoot;
    this.#guard = options.guard;
    this.#limits = resolveLimits(DEFAULT_BACKUP_LIMITS, options.limits);
    this.#clock = options.clock ?? (() => new Date());
    this.#fileCopier = options.fileCopier ?? new NodeBackupFileCopier();
    // The seal key is not optional. A repository without one holds manifests
    // that attest to nothing but themselves.
    this.#sealKey = validateSealKey(options.sealKey);
    this.#encryptionKey =
      options.encryptionKey === undefined ? undefined : validateEncryptionKey(options.encryptionKey);
    this.#quota = validateQuota(options.quota ?? DEFAULT_BACKUP_QUOTA);
    this.#retentionPolicy = validateRetentionPolicy(
      options.retentionPolicy ?? DEFAULT_RETENTION_POLICY,
    );
  }

  /**
   * Lists what the repository holds, using each snapshot's own manifest for the
   * size rather than walking the tree: retention has to be decidable without
   * reading every byte it might delete.
   */
  async listBackups(): Promise<readonly StoredBackupSummary[]> {
    const snapshotsRoot = resolve(this.#repositoryRoot, 'snapshots');
    if (!(await pathExists(snapshotsRoot))) return Object.freeze([]);
    let names: string[];
    try {
      names = await readdir(snapshotsRoot);
    } catch {
      throw new BackupOperationError('filesystem-failure', 'preflight');
    }
    const summaries: StoredBackupSummary[] = [];
    for (const name of names.sort(compareManifestPaths)) {
      if (name.endsWith('.lock')) continue;
      const snapshotPath = resolve(snapshotsRoot, name);
      let stat;
      try {
        stat = await lstat(snapshotPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      let manifest: BackupManifest;
      try {
        manifest = parseBackupManifest(
          await readFile(resolve(snapshotPath, 'manifest.json'), 'utf8'),
        );
      } catch {
        // A snapshot whose manifest will not parse is not counted as stored.
        // It is also never selected for deletion here: deciding to remove
        // something unreadable is an operator's call, not retention's.
        continue;
      }
      summaries.push(
        Object.freeze({
          backupId: manifest.backupId,
          createdAt: manifest.createdAt,
          sizeBytes: manifest.totals.bytes,
        }),
      );
    }
    return Object.freeze(summaries);
  }

  /**
   * Verifies a stored backup end to end: seal first, then payload.
   *
   * Seal first is the point. A tampered manifest is refused before anything
   * reads a byte it describes, so a forged manifest cannot steer verification
   * at files of its own choosing.
   */
  async verifyBackup(backupId: string): Promise<{ readonly manifestSha256: string }> {
    validateBackupId(backupId);
    const snapshotsRoot = await requirePlainDirectory(
      resolve(this.#repositoryRoot, 'snapshots'),
      'verify',
    );
    const snapshotPath = await requirePlainDirectory(resolve(snapshotsRoot, backupId), 'verify');
    const manifest = await this.#readSealedManifest(snapshotPath, backupId);
    const payloadRoot = await requirePlainDirectory(resolve(snapshotPath, 'payload'), 'verify');
    await verifyPayload(payloadRoot, manifest, this.#limits, {
      form: 'as-stored',
      ...(this.#encryptionKey === undefined ? {} : { encryptionKey: this.#encryptionKey }),
    });
    return Object.freeze({ manifestSha256: backupManifestSha256(manifest) });
  }

  async #readSealedManifest(snapshotPath: string, backupId: string): Promise<BackupManifest> {
    let manifestBytes: Buffer;
    let sealText: string;
    try {
      manifestBytes = await readFile(resolve(snapshotPath, 'manifest.json'));
      sealText = await readFile(resolve(snapshotPath, 'seal.json'), 'utf8');
    } catch {
      throw new BackupOperationError('integrity-mismatch', 'verify');
    }
    const seal = parseBackupSeal(sealText);
    verifyBackupSeal({ key: this.#sealKey, seal, backupId, manifestBytes });
    const manifest = parseBackupManifest(manifestBytes.toString('utf8'));
    if (manifest.backupId !== backupId) {
      throw new BackupOperationError('integrity-mismatch', 'verify');
    }
    if (seal.manifestSha256 !== backupManifestSha256(manifest)) {
      throw new BackupOperationError('integrity-mismatch', 'verify');
    }
    return manifest;
  }

  /**
   * Removes what retention no longer keeps.
   *
   * Returns what it removed so a caller can record it. A snapshot is deleted
   * only after its lock is held, so pruning cannot race a restore reading the
   * same snapshot.
   */
  async pruneExpiredBackups(): Promise<readonly string[]> {
    const stored = await this.listBackups();
    const expired = selectExpiredBackups({
      policy: this.#retentionPolicy,
      stored,
      now: this.#clock(),
    });
    const snapshotsRoot = resolve(this.#repositoryRoot, 'snapshots');
    const removed: string[] = [];
    for (const backup of expired) {
      const snapshotPath = resolve(snapshotsRoot, backup.backupId);
      const lockPath = resolve(snapshotsRoot, `${backup.backupId}.lock`);
      if (!isWithin(snapshotsRoot, snapshotPath) || snapshotPath === snapshotsRoot) {
        unsafePath('cleanup');
      }
      const lock = await acquireLock(lockPath);
      try {
        await rm(snapshotPath, { recursive: true, force: true });
        removed.push(backup.backupId);
      } catch {
        throw new BackupOperationError('cleanup-failed', 'cleanup');
      } finally {
        await releaseLock(lock, lockPath);
      }
    }
    return Object.freeze(removed);
  }

  async createBackup(inputPlan: CreateBackupPlan): Promise<BackupReceipt> {
    const plan = validatePlan(inputPlan);
    let guardInvoked = false;
    try {
      const receipt = await this.#guard.runWithExclusiveOfflineAccess(async (lease) => {
        if (guardInvoked) {
          throw new BackupOperationError('consistency-unavailable', 'guard');
        }
        guardInvoked = true;
        const acquiredAt = validateLease(lease);
        const createdAt = clockTimestamp(this.#clock);
        if (acquiredAt.getTime() > new Date(createdAt).getTime()) {
          throw new BackupOperationError('consistency-unavailable', 'guard');
        }
        return this.#createGuardedBackup(plan, lease, createdAt);
      });
      if (!guardInvoked) {
        throw new BackupOperationError('consistency-unavailable', 'guard');
      }
      return receipt;
    } catch (error) {
      if (error instanceof BackupOperationError) throw error;
      throw new BackupOperationError('consistency-unavailable', 'guard');
    }
  }

  async #createGuardedBackup(
    plan: CreateBackupPlan,
    lease: BackupConsistencyLease,
    createdAt: string,
  ): Promise<BackupReceipt> {
    const repositoryRoot = await requirePlainDirectory(this.#repositoryRoot, 'preflight');
    const sources = await resolveSources(plan.sources, repositoryRoot);
    const stagingRoot = resolve(repositoryRoot, 'staging');
    const snapshotsRoot = resolve(repositoryRoot, 'snapshots');
    try {
      await mkdir(stagingRoot, { recursive: true });
      await mkdir(snapshotsRoot, { recursive: true });
      const [stagingStat, snapshotsStat] = await Promise.all([
        lstat(stagingRoot),
        lstat(snapshotsRoot),
      ]);
      if (stagingStat.dev !== snapshotsStat.dev) unsafePath('preflight');
    } catch (error) {
      if (error instanceof BackupOperationError) throw error;
      throw new BackupOperationError('filesystem-failure', 'preflight');
    }

    const stagingPath = resolve(stagingRoot, `${plan.backupId}.partial`);
    const snapshotPath = resolve(snapshotsRoot, plan.backupId);
    const lockPath = resolve(snapshotsRoot, `${plan.backupId}.lock`);
    if (
      !isWithin(stagingRoot, stagingPath) ||
      !isWithin(snapshotsRoot, snapshotPath) ||
      !isWithin(snapshotsRoot, lockPath)
    ) {
      unsafePath('preflight');
    }
    const lock = await acquireLock(lockPath);
    let partialCreated = false;
    let promoted = false;
    let primaryError: unknown;
    let receipt: BackupReceipt | undefined;
    try {
      if ((await pathExists(stagingPath)) || (await pathExists(snapshotPath))) {
        throw new BackupOperationError('destination-conflict', 'preflight');
      }
      const inventory = await inventorySources(sources, this.#limits);
      // The quota is checked before the copy, not after: checking afterwards
      // means the disk already holds the bytes the quota exists to prevent.
      assertQuotaAllows({
        quota: this.#quota,
        stored: await this.listBackups(),
        incomingBytes: inventory.totals.bytes,
      });
      await ensureFreeSpace(
        repositoryRoot,
        this.#encryptionKey === undefined
          ? inventory.totals.bytes
          : encryptedSizeFor(inventory.totals.bytes),
        this.#limits.minimumFreeBytesAfterCopy,
      );
      await mkdir(stagingPath);
      partialCreated = true;
      const payloadRoot = resolve(stagingPath, 'payload');
      await mkdir(payloadRoot);
      const entries = await copyInventory(
        inventory,
        payloadRoot,
        this.#fileCopier,
        this.#encryptionKey,
      );
      const manifest: BackupManifest = Object.freeze({
        format: VOIDFALL_BACKUP_FORMAT,
        schemaVersion: VOIDFALL_BACKUP_SCHEMA_VERSION,
        backupId: plan.backupId,
        serverInstanceId: plan.serverInstanceId,
        serverRelease: plan.serverRelease,
        retentionPolicyId: plan.retentionPolicyId,
        scope: plan.scope,
        createdAt,
        consistency: Object.freeze({ method: lease.method, acquiredAt: lease.acquiredAt }),
        sources: Object.freeze(
          sources.map((source) => Object.freeze({ logicalName: source.logicalName })),
        ),
        entries,
        totals: inventory.totals,
        encryption:
          this.#encryptionKey === undefined
            ? null
            : Object.freeze({ algorithm: 'aes-256-gcm' as const, keyId: this.#encryptionKey.keyId }),
      });
      const serializedManifest = serializeBackupManifest(manifest);
      try {
        await writeFile(resolve(stagingPath, 'manifest.json'), serializedManifest, {
          encoding: 'utf8',
          flag: 'wx',
        });
      } catch {
        throw new BackupOperationError('filesystem-failure', 'copy');
      }
      await verifyPayload(payloadRoot, manifest, this.#limits, {
      form: 'as-stored',
      ...(this.#encryptionKey === undefined ? {} : { encryptionKey: this.#encryptionKey }),
    });
      const storedManifestBytes = await readFile(resolve(stagingPath, 'manifest.json'));
      const storedManifest = parseBackupManifest(storedManifestBytes.toString('utf8'));
      if (backupManifestSha256(storedManifest) !== backupManifestSha256(manifest)) {
        throw new BackupOperationError('integrity-mismatch', 'verify');
      }
      // Sealed over the bytes actually on disk, not over the in-memory object:
      // the seal has to attest to what a later reader will read.
      const seal = createBackupSeal({
        key: this.#sealKey,
        backupId: plan.backupId,
        manifestBytes: storedManifestBytes,
        manifestSha256: backupManifestSha256(storedManifest),
      });
      try {
        await writeFile(resolve(stagingPath, 'seal.json'), serializeBackupSeal(seal), {
          encoding: 'utf8',
          flag: 'wx',
        });
      } catch {
        throw new BackupOperationError('filesystem-failure', 'copy');
      }
      try {
        await rename(stagingPath, snapshotPath);
      } catch {
        throw new BackupOperationError('promotion-failed', 'promote');
      }
      promoted = true;
      receipt = Object.freeze({
        operation: 'backup',
        backupId: plan.backupId,
        createdAt,
        consistencyMethod: lease.method,
        manifestSha256: backupManifestSha256(manifest),
        totals: Object.freeze({ ...manifest.totals }),
      });
    } catch (error) {
      primaryError = error;
      if (!(error instanceof BackupOperationError)) {
        primaryError = new BackupOperationError('filesystem-failure', 'copy');
      }
    } finally {
      if (partialCreated && !promoted) {
        try {
          await cleanPartial(stagingPath, stagingRoot);
        } catch (cleanupError) {
          primaryError = cleanupError;
        }
      }
      try {
        await releaseLock(lock, lockPath);
      } catch (cleanupError) {
        primaryError = cleanupError;
      }
    }
    if (primaryError !== undefined) {
      throw primaryError instanceof BackupOperationError
        ? primaryError
        : new BackupOperationError('filesystem-failure', 'copy');
    }
    if (receipt === undefined) {
      throw new BackupOperationError('filesystem-failure', 'copy');
    }
    return receipt;
  }

  async restoreBackup(inputPlan: RestoreBackupPlan): Promise<RestoreReceipt> {
    const plan = validateRestorePlan(inputPlan);
    const repositoryRoot = await requirePlainDirectory(this.#repositoryRoot, 'preflight');
    const snapshotsRoot = await requirePlainDirectory(resolve(repositoryRoot, 'snapshots'), 'verify');
    const snapshotPath = await requirePlainDirectory(
      resolve(snapshotsRoot, plan.backupId),
      'verify',
    );
    if (!isWithin(snapshotsRoot, snapshotPath) || snapshotPath === snapshotsRoot) {
      unsafePath('verify');
    }
    const isolatedParent = await requirePlainDirectory(plan.isolatedParentRoot, 'preflight');
    const targetPath = resolve(isolatedParent, plan.targetName);
    const partialPath = resolve(isolatedParent, `.${plan.targetName}.voidfall-restore.partial`);
    const lockPath = resolve(isolatedParent, `.${plan.targetName}.voidfall-restore.lock`);
    if (
      !isWithin(isolatedParent, targetPath) ||
      !isWithin(isolatedParent, partialPath) ||
      !isWithin(isolatedParent, lockPath) ||
      isWithin(repositoryRoot, targetPath) ||
      isWithin(targetPath, repositoryRoot)
    ) {
      unsafePath('preflight');
    }

    // The seal is checked before anything else is trusted. A manifest that was
    // rewritten in the repository must not be able to steer a restore.
    const manifest = await this.#readSealedManifest(snapshotPath, plan.backupId);
    const payloadRoot = await requirePlainDirectory(resolve(snapshotPath, 'payload'), 'verify');
    await verifyPayload(payloadRoot, manifest, this.#limits, {
      form: 'as-stored',
      ...(this.#encryptionKey === undefined ? {} : { encryptionKey: this.#encryptionKey }),
    });

    const lock = await acquireLock(lockPath);
    let partialCreated = false;
    let promoted = false;
    let primaryError: unknown;
    let receipt: RestoreReceipt | undefined;
    try {
      if ((await pathExists(targetPath)) || (await pathExists(partialPath))) {
        throw new BackupOperationError('destination-conflict', 'preflight');
      }
      await ensureFreeSpace(
        isolatedParent,
        manifest.totals.bytes,
        this.#limits.minimumFreeBytesAfterCopy,
      );
      await mkdir(partialPath);
      partialCreated = true;
      await restoreInventory({
        manifest,
        payloadRoot,
        destinationRoot: partialPath,
        copier: this.#fileCopier,
        ...(manifest.encryption === null || this.#encryptionKey === undefined
          ? {}
          : { encryptionKey: this.#encryptionKey }),
      });
      // Verified without a key: what was restored is plaintext, whatever the
      // snapshot held. Passing the key here would check the wrong thing.
      await verifyPayload(partialPath, manifest, this.#limits, { form: 'plaintext' });
      try {
        await rename(partialPath, targetPath);
      } catch {
        throw new BackupOperationError('promotion-failed', 'promote');
      }
      promoted = true;
      receipt = Object.freeze({
        operation: 'restore',
        backupId: plan.backupId,
        restoredAt: clockTimestamp(this.#clock),
        manifestSha256: backupManifestSha256(manifest),
        totals: Object.freeze({ ...manifest.totals }),
      });
    } catch (error) {
      primaryError =
        error instanceof BackupOperationError
          ? error
          : new BackupOperationError('filesystem-failure', 'copy');
    } finally {
      if (partialCreated && !promoted) {
        try {
          await cleanPartial(partialPath, isolatedParent);
        } catch (cleanupError) {
          primaryError = cleanupError;
        }
      }
      try {
        await releaseLock(lock, lockPath);
      } catch (cleanupError) {
        primaryError = cleanupError;
      }
    }
    if (primaryError !== undefined) {
      throw primaryError instanceof BackupOperationError
        ? primaryError
        : new BackupOperationError('filesystem-failure', 'copy');
    }
    if (receipt === undefined) {
      throw new BackupOperationError('filesystem-failure', 'copy');
    }
    return receipt;
  }
}
