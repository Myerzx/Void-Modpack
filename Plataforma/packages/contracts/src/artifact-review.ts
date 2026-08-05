import { Type, type Static } from '@sinclair/typebox';
import { ArtifactCompatibilityReportSchema, ReviewedSideSchema } from './artifact-compatibility.js';
import {
  ArtifactInspectionReportSchema,
  DeclaredLoaderSchema,
  ModIdSchema,
} from './artifact-inspection.js';
import {
  ActorRefSchema,
  ContractSchemaVersion,
  FileNameSchema,
  IsoDateTimeSchema,
  Sha256Schema,
  UuidSchema,
} from './common.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

/**
 * Public contract for the Phase 8.3 artifact review workflow.
 *
 * A submission moves through a closed set of states and ends in a human
 * decision. Approval changes a review state and nothing else: it does not
 * install, copy or promote an artifact, and no state in this contract can put
 * one into a Minecraft runtime.
 *
 * Nothing here carries a path, a root, a quarantine location or raw bytes. An
 * artifact is identified by its SHA-256 and an opaque submission id.
 */

/**
 * `blocked` is terminal for analysis, not for review: a human may still reject
 * it explicitly, which is why the decision is recorded rather than implied.
 */
export const ArtifactSubmissionStateSchema = Type.Union([
  Type.Literal('uploaded'),
  Type.Literal('quarantined'),
  Type.Literal('analyzing'),
  Type.Literal('blocked'),
  Type.Literal('reviewable'),
  Type.Literal('approved'),
  Type.Literal('rejected'),
]);

/** Closed set of publishable failure codes. Nothing internal leaks through. */
export const ArtifactSubmissionFailureCodeSchema = Type.Union([
  Type.Literal('not-a-zip-container'),
  Type.Literal('truncated-archive'),
  Type.Literal('unsupported-archive-feature'),
  Type.Literal('encrypted-entry'),
  Type.Literal('content-too-large'),
  Type.Literal('metadata-unreadable'),
  Type.Literal('hash-mismatch'),
  Type.Literal('quarantine-rejected'),
  Type.Literal('analysis-failed'),
]);

export const ArtifactSubmissionFailureSchema = Type.Object(
  {
    code: ArtifactSubmissionFailureCodeSchema,
    stage: Type.Union([
      Type.Literal('upload'),
      Type.Literal('quarantine'),
      Type.Literal('inspection'),
      Type.Literal('compatibility'),
    ]),
  },
  { additionalProperties: false },
);

export const ArtifactReviewReasonCodeSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z][a-z0-9._-]{0,63}$',
});

/**
 * What the analysis concluded, in the compact shape a list needs. The full
 * inspection and compatibility reports are fetched separately; this summary
 * never restates them in a form that could drift from the stored originals.
 */
export const ArtifactAnalysisSummarySchema = Type.Object(
  {
    inspected: Type.Boolean(),
    analyzed: Type.Boolean(),
    loaders: Type.Array(DeclaredLoaderSchema, { maxItems: 5, uniqueItems: true }),
    modIds: Type.Array(ModIdSchema, { maxItems: 64, uniqueItems: true }),
    declaredVersions: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 64,
      uniqueItems: true,
    }),
    verdict: Type.Union([
      Type.Literal('compatible'),
      Type.Literal('incompatible'),
      Type.Literal('unknown'),
      Type.Null(),
    ]),
    blockerCount: Type.Integer({ minimum: 0, maximum: 16_384 }),
    warningCount: Type.Integer({ minimum: 0, maximum: 16_384 }),
    informationCount: Type.Integer({ minimum: 0, maximum: 16_384 }),
    /** Proven blockers are what separates `blocked` from `reviewable`. */
    provenBlockerCount: Type.Integer({ minimum: 0, maximum: 16_384 }),
  },
  { additionalProperties: false },
);

/**
 * A recorded human decision. Actor, reason and the analyzed hash are all
 * mandatory: a decision that does not name the exact bytes it judged could be
 * replayed against a different artifact.
 */
export const ArtifactReviewDecisionSchema = Type.Object(
  {
    decision: Type.Union([Type.Literal('approved'), Type.Literal('rejected')]),
    actor: ActorRefSchema,
    reasonCode: ArtifactReviewReasonCodeSchema,
    analyzedSha256: Sha256Schema,
    decidedAt: IsoDateTimeSchema,
  },
  { additionalProperties: false },
);

export const ArtifactSubmissionSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    submissionId: UuidSchema,
    filename: FileNameSchema,
    sha256: Sha256Schema,
    sizeBytes: Type.Integer({ minimum: 1, maximum: 1_073_741_824 }),
    state: ArtifactSubmissionStateSchema,
    submittedBy: ActorRefSchema,
    /** Recorded by review only; `null` means nobody decided yet. */
    reviewedSide: ReviewedSideSchema,
    submittedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    version: Type.Integer({ minimum: 1, maximum: 9_007_199_254_740_991 }),
    analysis: ArtifactAnalysisSummarySchema,
    failure: Type.Union([ArtifactSubmissionFailureSchema, Type.Null()]),
    decision: Type.Union([ArtifactReviewDecisionSchema, Type.Null()]),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/artifact-submission.schema.json',
    additionalProperties: false,
  },
);

export const ArtifactSubmissionPageSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    submissions: Type.Array(ArtifactSubmissionSchema, { maxItems: 100 }),
    total: Type.Integer({ minimum: 0 }),
    limit: Type.Integer({ minimum: 1, maximum: 100 }),
    offset: Type.Integer({ minimum: 0 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/artifact-submission-page.schema.json',
    additionalProperties: false,
  },
);

/**
 * The full record behind one submission. The reports are the stored originals,
 * so a reader never has to trust a restatement of them.
 */
export const ArtifactSubmissionDetailSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    submission: ArtifactSubmissionSchema,
    inspection: Type.Union([ArtifactInspectionReportSchema, Type.Null()]),
    compatibility: Type.Union([ArtifactCompatibilityReportSchema, Type.Null()]),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/artifact-submission-detail.schema.json',
    additionalProperties: false,
  },
);

export const ArtifactUploadAcceptanceSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    submissionId: UuidSchema,
    sha256: Sha256Schema,
    sizeBytes: Type.Integer({ minimum: 1, maximum: 1_073_741_824 }),
    state: ArtifactSubmissionStateSchema,
    jobId: Type.Union([UuidSchema, Type.Null()]),
    replayed: Type.Boolean(),
    acceptedAt: IsoDateTimeSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/artifact-upload-acceptance.schema.json',
    additionalProperties: false,
  },
);

/**
 * A decision request. It restates the hash it believes was analyzed and the
 * record version it read, so a decision taken against a stale analysis is
 * refused rather than applied.
 */
export const ArtifactReviewDecisionRequestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    decision: Type.Union([Type.Literal('approve'), Type.Literal('reject')]),
    reasonCode: ArtifactReviewReasonCodeSchema,
    analyzedSha256: Sha256Schema,
    expectedVersion: Type.Integer({ minimum: 1, maximum: 9_007_199_254_740_991 }),
    /** A reviewer may record the side along with the decision. */
    reviewedSide: Type.Optional(ReviewedSideSchema),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/artifact-review-decision-request.schema.json',
    additionalProperties: false,
  },
);

export type ArtifactSubmissionState = Static<typeof ArtifactSubmissionStateSchema>;
export type ArtifactSubmissionFailureCode = Static<typeof ArtifactSubmissionFailureCodeSchema>;
export type ArtifactSubmissionFailure = Static<typeof ArtifactSubmissionFailureSchema>;
export type ArtifactAnalysisSummary = Static<typeof ArtifactAnalysisSummarySchema>;
export type ArtifactReviewDecision = Static<typeof ArtifactReviewDecisionSchema>;
export type ArtifactSubmission = Static<typeof ArtifactSubmissionSchema>;
export type ArtifactSubmissionPage = Static<typeof ArtifactSubmissionPageSchema>;
export type ArtifactSubmissionDetail = Static<typeof ArtifactSubmissionDetailSchema>;
export type ArtifactUploadAcceptance = Static<typeof ArtifactUploadAcceptanceSchema>;
export type ArtifactReviewDecisionRequest = Static<typeof ArtifactReviewDecisionRequestSchema>;

/** States in which no analysis may be reported yet. */
const PRE_ANALYSIS_STATES = new Set<ArtifactSubmissionState>(['uploaded', 'quarantined']);
/** States a human decision closes. */
const DECIDED_STATES = new Set<ArtifactSubmissionState>(['approved', 'rejected']);

const ALLOWED_TRANSITIONS: Readonly<Record<ArtifactSubmissionState, readonly ArtifactSubmissionState[]>> =
  Object.freeze({
    uploaded: ['quarantined', 'blocked'],
    quarantined: ['analyzing', 'blocked'],
    analyzing: ['blocked', 'reviewable'],
    // A blocked artifact is never silently admitted; the only way forward is an
    // explicit rejection recorded by a person.
    blocked: ['rejected'],
    reviewable: ['approved', 'rejected'],
    approved: [],
    rejected: [],
  });

