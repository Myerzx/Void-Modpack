import type { InventoriedMod, WorkspaceInventory } from '@voidfall/workspace-inventory';

/**
 * What changed between two versions of a workspace, and what may be built from it.
 *
 * A release is a claim about a difference: these mods were added, those files
 * changed, this is what you get if you take it. Everything here is computed
 * from two inventories, both of which carry a digest per file — so the claim
 * is derived, never typed by hand and never inferred from a version number.
 *
 * The other half is the distribution gate. Producing an artefact and being
 * allowed to hand it to somebody are different questions, and this module
 * refuses to let the second be assumed from the first.
 */

export type ModChangeKind = 'added' | 'removed' | 'updated' | 'rebuilt';

export interface ModChange {
  readonly kind: ModChangeKind;
  readonly modId: string;
  readonly displayName: string | null;
  /** `null` when the mod is new. */
  readonly fromVersion: string | null;
  /** `null` when the mod was removed. */
  readonly toVersion: string | null;
  readonly fromSha256: string | null;
  readonly toSha256: string | null;
}

export type FileChangeKind = 'added' | 'removed' | 'changed';

export interface FileChange {
  readonly kind: FileChangeKind;
  readonly path: string;
  readonly role: string;
  readonly fromSha256: string | null;
  readonly toSha256: string | null;
}

export interface WorkspaceDiff {
  readonly mods: readonly ModChange[];
  readonly files: readonly FileChange[];
  readonly totals: {
    readonly modsAdded: number;
    readonly modsRemoved: number;
    readonly modsUpdated: number;
    readonly filesChanged: number;
  };
  /** True when the two inventories are byte-for-byte the same set of files. */
  readonly identical: boolean;
}

/**
 * Why a file may not leave this machine.
 *
 * Taken from the reviewed catalogue, never inferred. A mod archive with no
 * provider metadata cannot be referenced by a pack manifest, and putting it in
 * an overrides folder is redistributing it — so a missing review is a refusal,
 * not a warning to click past.
 */
export type DistributionBlockReason =
  | 'provider-metadata-required'
  | 'license-and-authorship-required'
  | 'not-reviewed';

export interface DistributionBlock {
  readonly path: string;
  readonly reason: DistributionBlockReason;
}

export interface DistributionDecision {
  /** Whether an artefact built from this may be handed to anybody else. */
  readonly distributable: boolean;
  readonly blocks: readonly DistributionBlock[];
  /**
   * Artefacts the operator may still build for their own machine.
   *
   * A server archive somebody restores onto their own host is not
   * distribution, and refusing to build one would be treating a licence
   * question as a backup question.
   */
  readonly localUseOnly: boolean;
}

/** One line of a changelog, with the facts that produced it. */
export interface ChangelogEntry {
  readonly section: 'Added' | 'Removed' | 'Updated' | 'Configuration' | 'Content';
  readonly text: string;
}

export interface ReleasePlan {
  readonly fromInventorySha256: string | null;
  readonly toInventorySha256: string;
  readonly diff: WorkspaceDiff;
  readonly distribution: DistributionDecision;
  readonly changelog: readonly ChangelogEntry[];
  /**
   * What a boot of this state observed, when one was run.
   *
   * `null` means nobody checked, which is different from "it did not start" and
   * has to read differently in a release record.
   */
  readonly bootOutcome: string | null;
}

export type ReleasePlannerErrorCode = 'invalid-input' | 'inventories-not-comparable';

export class ReleasePlannerError extends Error {
  public readonly code: ReleasePlannerErrorCode;

  public constructor(code: ReleasePlannerErrorCode) {
    super(`release-planner:${code}`);
    this.name = 'ReleasePlannerError';
    this.code = code;
  }
}

export type { InventoriedMod, WorkspaceInventory };
