import { buildChangelog } from './changelog.js';
import { diffInventories } from './diff.js';
import { evaluateDistribution, type ReviewedDistributionEntry } from './distribution.js';
import { type ReleasePlan, type WorkspaceInventory } from './types.js';

/**
 * The whole answer to "what would this release be?".
 *
 * Composed rather than computed here: the diff, the gate and the changelog each
 * answer one question, and a plan is the three of them together plus what a
 * boot observed.
 */
export function planRelease(input: {
  readonly from: WorkspaceInventory | null;
  readonly to: WorkspaceInventory;
  readonly catalogue: readonly ReviewedDistributionEntry[];
  /**
   * What a sandbox boot of this state reported, when one was run.
   *
   * `null` means nobody checked. That is a different statement from "it did not
   * start", and a release record that conflated them would let an untested
   * build read as a tested one.
   */
  readonly bootOutcome?: string | null;
}): ReleasePlan {
  const diff = diffInventories({ from: input.from, to: input.to });
  return Object.freeze({
    fromInventorySha256: input.from?.inventorySha256 ?? null,
    toInventorySha256: input.to.inventorySha256,
    diff,
    distribution: evaluateDistribution({ inventory: input.to, catalogue: input.catalogue }),
    changelog: buildChangelog(diff),
    bootOutcome: input.bootOutcome ?? null,
  });
}
