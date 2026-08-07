import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeZipArchive, type ArchiveEntry, type ArchiveReceipt } from './archive.js';
import { type SideAssignment } from './side.js';
import { type DistributionDecision, type WorkspaceInventory } from './types.js';

/**
 * Turns an inventory into a package somebody can actually install.
 *
 * Two rules decide what goes in, and both are refusals rather than guesses:
 *
 * A mod archive with no recorded side is **left out**. Most mods run on the
 * server, so inferring "server" for an unrecorded jar would be right often
 * enough to be trusted and wrong often enough to matter — a client-only mod in
 * a server package is a crash at boot. It is reported as excluded, with the
 * reason, so the gap is visible instead of silently resolved.
 *
 * Building for distribution is refused when the licence gate refuses. Building
 * the same package for the operator's own machine is not, because restoring
 * your own server onto your own host is a backup, and treating it as
 * redistribution would make the tool useless for the thing it is mainly for.
 */

export type PackageSide = 'server' | 'client';

/**
 * Who the package is for.
 *
 * Not a formality: it selects which gate applies, and it is an input rather
 * than something inferred, so nobody can produce a distributable artefact by
 * forgetting to ask.
 */
export type PackageIntent = 'local-use' | 'distribution';

export type ExclusionReason =
  /** Recorded on the other side only. */
  | 'other-side'
  /** No side was ever observed for this archive. Never inferred. */
  | 'unassigned'
  /** Forge's own libraries and argument files, unless asked for. */
  | 'runtime-infrastructure';

export interface PackagedFile {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ExcludedFile {
  readonly path: string;
  readonly reason: ExclusionReason;
}

export interface PackageManifest {
  readonly schemaVersion: 1;
  readonly side: PackageSide;
  readonly version: string;
  readonly createdAt: string;
  readonly intent: PackageIntent;
  /** The inventory this was built from, so a package is traceable to a scan. */
  readonly sourceInventorySha256: string;
  readonly includesRuntime: boolean;
  /**
   * True when a client package was derived from a server installation.
   *
   * The panel imports a server. A client package cut from it carries the shared
   * configuration and the client-side mods, but nothing that only ever exists
   * in a client installation. Saying so beats letting somebody assume it is a
   * complete client.
   */
  readonly derivedFromServerWorkspace: boolean;
  readonly files: readonly PackagedFile[];
  readonly excluded: readonly ExcludedFile[];
  readonly archive: {
    readonly fileName: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly entries: number;
  };
}

export type PackageErrorCode = 'distribution-refused' | 'nothing-to-package' | 'invalid-version';

export class PackageError extends Error {
  public readonly code: PackageErrorCode;
  /** The gate's own words, when a licence refusal caused it. */
  public readonly detail: string | null;

