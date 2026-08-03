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
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

import {
  AuthorizedFileOperationError,
  type AuthorizedDirectorySnapshot,
  type AuthorizedFileRevisionManifest,
  type AuthorizedFileRootDefinition,
  type AuthorizedFileServiceOptions,
  type AuthorizedFileSnapshot,
  type ListAuthorizedDirectoryPlan,
  type ReadAuthorizedFilePlan,
  type ReplaceAuthorizedFilePlan,
  type ReplaceAuthorizedFileReceipt,
} from './types.js';

const IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const EXTENSION = /^\.[a-z0-9][a-z0-9._-]{0,15}$/u;
const MAXIMUM_CONFIGURED_BYTES = 16 * 1_024 * 1_024;
const MAXIMUM_DIRECTORY_ENTRIES = 10_000;

interface FrozenRootDefinition extends AuthorizedFileRootDefinition {
  readonly readableExtensionSet: ReadonlySet<string>;
  readonly writableExtensionSet: ReadonlySet<string>;
}

interface PlainFile {
  readonly bytes: Buffer;
  readonly mode: number;
}

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

function normalizeFilesystemPath(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return result === '' || (!result.startsWith('..') && !isAbsolute(result));
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validateRelativePath(value: unknown, allowRoot: boolean): value is string {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\u0000')) return false;
  if (allowRoot && value === '') return true;
  if (value.length < 1 || value.length > 1_024 || value !== value.normalize('NFC')) return false;
  const segments = value.split('/');
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      segment.length <= 255 &&
      !/[\u0000-\u001f\u007f:]/u.test(segment),
  );
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
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

function freezeDeep<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
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

async function requireCanonicalDirectory(root: string, path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
    }
    const canonical = await realpath(path);
    if (
      !isWithin(root, canonical) ||
      normalizeFilesystemPath(canonical) !== normalizeFilesystemPath(path)
    ) {
      throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
    }
  } catch (error) {
    if (error instanceof AuthorizedFileOperationError) throw error;
    throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
  }
}

async function rejectLinkedComponents(root: string, target: string): Promise<void> {
  const relativePath = relative(root, target);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
  }
  let current = root;
  for (const segment of relativePath.split(sep).filter((item) => item.length > 0)) {
    current = join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
    }
  }
}

async function readPlainFile(path: string, maximumBytes: number): Promise<PlainFile> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(path);
    if (before.isSymbolicLink()) {
      throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
    }
    if (!before.isFile() || before.nlink !== 1) {
      throw new AuthorizedFileOperationError('unsupported-entry', 'preflight');
    }
    if (before.size > maximumBytes) {
      throw new AuthorizedFileOperationError('content-too-large', 'read');
    }
    handle = await open(path, constants.O_RDONLY);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > maximumBytes) {
      throw new AuthorizedFileOperationError('content-too-large', 'read');
    }
    const after = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.nlink !== 1 ||
      after.size !== offset
    ) {
      throw new AuthorizedFileOperationError('concurrent-modification', 'read');
    }
    return Object.freeze({ bytes: buffer.subarray(0, offset), mode: before.mode & 0o777 });
  } catch (error) {
    if (error instanceof AuthorizedFileOperationError) throw error;
    throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function decodeText(bytes: Uint8Array): string {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (value.includes('\u0000')) throw new Error('NUL is not allowed');
    return value;
  } catch {
    throw new AuthorizedFileOperationError('invalid-text-content', 'read');
  }
}

async function writeExclusive(path: string, bytes: Uint8Array, mode: number): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'wx', mode);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function freezeExtensionList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new AuthorizedFileOperationError('invalid-definition', 'definition');
  }
  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !EXTENSION.test(item) || unique.has(item)) {
      throw new AuthorizedFileOperationError('invalid-definition', 'definition');
    }
    unique.add(item);
  }
  return Object.freeze([...unique].sort(compareOrdinal));
}

