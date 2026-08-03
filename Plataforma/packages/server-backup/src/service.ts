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

function unsafePath(stage: 'preflight' | 'verify'): never {
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

async function copyInventory(
  inventory: Inventory,
  payloadRoot: string,
  copier: BackupFileCopier,
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
    try {
      await copier.copyFile(entry.sourcePath, destination);
    } catch (error) {
      if (error instanceof BackupOperationError) throw error;
      throw new BackupOperationError('filesystem-failure', 'copy');
    }
    let destinationStat;
    try {
      destinationStat = await lstat(destination);
    } catch {
      throw new BackupOperationError('filesystem-failure', 'verify');
    }
    if (
      !destinationStat.isFile() ||
      destinationStat.isSymbolicLink() ||
      destinationStat.nlink > 1 ||
      destinationStat.size !== entry.sizeBytes
    ) {
      throw new BackupOperationError('integrity-mismatch', 'verify');
    }
    const [sourceHash, destinationHash] = await Promise.all([
      sha256File(entry.sourcePath),
      sha256File(destination),
    ]);
    if (sourceHash !== destinationHash) {
      throw new BackupOperationError('integrity-mismatch', 'verify');
    }
    manifestEntries.push(
      Object.freeze({
        path: entry.path,
        type: 'file',
        sizeBytes: entry.sizeBytes,
        sha256: destinationHash,
      }),
    );
  }
  return Object.freeze(manifestEntries);
}

async function verifyPayload(
  payloadRoot: string,
  manifest: BackupManifest,
  limits: BackupLimits,
): Promise<void> {
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
      if (observed.type !== 'file' || observed.sizeBytes !== expected.sizeBytes) {
        throw new BackupOperationError('integrity-mismatch', 'verify');
      }
      const hash = await sha256File(observed.sourcePath);
      if (hash !== expected.sha256) {
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
      await ensureFreeSpace(
        repositoryRoot,
        inventory.totals.bytes,
        this.#limits.minimumFreeBytesAfterCopy,
      );
      await mkdir(stagingPath);
      partialCreated = true;
      const payloadRoot = resolve(stagingPath, 'payload');
      await mkdir(payloadRoot);
      const entries = await copyInventory(inventory, payloadRoot, this.#fileCopier);
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
      await verifyPayload(payloadRoot, manifest, this.#limits);
      const storedManifest = parseBackupManifest(
        await readFile(resolve(stagingPath, 'manifest.json'), 'utf8'),
      );
      if (backupManifestSha256(storedManifest) !== backupManifestSha256(manifest)) {
        throw new BackupOperationError('integrity-mismatch', 'verify');
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

    let manifest: BackupManifest;
    try {
      manifest = parseBackupManifest(await readFile(resolve(snapshotPath, 'manifest.json'), 'utf8'));
    } catch (error) {
      if (error instanceof BackupOperationError) throw error;
      throw new BackupOperationError('integrity-mismatch', 'verify');
    }
    if (manifest.backupId !== plan.backupId) {
      throw new BackupOperationError('integrity-mismatch', 'verify');
    }
    const payloadRoot = await requirePlainDirectory(resolve(snapshotPath, 'payload'), 'verify');
    await verifyPayload(payloadRoot, manifest, this.#limits);

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
      const inventoryEntries: InventoryEntry[] = manifest.entries.map((entry) => {
        const sourcePath = safeTarget(payloadRoot, entry.path, 'verify');
        return entry.type === 'directory'
          ? { path: entry.path, type: 'directory', sourcePath }
          : {
              path: entry.path,
              type: 'file',
              sourcePath,
              sizeBytes: entry.sizeBytes,
            };
      });
      await copyInventory(
        {
          entries: inventoryEntries,
          totals: manifest.totals,
        },
        partialPath,
        this.#fileCopier,
      );
      await verifyPayload(partialPath, manifest, this.#limits);
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