  public constructor(code: PackageErrorCode, detail: string | null = null) {
    super(detail === null ? `release-package:${code}` : `release-package:${code}:${detail}`);
    this.name = 'PackageError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Directories that only ever mean something on a server.
 *
 * `world/` reaches a package at all only because the scanner lets per-world
 * server configuration through — those are the operator's real settings, and a
 * package without them would describe a different server. A client has no
 * world and no `serverconfig`, so extracting them into one would create a
 * `world/` directory nobody asked for. `defaultconfigs/` is Forge's seed for
 * exactly those files, and equally server-side.
 */
const SERVER_ONLY_DIRECTORIES: ReadonlySet<string> = new Set(['world', 'defaultconfigs']);

/**
 * Whether a path belongs to the server side by where it sits, not by its role.
 *
 * A file inside `mods/` that is not a mod archive — a `.jar.disabled`, a
 * `.bak` — is residue of somebody's server folder. Keeping it in the server
 * package preserves what the folder actually looks like; putting it in a client
 * package would ship a server's switched-off mods to a player, and it would do
 * so without ever passing the side split, which is the one thing this module
 * exists to prevent.
 */
function isServerSideByLocation(path: string, role: string): boolean {
  const [first] = path.split('/');
  if (first !== undefined && SERVER_ONLY_DIRECTORIES.has(first)) return true;
  return first === 'mods' && role !== 'mod-archive';
}

export interface PackageSelection {
  readonly include: readonly PackagedFile[];
  readonly excluded: readonly ExcludedFile[];
}

/**
 * Decides which of an inventory's files belong in one side's package.
 *
 * Separate from writing the archive so it can be shown to somebody before a
 * gigabyte is written, and tested without touching a disk.
 */
export function selectPackageContents(input: {
  readonly inventory: WorkspaceInventory;
  readonly assignments: readonly SideAssignment[];
  readonly side: PackageSide;
  readonly includeRuntime?: boolean;
}): PackageSelection {
  const bySide = new Map(
    input.assignments.map((assignment) => [assignment.fileName.toLowerCase(), assignment.side]),
  );
  const include: PackagedFile[] = [];
  const excluded: ExcludedFile[] = [];

  for (const file of input.inventory.files) {
    const packaged: PackagedFile = {
      path: file.path,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
    };

    if (file.role === 'runtime') {
      if (input.includeRuntime === true) include.push(packaged);
      else excluded.push({ path: file.path, reason: 'runtime-infrastructure' });
      continue;
    }

    if (file.role === 'mod-archive') {
      const name = (file.path.split('/').pop() ?? '').toLowerCase();
      const side = bySide.get(name);
      if (side === undefined || side === 'neither') {
        excluded.push({ path: file.path, reason: 'unassigned' });
        continue;
      }
      const belongs =
        input.side === 'server' ? side !== 'client-only' : side !== 'server-only';
      if (belongs) include.push(packaged);
      else excluded.push({ path: file.path, reason: 'other-side' });
      continue;
    }

    if (isServerSideByLocation(file.path, file.role)) {
      if (input.side === 'server') include.push(packaged);
      else excluded.push({ path: file.path, reason: 'other-side' });
      continue;
    }

    // Everything else — configuration, datapacks, scripts, resources — is
    // shared. A client package built from a server workspace carrying the
    // server's common configuration is the honest result of importing a
    // server, and the manifest says where it came from.
    include.push(packaged);
  }

  const byPath = (left: { path: string }, right: { path: string }): number =>
    left.path.localeCompare(right.path, 'en-US');

  return Object.freeze({
    include: Object.freeze([...include].sort(byPath)),
    excluded: Object.freeze([...excluded].sort(byPath)),
  });
}

async function digestOf(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Writes one side's archive and the manifest that describes it.
 *
 * The manifest sits beside the archive rather than inside it, so the archive's
 * digest is a fact about the archive and not about a document describing
 * itself.
 */
export async function buildPackage(input: {
  readonly workspaceRoot: string;
  readonly outputDirectory: string;
  readonly inventory: WorkspaceInventory;
  readonly assignments: readonly SideAssignment[];
  readonly distribution: DistributionDecision;
  readonly side: PackageSide;
  readonly version: string;
  readonly intent: PackageIntent;
  readonly includeRuntime?: boolean;
  /** Defaults to now. Injectable so a build is reproducible in a test. */
  readonly now?: Date;
}): Promise<{
  readonly manifest: PackageManifest;
  readonly manifestPath: string;
  readonly receipt: ArchiveReceipt;
}> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input.version)) {
    // The version becomes a file name. Anything else is a path question nobody
    // wants to answer at write time.
    throw new PackageError('invalid-version', input.version);
  }
  if (input.intent === 'distribution' && !input.distribution.distributable) {
    const reasons = new Map<string, number>();
    for (const block of input.distribution.blocks) {
      reasons.set(block.reason, (reasons.get(block.reason) ?? 0) + 1);
    }
    throw new PackageError(
      'distribution-refused',
      [...reasons].map(([reason, count]) => `${String(count)} ${reason}`).join(', '),
    );
  }

  const selection = selectPackageContents({
    inventory: input.inventory,
    assignments: input.assignments,
    side: input.side,
    includeRuntime: input.includeRuntime === true,
  });
  if (selection.include.length === 0) {
    // An empty archive is indistinguishable from a build that silently failed.
    throw new PackageError('nothing-to-package');
  }

  const fileName = `voidfall-${input.side}-${input.version}.zip`;
  const targetPath = join(input.outputDirectory, fileName);
  const entries: readonly ArchiveEntry[] = selection.include.map((file) => ({
    name: file.path,
    source: join(input.workspaceRoot, ...file.path.split('/')),
  }));

  const receipt = await writeZipArchive({ targetPath, entries });
  const manifest: PackageManifest = Object.freeze({
    schemaVersion: 1,
    side: input.side,
    version: input.version,
    createdAt: (input.now ?? new Date()).toISOString(),
    intent: input.intent,
    sourceInventorySha256: input.inventory.inventorySha256,
    includesRuntime: input.includeRuntime === true,
    derivedFromServerWorkspace: input.side === 'client',
    files: selection.include,
    excluded: selection.excluded,
    archive: {
      fileName,
      sha256: await digestOf(targetPath),
      bytes: receipt.bytes,
      entries: receipt.entries,
    },
  });

  const manifestPath = join(input.outputDirectory, `voidfall-${input.side}-${input.version}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return Object.freeze({ manifest, manifestPath, receipt });
}
