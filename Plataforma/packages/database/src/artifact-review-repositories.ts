import {
  isAllowedSubmissionTransition,
  validateArtifactSubmission,
  type ActorRef,
  type ArtifactCompatibilityReport,
  type ArtifactInspectionReportContract,
  type ArtifactSubmission,
  type ArtifactSubmissionFailure,
  type ArtifactSubmissionPage,
  type ArtifactSubmissionState,
} from '@voidfall/contracts';

import type { Database, SqlClient } from './database.js';

/**
 * Durable storage for the Phase 8.3 artifact review workflow.
 *
 * The repository owns the state machine: a transition it does not recognise is
 * refused before any write, and every mutation carries the version the caller
 * read, so a decision taken against a stale analysis loses instead of applying.
 *
 * Nothing here stores or returns a path, a quarantine location or artifact
 * bytes, and no method installs, copies or promotes an artifact.
 */

export type ArtifactReviewErrorCode =
  | 'submission-not-found'
  | 'invalid-transition'
  | 'stale-submission'
  | 'analysis-mismatch'
  | 'invalid-submission';

export class ArtifactReviewError extends Error {
  public readonly code: ArtifactReviewErrorCode;

  public constructor(code: ArtifactReviewErrorCode) {
    super(`artifact-review:${code}`);
    this.name = 'ArtifactReviewError';
    this.code = code;
  }
}

interface SubmissionRow {
  readonly submission_id: string;
  readonly filename: string;
  readonly sha256: string;
  readonly size_bytes: string | number;
  readonly state: ArtifactSubmissionState;
  readonly submitted_by: ActorRef;
  readonly reviewed_side: 'client' | 'server' | 'both' | null;
  readonly inspected: boolean;
  readonly analyzed: boolean;
  readonly verdict: 'compatible' | 'incompatible' | 'unknown' | null;
  readonly loaders: readonly string[];
  readonly mod_ids: readonly string[];
  readonly declared_versions: readonly string[];
  readonly blocker_count: number;
  readonly warning_count: number;
  readonly information_count: number;
  readonly proven_blocker_count: number;
  readonly failure_code: string | null;
  readonly failure_stage: string | null;
  readonly decision: 'approved' | 'rejected' | null;
  readonly decision_actor: ActorRef | null;
  readonly decision_reason_code: string | null;
  readonly decision_analyzed_sha256: string | null;
  readonly decided_at: Date | string | null;
  readonly version: string | number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const SUBMISSION_COLUMNS = `submission_id, filename, sha256, size_bytes, state, submitted_by, reviewed_side,
  inspected, analyzed, verdict, loaders, mod_ids, declared_versions,
  blocker_count, warning_count, information_count, proven_blocker_count,
  failure_code, failure_stage, decision, decision_actor, decision_reason_code,
  decision_analyzed_sha256, decided_at, version, created_at, updated_at`;

function isoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapSubmission(row: SubmissionRow): ArtifactSubmission {
  const submission: ArtifactSubmission = {
    schemaVersion: 1,
    submissionId: row.submission_id,
    filename: row.filename,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    state: row.state,
    submittedBy: row.submitted_by,
    reviewedSide: row.reviewed_side,
    submittedAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
    version: Number(row.version),
    analysis: {
      inspected: row.inspected,
      analyzed: row.analyzed,
      loaders: [...row.loaders] as ArtifactSubmission['analysis']['loaders'],
      modIds: [...row.mod_ids],
      declaredVersions: [...row.declared_versions],
      verdict: row.verdict,
      blockerCount: row.blocker_count,
      warningCount: row.warning_count,
      informationCount: row.information_count,
      provenBlockerCount: row.proven_blocker_count,
    },
    failure:
      row.failure_code === null || row.failure_stage === null
        ? null
        : ({ code: row.failure_code, stage: row.failure_stage } as ArtifactSubmissionFailure),
    decision:
      row.decision === null ||
      row.decision_actor === null ||
      row.decision_reason_code === null ||
      row.decision_analyzed_sha256 === null ||
      row.decided_at === null
        ? null
        : {
            decision: row.decision,
            actor: row.decision_actor,
            reasonCode: row.decision_reason_code,
            analyzedSha256: row.decision_analyzed_sha256,
            decidedAt: isoString(row.decided_at),
          },
  };

  // The storage constraints and the contract state the same invariants; a row
  // that satisfied one but not the other is a defect, not a value to publish.
  const validated = validateArtifactSubmission(submission);
  if (!validated.success) throw new ArtifactReviewError('invalid-submission');
  return validated.value;
}

export interface CreateSubmissionInput {
  readonly submissionId: string;
  readonly serverInstanceId: string;
  readonly filename: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly submittedBy: ActorRef;
  readonly now: Date;
}

export interface RecordInspectionInput {
  readonly submissionId: string;
  readonly expectedVersion: number;
  readonly report: ArtifactInspectionReportContract;
  readonly now: Date;
}

export interface RecordCompatibilityInput {
  readonly submissionId: string;
  readonly expectedVersion: number;
  readonly report: ArtifactCompatibilityReport;
  readonly now: Date;
}

export interface RecordDecisionInput {
  readonly submissionId: string;
  readonly decisionId: string;
  readonly decision: 'approved' | 'rejected';
  readonly actor: ActorRef;
  readonly reasonCode: string;
  readonly analyzedSha256: string;
  readonly expectedVersion: number;
  /** Recorded alongside the decision when the reviewer states it. */
  readonly reviewedSide?: 'client' | 'server' | 'both';
  readonly now: Date;
}

export interface ListSubmissionsInput {
  readonly serverInstanceId: string;
  readonly states?: readonly ArtifactSubmissionState[];
  readonly limit: number;
  readonly offset: number;
}

export class ArtifactReviewRepository {
  constructor(private readonly database: Database) {}

