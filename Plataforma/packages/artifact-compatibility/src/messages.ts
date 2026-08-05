import type {
  CompatibilityIssueCode,
  CompatibilityIssueReason,
  CompatibilityRecommendedAction,
} from '@voidfall/contracts';

/**
 * The human message is kept apart from the stable code on purpose: a sentence
 * may be rewritten or translated without breaking a consumer that branches on
 * `code` and `reason`. Nothing here interpolates observed data — that belongs to
 * the issue `detail`, which is sanitized separately.
 */

export type IssueKind = `${CompatibilityIssueCode}:${CompatibilityIssueReason}`;

const EXPLANATIONS: ReadonlyMap<IssueKind, string> = new Map<IssueKind, string>([
  [
    'minecraft-version-mismatch:declared-mismatch',
    'The mod declares a Minecraft version range that excludes the version this context runs.',
  ],
  [
    'minecraft-version-mismatch:not-declared',
    'The mod declares no Minecraft version, so nothing proves it was built for the version this context runs.',
  ],
  [
    'minecraft-version-mismatch:range-unsupported',
    'The declared Minecraft range is outside the supported range syntax, so it could not be resolved.',
  ],
  [
    'loader-mismatch:declared-mismatch',
    'The artifact declares a mod loader this context does not run.',
  ],
  [
    'loader-version-mismatch:declared-mismatch',
    'The mod declares a loader version range that excludes the loader version this context runs.',
  ],
  [
    'loader-version-mismatch:not-declared',
    'The mod constrains the loader version, but this context declares no loader version to compare it against.',
  ],
  [
    'loader-version-mismatch:range-unsupported',
    'The declared loader version range is outside the supported range syntax, so it could not be resolved.',
  ],
  [
    'side-mismatch:declared-mismatch',
    'The artifact was reviewed for a side this context does not serve.',
  ],
  [
    'side-mismatch:dependency-side-not-applicable',
    'The dependency is declared for the other side and was not evaluated in this context.',
  ],
  [
    'missing-required-dependency:not-declared',
    'A mandatory dependency is present in no artifact of this context.',
  ],
  [
    'missing-required-dependency:possibly-embedded',
    'A mandatory dependency is present in no artifact of this context, but the artifact declares embedded libraries that were never opened, so its absence could not be proven.',
  ],
  [
    'dependency-version-mismatch:declared-mismatch',
    'A dependency is present with a version the mod excludes.',
  ],
  [
    'dependency-version-mismatch:not-declared',
    'A dependency is present but declares no version, so the required range could not be resolved.',
  ],
  [
    'dependency-version-mismatch:range-unsupported',
    'The declared dependency range is outside the supported range syntax, so it could not be resolved.',
  ],
  [
    'duplicate-mod-id:duplicate-declaration',
    'More than one artifact declares the same mod id in this context.',
  ],
  [
    'duplicate-content:duplicate-declaration',
    'More than one artifact in this context carries identical content.',
  ],
  [
    'filename-collision:duplicate-declaration',
    'Two artifacts with different content claim the same filename in this context.',
  ],
  [
    'explicit-conflict:reviewed-conflict',
    'A reviewed conflict names two mods that would both be present in this context.',
  ],
  [
    'dependency-cycle:cyclic-declaration',
    'These mods require each other, so none of them can be admitted to this context on its own.',
  ],
  [
    'metadata-unverified:descriptor-unreadable',
    'A descriptor is present but could not be read within the strict reviewed subset, so the declaration is unknown rather than absent.',
  ],
  [
    'metadata-unverified:loader-not-declared',
    'The artifact declares no mod descriptor, so no loader, mod id or dependency could be read.',
  ],
  [
    'metadata-unverified:legacy-descriptor',
    'The artifact carries only a legacy descriptor, which has no reviewed parser, so its declaration could not be read.',
  ],
  [
    'metadata-unverified:mod-version-unresolved',
    'The mod version stayed an unresolved placeholder, so the identity of this mod cannot be stated.',
  ],
  [
    'metadata-unverified:side-not-reviewed',
    'No reviewed side exists for this artifact, and presence or filename may not stand in for that decision.',
  ],
  [
    'metadata-unverified:nested-libraries-not-inspected',
    'The artifact declares embedded libraries. They are reported as declarations and were never opened, so they carry no compatibility judgement of their own.',
  ],
  [
    'distribution-unreviewed:not-reviewed',
    'No review approved redistributing this artifact, so origin and licence remain unknown.',
  ],
]);

