/**
 * What a Minecraft workspace contains, as read.
 *
 * The first step of the product's main path is importing a server or modpack
 * and knowing exactly what is in it. This package answers that and stops: it
 * reads, hashes and classifies, and it never writes, never executes and never
 * decides what a value means.
 *
 * Three rules shape the whole module:
 *
 *  - **Read-only, structurally.** Nothing here opens a file for writing. The
 *    source of an import is somebody's real installation, and an importer that
 *    could modify it is one nobody should point at their server.
 *  - **Excluded is recorded, not skipped.** A world, a log, a whitelist and a
 *    `server.properties` are deliberately not read. Saying so is the point —
 *    an inventory that quietly omits things is indistinguishable from one that
 *    failed to find them.
 *  - **Locating a file is not understanding it.** Every mod is inventoried;
 *    the level at which it can be edited is classified separately, and the
 *    least capable level is the default.
 */

/** How the inventory treats a file it found. */
export type WorkspaceFileRole =
  /** A mod archive. Inspected for what it declares, never executed. */
  | 'mod-archive'
  /** A structured configuration file: TOML, JSON or properties. */
  | 'configuration'
  /** A datapack, as a directory entry or an archive. */
  | 'datapack'
  /** A script — KubeJS and friends. Located, never interpreted. */
  | 'script'
  /** A resource pack or asset bundle. */
  | 'resource'
  /**
   * The server runtime itself — Forge's libraries and argument files.
   *
   * Not content anybody manages through this panel, which is why it is left
   * out of an inventory by default. It is still needed to boot a sandbox, so
   * it can be asked for explicitly.
   */
  | 'runtime'
  /** Found, classified as nothing in particular, and left alone. */
  | 'other';

/**
 * Why a path was not read.
 *
 * Every one of these is a deliberate refusal rather than a gap. `private-state`
 * covers the categories the repository already keeps out of Git — worlds,
 * logs, caches, access lists — because an importer that hashed a whitelist
 * would put player names in an inventory nobody asked to collect.
 */
export type WorkspaceExclusionReason =
  | 'private-state'
  /**
   * The server runtime, left out because it is infrastructure rather than
   * content — not because it is private. Ask for it and it is included.
   */
  | 'runtime-infrastructure'
  | 'too-large'
  | 'unreadable'
  | 'symlink';

export interface WorkspaceFile {
  /** Always relative to the workspace root, with `/` separators. */
  readonly path: string;
  readonly role: WorkspaceFileRole;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface WorkspaceExclusion {
  readonly path: string;
  readonly reason: WorkspaceExclusionReason;
}

/**
 * The level at which a mod's configuration can be edited.
 *
 * Ordered from most to least capable, and the default is the least. Assuming a
 * mod is understood because its JAR could be read is how an editor corrupts a
 * configuration with confidence; `UNSUPPORTED` and `RUNTIME_ONLY` are ordinary
 * outcomes, not failures of the inventory.
 */
export type ModEditLevel =
  /** A reviewed schema covers this file. Semantics are known. */
  | 'FULLY_MANAGED'
  /** Structure is parseable and editable. Meaning is not known. */
  | 'STRUCTURED'
  /** Located and editable as text, in an advanced mode, with a warning. */
  | 'RAW_EDITABLE'
  /** Located, but there is no safe mutation. */
  | 'UNSUPPORTED'
  /** Nothing was found; it may only exist after the mod has run. */
  | 'RUNTIME_ONLY';

/** How a configuration file came to be associated with a mod. */
export type ConfigurationMatchRule =
  /** `config/<modId>.toml` and its `-common`/`-server`/`-client` variants. */
  | 'config-file-by-mod-id'
  /** `config/<modId>/**` — a directory named for the mod. */
  | 'config-directory-by-mod-id'
  /** A reviewed resource in the closed product registry names this path. */
  | 'reviewed-resource';

export interface ConfigurationCandidate {
  readonly path: string;
  readonly rule: ConfigurationMatchRule;
}

export interface InventoriedMod {
  readonly modId: string;
  readonly displayName: string | null;
  /** Exactly as declared. Unresolved substitutions stay unresolved. */
  readonly version: string | null;
  readonly loader: string;
  /** Where the archive is, relative to the root. */
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly editLevel: ModEditLevel;
  /**
   * Why the level is what it is, in one phrase. An unavailable capability with
   * no cause is indistinguishable from a defect; the same applies here.
   */
  readonly editLevelReason: string;
  /**
   * Files this mod probably owns, and the rule that matched.
   *
   * "Probably" is the honest word. Nothing in a JAR states where its
   * configuration lives, so these are conventions, reported with the rule so a
   * reader can judge them rather than trust them.
   */
  readonly configurationCandidates: readonly ConfigurationCandidate[];
}

/**
 * An archive that declared no mod at all.
 *
 * Recorded rather than dropped: a JAR in the mods directory that declares
 * nothing is a fact about the installation worth seeing, and silently omitting
 * it would make the inventory disagree with the folder.
 */
export interface UndeclaredArchive {
  readonly path: string;
  readonly sha256: string;
  readonly reason: 'no-declared-mod' | 'inspection-refused';
}

export interface WorkspaceInventory {
  readonly schemaVersion: 1;
  /** Digest over the inventory's own content, so two scans are comparable. */
  readonly inventorySha256: string;
  readonly files: readonly WorkspaceFile[];
  readonly exclusions: readonly WorkspaceExclusion[];
  readonly mods: readonly InventoriedMod[];
  readonly undeclaredArchives: readonly UndeclaredArchive[];
  readonly totals: {
    readonly files: number;
    readonly bytes: number;
    readonly mods: number;
  };
}

export type WorkspaceInventoryErrorCode =
  | 'invalid-options'
  | 'root-not-a-directory'
  | 'root-not-absolute'
  | 'too-many-files';

export class WorkspaceInventoryError extends Error {
  public readonly code: WorkspaceInventoryErrorCode;

  public constructor(code: WorkspaceInventoryErrorCode) {
    super(`workspace-inventory:${code}`);
    this.name = 'WorkspaceInventoryError';
    this.code = code;
  }
}