function freezeRoot(input: AuthorizedFileRootDefinition): FrozenRootDefinition {
  if (
    !isRecord(input) ||
    !exactKeys(input, [
      'rootId',
      'rootPath',
      'readableExtensions',
      'writableExtensions',
      'maximumFileBytes',
    ]) ||
    typeof input.rootId !== 'string' ||
    !IDENTIFIER.test(input.rootId) ||
    typeof input.rootPath !== 'string' ||
    !isAbsolute(input.rootPath) ||
    input.rootPath.includes('\u0000') ||
    dirname(resolve(input.rootPath)) === resolve(input.rootPath) ||
    !Number.isSafeInteger(input.maximumFileBytes) ||
    input.maximumFileBytes < 1 ||
    input.maximumFileBytes > MAXIMUM_CONFIGURED_BYTES
  ) {
    throw new AuthorizedFileOperationError('invalid-definition', 'definition');
  }
  const readableExtensions = freezeExtensionList(input.readableExtensions);
  const writableExtensions = freezeExtensionList(input.writableExtensions);
  if (writableExtensions.some((extension) => !readableExtensions.includes(extension))) {
    throw new AuthorizedFileOperationError('invalid-definition', 'definition');
  }
  return Object.freeze({
    rootId: input.rootId,
    rootPath: resolve(input.rootPath),
    readableExtensions,
    writableExtensions,
    maximumFileBytes: input.maximumFileBytes,
    readableExtensionSet: new Set(readableExtensions),
    writableExtensionSet: new Set(writableExtensions),
  });
}

export class AuthorizedFileService {
  readonly #revisionRoot: string;
  readonly #roots: ReadonlyMap<string, FrozenRootDefinition>;
  readonly #activeMutations = new Set<string>();

  public constructor(options: AuthorizedFileServiceOptions) {
    if (
      !isRecord(options) ||
      !exactKeys(options, ['revisionRoot', 'roots']) ||
      typeof options.revisionRoot !== 'string' ||
      !isAbsolute(options.revisionRoot) ||
      options.revisionRoot.includes('\u0000') ||
      dirname(resolve(options.revisionRoot)) === resolve(options.revisionRoot) ||
      !Array.isArray(options.roots) ||
      options.roots.length === 0 ||
      options.roots.length > 128
    ) {
      throw new AuthorizedFileOperationError('invalid-definition', 'definition');
    }
    const roots = new Map<string, FrozenRootDefinition>();
    for (const input of options.roots) {
      const root = freezeRoot(input);
      if (roots.has(root.rootId)) {
        throw new AuthorizedFileOperationError('invalid-definition', 'definition');
      }
      roots.set(root.rootId, root);
    }
    const revisionRoot = resolve(options.revisionRoot);
    const rootValues = [...roots.values()];
    for (let index = 0; index < rootValues.length; index += 1) {
      const current = rootValues[index];
      if (current === undefined || pathsOverlap(current.rootPath, revisionRoot)) {
        throw new AuthorizedFileOperationError('invalid-definition', 'definition');
      }
      for (let otherIndex = index + 1; otherIndex < rootValues.length; otherIndex += 1) {
        const other = rootValues[otherIndex];
        if (other !== undefined && pathsOverlap(current.rootPath, other.rootPath)) {
          throw new AuthorizedFileOperationError('invalid-definition', 'definition');
        }
      }
    }
    this.#revisionRoot = revisionRoot;
    this.#roots = roots;
  }

