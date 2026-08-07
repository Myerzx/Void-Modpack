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
  /**
   * A launcher's own cache, which on the server this was first run against
   * held 19 GB. Nothing in it is read by the server, and the configuration
   * files scattered through it look exactly like configuration to a rule that
   * goes by extension — which is how a sandbox ended up carrying 1.2 GB of it.
   */
  'local',
  'world',
  'world_nether',
  'world_the_end',
  'backups',
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

/**
 * The server runtime, which is infrastructure rather than content.
 *
 * Kept out of an inventory by default because nobody manages a Forge library
 * through a configuration panel, and 159 MB of jars drowns the list of things
 * that matter. It is not private, so asking for it is enough — a sandbox has
 * to bring it or nothing boots.
 */
const RUNTIME_DIRECTORIES: ReadonlySet<string> = new Set(['libraries']);

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
  /**
   * Include the server runtime — Forge libraries and argument files.
   *
   * Off by default: an inventory is about what an operator manages. A sandbox
   * asks for it, because without it there is nothing to boot.
   */
  readonly includeRuntime?: boolean;
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

  if (isRuntimeInfrastructure(lower)) return 'runtime';
  if (extension === '.jar') return 'mod-archive';
  if (DATAPACK_ROOTS.some((root) => lower.startsWith(root))) return 'datapack';
  if (RESOURCE_ROOTS.some((root) => lower.startsWith(root))) return 'resource';
  if (SCRIPT_EXTENSIONS.has(extension) && SCRIPT_ROOTS.some((root) => lower.startsWith(root))) {
    return 'script';
  }
  if (CONFIGURATION_EXTENSIONS.has(extension)) return 'configuration';
  return 'other';
}

function isRuntimeInfrastructure(relativePath: string): boolean {
  return relativePath
    .split('/')
    .some((segment) => RUNTIME_DIRECTORIES.has(segment.toLocaleLowerCase('en-US')));
}

/**
 * Whether a path is private state, checked at every segment.
 *
 * Every segment including the last, so the walk refuses the `logs` directory
 * itself and never descends. Checking only the parent segments meant the
 * directory was entered and each file rejected individually — same answer,
 * except that a first attempt at a real server carried 20 800 files into a
 * sandbox because a `.json` inside `crash-reports` still looked like
 * configuration.
 *
 * Dot-directories go with them. A `.vscode`, a `.git` or an editor's cache at
 * the root of a server is somebody's tooling, never something the server
 * reads, and no allowlist of mod directories would have predicted their names.
 */
/**
 * Forge keeps per-world server configuration inside the level directory.
 *
 * `<level>/serverconfig/*.toml` is configuration an operator manages — it is
 * where Mine and Slash and twenty other mods keep their server settings — and
 * it only lives under the world for Forge's own reasons. Excluding it with the
 * world meant an inventory could not see it and a sandbox booted on defaults
 * instead of on the operator's actual settings, which is a boot that proves
 * something about a server nobody runs.
 *
 * Matched by segment rather than by level name, because the level is whatever
 * `server.properties` says and that file is not read.
 */
function isPerWorldServerConfig(segments: readonly string[]): boolean {
  // `>= 2` so the `serverconfig` directory itself is allowed through, not only
  // the files under it — otherwise the walk refuses the directory and never
  // reaches them.
  return segments.length >= 2 && segments.includes('serverconfig');
}

function isPrivateState(relativePath: string): boolean {
  const segments = relativePath.split('/');
  if (isPerWorldServerConfig(segments)) return false;
  const name = segments[segments.length - 1] ?? '';
  if (PRIVATE_STATE_FILES.has(name.toLocaleLowerCase('en-US'))) return true;
  return segments.some(
    (segment) =>
      PRIVATE_STATE_DIRECTORIES.has(segment.toLocaleLowerCase('en-US')) ||
      (segment.startsWith('.') && segment !== '.' && segment !== '..'),
  );
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
        // A level directory is refused as a whole, except that Forge keeps
        // per-world server configuration inside it. Descending only for that
        // is the difference between an inventory that sees an operator's
        // settings and one that does not.
        if (entry.isDirectory() && (await containsServerConfig(absolute))) {
          await walk(absolute);
          continue;
        }
        exclusions.push({ path: relativePath, reason: 'private-state' });
        continue;
      }
      if (options.includeRuntime !== true && isRuntimeInfrastructure(relativePath)) {
        exclusions.push({ path: relativePath, reason: 'runtime-infrastructure' });
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

/** Whether a refused directory nonetheless holds per-world server config. */
async function containsServerConfig(directory: string): Promise<boolean> {
  const info = await lstat(join(directory, 'serverconfig')).catch(() => undefined);
  return info?.isDirectory() === true;
}

/** Always `/`-separated, so an inventory taken on Windows matches one on Linux. */
function toRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join(posix.sep);
}
