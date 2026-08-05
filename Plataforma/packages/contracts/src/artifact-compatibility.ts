import { Type, type Static } from '@sinclair/typebox';
import { ArtifactInspectionReportSchema, InspectionEvidenceSchema, ModIdSchema } from './artifact-inspection.js';
import { ContractSchemaVersion, FileNameSchema, IsoDateTimeSchema, Sha256Schema, SlugSchema } from './common.js';
import { InventoryRuntimeSchema } from './inventory-snapshot.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

/**
 * Public contract for the Phase 8.2 compatibility engine.
 *
 * Phase 8.1 answers "what does this file declare?". This contract answers the
 * next question — "may this declaration enter that runtime?" — and nothing
 * further. It never installs, never repairs and never invents a correction: an
 * issue carries a stable code, the evidence it was derived from and a manual
 * action a human still has to decide on.
 *
 * Two axes are kept apart on purpose. `code` names the *subject* of an issue and
 * is stable forever; `determinacy` states how strongly it was established. A
 * `proven` issue means the engine demonstrated the problem from a declaration.
 * An `unproven` issue means the engine could not demonstrate its *absence* —
 * unknown blocks, it never passes silently.
 */

export const ArtifactCompatibilityContextKindSchema = Type.Union([
  Type.Literal('launcher_current'),
  Type.Literal('server_active'),
]);

/**
 * A target the artifact would have to run in. Every context in a plan is a
 * target: unlike the Phase 7.0 documentation analysis, this engine has no
 * "reference" or "historical" context whose findings could be softened.
 */
export const ArtifactCompatibilityContextSchema = Type.Object(
  {
    contextId: SlugSchema,
    kind: ArtifactCompatibilityContextKindSchema,
    side: Type.Union([Type.Literal('client'), Type.Literal('server')]),
    runtime: InventoryRuntimeSchema,
    javaVersion: Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Null()]),
  },
  { additionalProperties: false },
);

/**
 * The side an artifact was *reviewed* for. It is never derived from presence,
 * filename or declared metadata; `null` means no human decided yet, which the
 * engine reports as unverified rather than assuming `both`.
 */
export const ReviewedSideSchema = Type.Union([
  Type.Literal('client'),
  Type.Literal('server'),
  Type.Literal('both'),
  Type.Null(),
]);

