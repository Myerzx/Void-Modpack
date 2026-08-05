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
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

import { diffText, type TextDiff } from './text-diff.js';
import {
  AuthorizedFileOperationError,
  type AuthorizedDirectorySnapshot,
  type AuthorizedFileMutationReceipt,
  type AuthorizedFileRevisionManifest,
  type AuthorizedFileRootDefinition,
  type AuthorizedFileServiceOptions,
  type AuthorizedFileSnapshot,
  type CopyAuthorizedFilePlan,
  type CreateAuthorizedFilePlan,
  type DeleteAuthorizedFilePlan,
  type DiffAuthorizedFilePlan,
  type ListAuthorizedDirectoryPlan,
  type MoveAuthorizedFilePlan,
  type ReadAuthorizedFilePlan,
  type ReplaceAuthorizedFilePlan,
  type ReplaceAuthorizedFileReceipt,
  type RestoreAuthorizedFilePlan,
} from './types.js';

export interface AuthorizedFileDiffSnapshot {
  readonly rootId: string;
  readonly filePath: string;
  readonly previousLabel: string;
  readonly currentLabel: string;
  readonly diff: TextDiff;
}

const IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const EXTENSION = /^\.[a-z0-9][a-z0-9._-]{0,15}$/u;
const MAXIMUM_CONFIGURED_BYTES = 16 * 1_024 * 1_024;
const MAXIMUM_DIRECTORY_ENTRIES = 10_000;
/** A manifest is a handful of fields; anything larger is not one. */
const MAXIMUM_MANIFEST_BYTES = 64 * 1_024;

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

function isWithin(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return result === '' || (!result.startsWith('..') && !isAbsolute(result));
}

async function rejectAbsoluteLinkedComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const filesystemRoot = parse(absolute).root;
  let current = filesystemRoot;
  for (const segment of relative(filesystemRoot, absolute).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
    }
  }
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
    if (!isWithin(root, path)) {
      throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
    }
    await rejectAbsoluteLinkedComponents(path);
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
    }
    const canonical = await realpath(path);
    const canonicalStat = await lstat(canonical);
    if (canonicalStat.dev !== stat.dev || canonicalStat.ino !== stat.ino) {
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
    // A component that cannot be stat'd — most often because it simply is not
    // there — is refused as an unsafe path rather than escaping as a raw
    // filesystem error a caller would have to interpret.
    const stat = await lstat(current).catch(() => {
      throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
    });
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
      const before = await lstat(target).catch(() => {
        throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
      });
      const canonical = await realpath(target).catch(() => {
        throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
      });
      const canonicalStat = await lstat(canonical).catch(() => {
        throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
      });
      if (canonicalStat.dev !== before.dev || canonicalStat.ino !== before.ino) {
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
    // Same key shape the mutation set holds, so a replace and a delete of the
    // same file exclude each other rather than each believing it is alone.
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

  // ---------------------------------------------------------------------------
  // The mutation set.
  //
  // Three rules hold across all four operations and are what make them safe to
  // expose:
  //
  //   1. No mutation ever overwrites. A destination that already exists is a
  //      conflict, never a silent replacement — so no sequence of calls can
  //      destroy a file the caller never named.
  //   2. Every step that loses bytes writes them to an immutable revision
  //      *before* the loss, exactly as `replace` does.
  //   3. A mutation stays inside one root. Crossing roots would let the policy
  //      on a strict root be escaped by moving a file into a permissive one.
  // ---------------------------------------------------------------------------

  /**
   * Resolves a path that must **not** exist yet.
   *
   * `#target` lstats the final entry, so it can only resolve something already
   * there; a destination needs the same guards applied to its parent and then
   * the opposite conclusion about itself.
   */
  async #targetForNew(root: FrozenRootDefinition, relativePath: string): Promise<string> {
    const target = resolve(root.rootPath, ...relativePath.split('/'));
    if (!isWithin(root.rootPath, target)) {
      throw new AuthorizedFileOperationError('unsafe-path', 'preflight');
    }
    await requireCanonicalDirectory(root.rootPath, root.rootPath);
    // The parent must already exist and be a real directory: a mutation never
    // conjures the tree it is writing into.
    const parent = dirname(target);
    await requireCanonicalDirectory(root.rootPath, parent);
    await rejectLinkedComponents(root.rootPath, parent);
    if (await pathExists(target)) {
      throw new AuthorizedFileOperationError('destination-exists', 'preflight');
    }
    return target;
  }

  /**
   * Holds the mutation keys for every path a step touches.
   *
   * Both ends of a move are held, so a concurrent operation cannot be writing
   * the destination while this one is deciding the destination is free.
   */
  #holdPaths(root: FrozenRootDefinition, paths: readonly string[]): () => void {
    const keys = [
      ...new Set(paths.map((path) => `${root.rootId}\u0000${path.toLocaleLowerCase('en-US')}`)),
    ].sort(compareOrdinal);
    const held: string[] = [];
    try {
      for (const key of keys) {
        if (this.#activeMutations.has(key)) {
          throw new AuthorizedFileOperationError('operation-in-progress', 'preflight');
        }
        this.#activeMutations.add(key);
        held.push(key);
      }
    } catch (error) {
      for (const key of held) this.#activeMutations.delete(key);
      throw error;
    }
    return () => {
      for (const key of held) this.#activeMutations.delete(key);
    };
  }

  #requireWritableExtension(root: FrozenRootDefinition, relativePath: string): void {
    const extension = extname(relativePath).toLocaleLowerCase('en-US');
    if (!root.writableExtensionSet.has(extension)) {
      throw new AuthorizedFileOperationError('unsupported-extension', 'plan');
    }
  }

  #validateActor(input: Record<string, unknown>): void {
    if (
      typeof input.actorId !== 'string' ||
      !UUID.test(input.actorId) ||
      typeof input.reasonCode !== 'string' ||
      !IDENTIFIER.test(input.reasonCode) ||
      !canonicalTimestamp(input.changedAt)
    ) {
      throw new AuthorizedFileOperationError('invalid-plan', 'plan');
    }
  }

  /** Reads an existing file and refuses unless it is exactly the expected bytes. */
  async #verifiedSource(
    root: FrozenRootDefinition,
    relativePath: string,
    expectedSha256: string,
  ): Promise<PlainFile> {
    const target = await this.#target(root, relativePath, false);
    const file = await readPlainFile(target, root.maximumFileBytes);
    if (sha256(file.bytes) !== expectedSha256) {
      throw new AuthorizedFileOperationError('concurrent-modification', 'preflight');
    }
    return file;
  }

  /**
   * Writes the bytes a destructive step is about to lose and publishes the
   * revision atomically, exactly as `replace` does.
   *
   * The revision is published *before* the loss, so a crash between the two
   * leaves a recoverable revision and an untouched file — never the reverse.
   */
  async #preserveRevision(input: {
    readonly root: FrozenRootDefinition;
    readonly filePath: string;
    readonly revisionId: string;
    readonly actorId: string;
    readonly reasonCode: string;
    readonly changedAt: string;
    readonly bytes: Buffer;
    readonly state: 'preserved-before-move' | 'preserved-before-delete';
    readonly movedToPath?: string;
  }): Promise<{ readonly revisionReference: string; readonly manifestSha256: string }> {
    const layout = await this.#prepareRevisionLayout(input.root.rootId);
    const stagingDirectory = join(
      layout.stagingRoot,
      `${input.root.rootId}-${input.revisionId}`,
    );
    const revisionDirectory = join(layout.revisionsForRoot, input.revisionId);
    if ((await pathExists(stagingDirectory)) || (await pathExists(revisionDirectory))) {
      throw new AuthorizedFileOperationError('revision-conflict', 'revision');
    }
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });

    let published = false;
    try {
      const previousSha256 = sha256(input.bytes);
      const manifest: AuthorizedFileRevisionManifest = {
        format: 'voidfall-authorized-file-revision',
        schemaVersion: 1,
        revisionId: input.revisionId,
        rootId: input.root.rootId,
        filePath: input.filePath,
        actorId: input.actorId,
        reasonCode: input.reasonCode,
        changedAt: input.changedAt,
        state: input.state,
        previousSha256,
        // A move keeps the bytes, only elsewhere; a delete leaves nothing, and
        // saying so is what lets a restorer tell the two apart.
        intendedSha256: input.state === 'preserved-before-move' ? previousSha256 : null,
        previousSizeBytes: input.bytes.byteLength,
        intendedSizeBytes:
          input.state === 'preserved-before-move' ? input.bytes.byteLength : null,
        previousPayload: 'previous.bin',
        ...(input.movedToPath === undefined ? {} : { movedToPath: input.movedToPath }),
      };
      const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
      await writeExclusive(join(stagingDirectory, 'previous.bin'), input.bytes, 0o600);
      await writeExclusive(join(stagingDirectory, 'manifest.json'), manifestBytes, 0o600);
      await rename(stagingDirectory, revisionDirectory);
      published = true;
      return {
        revisionReference: `revisions/${input.root.rootId}/${input.revisionId}`,
        manifestSha256: sha256(manifestBytes),
      };
    } finally {
      if (!published) {
        if (dirname(stagingDirectory) !== join(this.#revisionRoot, 'staging')) {
          throw new AuthorizedFileOperationError('cleanup-failed', 'cleanup');
        }
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {
          throw new AuthorizedFileOperationError('cleanup-failed', 'cleanup');
        });
      }
    }
  }

  /**
   * Creates a file that does not exist yet.
   *
   * Nothing is lost, so there is no revision to take. The entry is created
   * exclusively, so the filesystem — not a prior existence check — decides
   * which of two concurrent creates wins.
   */
  public async create(input: CreateAuthorizedFilePlan): Promise<AuthorizedFileMutationReceipt> {
    if (
      !isRecord(input) ||
      !exactKeys(input, ['rootId', 'filePath', 'actorId', 'reasonCode', 'changedAt', 'content']) ||
      !validateRelativePath(input.filePath, false) ||
      typeof input.content !== 'string' ||
      input.content.includes('\u0000') ||
      Buffer.from(input.content, 'utf8').toString('utf8') !== input.content
    ) {
      throw new AuthorizedFileOperationError('invalid-plan', 'plan');
    }
    this.#validateActor(input);
    const root = this.#root(input.rootId);
    this.#requireWritableExtension(root, input.filePath);
    const content = Buffer.from(input.content, 'utf8');
    if (content.byteLength > root.maximumFileBytes) {
      throw new AuthorizedFileOperationError('content-too-large', 'plan');
    }

    const release = this.#holdPaths(root, [input.filePath]);
    try {
      const target = await this.#targetForNew(root, input.filePath);
      try {
        await writeExclusive(target, content, 0o600);
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          throw new AuthorizedFileOperationError('destination-exists', 'replace');
        }
        throw new AuthorizedFileOperationError('replacement-failed', 'replace');
      }
      const applied = await readPlainFile(target, root.maximumFileBytes);
      if (decodeText(applied.bytes) !== input.content) {
        throw new AuthorizedFileOperationError('verification-failed', 'verify');
      }
      return freezeDeep({
        operation: 'create' as const,
        rootId: root.rootId,
        filePath: input.filePath,
        destinationPath: null,
        sha256: sha256(content),
        revisionReference: null,
      });
    } finally {
      release();
    }
  }

  /**
   * Moves a file within one root. A rename is the case where both paths share
   * a parent; the guards and the failure modes are identical, so it is not a
   * separate operation.
   */
  public async move(input: MoveAuthorizedFilePlan): Promise<AuthorizedFileMutationReceipt> {
    if (
      !isRecord(input) ||
      !exactKeys(input, [
        'rootId',
        'sourcePath',
        'destinationPath',
        'revisionId',
        'actorId',
        'reasonCode',
        'changedAt',
        'expectedSha256',
      ]) ||
      !validateRelativePath(input.sourcePath, false) ||
      !validateRelativePath(input.destinationPath, false) ||
      typeof input.revisionId !== 'string' ||
      !IDENTIFIER.test(input.revisionId) ||
      typeof input.expectedSha256 !== 'string' ||
      !SHA256.test(input.expectedSha256)
    ) {
      throw new AuthorizedFileOperationError('invalid-plan', 'plan');
    }
    this.#validateActor(input);
    if (input.sourcePath === input.destinationPath) {
      throw new AuthorizedFileOperationError('no-change', 'plan');
    }
    const root = this.#root(input.rootId);
    // Both ends must be writable: the source is losing its file and the
    // destination is gaining one.
    this.#requireWritableExtension(root, input.sourcePath);
    this.#requireWritableExtension(root, input.destinationPath);

    const release = this.#holdPaths(root, [input.sourcePath, input.destinationPath]);
    try {
      const source = await this.#verifiedSource(root, input.sourcePath, input.expectedSha256);
      const sourcePath = await this.#target(root, input.sourcePath, false);
      const destination = await this.#targetForNew(root, input.destinationPath);

      const revision = await this.#preserveRevision({
        root,
        filePath: input.sourcePath,
        revisionId: input.revisionId,
        actorId: input.actorId,
        reasonCode: input.reasonCode,
        changedAt: input.changedAt,
        bytes: source.bytes,
        state: 'preserved-before-move',
        movedToPath: input.destinationPath,
      });

      try {
        // `rename` refuses to clobber a directory but will happily replace a
        // file on POSIX, so `#targetForNew` having found the destination absent
        // is what keeps this from overwriting — and the hold is what keeps that
        // finding true.
        await rename(sourcePath, destination);
      } catch {
        throw new AuthorizedFileOperationError('replacement-failed', 'replace');
      }

      const moved = await readPlainFile(destination, root.maximumFileBytes);
      if (sha256(moved.bytes) !== input.expectedSha256) {
        throw new AuthorizedFileOperationError('verification-failed', 'verify');
      }
      return freezeDeep({
        operation: 'move' as const,
        rootId: root.rootId,
        filePath: input.sourcePath,
        destinationPath: input.destinationPath,
        sha256: input.expectedSha256,
        revisionReference: revision.revisionReference,
      });
    } finally {
      release();
    }
  }

  /** Copies a file within one root. Nothing is lost, so no revision is taken. */
  public async copy(input: CopyAuthorizedFilePlan): Promise<AuthorizedFileMutationReceipt> {
    if (
      !isRecord(input) ||
      !exactKeys(input, [
        'rootId',
        'sourcePath',
        'destinationPath',
        'actorId',
        'reasonCode',
        'changedAt',
        'expectedSha256',
      ]) ||
      !validateRelativePath(input.sourcePath, false) ||
      !validateRelativePath(input.destinationPath, false) ||
      typeof input.expectedSha256 !== 'string' ||
      !SHA256.test(input.expectedSha256)
    ) {
      throw new AuthorizedFileOperationError('invalid-plan', 'plan');
    }
    this.#validateActor(input);
    if (input.sourcePath === input.destinationPath) {
      throw new AuthorizedFileOperationError('no-change', 'plan');
    }
    const root = this.#root(input.rootId);
    // The source is only read, so readable is enough for it; the destination is
    // written, so it must be writable.
    const sourceExtension = extname(input.sourcePath).toLocaleLowerCase('en-US');
    if (!root.readableExtensionSet.has(sourceExtension)) {
      throw new AuthorizedFileOperationError('unsupported-extension', 'plan');
    }
    this.#requireWritableExtension(root, input.destinationPath);

    const release = this.#holdPaths(root, [input.sourcePath, input.destinationPath]);
    try {
      const source = await this.#verifiedSource(root, input.sourcePath, input.expectedSha256);
      const destination = await this.#targetForNew(root, input.destinationPath);
      try {
        await writeExclusive(destination, source.bytes, 0o600);
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          throw new AuthorizedFileOperationError('destination-exists', 'replace');
        }
        throw new AuthorizedFileOperationError('replacement-failed', 'replace');
      }
      const written = await readPlainFile(destination, root.maximumFileBytes);
      if (sha256(written.bytes) !== input.expectedSha256) {
        throw new AuthorizedFileOperationError('verification-failed', 'verify');
      }
      return freezeDeep({
        operation: 'copy' as const,
        rootId: root.rootId,
        filePath: input.sourcePath,
        destinationPath: input.destinationPath,
        sha256: input.expectedSha256,
        revisionReference: null,
      });
    } finally {
      release();
    }
  }

  /**
   * Deletes a file after preserving its bytes.
   *
   * The revision is published first: a delete that lost the bytes would be the
   * one mutation nothing could undo.
   */
  public async delete(input: DeleteAuthorizedFilePlan): Promise<AuthorizedFileMutationReceipt> {
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
      ]) ||
      !validateRelativePath(input.filePath, false) ||
      typeof input.revisionId !== 'string' ||
      !IDENTIFIER.test(input.revisionId) ||
      typeof input.expectedSha256 !== 'string' ||
      !SHA256.test(input.expectedSha256)
    ) {
      throw new AuthorizedFileOperationError('invalid-plan', 'plan');
    }
    this.#validateActor(input);
    const root = this.#root(input.rootId);
    this.#requireWritableExtension(root, input.filePath);

    const release = this.#holdPaths(root, [input.filePath]);
    try {
      const source = await this.#verifiedSource(root, input.filePath, input.expectedSha256);
      const target = await this.#target(root, input.filePath, false);

      const revision = await this.#preserveRevision({
        root,
        filePath: input.filePath,
        revisionId: input.revisionId,
        actorId: input.actorId,
        reasonCode: input.reasonCode,
        changedAt: input.changedAt,
        bytes: source.bytes,
        state: 'preserved-before-delete',
      });

      try {
        await unlink(target);
      } catch {
        throw new AuthorizedFileOperationError('replacement-failed', 'replace');
      }
      if (await pathExists(target)) {
        throw new AuthorizedFileOperationError('verification-failed', 'verify');
      }
      return freezeDeep({
        operation: 'delete' as const,
        rootId: root.rootId,
        filePath: input.filePath,
        destinationPath: null,
        sha256: input.expectedSha256,
        revisionReference: revision.revisionReference,
      });
    } finally {
      release();
    }
  }

  // ---------------------------------------------------------------------------
  // Review and restoration.
  // ---------------------------------------------------------------------------

  /**
   * Reads a preserved revision back.
   *
   * The manifest is re-validated on the way in rather than trusted: it lives on
   * disk, and a revision directory whose manifest was tampered with must not be
   * able to redirect a restore at some other file.
   */
  async #readRevision(
    root: FrozenRootDefinition,
    revisionId: string,
  ): Promise<{ readonly manifest: AuthorizedFileRevisionManifest; readonly bytes: Buffer }> {
    const layout = await this.#prepareRevisionLayout(root.rootId);
    const directory = join(layout.revisionsForRoot, revisionId);
    if (!(await pathExists(directory))) {
      throw new AuthorizedFileOperationError('unknown-revision', 'read');
    }
    await requireCanonicalDirectory(this.#revisionRoot, directory);

    const manifestFile = await readPlainFile(join(directory, 'manifest.json'), MAXIMUM_MANIFEST_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeText(manifestFile.bytes));
    } catch {
      throw new AuthorizedFileOperationError('unknown-revision', 'read');
    }
    if (
      !isRecord(parsed) ||
      parsed.format !== 'voidfall-authorized-file-revision' ||
      parsed.schemaVersion !== 1 ||
      parsed.revisionId !== revisionId ||
      // A manifest naming another root is refused outright: honouring it would
      // let a revision under a permissive root restore into a strict one.
      parsed.rootId !== root.rootId ||
      !validateRelativePath(parsed.filePath, false) ||
      typeof parsed.previousSha256 !== 'string' ||
      !SHA256.test(parsed.previousSha256) ||
      parsed.previousPayload !== 'previous.bin' ||
      (parsed.state !== 'prepared-before-replacement' &&
        parsed.state !== 'preserved-before-move' &&
        parsed.state !== 'preserved-before-delete')
    ) {
      throw new AuthorizedFileOperationError('unknown-revision', 'read');
    }

    const payload = await readPlainFile(join(directory, 'previous.bin'), root.maximumFileBytes);
    if (sha256(payload.bytes) !== parsed.previousSha256) {
      throw new AuthorizedFileOperationError('verification-failed', 'verify');
    }
    return { manifest: parsed as unknown as AuthorizedFileRevisionManifest, bytes: payload.bytes };
  }

  /**
   * Compares the file on disk against a revision or against proposed text.
   *
   * Every line comes back redacted, so a reviewer can see *that* a credential
   * changed without the review screen becoming a way to read it.
   */
  public async diff(input: DiffAuthorizedFilePlan): Promise<AuthorizedFileDiffSnapshot> {
    if (
      !isRecord(input) ||
      !exactKeys(input, ['rootId', 'filePath', 'against']) ||
      !validateRelativePath(input.filePath, false) ||
      !isRecord(input.against)
    ) {
      throw new AuthorizedFileOperationError('invalid-plan', 'plan');
    }
    const against = input.against;
    const isRevision = against.type === 'revision';
    if (isRevision) {
      if (
        !exactKeys(against, ['type', 'revisionId']) ||
        typeof against.revisionId !== 'string' ||
        !IDENTIFIER.test(against.revisionId)
      ) {
        throw new AuthorizedFileOperationError('invalid-plan', 'plan');
      }
    } else if (
      against.type !== 'proposed' ||
      !exactKeys(against, ['type', 'content']) ||
      typeof against.content !== 'string'
    ) {
      throw new AuthorizedFileOperationError('invalid-plan', 'plan');
    }

    const root = this.#root(input.rootId);
    const extension = extname(input.filePath).toLocaleLowerCase('en-US');
    if (!root.readableExtensionSet.has(extension)) {
      throw new AuthorizedFileOperationError('unsupported-extension', 'plan');
    }

    // A file that is not there compares as empty rather than failing: that is
    // exactly the case after a delete, and it is the case a reviewer most needs
    // to see before restoring.
    const targetPath = resolve(root.rootPath, ...input.filePath.split('/'));
    const currentText = (await pathExists(targetPath))
      ? decodeText((await readPlainFile(await this.#target(root, input.filePath, false), root.maximumFileBytes)).bytes)
      : '';

    if (isRevision) {
      const revision = await this.#readRevision(root, String(against.revisionId));
      const previousText = decodeText(revision.bytes);
      return freezeDeep({
        rootId: root.rootId,
        filePath: input.filePath,
        previousLabel: `revision:${revision.manifest.revisionId}`,
        currentLabel: 'current',
        diff: diffText(previousText, currentText),
      });
    }

    const proposed = String(against.content);
    if (Buffer.byteLength(proposed, 'utf8') > root.maximumFileBytes) {
      throw new AuthorizedFileOperationError('content-too-large', 'plan');
    }
    return freezeDeep({
      rootId: root.rootId,
      filePath: input.filePath,
      previousLabel: 'current',
      currentLabel: 'proposed',
      diff: diffText(currentText, proposed),
    });
  }

  /**
   * Puts a preserved revision back at its own recorded path.
   *
   * Restoration only fills an absent path. A file that is present is a
   * different operation — a replacement, which requires the caller to state the
   * hash they believe they are replacing — and silently overwriting here would
   * be the one way this package could destroy data without being asked to.
   *
   * The preserved bytes never leave the service on this path, so a revision can
   * be restored by someone who is not allowed to read what it contains.
   */
  public async restore(input: RestoreAuthorizedFilePlan): Promise<AuthorizedFileMutationReceipt> {
    if (
      !isRecord(input) ||
      !exactKeys(input, ['rootId', 'revisionId', 'actorId', 'reasonCode', 'changedAt']) ||
      typeof input.revisionId !== 'string' ||
      !IDENTIFIER.test(input.revisionId)
    ) {
      throw new AuthorizedFileOperationError('invalid-plan', 'plan');
    }
    this.#validateActor(input);
    const root = this.#root(input.rootId);
    const revision = await this.#readRevision(root, input.revisionId);
    const filePath = revision.manifest.filePath;
    // Re-checked against the live policy, not against whatever was writable when
    // the revision was taken.
    this.#requireWritableExtension(root, filePath);

    const release = this.#holdPaths(root, [filePath]);
    try {
      const target = await this.#targetForNew(root, filePath);
      try {
        await writeExclusive(target, revision.bytes, 0o600);
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          throw new AuthorizedFileOperationError('destination-exists', 'replace');
        }
        throw new AuthorizedFileOperationError('replacement-failed', 'replace');
      }
      const applied = await readPlainFile(target, root.maximumFileBytes);
      if (sha256(applied.bytes) !== revision.manifest.previousSha256) {
        throw new AuthorizedFileOperationError('verification-failed', 'verify');
      }
      return freezeDeep({
        operation: 'restore' as const,
        rootId: root.rootId,
        filePath,
        destinationPath: null,
        sha256: revision.manifest.previousSha256,
        revisionReference: `revisions/${root.rootId}/${input.revisionId}`,
      });
    } finally {
      release();
    }
  }
}
