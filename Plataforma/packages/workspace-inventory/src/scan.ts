import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, sep } from 'node:path';

import {
  WorkspaceInventoryError,
  type WorkspaceExclusion,
  type WorkspaceFile,
  type WorkspaceFileRole,
} from './types.js';

/**
 * Walks a workspace and reports what is in it, without touching it.
 *
 * Nothing here opens a file for writing, creates a directory or follows a
 * symlink. The last one is not fussiness: a link inside an imported pack can
 * point anywhere on the host, and a scanner that followed one would hash files
 * outside the directory the operator pointed at — and could be made to.
 */

/**
 * Paths that are never read, by category rather than by guess.
 *
 * These are the same categories the repository keeps out of Git: worlds, logs,
 * crash reports, caches and access lists. Hashing a whitelist would put player
 * names into an inventory nobody asked to collect, and a world is both
 * enormous and none of an importer's business.
 */
const PRIVATE_STATE_DIRECTORIES: ReadonlySet<string> = new Set([
  'logs',
  'crash-reports',
  'saves',
  'world',
  'world_nether',
  'world_the_end',
  'backups',
  'libraries',
  '.git',
  'node_modules',
]);

const PRIVATE_STATE_FILES: ReadonlySet<string> = new Set([
  'server.properties',
  'ops.json',
  'whitelist.json',
  'banned-players.json',
  'banned-ips.json',
  'usercache.json',
  'usernamecache.json',
  'eula.txt',
]);

const CONFIGURATION_EXTENSIONS: ReadonlySet<string> = new Set([
  '.toml',
  '.json',
  '.json5',
  '.properties',
  '.cfg',
  '.conf',
  '.yaml',
  '.yml',
  '.snbt',
]);

const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.ts', '.zs', '.lua', '.py']);

/** Directories whose contents are datapacks or resources regardless of extension. */
const DATAPACK_ROOTS: readonly string[] = ['datapacks/', 'world/datapacks/', 'kubejs/data/'];
const RESOURCE_ROOTS: readonly string[] = ['resourcepacks/', 'kubejs/assets/'];
const SCRIPT_ROOTS: readonly string[] = ['kubejs/', 'scripts/'];

export interface ScanWorkspaceOptions {
  /** Absolute path to the workspace being imported. Never written to. */
  readonly root: string;
  /** Files above this are recorded as excluded rather than hashed. */
  readonly maximumFileBytes?: number;
  /** A bound on the walk, so a pathological tree cannot run forever. */
  readonly maximumFiles?: number;
}

export interface WorkspaceScan {
  readonly files: readonly WorkspaceFile[];
  readonly exclusions: readonly WorkspaceExclusion[];
}

const DEFAULT_MAXIMUM_FILE_BYTES = 268_435_456;
const DEFAULT_MAXIMUM_FILES = 200_000;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLocaleLowerCase('en-US');
}

/**
 * Assigns a role from the path alone.
 *
 * Deliberately from the path and not from the content: sniffing a file to
 * decide what it is means reading files the inventory has no reason to read,
 * and a wrong guess is worse than `other`.
 */
export function roleForPath(relativePath: string): WorkspaceFileRole {
  const lower = relativePath.toLocaleLowerCase('en-US');
  const extension = extensionOf(lower);

  if (extension === '.jar') return 'mod-archive';
  if (DATAPACK_ROOTS.some((root) => lower.startsWith(root))) return 'datapack';
  if (RESOURCE_ROOTS.some((root) => lower.startsWith(root))) return 'resource';
  if (SCRIPT_EXTENSIONS.has(extension) && SCRIPT_ROOTS.some((root) => lower.startsWith(root))) {
    return 'script';
  }
  if (CONFIGURATION_EXTENSIONS.has(extension)) return 'configuration';
  return 'other';
}

function isPrivateState(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const name = segments[segments.length - 1] ?? '';
  if (PRIVATE_STATE_FILES.has(name.toLocaleLowerCase('en-US'))) return true;
  return segments
    .slice(0, -1)
    .some((segment) => PRIVATE_STATE_DIRECTORIES.has(segment.toLocaleLowerCase('en-US')));
}

/**
 * Scans the workspace.
 *
 * The result is sorted by path so two scans of the same directory produce the
 * same list in the same order. Nothing derived from the filesystem's own
 * timestamps enters it: a reproducible inventory has to compare equal across
 * machines and across copies, and an mtime does neither.
 */
export async function scanWorkspace(options: ScanWorkspaceOptions): Promise<WorkspaceScan> {
  if (options === null || typeof options !== 'object' || typeof options.root !== 'string') {
    throw new WorkspaceInventoryError('invalid-options');
  }
  if (!isAbsolute(options.root)) throw new WorkspaceInventoryError('root-not-absolute');
  const rootStat = await lstat(options.root).catch(() => undefined);
  if (rootStat === undefined || !rootStat.isDirectory()) {
    throw new WorkspaceInventoryError('root-not-a-directory');
  }

  const maximumFileBytes = options.maximumFileBytes ?? DEFAULT_MAXIMUM_FILE_BYTES;
  const maximumFiles = options.maximumFiles ?? DEFAULT_MAXIMUM_FILES;
  const files: WorkspaceFile[] = [];
  const exclusions: WorkspaceExclusion[] = [];
  let seen = 0;

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) {
      exclusions.push({ path: toRelative(options.root, directory), reason: 'unreadable' });
      return;
    }
    // Sorted at every level, so the walk order is the same everywhere.
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));

    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativePath = toRelative(options.root, absolute);

      if (entry.isSymbolicLink()) {
        // A link inside an imported pack can point anywhere on the host.
        exclusions.push({ path: relativePath, reason: 'symlink' });
        continue;
      }
      if (isPrivateState(relativePath)) {
        exclusions.push({ path: relativePath, reason: 'private-state' });
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      seen += 1;
      if (seen > maximumFiles) throw new WorkspaceInventoryError('too-many-files');

      const stats = await lstat(absolute).catch(() => undefined);
      if (stats === undefined) {
        exclusions.push({ path: relativePath, reason: 'unreadable' });
        continue;
      }
      if (stats.size > maximumFileBytes) {
        exclusions.push({ path: relativePath, reason: 'too-large' });
        continue;
      }

      const content = await readFile(absolute).catch(() => undefined);
      if (content === undefined) {
        exclusions.push({ path: relativePath, reason: 'unreadable' });
        continue;
      }
      files.push({
        path: relativePath,
        role: roleForPath(relativePath),
        sizeBytes: stats.size,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
  };

  await walk(options.root);

  files.sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
  exclusions.sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
  return { files: Object.freeze(files), exclusions: Object.freeze(exclusions) };
}

/** Always `/`-separated, so an inventory taken on Windows matches one on Linux. */
function toRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join(posix.sep);
}
