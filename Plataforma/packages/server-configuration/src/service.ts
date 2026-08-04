import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';

import {
  configurationRevisionManifestSha256,
  parseConfigurationRevisionManifest,
  serializeConfigurationRevisionManifest,
  type ConfigurationRevisionManifest,
} from './manifest.js';
import {
  diffConfigurationDocuments,
  mutateConfigurationDocument,
  parseConfigurationDocument,
  revisionPayloadFileName,
} from './document.js';
import {
  VOIDFALL_CONFIGURATION_REVISION_FORMAT,
  VOIDFALL_CONFIGURATION_REVISION_SCHEMA_VERSION,
  type ApplyConfigurationPlan,
  type ConfigurationConsistencyLease,
  type ConfigurationFileReplacer,
  type ConfigurationMutationReceipt,
  type ConfigurationOperation,
  ConfigurationOperationError,
  type ConfigurationResourceDefinition,
  type FilesystemConfigurationServiceOptions,
  type RollbackConfigurationPlan,
} from './types.js';
import {
  canonicalTimestamp,
  freezeResourceDefinition,
  validateApplyPlan,
  validateRollbackPlan,
} from './validation.js';

const MAXIMUM_MANIFEST_BYTES = 65_536;

interface RepositoryLayout {
  readonly root: string;
  readonly stagingRoot: string;
  readonly revisionsRoot: string;
  readonly resourceRevisionsRoot: string;
  readonly locksRoot: string;
}

interface ReadPlainFile {
  readonly content: Uint8Array;
  readonly mode: number;
  readonly canonicalPath: string;
}

interface MutationMaterial {
  readonly operation: ConfigurationOperation;
  readonly intendedContent: Uint8Array;
  readonly changedFields: readonly string[];
  readonly restartRequired: boolean;
  readonly restoredFromRevisionId: string | null;
}

interface CommonMutationPlan {
  readonly resourceId: string;
  readonly revisionId: string;
  readonly expectedCurrentSha256: string;
  readonly reasonCode: string;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function normalizeComparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function samePath(left: string, right: string): boolean {
  return normalizeComparablePath(left) === normalizeComparablePath(right);
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function rejectLinkedPathComponents(
  path: string,
  integrityFailure = false,
): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const remainder = relative(root, absolute);
  let current = root;
  for (const segment of remainder.split(sep).filter((item) => item.length > 0)) {
    current = resolve(current, segment);
    let entry;
    try {
      entry = await lstat(current);
    } catch {
      throw new ConfigurationOperationError(
        integrityFailure ? 'revision-integrity-mismatch' : 'unsafe-path',
        integrityFailure ? 'verify' : 'preflight',
      );
    }
    if (entry.isSymbolicLink()) {
      throw new ConfigurationOperationError(
        integrityFailure ? 'revision-integrity-mismatch' : 'unsafe-path',
        integrityFailure ? 'verify' : 'preflight',
      );
    }
  }
}

async function requirePlainDirectory(path: string): Promise<string> {
  try {
    await rejectLinkedPathComponents(path);
    const before = await lstat(path);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new ConfigurationOperationError('unsafe-path', 'preflight');
    }
    const canonical = await realpath(path);
    return canonical;
  } catch (error) {
    if (error instanceof ConfigurationOperationError) throw error;
    throw new ConfigurationOperationError('unsafe-path', 'preflight');
  }
}