const ACTIONS: ReadonlyMap<IssueKind, CompatibilityRecommendedAction> = new Map<
  IssueKind,
  CompatibilityRecommendedAction
>([
  ['minecraft-version-mismatch:declared-mismatch', 'match-minecraft-version'],
  ['minecraft-version-mismatch:not-declared', 'review-metadata'],
  ['minecraft-version-mismatch:range-unsupported', 'review-metadata'],
  ['loader-mismatch:declared-mismatch', 'match-loader'],
  ['loader-version-mismatch:declared-mismatch', 'match-loader-version'],
  ['loader-version-mismatch:not-declared', 'review-metadata'],
  ['loader-version-mismatch:range-unsupported', 'review-metadata'],
  ['side-mismatch:declared-mismatch', 'match-side'],
  ['side-mismatch:dependency-side-not-applicable', 'review-metadata'],
  ['missing-required-dependency:not-declared', 'provide-dependency'],
  ['missing-required-dependency:possibly-embedded', 'provide-dependency'],
  ['dependency-version-mismatch:declared-mismatch', 'match-dependency-version'],
  ['dependency-version-mismatch:not-declared', 'review-metadata'],
  ['dependency-version-mismatch:range-unsupported', 'review-metadata'],
  ['duplicate-mod-id:duplicate-declaration', 'deduplicate-mod-id'],
  ['duplicate-content:duplicate-declaration', 'deduplicate-content'],
  ['filename-collision:duplicate-declaration', 'rename-artifact'],
  ['explicit-conflict:reviewed-conflict', 'resolve-conflict'],
  ['dependency-cycle:cyclic-declaration', 'review-metadata'],
  ['metadata-unverified:descriptor-unreadable', 'review-metadata'],
  ['metadata-unverified:loader-not-declared', 'review-metadata'],
  ['metadata-unverified:legacy-descriptor', 'review-metadata'],
  ['metadata-unverified:mod-version-unresolved', 'review-metadata'],
  ['metadata-unverified:side-not-reviewed', 'review-side'],
  ['metadata-unverified:nested-libraries-not-inspected', 'review-metadata'],
  ['distribution-unreviewed:not-reviewed', 'review-distribution'],
]);

/** Every kind the engine may emit, so a missing message cannot ship silently. */
export const KNOWN_ISSUE_KINDS: readonly IssueKind[] = Object.freeze([...EXPLANATIONS.keys()]);

export function explanationFor(kind: IssueKind): string {
  const explanation = EXPLANATIONS.get(kind);
  if (explanation === undefined) {
    throw new Error(`missing explanation for ${kind}`);
  }
  return explanation;
}

export function recommendedActionFor(kind: IssueKind): CompatibilityRecommendedAction {
  const action = ACTIONS.get(kind);
  if (action === undefined) {
    throw new Error(`missing recommended action for ${kind}`);
  }
  return action;
}

// A colon is excluded on purpose: no detail format needs one, and leaving it
// out means a Windows drive prefix cannot survive into a report.
const DETAIL_ALLOWED = /[A-Za-z0-9 ()[\],.;=<>_+*^~-]/u;

/**
 * Observed values are filtered to the charset the contract allows before they
 * reach a report. A declared range or version comes from an untrusted archive,
 * so it is sanitized here rather than trusted to be well behaved — a hostile
 * descriptor can neither smuggle a path into a report nor make the report fail
 * its own validation.
 */
export function safeDetail(value: string): string | null {
  let result = '';
  for (const character of value) {
    if (result.length >= 256) break;
    if (DETAIL_ALLOWED.test(character)) result += character;
  }
  const trimmed = result.trim();
  return trimmed.length === 0 ? null : trimmed;
}