export const CompatibilityCandidateSchema = Type.Object(
  {
    artifactId: SlugSchema,
    filename: FileNameSchema,
    /** The Phase 8.1 report, verbatim. This contract adds no declaration of its own. */
    inspection: ArtifactInspectionReportSchema,
    reviewedSide: ReviewedSideSchema,
    targetContextIds: Type.Array(SlugSchema, { minItems: 1, maxItems: 8, uniqueItems: true }),
    /** Whether a human approved redistributing this artifact. Never inferred. */
    distributionReviewed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CompatibilityInstalledModSchema = Type.Object(
  {
    modId: ModIdSchema,
    version: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  },
  { additionalProperties: false },
);

/**
 * An artifact already approved for a context. It is a reviewed summary, not an
 * inspection: the engine compares against it but never re-judges it.
 */
export const CompatibilityInstalledArtifactSchema = Type.Object(
  {
    artifactId: SlugSchema,
    filename: FileNameSchema,
    sha256: Sha256Schema,
    contextIds: Type.Array(SlugSchema, { minItems: 1, maxItems: 8, uniqueItems: true }),
    mods: Type.Array(CompatibilityInstalledModSchema, { maxItems: 64 }),
  },
  { additionalProperties: false },
);

/**
 * A conflict a human reviewed and recorded. Phase 8.1 does not read any "breaks"
 * declaration, so an explicit conflict can only enter the engine through review.
 */
export const CompatibilityExplicitConflictSchema = Type.Object(
  {
    modId: ModIdSchema,
    conflictsWith: ModIdSchema,
  },
  { additionalProperties: false },
);

export const ArtifactCompatibilityPlanSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    analysisId: SlugSchema,
    generatedAt: IsoDateTimeSchema,
    contexts: Type.Array(ArtifactCompatibilityContextSchema, { minItems: 1, maxItems: 8 }),
    candidates: Type.Array(CompatibilityCandidateSchema, { minItems: 1, maxItems: 256 }),
    installed: Type.Array(CompatibilityInstalledArtifactSchema, { maxItems: 4_096 }),
    explicitConflicts: Type.Array(CompatibilityExplicitConflictSchema, { maxItems: 512 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/artifact-compatibility-plan.schema.json',
    additionalProperties: false,
  },
);

/** Stable issue codes. A code names the subject and never changes meaning. */
export const CompatibilityIssueCodeSchema = Type.Union([
  Type.Literal('minecraft-version-mismatch'),
  Type.Literal('loader-mismatch'),
  Type.Literal('loader-version-mismatch'),
  Type.Literal('side-mismatch'),
  Type.Literal('missing-required-dependency'),
  Type.Literal('dependency-version-mismatch'),
  Type.Literal('duplicate-mod-id'),
  Type.Literal('duplicate-content'),
  Type.Literal('filename-collision'),
  Type.Literal('explicit-conflict'),
  Type.Literal('dependency-cycle'),
  Type.Literal('metadata-unverified'),
  Type.Literal('distribution-unreviewed'),
]);

/**
 * Why the engine reached the issue. Closed so a reader can branch on it, and
 * separate from the human message, which may be rewritten without breaking it.
 */
export const CompatibilityIssueReasonSchema = Type.Union([
  Type.Literal('declared-mismatch'),
  Type.Literal('not-declared'),
  Type.Literal('range-unsupported'),
  Type.Literal('descriptor-unreadable'),
  Type.Literal('loader-not-declared'),
  Type.Literal('legacy-descriptor'),
  Type.Literal('mod-version-unresolved'),
  Type.Literal('side-not-reviewed'),
  Type.Literal('nested-libraries-not-inspected'),
  Type.Literal('possibly-embedded'),
  Type.Literal('dependency-side-not-applicable'),
  Type.Literal('duplicate-declaration'),
  Type.Literal('cyclic-declaration'),
  Type.Literal('reviewed-conflict'),
  Type.Literal('not-reviewed'),
]);

/**
 * Manual actions only. There is deliberately no action that a machine could
 * execute on its own: this phase explains, it does not repair.
 */
export const CompatibilityRecommendedActionSchema = Type.Union([
  Type.Literal('review-metadata'),
  Type.Literal('match-minecraft-version'),
  Type.Literal('match-loader'),
  Type.Literal('match-loader-version'),
  Type.Literal('match-side'),
  Type.Literal('review-side'),
  Type.Literal('provide-dependency'),
  Type.Literal('match-dependency-version'),
  Type.Literal('deduplicate-mod-id'),
  Type.Literal('deduplicate-content'),
  Type.Literal('rename-artifact'),
  Type.Literal('resolve-conflict'),
  Type.Literal('review-distribution'),
]);

/**
 * Observed detail such as `required=[1.20.1];running=1.19.2`. Bounded to a
 * charset that cannot express a filesystem path, a drive prefix, a quote or a
 * control character, so no location can leak through an explanation.
 */
export const CompatibilityIssueDetailSchema = Type.Union([
  Type.String({ minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9 ()\\[\\],.;=<>_+*^~-]+$' }),
  Type.Null(),
]);

export const CompatibilityIssueSchema = Type.Object(
  {
    code: CompatibilityIssueCodeSchema,
    severity: Type.Union([
      Type.Literal('blocker'),
      Type.Literal('warning'),
      Type.Literal('information'),
    ]),
    /** `proven`: demonstrated from a declaration. `unproven`: absence could not be shown. */
    determinacy: Type.Union([Type.Literal('proven'), Type.Literal('unproven')]),
    reason: CompatibilityIssueReasonSchema,
    contextIds: Type.Array(SlugSchema, { minItems: 1, maxItems: 8, uniqueItems: true }),
    artifactIds: Type.Array(SlugSchema, { minItems: 1, maxItems: 16, uniqueItems: true }),
    modIds: Type.Array(ModIdSchema, { maxItems: 16, uniqueItems: true }),
    /** Closed union of the reviewed descriptors the issue was derived from. */
    evidence: Type.Array(InspectionEvidenceSchema, { maxItems: 6, uniqueItems: true }),
    detail: CompatibilityIssueDetailSchema,
    explanation: Type.String({ minLength: 1, maxLength: 512, pattern: '^[^\\u0000-\\u001f]+$' }),
    recommendedAction: CompatibilityRecommendedActionSchema,
  },
  { additionalProperties: false },
);

export const CompatibilityStatusSchema = Type.Union([
  Type.Literal('compatible'),
  Type.Literal('incompatible'),
  Type.Literal('unknown'),
]);

export const CompatibilityContextEvaluationSchema = Type.Object(
  {
    contextId: SlugSchema,
    status: CompatibilityStatusSchema,
  },
  { additionalProperties: false },
);

export const CompatibilityArtifactEvaluationSchema = Type.Object(
  {
    artifactId: SlugSchema,
    filename: FileNameSchema,
    sha256: Sha256Schema,
    modIds: Type.Array(ModIdSchema, { maxItems: 64, uniqueItems: true }),
    status: CompatibilityStatusSchema,
    contexts: Type.Array(CompatibilityContextEvaluationSchema, { minItems: 1, maxItems: 8 }),
  },
  { additionalProperties: false },
);

/**
 * Installed artifacts an issue points at. They are listed so every identifier a
 * report cites is also declared by that report, exactly as Phase 8.1 requires of
 * its evidence; they are not judged here.
 */
export const CompatibilityRelatedArtifactSchema = Type.Object(
  {
    artifactId: SlugSchema,
    filename: FileNameSchema,
    sha256: Sha256Schema,
    modIds: Type.Array(ModIdSchema, { maxItems: 64, uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const ArtifactCompatibilityReportSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    analysisId: SlugSchema,
    generatedAt: IsoDateTimeSchema,
    contexts: Type.Array(ArtifactCompatibilityContextSchema, { minItems: 1, maxItems: 8 }),
    artifacts: Type.Array(CompatibilityArtifactEvaluationSchema, { minItems: 1, maxItems: 256 }),
    relatedInstalled: Type.Array(CompatibilityRelatedArtifactSchema, { maxItems: 4_096 }),
    issues: Type.Array(CompatibilityIssueSchema, { maxItems: 16_384 }),
    summary: Type.Object(
      {
        compatibleArtifacts: Type.Integer({ minimum: 0 }),
        incompatibleArtifacts: Type.Integer({ minimum: 0 }),
        unknownArtifacts: Type.Integer({ minimum: 0 }),
        blockerCount: Type.Integer({ minimum: 0 }),
        warningCount: Type.Integer({ minimum: 0 }),
        informationCount: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/artifact-compatibility-report.schema.json',
    additionalProperties: false,
  },
);

export type ArtifactCompatibilityContextKind = Static<typeof ArtifactCompatibilityContextKindSchema>;
export type ArtifactCompatibilityContext = Static<typeof ArtifactCompatibilityContextSchema>;
export type ReviewedSide = Static<typeof ReviewedSideSchema>;
export type CompatibilityCandidate = Static<typeof CompatibilityCandidateSchema>;
export type CompatibilityInstalledMod = Static<typeof CompatibilityInstalledModSchema>;
export type CompatibilityInstalledArtifact = Static<typeof CompatibilityInstalledArtifactSchema>;
export type CompatibilityExplicitConflict = Static<typeof CompatibilityExplicitConflictSchema>;
export type ArtifactCompatibilityPlan = Static<typeof ArtifactCompatibilityPlanSchema>;
export type CompatibilityIssueCode = Static<typeof CompatibilityIssueCodeSchema>;
export type CompatibilityIssueReason = Static<typeof CompatibilityIssueReasonSchema>;
export type CompatibilityRecommendedAction = Static<typeof CompatibilityRecommendedActionSchema>;
export type CompatibilityIssue = Static<typeof CompatibilityIssueSchema>;
export type CompatibilityStatus = Static<typeof CompatibilityStatusSchema>;
export type CompatibilityContextEvaluation = Static<typeof CompatibilityContextEvaluationSchema>;
export type CompatibilityArtifactEvaluation = Static<typeof CompatibilityArtifactEvaluationSchema>;
export type CompatibilityRelatedArtifact = Static<typeof CompatibilityRelatedArtifactSchema>;
export type ArtifactCompatibilityReport = Static<typeof ArtifactCompatibilityReportSchema>;

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function contextIssues(contexts: readonly ArtifactCompatibilityContext[]): ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = [];
  for (const duplicate of duplicateValues(contexts.map((context) => context.contextId))) {
    issues.push(semanticIssue('/contexts', `duplicate context id: ${duplicate}`));
  }
  for (const [index, context] of contexts.entries()) {
    // A target that cannot load mods is not a compatibility target at all.
    if (context.runtime.loader === 'vanilla') {
      issues.push(semanticIssue(`/contexts/${index}/runtime/loader`, 'a target context must declare a mod loader'));
    }
    if (context.kind === 'launcher_current' && context.side !== 'client') {
      issues.push(semanticIssue(`/contexts/${index}/side`, 'launcher_current must be client'));
    }
    if (context.kind === 'server_active' && context.side !== 'server') {
      issues.push(semanticIssue(`/contexts/${index}/side`, 'server_active must be server'));
    }
  }
  return issues;
}

export function validateArtifactCompatibilityPlan(
  value: unknown,
): ContractValidationResult<ArtifactCompatibilityPlan> {
  const result = validateContract(ArtifactCompatibilityPlanSchema, value);
  if (!result.success) return result;

  const plan = result.value;
  const issues = contextIssues(plan.contexts);
  const contextIds = new Set(plan.contexts.map((context) => context.contextId));
  const candidateIds = new Set(plan.candidates.map((candidate) => candidate.artifactId));

  for (const duplicate of duplicateValues(plan.candidates.map((candidate) => candidate.artifactId))) {
    issues.push(semanticIssue('/candidates', `duplicate artifact id: ${duplicate}`));
  }
  for (const duplicate of duplicateValues(plan.installed.map((artifact) => artifact.artifactId))) {
    issues.push(semanticIssue('/installed', `duplicate artifact id: ${duplicate}`));
  }

  for (const [index, candidate] of plan.candidates.entries()) {
    if (candidate.targetContextIds.some((contextId) => !contextIds.has(contextId))) {
      issues.push(
        semanticIssue(`/candidates/${index}/targetContextIds`, 'a target context must exist in the plan'),
      );
    }
  }
  for (const [index, artifact] of plan.installed.entries()) {
    if (artifact.contextIds.some((contextId) => !contextIds.has(contextId))) {
      issues.push(semanticIssue(`/installed/${index}/contextIds`, 'an installed context must exist in the plan'));
    }
    // A candidate is being judged; it cannot also be presented as settled.
    if (candidateIds.has(artifact.artifactId)) {
      issues.push(
        semanticIssue(`/installed/${index}/artifactId`, 'an artifact cannot be both candidate and installed'),
      );
    }
  }

  const conflictKeys = plan.explicitConflicts.map((conflict) => `${conflict.modId} ${conflict.conflictsWith}`);
  for (const duplicate of duplicateValues(conflictKeys)) {
    issues.push(semanticIssue('/explicitConflicts', `duplicate conflict: ${duplicate.replace(' ', ' with ')}`));
  }
  for (const [index, conflict] of plan.explicitConflicts.entries()) {
    if (conflict.modId === conflict.conflictsWith) {
      issues.push(semanticIssue(`/explicitConflicts/${index}`, 'a mod cannot conflict with itself'));
    }
  }

  return appendSemanticIssues(result, issues);
}

export function validateArtifactCompatibilityReport(
  value: unknown,
): ContractValidationResult<ArtifactCompatibilityReport> {
  const result = validateContract(ArtifactCompatibilityReportSchema, value);
  if (!result.success) return result;

  const report = result.value;
  const issues = contextIssues(report.contexts);
  const contextIds = new Set(report.contexts.map((context) => context.contextId));
  const artifactIds = new Set(report.artifacts.map((artifact) => artifact.artifactId));
  const relatedIds = new Set(report.relatedInstalled.map((artifact) => artifact.artifactId));
  const knownIds = new Set([...artifactIds, ...relatedIds]);
  const declaredModIds = new Set([
    ...report.artifacts.flatMap((artifact) => artifact.modIds),
    ...report.relatedInstalled.flatMap((artifact) => artifact.modIds),
  ]);

  for (const duplicate of duplicateValues(report.artifacts.map((artifact) => artifact.artifactId))) {
    issues.push(semanticIssue('/artifacts', `duplicate artifact id: ${duplicate}`));
  }
  for (const duplicate of duplicateValues(report.relatedInstalled.map((artifact) => artifact.artifactId))) {
    issues.push(semanticIssue('/relatedInstalled', `duplicate artifact id: ${duplicate}`));
  }
  for (const [index, artifact] of report.artifacts.entries()) {
    if (relatedIds.has(artifact.artifactId)) {
      issues.push(
        semanticIssue(`/artifacts/${index}/artifactId`, 'an evaluated artifact cannot also be listed as installed'),
      );
    }
    const evaluatedContextIds = artifact.contexts.map((context) => context.contextId);
    if (
      duplicateValues(evaluatedContextIds).length > 0 ||
      evaluatedContextIds.some((contextId) => !contextIds.has(contextId))
    ) {
      issues.push(
        semanticIssue(`/artifacts/${index}/contexts`, 'an artifact must evaluate each of its contexts exactly once'),
      );
    }
  }

  for (const [index, issue] of report.issues.entries()) {
    // Every identifier an issue cites must be declared by the report itself,
    // so no arbitrary name can be reported as evidence.
    if (issue.artifactIds.some((artifactId) => !knownIds.has(artifactId))) {
      issues.push(semanticIssue(`/issues/${index}/artifactIds`, 'an issue artifact must be declared by the report'));
    }
    if (!issue.artifactIds.some((artifactId) => artifactIds.has(artifactId))) {
      issues.push(
        semanticIssue(`/issues/${index}/artifactIds`, 'an issue must cite at least one evaluated artifact'),
      );
    }
    if (issue.contextIds.some((contextId) => !contextIds.has(contextId))) {
      issues.push(semanticIssue(`/issues/${index}/contextIds`, 'an issue context must exist in the report'));
    }
    if (issue.modIds.some((modId) => !declaredModIds.has(modId))) {
      issues.push(semanticIssue(`/issues/${index}/modIds`, 'an issue mod must be declared by the report'));
    }
    // Unknown blocks. A merely unproven issue may never be downgraded below the
    // level that stops an approval.
    if (issue.determinacy === 'unproven' && issue.severity !== 'blocker') {
      issues.push(semanticIssue(`/issues/${index}/severity`, 'an unproven issue must block'));
    }
  }

  const summary = report.summary;
  const statusCount = (status: CompatibilityStatus): number =>
    report.artifacts.filter((artifact) => artifact.status === status).length;
  if (
    summary.compatibleArtifacts !== statusCount('compatible') ||
    summary.incompatibleArtifacts !== statusCount('incompatible') ||
    summary.unknownArtifacts !== statusCount('unknown')
  ) {
    issues.push(semanticIssue('/summary', 'artifact status totals must match the report'));
  }
  const severityCount = (severity: CompatibilityIssue['severity']): number =>
    report.issues.filter((issue) => issue.severity === severity).length;
  if (
    summary.blockerCount !== severityCount('blocker') ||
    summary.warningCount !== severityCount('warning') ||
    summary.informationCount !== severityCount('information')
  ) {
    issues.push(semanticIssue('/summary', 'issue totals must match the report'));
  }

  return appendSemanticIssues(result, issues);
}