async function readBoundedPlainFile(
  path: string,
  maximumBytes: number,
  integrityFailure = false,
): Promise<ReadPlainFile> {
  let handle: FileHandle | undefined;
  try {
    await rejectLinkedPathComponents(path, integrityFailure);
    const before = await lstat(path);
    if (before.isSymbolicLink()) {
      throw new ConfigurationOperationError(
        integrityFailure ? 'revision-integrity-mismatch' : 'unsafe-path',
        integrityFailure ? 'verify' : 'preflight',
      );
    }
    if (!before.isFile() || before.nlink !== 1) {
      throw new ConfigurationOperationError(
        integrityFailure ? 'revision-integrity-mismatch' : 'unsupported-entry',
        integrityFailure ? 'verify' : 'preflight',
      );
    }
    if (before.size > maximumBytes) {
      throw new ConfigurationOperationError(
        integrityFailure ? 'revision-integrity-mismatch' : 'content-too-large',
        integrityFailure ? 'verify' : 'preflight',
      );
    }
    const canonicalPath = await realpath(path);
    handle = await open(path, constants.O_RDONLY);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new ConfigurationOperationError(
        integrityFailure ? 'revision-integrity-mismatch' : 'unsafe-path',
        integrityFailure ? 'verify' : 'preflight',
      );
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > maximumBytes) {
      throw new ConfigurationOperationError(
        integrityFailure ? 'revision-integrity-mismatch' : 'content-too-large',
        integrityFailure ? 'verify' : 'preflight',
      );
    }
    const after = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.nlink !== 1 ||
      after.size !== offset
    ) {
      throw new ConfigurationOperationError(
        integrityFailure ? 'revision-integrity-mismatch' : 'concurrent-modification',
        integrityFailure ? 'verify' : 'preflight',
      );
    }
    return Object.freeze({
      content: buffer.subarray(0, offset),
      mode: before.mode & 0o777,
      canonicalPath,
    });
  } catch (error) {
    if (error instanceof ConfigurationOperationError) throw error;
    throw new ConfigurationOperationError(
      integrityFailure ? 'revision-integrity-mismatch' : 'unsafe-path',
      integrityFailure ? 'verify' : 'preflight',
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

class NodeConfigurationFileReplacer implements ConfigurationFileReplacer {
  async replace(input: Parameters<ConfigurationFileReplacer['replace']>[0]): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(input.temporaryPath, 'wx', input.mode);
      await handle.writeFile(input.content);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(input.temporaryPath, input.targetPath);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

async function acquireLock(path: string): Promise<FileHandle> {
  try {
    return await open(path, 'wx', 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new ConfigurationOperationError('concurrent-modification', 'preflight');
    }
    throw new ConfigurationOperationError('unsafe-path', 'preflight');
  }
}

async function releaseLock(handle: FileHandle, path: string): Promise<void> {
  try {
    await handle.close();
    await unlink(path);
  } catch {
    throw new ConfigurationOperationError('cleanup-failed', 'cleanup');
  }
}

async function cleanPartial(path: string, expectedParent: string): Promise<void> {
  if (!isWithin(expectedParent, path) || dirname(path) !== expectedParent) {
    throw new ConfigurationOperationError('cleanup-failed', 'cleanup');
  }
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    throw new ConfigurationOperationError('cleanup-failed', 'cleanup');
  }
}

async function cleanTemporary(path: string, expectedParent: string): Promise<void> {
  if (dirname(path) !== expectedParent) {
    throw new ConfigurationOperationError('cleanup-failed', 'cleanup');
  }
  try {
    await rm(path, { force: true });
  } catch {
    throw new ConfigurationOperationError('cleanup-failed', 'cleanup');
  }
}

async function writeDurableExclusive(
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validateLease(lease: ConfigurationConsistencyLease): Date {
  if (
    lease === null ||
    typeof lease !== 'object' ||
    lease.method !== 'offline-exclusive-v1' ||
    !(lease.acquiredAt instanceof Date) ||
    !Number.isFinite(lease.acquiredAt.getTime())
  ) {
    throw new ConfigurationOperationError('consistency-unavailable', 'guard');
  }
  return lease.acquiredAt;
}

export class FilesystemConfigurationService {
  readonly #repositoryRoot: string;
  readonly #resources: ReadonlyMap<string, ConfigurationResourceDefinition>;
  readonly #guard: FilesystemConfigurationServiceOptions['guard'];
  readonly #clock: () => Date;
  readonly #fileReplacer: ConfigurationFileReplacer;
  readonly #recoveryReplacer = new NodeConfigurationFileReplacer();

  constructor(options: FilesystemConfigurationServiceOptions) {
    if (
      options === null ||
      typeof options !== 'object' ||
      typeof options.repositoryRoot !== 'string' ||
      !isAbsolute(options.repositoryRoot) ||
      options.repositoryRoot.includes('\u0000') ||
      !Array.isArray(options.resources) ||
      options.resources.length === 0 ||
      options.resources.length > 256 ||
      options.guard === undefined ||
      typeof options.guard.runWithExclusiveOfflineAccess !== 'function' ||
      (options.fileReplacer !== undefined &&
        typeof options.fileReplacer.replace !== 'function')
    ) {
      throw new ConfigurationOperationError('invalid-definition', 'definition');
    }
    const resources = new Map<string, ConfigurationResourceDefinition>();
    const paths = new Set<string>();
    for (const input of options.resources) {
      const resource = freezeResourceDefinition(input);
      const comparablePath = normalizeComparablePath(resource.filePath);
      if (resources.has(resource.resourceId) || paths.has(comparablePath)) {
        throw new ConfigurationOperationError('invalid-definition', 'definition');
      }
      resources.set(resource.resourceId, resource);
      paths.add(comparablePath);
    }
    this.#repositoryRoot = options.repositoryRoot;
    this.#resources = resources;
    this.#guard = options.guard;
    this.#clock = options.clock ?? (() => new Date());
    this.#fileReplacer = options.fileReplacer ?? new NodeConfigurationFileReplacer();
  }

  async applyConfiguration(
    inputPlan: ApplyConfigurationPlan,
  ): Promise<ConfigurationMutationReceipt> {
    const plan = validateApplyPlan(inputPlan);
    const resource = this.#resource(plan.resourceId);
    return this.#withGuard(resource, (createdAt) =>
      this.#mutate(resource, plan, createdAt, async (currentContent) => {
        const current = parseConfigurationDocument(currentContent, resource);
        const mutation = mutateConfigurationDocument(current, resource, plan.changes);
        return Object.freeze({
          operation: 'update' as const,
          intendedContent: mutation.content,
          changedFields: mutation.changedFields,
          restartRequired: mutation.restartRequired,
          restoredFromRevisionId: null,
        });
      }),
    );
  }

  async rollbackConfiguration(
    inputPlan: RollbackConfigurationPlan,
  ): Promise<ConfigurationMutationReceipt> {
    const plan = validateRollbackPlan(inputPlan);
    const resource = this.#resource(plan.resourceId);
    return this.#withGuard(resource, (createdAt) =>
      this.#mutate(resource, plan, createdAt, async (currentContent, layout) => {
        const source = await this.#readRevision(
          layout,
          resource,
          plan.sourceRevisionId,
        );
        const current = parseConfigurationDocument(currentContent, resource);
        const restored = parseConfigurationDocument(source.content, resource);
        const changedFields = diffConfigurationDocuments(current, restored, resource);
        return Object.freeze({
          operation: 'rollback' as const,
          intendedContent: source.content,
          changedFields,
          restartRequired: changedFields.some(
            (fieldName) => resource.fields[fieldName]?.restartRequired === true,
          ),
          restoredFromRevisionId: plan.sourceRevisionId,
        });
      }),
    );
  }

  #resource(resourceId: string): ConfigurationResourceDefinition {
    const resource = this.#resources.get(resourceId);
    if (resource === undefined) {
      throw new ConfigurationOperationError('resource-not-found', 'plan');
    }
    return resource;
  }

  async #withGuard<T>(
    resource: ConfigurationResourceDefinition,
    operation: (createdAt: string) => Promise<T>,
  ): Promise<T> {
    let invoked = false;
    try {
      const result = await this.#guard.runWithExclusiveOfflineAccess(
        resource.resourceId,
        async (lease) => {
          if (invoked) {
            throw new ConfigurationOperationError('consistency-unavailable', 'guard');
          }
          invoked = true;
          const acquiredAt = validateLease(lease);
          const now = canonicalTimestamp(this.#clock);
          if (acquiredAt.getTime() > new Date(now).getTime()) {
            throw new ConfigurationOperationError('consistency-unavailable', 'guard');
          }
          return operation(now);
        },
      );
      if (!invoked) {
        throw new ConfigurationOperationError('consistency-unavailable', 'guard');
      }
      return result;
    } catch (error) {
      if (error instanceof ConfigurationOperationError) throw error;
      throw new ConfigurationOperationError('consistency-unavailable', 'guard');
    }
  }

  async #prepareLayout(resource: ConfigurationResourceDefinition): Promise<RepositoryLayout> {
    const root = await requirePlainDirectory(this.#repositoryRoot);
    const target = await readBoundedPlainFile(resource.filePath, resource.maximumBytes);
    const targetParent = dirname(target.canonicalPath);
    if (
      isWithin(root, target.canonicalPath) ||
      samePath(root, targetParent) ||
      isWithin(targetParent, root)
    ) {
      throw new ConfigurationOperationError('unsafe-path', 'preflight');
    }
    const stagingRoot = resolve(root, 'staging');
    const revisionsRoot = resolve(root, 'revisions');
    const locksRoot = resolve(root, 'locks');
    const resourceRevisionsRoot = resolve(revisionsRoot, resource.resourceId);
    try {
      await mkdir(stagingRoot, { recursive: true });
      await mkdir(resourceRevisionsRoot, { recursive: true });
      await mkdir(locksRoot, { recursive: true });
    } catch {
      throw new ConfigurationOperationError('unsafe-path', 'preflight');
    }
    const [canonicalStaging, canonicalRevisions, canonicalResourceRevisions, canonicalLocks] =
      await Promise.all([
        requirePlainDirectory(stagingRoot),
        requirePlainDirectory(revisionsRoot),
        requirePlainDirectory(resourceRevisionsRoot),
        requirePlainDirectory(locksRoot),
      ]);
    const [stagingStat, resourceRevisionStat] = await Promise.all([
      lstat(canonicalStaging),
      lstat(canonicalResourceRevisions),
    ]);
    if (stagingStat.dev !== resourceRevisionStat.dev) {
      throw new ConfigurationOperationError('unsafe-path', 'preflight');
    }
    return Object.freeze({
      root,
      stagingRoot: canonicalStaging,
      revisionsRoot: canonicalRevisions,
      resourceRevisionsRoot: canonicalResourceRevisions,
      locksRoot: canonicalLocks,
    });
  }

  async #mutate(
    resource: ConfigurationResourceDefinition,
    plan: CommonMutationPlan,
    createdAt: string,
    createMaterial: (
      currentContent: Uint8Array,
      layout: RepositoryLayout,
    ) => Promise<MutationMaterial>,
  ): Promise<ConfigurationMutationReceipt> {
    const layout = await this.#prepareLayout(resource);
    const lockPath = resolve(layout.locksRoot, `${resource.resourceId}.lock`);
    if (!isWithin(layout.locksRoot, lockPath)) {
      throw new ConfigurationOperationError('unsafe-path', 'preflight');
    }
    const lock = await acquireLock(lockPath);
    let primaryError: unknown;
    let receipt: ConfigurationMutationReceipt | undefined;
    let stagingCreated = false;
    let revisionPublished = false;
    let temporaryReserved = false;
    let recoveryReserved = false;
    const stagingPath = resolve(layout.stagingRoot, `${plan.revisionId}.partial`);
    const revisionPath = resolve(layout.resourceRevisionsRoot, plan.revisionId);
    const targetParent = dirname(resource.filePath);
    const temporaryPath = resolve(
      targetParent,
      `.${basename(resource.filePath)}.voidfall-${plan.revisionId}.partial`,
    );
    const recoveryPath = resolve(
      targetParent,
      `.${basename(resource.filePath)}.voidfall-${plan.revisionId}.recovery.partial`,
    );
    try {
      if (
        !isWithin(layout.stagingRoot, stagingPath) ||
        !isWithin(layout.resourceRevisionsRoot, revisionPath) ||
        dirname(temporaryPath) !== targetParent ||
        dirname(recoveryPath) !== targetParent ||
        (await pathExists(stagingPath)) ||
        (await pathExists(revisionPath))
      ) {
        throw new ConfigurationOperationError('revision-conflict', 'preflight');
      }
      if ((await pathExists(temporaryPath)) || (await pathExists(recoveryPath))) {
        throw new ConfigurationOperationError('concurrent-modification', 'preflight');
      }
      temporaryReserved = true;
      recoveryReserved = true;
      const current = await readBoundedPlainFile(resource.filePath, resource.maximumBytes);
      const previousSha256 = sha256(current.content);
      if (previousSha256 !== plan.expectedCurrentSha256) {
        throw new ConfigurationOperationError('concurrent-modification', 'preflight');
      }
      parseConfigurationDocument(current.content, resource);
      const material = await createMaterial(current.content, layout);
      if (material.intendedContent.byteLength > resource.maximumBytes) {
        throw new ConfigurationOperationError('content-too-large', 'preflight');
      }
      parseConfigurationDocument(material.intendedContent, resource);
      const intendedSha256 = sha256(material.intendedContent);
      if (intendedSha256 === previousSha256) {
        throw new ConfigurationOperationError('no-change', 'preflight');
      }
      const manifest: ConfigurationRevisionManifest = Object.freeze({
        format: VOIDFALL_CONFIGURATION_REVISION_FORMAT,
        manifestSchemaVersion: VOIDFALL_CONFIGURATION_REVISION_SCHEMA_VERSION,
        revisionId: plan.revisionId,
        resourceId: resource.resourceId,
        resourceSchemaId: resource.schemaId,
        resourceSchemaVersion: resource.schemaVersion,
        resourceSchemaSha256: resource.schemaSha256,
        configurationFormat: resource.format,
        createdAt,
        reasonCode: plan.reasonCode,
        operation: material.operation,
        restoredFromRevisionId: material.restoredFromRevisionId,
        previousSizeBytes: current.content.byteLength,
        previousSha256,
        intendedSha256,
        changedFields: material.changedFields,
        restartRequired: material.restartRequired,
      });
      await mkdir(stagingPath);
      stagingCreated = true;
      await writeDurableExclusive(
        resolve(stagingPath, revisionPayloadFileName(resource)),
        current.content,
      );
      await writeDurableExclusive(
        resolve(stagingPath, 'manifest.json'),
        serializeConfigurationRevisionManifest(manifest),
      );
      await this.#verifyRevisionDirectory(stagingPath, resource, manifest);
      try {
        await rename(stagingPath, revisionPath);
      } catch {
        throw new ConfigurationOperationError('revision-conflict', 'revision');
      }
      revisionPublished = true;
      await this.#replaceWithRecovery(
        resource,
        current,
        material.intendedContent,
        intendedSha256,
        temporaryPath,
        recoveryPath,
      );
      receipt = Object.freeze({
        operation: material.operation,
        revisionId: plan.revisionId,
        resourceId: resource.resourceId,
        createdAt,
        previousSha256,
        currentSha256: intendedSha256,
        manifestSha256: configurationRevisionManifestSha256(manifest),
        changedFields: Object.freeze([...material.changedFields]),
        restartRequired: material.restartRequired,
        ...(material.restoredFromRevisionId === null
          ? {}
          : { restoredFromRevisionId: material.restoredFromRevisionId }),
      });
    } catch (error) {
      primaryError =
        error instanceof ConfigurationOperationError
          ? error
          : new ConfigurationOperationError('replacement-failed', 'replace');
    } finally {
      if (stagingCreated && !revisionPublished) {
        try {
          await cleanPartial(stagingPath, layout.stagingRoot);
        } catch (cleanupError) {
          primaryError = cleanupError;
        }
      }
      if (temporaryReserved) {
        try {
          await cleanTemporary(temporaryPath, targetParent);
        } catch (cleanupError) {
          primaryError = cleanupError;
        }
      }
      if (recoveryReserved) {
        try {
          await cleanTemporary(recoveryPath, targetParent);
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
    if (primaryError !== undefined) throw primaryError;
    if (receipt === undefined) {
      throw new ConfigurationOperationError('replacement-failed', 'replace');
    }
    return receipt;
  }

  async #replaceWithRecovery(
    resource: ConfigurationResourceDefinition,
    previous: ReadPlainFile,
    intendedContent: Uint8Array,
    intendedSha256: string,
    temporaryPath: string,
    recoveryPath: string,
  ): Promise<void> {
    let replacementFailed = false;
    try {
      await this.#fileReplacer.replace({
        targetPath: resource.filePath,
        temporaryPath,
        content: intendedContent,
        mode: previous.mode,
      });
    } catch {
      replacementFailed = true;
    }
    if (!replacementFailed) {
      try {
        const applied = await readBoundedPlainFile(resource.filePath, resource.maximumBytes);
        if (sha256(applied.content) === intendedSha256) {
          parseConfigurationDocument(applied.content, resource);
          return;
        }
      } catch {
        // Recovery below restores the exact prior bytes before reporting failure.
      }
    }
    let stillPrevious = false;
    try {
      const current = await readBoundedPlainFile(resource.filePath, resource.maximumBytes);
      stillPrevious = sha256(current.content) === sha256(previous.content);
    } catch {
      stillPrevious = false;
    }
    if (!stillPrevious) {
      try {
        await this.#recoveryReplacer.replace({
          targetPath: resource.filePath,
          temporaryPath: recoveryPath,
          content: previous.content,
          mode: previous.mode,
        });
        const recovered = await readBoundedPlainFile(resource.filePath, resource.maximumBytes);
        if (sha256(recovered.content) !== sha256(previous.content)) {
          throw new Error('recovery hash mismatch');
        }
      } catch {
        throw new ConfigurationOperationError('recovery-failed', 'verify');
      }
    }
    throw new ConfigurationOperationError(
      replacementFailed ? 'replacement-failed' : 'verification-failed',
      replacementFailed ? 'replace' : 'verify',
    );
  }

  async #verifyRevisionDirectory(
    revisionPath: string,
    resource: ConfigurationResourceDefinition,
    expected?: ConfigurationRevisionManifest,
  ): Promise<{ readonly manifest: ConfigurationRevisionManifest; readonly content: Uint8Array }> {
    const canonical = await requirePlainDirectory(revisionPath);
    let entries: string[];
    try {
      entries = (await readdir(canonical)).sort();
    } catch {
      throw new ConfigurationOperationError('revision-integrity-mismatch', 'verify');
    }
    if (
      entries.length !== 2 ||
      entries[0] !== 'manifest.json' ||
      entries[1] !== revisionPayloadFileName(resource)
    ) {
      throw new ConfigurationOperationError('revision-integrity-mismatch', 'verify');
    }
    const manifestFile = await readBoundedPlainFile(
      resolve(canonical, 'manifest.json'),
      MAXIMUM_MANIFEST_BYTES,
      true,
    );
    let serialized: string;
    try {
      serialized = new TextDecoder('utf-8', { fatal: true }).decode(manifestFile.content);
    } catch {
      throw new ConfigurationOperationError('revision-integrity-mismatch', 'verify');
    }
    const manifest = parseConfigurationRevisionManifest(serialized);
    const content = await readBoundedPlainFile(
      resolve(canonical, revisionPayloadFileName(resource)),
      resource.maximumBytes,
      true,
    );
    if (
      manifest.resourceId !== resource.resourceId ||
      manifest.resourceSchemaId !== resource.schemaId ||
      manifest.resourceSchemaVersion !== resource.schemaVersion ||
      manifest.resourceSchemaSha256 !== resource.schemaSha256 ||
      manifest.configurationFormat !== resource.format
    ) {
      throw new ConfigurationOperationError('schema-mismatch', 'verify');
    }
    if (
      manifest.previousSizeBytes !== content.content.byteLength ||
      manifest.previousSha256 !== sha256(content.content) ||
      (expected !== undefined &&
        configurationRevisionManifestSha256(manifest) !==
          configurationRevisionManifestSha256(expected))
    ) {
      throw new ConfigurationOperationError('revision-integrity-mismatch', 'verify');
    }
    parseConfigurationDocument(content.content, resource);
    return Object.freeze({ manifest, content: content.content });
  }

  async #readRevision(
    layout: RepositoryLayout,
    resource: ConfigurationResourceDefinition,
    revisionId: string,
  ): Promise<{ readonly manifest: ConfigurationRevisionManifest; readonly content: Uint8Array }> {
    const revisionPath = resolve(layout.resourceRevisionsRoot, revisionId);
    if (!isWithin(layout.resourceRevisionsRoot, revisionPath) || !(await pathExists(revisionPath))) {
      throw new ConfigurationOperationError('revision-integrity-mismatch', 'verify');
    }
    const revision = await this.#verifyRevisionDirectory(revisionPath, resource);
    if (revision.manifest.revisionId !== revisionId) {
      throw new ConfigurationOperationError('revision-integrity-mismatch', 'verify');
    }
    return revision;
  }
}