  #root(rootId: unknown): FrozenRootDefinition {
    if (typeof rootId !== 'string' || !IDENTIFIER.test(rootId)) {
      throw new AuthorizedFileOperationError('invalid-plan', 'plan');
    }
    const root = this.#roots.get(rootId);
    if (root === undefined) throw new AuthorizedFileOperationError('unknown-root', 'plan');
    return root;
  }

  async #target(
    root: FrozenRootDefinition,
    relativePath: string,
    directory: boolean,
  ): Promise<string> {
    const target = relativePath === '' ? root.rootPath : resolve(root.rootPath, ...relativePath.split('/'));
    if (!isWithin(root.rootPath, target)) {
      throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
    }
    await requireCanonicalDirectory(root.rootPath, root.rootPath);
    if (directory) {
      await requireCanonicalDirectory(root.rootPath, target);
    } else {
      await rejectLinkedComponents(root.rootPath, target);
      const canonical = await realpath(target).catch(() => {
        throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
      });
      if (
        !isWithin(root.rootPath, canonical) ||
        normalizeFilesystemPath(canonical) !== normalizeFilesystemPath(target)
      ) {
        throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
      }
    }
    return target;
  }

  public async list(input: ListAuthorizedDirectoryPlan): Promise<AuthorizedDirectorySnapshot> {
    if (
      !isRecord(input) ||
      !exactKeys(input, ['rootId', 'directoryPath', 'maximumEntries']) ||
      !validateRelativePath(input.directoryPath, true) ||
      !Number.isSafeInteger(input.maximumEntries) ||
      input.maximumEntries < 1 ||
      input.maximumEntries > MAXIMUM_DIRECTORY_ENTRIES
    ) {
      throw new AuthorizedFileOperationError('invalid-plan', 'plan');
    }
    const root = this.#root(input.rootId);
    const directoryPath = await this.#target(root, input.directoryPath, true);
    const entries = await readdir(directoryPath, { withFileTypes: true });
    if (entries.length > input.maximumEntries) {
      throw new AuthorizedFileOperationError('entry-limit-exceeded', 'read');
    }
    const result = [];
    for (const entry of entries.sort((left, right) => compareOrdinal(left.name, right.name))) {
      if (entry.isSymbolicLink()) {
        throw new AuthorizedFileOperationError('unsupported-entry', 'read');
      }
      const childPath = join(directoryPath, entry.name);
      const childRelative = input.directoryPath === '' ? entry.name : `${input.directoryPath}/${entry.name}`;
      if (entry.isDirectory()) {
        result.push({ name: entry.name, path: childRelative, type: 'directory' as const });
      } else if (entry.isFile()) {
        const extension = extname(entry.name).toLocaleLowerCase('en-US');
        if (!root.readableExtensionSet.has(extension)) continue;
        const stat = await lstat(childPath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
          throw new AuthorizedFileOperationError('unsupported-entry', 'read');
        }
        result.push({
          name: entry.name,
          path: childRelative,
          type: 'file' as const,
          sizeBytes: stat.size,
        });
      } else {
        throw new AuthorizedFileOperationError('unsupported-entry', 'read');
      }
    }
    return freezeDeep({ rootId: root.rootId, directoryPath: input.directoryPath, entries: result });
  }

  public async read(input: ReadAuthorizedFilePlan): Promise<AuthorizedFileSnapshot> {
    if (
      !isRecord(input) ||
      !exactKeys(input, ['rootId', 'filePath']) ||
      !validateRelativePath(input.filePath, false)
    ) {
      throw new AuthorizedFileOperationError('invalid-plan', 'plan');
    }
    const root = this.#root(input.rootId);
    const extension = extname(input.filePath).toLocaleLowerCase('en-US');
    if (!root.readableExtensionSet.has(extension)) {
      throw new AuthorizedFileOperationError('unsupported-extension', 'plan');
    }
    const target = await this.#target(root, input.filePath, false);
    const file = await readPlainFile(target, root.maximumFileBytes);
    return freezeDeep({
      rootId: root.rootId,
      filePath: input.filePath,
      filename: basename(target),
      sizeBytes: file.bytes.byteLength,
      sha256: sha256(file.bytes),
      content: decodeText(file.bytes),
    });
  }

  async #prepareRevisionLayout(rootId: string): Promise<{
    readonly stagingRoot: string;
    readonly revisionsForRoot: string;
  }> {
    const parent = dirname(this.#revisionRoot);
    await requireCanonicalDirectory(parent, parent);
    if (!(await pathExists(this.#revisionRoot))) {
      await mkdir(this.#revisionRoot, { recursive: false, mode: 0o700 });
    }
    await requireCanonicalDirectory(this.#revisionRoot, this.#revisionRoot);
    const stagingRoot = join(this.#revisionRoot, 'staging');
    const revisionsRoot = join(this.#revisionRoot, 'revisions');
    const revisionsForRoot = join(revisionsRoot, rootId);
    for (const directory of [stagingRoot, revisionsRoot, revisionsForRoot]) {
      if (!(await pathExists(directory))) await mkdir(directory, { recursive: false, mode: 0o700 });
      await requireCanonicalDirectory(this.#revisionRoot, directory);
    }
    return { stagingRoot, revisionsForRoot };
  }

  public async replace(input: ReplaceAuthorizedFilePlan): Promise<ReplaceAuthorizedFileReceipt> {
    if (
      !isRecord(input) ||
      !exactKeys(input, [
        'rootId',
        'filePath',
        'revisionId',
        'actorId',
        'reasonCode',
        'changedAt',
        'expectedSha256',
        'content',
      ]) ||
      !validateRelativePath(input.filePath, false) ||
      typeof input.revisionId !== 'string' ||
      !IDENTIFIER.test(input.revisionId) ||
      typeof input.actorId !== 'string' ||
      !UUID.test(input.actorId) ||
      typeof input.reasonCode !== 'string' ||
      !IDENTIFIER.test(input.reasonCode) ||
      !canonicalTimestamp(input.changedAt) ||
      typeof input.expectedSha256 !== 'string' ||
      !SHA256.test(input.expectedSha256) ||
      typeof input.content !== 'string' ||
      input.content.includes('\u0000') ||
      Buffer.from(input.content, 'utf8').toString('utf8') !== input.content
    ) {
      throw new AuthorizedFileOperationError('invalid-plan', 'plan');
    }
    const root = this.#root(input.rootId);
    const extension = extname(input.filePath).toLocaleLowerCase('en-US');
    if (!root.writableExtensionSet.has(extension)) {
      throw new AuthorizedFileOperationError('unsupported-extension', 'plan');
    }
    const content = Buffer.from(input.content, 'utf8');
    if (content.byteLength > root.maximumFileBytes) {
      throw new AuthorizedFileOperationError('content-too-large', 'plan');
    }
    const mutationKey = `${root.rootId}\u0000${input.filePath.toLocaleLowerCase('en-US')}`;
    if (this.#activeMutations.has(mutationKey)) {
      throw new AuthorizedFileOperationError('operation-in-progress', 'preflight');
    }
    this.#activeMutations.add(mutationKey);

    let stagingDirectory: string | undefined;
    let temporaryPath: string | undefined;
    let recoveryPath: string | undefined;
    let revisionPublished = false;
    try {
      const target = await this.#target(root, input.filePath, false);
      const previous = await readPlainFile(target, root.maximumFileBytes);
      const previousSha256 = sha256(previous.bytes);
      if (previousSha256 !== input.expectedSha256) {
        throw new AuthorizedFileOperationError('concurrent-modification', 'preflight');
      }
      const currentSha256 = sha256(content);
      if (currentSha256 === previousSha256) {
        throw new AuthorizedFileOperationError('no-change', 'plan');
      }

      const layout = await this.#prepareRevisionLayout(root.rootId);
      stagingDirectory = join(layout.stagingRoot, `${root.rootId}-${input.revisionId}`);
      const revisionDirectory = join(layout.revisionsForRoot, input.revisionId);
      if ((await pathExists(stagingDirectory)) || (await pathExists(revisionDirectory))) {
        throw new AuthorizedFileOperationError('revision-conflict', 'revision');
      }
      await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
      const manifest: AuthorizedFileRevisionManifest = {
        format: 'voidfall-authorized-file-revision',
        schemaVersion: 1,
        revisionId: input.revisionId,
        rootId: root.rootId,
        filePath: input.filePath,
        actorId: input.actorId,
        reasonCode: input.reasonCode,
        changedAt: input.changedAt,
        state: 'prepared-before-replacement',
        previousSha256,
        intendedSha256: currentSha256,
        previousSizeBytes: previous.bytes.byteLength,
        intendedSizeBytes: content.byteLength,
        previousPayload: 'previous.bin',
      };
      const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
      const manifestSha256 = sha256(manifestBytes);
      await writeExclusive(join(stagingDirectory, 'previous.bin'), previous.bytes, 0o600);
      await writeExclusive(join(stagingDirectory, 'manifest.json'), manifestBytes, 0o600);

      const parent = dirname(target);
      await requireCanonicalDirectory(root.rootPath, parent);
      temporaryPath = join(parent, `.${basename(target)}.${input.revisionId}.voidfall.tmp`);
      recoveryPath = join(parent, `.${basename(target)}.${input.revisionId}.voidfall.recovery`);
      if ((await pathExists(temporaryPath)) || (await pathExists(recoveryPath))) {
        throw new AuthorizedFileOperationError('unsafe-path', 'replace');
      }
      await writeExclusive(temporaryPath, content, previous.mode);
      const beforeReplace = await readPlainFile(target, root.maximumFileBytes);
      if (sha256(beforeReplace.bytes) !== previousSha256) {
        throw new AuthorizedFileOperationError('concurrent-modification', 'replace');
      }
      await rename(stagingDirectory, revisionDirectory);
      revisionPublished = true;

      try {
        await rename(temporaryPath, target);
        temporaryPath = undefined;
        const applied = await readPlainFile(target, root.maximumFileBytes);
        if (sha256(applied.bytes) !== currentSha256 || decodeText(applied.bytes) !== input.content) {
          throw new AuthorizedFileOperationError('verification-failed', 'verify');
        }
      } catch (error) {
        let restored = false;
        try {
          const current = await readPlainFile(target, root.maximumFileBytes);
          if (sha256(current.bytes) === previousSha256) {
            restored = true;
          } else {
            await writeExclusive(recoveryPath, previous.bytes, previous.mode);
            await rename(recoveryPath, target);
            recoveryPath = undefined;
            const recovered = await readPlainFile(target, root.maximumFileBytes);
            restored = sha256(recovered.bytes) === previousSha256;
          }
        } catch {
          restored = false;
        }
        if (!restored) throw new AuthorizedFileOperationError('recovery-failed', 'verify');
        if (error instanceof AuthorizedFileOperationError) throw error;
        throw new AuthorizedFileOperationError('replacement-failed', 'replace');
      }

      return freezeDeep({
        revisionId: input.revisionId,
        rootId: root.rootId,
        filePath: input.filePath,
        previousSha256,
        currentSha256,
        manifestSha256,
        revisionReference: `revisions/${root.rootId}/${input.revisionId}`,
      });
    } finally {
      this.#activeMutations.delete(mutationKey);
      if (stagingDirectory !== undefined && !revisionPublished) {
        if (dirname(stagingDirectory) !== join(this.#revisionRoot, 'staging')) {
          throw new AuthorizedFileOperationError('cleanup-failed', 'cleanup');
        }
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {
          throw new AuthorizedFileOperationError('cleanup-failed', 'cleanup');
        });
      }
      for (const candidate of [temporaryPath, recoveryPath]) {
        if (candidate !== undefined) {
          await unlink(candidate).catch((error) => {
            if (!isNodeError(error) || error.code !== 'ENOENT') {
              throw new AuthorizedFileOperationError('cleanup-failed', 'cleanup');
            }
          });
        }
      }
    }
  }
}
