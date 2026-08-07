import {
  type DistributionBlock,
  type DistributionBlockReason,
  type DistributionDecision,
  type WorkspaceInventory,
} from './types.js';

/**
 * Decides whether an artefact may be handed to anybody else.
 *
 * Building and distributing are different questions, and this module exists so
 * the second is never assumed from the first. A server archive an operator
 * restores onto their own host is a backup; the same archive sent to a friend
 * redistributes every mod in it.
 *
 * The rule from the repository's own gates: **never infer that an asset is
 * redistributable.** A mod archive with no reviewed provider metadata cannot be
 * referenced by a pack manifest — there is no project or file id to reference
 * it with — and putting it in an `overrides` folder instead is redistributing
 * the bytes. Both roads need the review, so a missing one is a refusal rather
 * than a warning to click past.
 */

/** How the reviewed catalogue describes a file's distribution status. */
export interface ReviewedDistributionEntry {
  /** File name as the catalogue records it. */
  readonly fileName: string;
  readonly sha256: string;
  readonly review: string;
}

const APPROVED_REVIEWS: ReadonlySet<string> = new Set(['approved', 'distribution-approved']);

function reasonFor(review: string | undefined): DistributionBlockReason {
  if (review === undefined) return 'not-reviewed';
  if (review === 'provider-metadata-required') return 'provider-metadata-required';
  if (review === 'license-and-authorship-required') return 'license-and-authorship-required';
  return 'not-reviewed';
}

export function evaluateDistribution(input: {
  readonly inventory: WorkspaceInventory;
  /** The reviewed catalogue. Absent entries are unreviewed, never assumed fine. */
  readonly catalogue: readonly ReviewedDistributionEntry[];
}): DistributionDecision {
  const byDigest = new Map(input.catalogue.map((entry) => [entry.sha256.toLowerCase(), entry]));
  const blocks: DistributionBlock[] = [];

  for (const mod of input.inventory.mods) {
    // Matched by digest rather than by file name. A renamed jar is the same
    // bytes and the same licence question; a same-named jar with different
    // bytes is a different artefact that nobody reviewed.
    const entry = byDigest.get(mod.archiveSha256.toLowerCase());
    if (entry !== undefined && APPROVED_REVIEWS.has(entry.review)) continue;
    blocks.push({ path: mod.archivePath, reason: reasonFor(entry?.review) });
  }

  // Archives that declared no mod are still bytes somebody wrote, and shipping
  // them needs the same evidence as any other.
  for (const archive of input.inventory.undeclaredArchives) {
    const entry = byDigest.get(archive.sha256.toLowerCase());
    if (entry !== undefined && APPROVED_REVIEWS.has(entry.review)) continue;
    blocks.push({ path: archive.path, reason: reasonFor(entry?.review) });
  }

  blocks.sort((left, right) => left.path.localeCompare(right.path, 'en-US'));

  return Object.freeze({
    distributable: blocks.length === 0,
    blocks: Object.freeze(blocks),
    // Always true: an operator may always build for their own machine. The gate
    // is about handing it to somebody, not about making it.
    localUseOnly: blocks.length > 0,
  });
}

/**
 * Whether a CurseForge pack can be produced at all.
 *
 * A CurseForge manifest references mods by project and file id. Without them
 * the only way to include a mod is to copy the jar into `overrides/`, which is
 * redistribution — so an export with unreviewed mods is not a smaller export,
 * it is a licence violation with a progress bar.
 */
export function canExportCurseForgePack(decision: DistributionDecision): {
  readonly allowed: boolean;
  readonly refusal: string | null;
} {
  if (decision.distributable) return { allowed: true, refusal: null };
  const withoutMetadata = decision.blocks.filter(
    (block) => block.reason === 'provider-metadata-required',
  ).length;
  const withoutLicence = decision.blocks.filter(
    (block) => block.reason === 'license-and-authorship-required',
  ).length;
  const unreviewed = decision.blocks.length - withoutMetadata - withoutLicence;
  return {
    allowed: false,
    refusal:
      `${String(decision.blocks.length)} archive(s) cannot be redistributed: ` +
      `${String(withoutMetadata)} need provider metadata, ` +
      `${String(withoutLicence)} need licence and authorship, ` +
      `${String(unreviewed)} were never reviewed.`,
  };
}