  async #loadForUpdate(
    client: SqlClient,
    submissionId: string,
    expectedVersion: number,
  ): Promise<SubmissionRow> {
    const current = await client.query<SubmissionRow>(
      `SELECT ${SUBMISSION_COLUMNS} FROM artifact_submissions WHERE submission_id = $1 FOR UPDATE`,
      [submissionId],
    );
    const row = current.rows[0];
    if (row === undefined) throw new ArtifactReviewError('submission-not-found');
    if (Number(row.version) !== expectedVersion) throw new ArtifactReviewError('stale-submission');
    return row;
  }

  #requireTransition(from: ArtifactSubmissionState, to: ArtifactSubmissionState): void {
    if (from === to) return;
    if (!isAllowedSubmissionTransition(from, to)) {
      throw new ArtifactReviewError('invalid-transition');
    }
  }

  /**
   * Records an upload. The same bytes submitted twice for the same server
   * resolve to the existing submission, so a replay never opens a second
   * review of one artifact.
   */
  async create(input: CreateSubmissionInput): Promise<{
    readonly submission: ArtifactSubmission;
    readonly replayed: boolean;
  }> {
    return this.database.transaction(async (client) => {
      const inserted = await client.query<SubmissionRow>(
        `INSERT INTO artifact_submissions (
           submission_id, server_instance_id, filename, sha256, size_bytes, state, submitted_by,
           created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,'uploaded',$6::jsonb,$7,$7)
         ON CONFLICT (server_instance_id, sha256) DO NOTHING
         RETURNING ${SUBMISSION_COLUMNS}`,
        [
          input.submissionId,
          input.serverInstanceId,
          input.filename,
          input.sha256,
          input.sizeBytes,
          JSON.stringify(input.submittedBy),
          input.now,
        ],
      );
      const row = inserted.rows[0];
      if (row !== undefined) return { submission: mapSubmission(row), replayed: false };

      const existing = await client.query<SubmissionRow>(
        `SELECT ${SUBMISSION_COLUMNS} FROM artifact_submissions
         WHERE server_instance_id = $1 AND sha256 = $2`,
        [input.serverInstanceId, input.sha256],
      );
      const existingRow = existing.rows[0];
      if (existingRow === undefined) throw new ArtifactReviewError('submission-not-found');
      return { submission: mapSubmission(existingRow), replayed: true };
    });
  }

  async findById(submissionId: string): Promise<ArtifactSubmission | undefined> {
    const result = await this.database.query<SubmissionRow>(
      `SELECT ${SUBMISSION_COLUMNS} FROM artifact_submissions WHERE submission_id = $1`,
      [submissionId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapSubmission(row);
  }

  async list(input: ListSubmissionsInput): Promise<ArtifactSubmissionPage> {
    const states = input.states ?? [];
    const filtered = states.length > 0;
    const parameters: unknown[] = [input.serverInstanceId];
    if (filtered) parameters.push([...states]);
    const stateClause = filtered ? ' AND state = ANY($2::text[])' : '';

    const total = await this.database.query<{ readonly count: string | number }>(
      `SELECT COUNT(*) AS count FROM artifact_submissions
       WHERE server_instance_id = $1${stateClause}`,
      parameters,
    );
    const rows = await this.database.query<SubmissionRow>(
      `SELECT ${SUBMISSION_COLUMNS} FROM artifact_submissions
       WHERE server_instance_id = $1${stateClause}
       ORDER BY created_at DESC, submission_id
       LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      [...parameters, input.limit, input.offset],
    );

    return {
      schemaVersion: 1,
      submissions: rows.rows.map(mapSubmission),
      total: Number(total.rows[0]?.count ?? 0),
      limit: input.limit,
      offset: input.offset,
    };
  }

  /** Moves a submission between states without touching its analysis. */
  async transition(input: {
    readonly submissionId: string;
    readonly to: ArtifactSubmissionState;
    readonly expectedVersion: number;
    readonly failure?: ArtifactSubmissionFailure;
    readonly now: Date;
  }): Promise<ArtifactSubmission> {
    return this.database.transaction(async (client) => {
      const row = await this.#loadForUpdate(client, input.submissionId, input.expectedVersion);
      this.#requireTransition(row.state, input.to);

      const updated = await client.query<SubmissionRow>(
        `UPDATE artifact_submissions
         SET state = $2,
             failure_code = COALESCE($3, failure_code),
             failure_stage = COALESCE($4, failure_stage),
             version = version + 1,
             updated_at = $5
         WHERE submission_id = $1
         RETURNING ${SUBMISSION_COLUMNS}`,
        [
          input.submissionId,
          input.to,
          input.failure?.code ?? null,
          input.failure?.stage ?? null,
          input.now,
        ],
      );
      const next = updated.rows[0];
      if (next === undefined) throw new ArtifactReviewError('submission-not-found');
      return mapSubmission(next);
    });
  }

  /**
   * Stores the bounded inspection report and the declarations it found. The
   * submission stays in `analyzing`: only compatibility decides what follows.
   */
  async recordInspection(input: RecordInspectionInput): Promise<ArtifactSubmission> {
    return this.database.transaction(async (client) => {
      const row = await this.#loadForUpdate(client, input.submissionId, input.expectedVersion);
      if (row.sha256 !== input.report.sha256) throw new ArtifactReviewError('analysis-mismatch');
      this.#requireTransition(row.state, 'analyzing');

      await client.query(
        `INSERT INTO artifact_inspection_reports (submission_id, sha256, report, created_at)
         VALUES ($1,$2,$3::jsonb,$4)
         ON CONFLICT (submission_id) DO UPDATE
           SET sha256 = EXCLUDED.sha256, report = EXCLUDED.report, created_at = EXCLUDED.created_at`,
        [input.submissionId, input.report.sha256, JSON.stringify(input.report), input.now],
      );

      const modIds = [...new Set(input.report.mods.map((mod) => mod.modId))].sort();
      const declaredVersions = [
        ...new Set(
          input.report.mods.flatMap((mod) => (mod.version === null ? [] : [mod.version])),
        ),
      ].sort();

      const updated = await client.query<SubmissionRow>(
        `UPDATE artifact_submissions
         SET state = 'analyzing', inspected = TRUE,
             loaders = $2::jsonb, mod_ids = $3::jsonb, declared_versions = $4::jsonb,
             version = version + 1, updated_at = $5
         WHERE submission_id = $1
         RETURNING ${SUBMISSION_COLUMNS}`,
        [
          input.submissionId,
          JSON.stringify([...input.report.loaders]),
          JSON.stringify(modIds),
          JSON.stringify(declaredVersions),
          input.now,
        ],
      );
      const next = updated.rows[0];
      if (next === undefined) throw new ArtifactReviewError('submission-not-found');
      return mapSubmission(next);
    });
  }

  /**
   * Stores the compatibility report, its issues, and the state it implies. A
   * proven blocker leaves the submission blocked; anything else becomes
   * reviewable, which is the only state a person may approve from.
   */
  async recordCompatibility(input: RecordCompatibilityInput): Promise<ArtifactSubmission> {
    return this.database.transaction(async (client) => {
      const row = await this.#loadForUpdate(client, input.submissionId, input.expectedVersion);
      const judged = input.report.artifacts.find((artifact) => artifact.sha256 === row.sha256);
      if (judged === undefined) throw new ArtifactReviewError('analysis-mismatch');

      const issues = input.report.issues.filter((issue) =>
        issue.artifactIds.includes(judged.artifactId),
      );
      const provenBlockers = issues.filter(
        (issue) => issue.severity === 'blocker' && issue.determinacy === 'proven',
      ).length;
      const nextState: ArtifactSubmissionState = provenBlockers > 0 ? 'blocked' : 'reviewable';
      this.#requireTransition(row.state, nextState);

      await client.query(
        `INSERT INTO artifact_compatibility_reports (submission_id, sha256, report, created_at)
         VALUES ($1,$2,$3::jsonb,$4)
         ON CONFLICT (submission_id) DO UPDATE
           SET sha256 = EXCLUDED.sha256, report = EXCLUDED.report, created_at = EXCLUDED.created_at`,
        [input.submissionId, row.sha256, JSON.stringify(input.report), input.now],
      );
      await client.query('DELETE FROM artifact_compatibility_issues WHERE submission_id = $1', [
        input.submissionId,
      ]);
      for (const [ordinal, issue] of issues.entries()) {
        await client.query(
          `INSERT INTO artifact_compatibility_issues (
             submission_id, ordinal, code, severity, determinacy, reason,
             context_ids, mod_ids, evidence, detail, explanation, recommended_action
           ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12)`,
          [
            input.submissionId,
            ordinal,
            issue.code,
            issue.severity,
            issue.determinacy,
            issue.reason,
            JSON.stringify([...issue.contextIds]),
            JSON.stringify([...issue.modIds]),
            JSON.stringify([...issue.evidence]),
            issue.detail,
            issue.explanation,
            issue.recommendedAction,
          ],
        );
      }

      const updated = await client.query<SubmissionRow>(
        `UPDATE artifact_submissions
         SET state = $2, analyzed = TRUE, verdict = $3,
             blocker_count = $4, warning_count = $5, information_count = $6,
             proven_blocker_count = $7, version = version + 1, updated_at = $8
         WHERE submission_id = $1
         RETURNING ${SUBMISSION_COLUMNS}`,
        [
          input.submissionId,
          nextState,
          judged.status,
          issues.filter((issue) => issue.severity === 'blocker').length,
          issues.filter((issue) => issue.severity === 'warning').length,
          issues.filter((issue) => issue.severity === 'information').length,
          provenBlockers,
          input.now,
        ],
      );
      const next = updated.rows[0];
      if (next === undefined) throw new ArtifactReviewError('submission-not-found');
      return mapSubmission(next);
    });
  }

  /**
   * Records a human decision. It is refused unless the caller names the exact
   * hash that was analyzed, so a decision can never be applied to bytes the
   * reviewer did not see. Approval changes the review state only.
   */
  async recordDecision(input: RecordDecisionInput): Promise<ArtifactSubmission> {
    return this.database.transaction(async (client) => {
      const row = await this.#loadForUpdate(client, input.submissionId, input.expectedVersion);
      if (row.sha256 !== input.analyzedSha256) throw new ArtifactReviewError('analysis-mismatch');
      this.#requireTransition(row.state, input.decision);

      await client.query(
        `INSERT INTO artifact_review_decisions (
           decision_id, submission_id, decision, from_state, actor, reason_code,
           analyzed_sha256, decided_at
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
        [
          input.decisionId,
          input.submissionId,
          input.decision,
          row.state,
          JSON.stringify(input.actor),
          input.reasonCode,
          input.analyzedSha256,
          input.now,
        ],
      );

      const updated = await client.query<SubmissionRow>(
        `UPDATE artifact_submissions
         SET state = $2, decision = $2, decision_actor = $3::jsonb, decision_reason_code = $4,
             decision_analyzed_sha256 = $5, decided_at = $6,
             reviewed_side = COALESCE($7, reviewed_side),
             version = version + 1, updated_at = $6
         WHERE submission_id = $1
         RETURNING ${SUBMISSION_COLUMNS}`,
        [
          input.submissionId,
          input.decision,
          JSON.stringify(input.actor),
          input.reasonCode,
          input.analyzedSha256,
          input.now,
          input.reviewedSide ?? null,
        ],
      );
      const next = updated.rows[0];
      if (next === undefined) throw new ArtifactReviewError('submission-not-found');
      return mapSubmission(next);
    });
  }

  async findInspectionReport(submissionId: string): Promise<ArtifactInspectionReportContract | undefined> {
    const result = await this.database.query<{ readonly report: ArtifactInspectionReportContract }>(
      'SELECT report FROM artifact_inspection_reports WHERE submission_id = $1',
      [submissionId],
    );
    return result.rows[0]?.report;
  }

  async findCompatibilityReport(
    submissionId: string,
  ): Promise<ArtifactCompatibilityReport | undefined> {
    const result = await this.database.query<{ readonly report: ArtifactCompatibilityReport }>(
      'SELECT report FROM artifact_compatibility_reports WHERE submission_id = $1',
      [submissionId],
    );
    return result.rows[0]?.report;
  }

  async countIssuesBySeverity(
    submissionId: string,
  ): Promise<Readonly<Record<'blocker' | 'warning' | 'information', number>>> {
    const result = await this.database.query<{
      readonly severity: 'blocker' | 'warning' | 'information';
      readonly count: string | number;
    }>(
      `SELECT severity, COUNT(*) AS count FROM artifact_compatibility_issues
       WHERE submission_id = $1 GROUP BY severity`,
      [submissionId],
    );
    const counts = { blocker: 0, warning: 0, information: 0 };
    for (const row of result.rows) counts[row.severity] = Number(row.count);
    return counts;
  }
}