export function isAllowedSubmissionTransition(
  from: ArtifactSubmissionState,
  to: ArtifactSubmissionState,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function validateArtifactSubmission(
  value: unknown,
): ContractValidationResult<ArtifactSubmission> {
  const result = validateContract(ArtifactSubmissionSchema, value);
  if (!result.success) return result;

  const submission = result.value;
  const issues: ContractValidationIssue[] = [];
  const { analysis, state } = submission;

  if (PRE_ANALYSIS_STATES.has(state) && (analysis.inspected || analysis.analyzed)) {
    issues.push(semanticIssue('/analysis', 'no analysis may be reported before it runs'));
  }
  if (!analysis.inspected && analysis.analyzed) {
    issues.push(semanticIssue('/analysis/analyzed', 'compatibility cannot run without an inspection'));
  }
  if (!analysis.analyzed && analysis.verdict !== null) {
    issues.push(semanticIssue('/analysis/verdict', 'a verdict requires a completed analysis'));
  }
  if (analysis.analyzed && analysis.verdict === null) {
    issues.push(semanticIssue('/analysis/verdict', 'a completed analysis must state a verdict'));
  }
  if (analysis.provenBlockerCount > analysis.blockerCount) {
    issues.push(semanticIssue('/analysis/provenBlockerCount', 'proven blockers cannot exceed all blockers'));
  }
  if (!analysis.inspected && (analysis.loaders.length > 0 || analysis.modIds.length > 0)) {
    issues.push(semanticIssue('/analysis', 'declarations cannot exist without an inspection'));
  }

  // `reviewable` is the state a person may act on, so it may not hide a proven
  // blocker: that combination belongs in `blocked`.
  if (state === 'reviewable' && analysis.provenBlockerCount > 0) {
    issues.push(semanticIssue('/state', 'a proven blocker must leave the submission blocked'));
  }
  if (state === 'blocked' && analysis.provenBlockerCount === 0 && submission.failure === null) {
    issues.push(semanticIssue('/state', 'blocked requires a proven blocker or a recorded failure'));
  }
  if (state === 'approved' && analysis.provenBlockerCount > 0) {
    issues.push(semanticIssue('/state', 'a proven blocker cannot be approved'));
  }

  if (DECIDED_STATES.has(state)) {
    if (submission.decision === null) {
      issues.push(semanticIssue('/decision', 'a decided submission must record its decision'));
    } else {
      if (submission.decision.decision !== state) {
        issues.push(semanticIssue('/decision/decision', 'the decision must match the state'));
      }
      // The decision names the exact bytes it judged.
      if (submission.decision.analyzedSha256 !== submission.sha256) {
        issues.push(
          semanticIssue('/decision/analyzedSha256', 'a decision must name the analyzed artifact'),
        );
      }
    }
  } else if (submission.decision !== null) {
    issues.push(semanticIssue('/decision', 'only a decided submission may carry a decision'));
  }

  return appendSemanticIssues(result, issues);
}

export function validateArtifactSubmissionPage(
  value: unknown,
): ContractValidationResult<ArtifactSubmissionPage> {
  const result = validateContract(ArtifactSubmissionPageSchema, value);
  if (!result.success) return result;

  const page = result.value;
  const issues: ContractValidationIssue[] = [];
  if (page.submissions.length > page.limit) {
    issues.push(semanticIssue('/submissions', 'a page cannot exceed its limit'));
  }
  if (page.total < page.submissions.length) {
    issues.push(semanticIssue('/total', 'the total cannot be smaller than the page'));
  }
  const identifiers = new Set(page.submissions.map((submission) => submission.submissionId));
  if (identifiers.size !== page.submissions.length) {
    issues.push(semanticIssue('/submissions', 'a submission may appear only once in a page'));
  }
  for (const [index, submission] of page.submissions.entries()) {
    const nested = validateArtifactSubmission(submission);
    if (!nested.success) {
      for (const issue of nested.issues) {
        issues.push(semanticIssue(`/submissions/${index}${issue.path}`, issue.message));
      }
    }
  }
  return appendSemanticIssues(result, issues);
}

export function validateArtifactSubmissionDetail(
  value: unknown,
): ContractValidationResult<ArtifactSubmissionDetail> {
  const result = validateContract(ArtifactSubmissionDetailSchema, value);
  if (!result.success) return result;

  const detail = result.value;
  const issues: ContractValidationIssue[] = [];
  const nested = validateArtifactSubmission(detail.submission);
  if (!nested.success) {
    for (const issue of nested.issues) {
      issues.push(semanticIssue(`/submission${issue.path}`, issue.message));
    }
  }
  if (detail.inspection !== null && detail.inspection.sha256 !== detail.submission.sha256) {
    issues.push(semanticIssue('/inspection/sha256', 'the inspection must describe this artifact'));
  }
  if (detail.submission.analysis.inspected && detail.inspection === null) {
    issues.push(semanticIssue('/inspection', 'an inspected submission must carry its report'));
  }
  if (detail.submission.analysis.analyzed && detail.compatibility === null) {
    issues.push(semanticIssue('/compatibility', 'an analyzed submission must carry its report'));
  }
  if (detail.compatibility !== null) {
    // The stored compatibility report must be about this artifact.
    const describesArtifact = detail.compatibility.artifacts.some(
      (artifact) => artifact.sha256 === detail.submission.sha256,
    );
    if (!describesArtifact) {
      issues.push(semanticIssue('/compatibility/artifacts', 'the report must judge this artifact'));
    }
  }
  return appendSemanticIssues(result, issues);
}

export function validateArtifactReviewDecisionRequest(
  value: unknown,
): ContractValidationResult<ArtifactReviewDecisionRequest> {
  return validateContract(ArtifactReviewDecisionRequestSchema, value);
}

export function validateArtifactUploadAcceptance(
  value: unknown,
): ContractValidationResult<ArtifactUploadAcceptance> {
  return validateContract(ArtifactUploadAcceptanceSchema, value);
}
