import { randomUUID } from 'node:crypto';

import {
  validateArtifactInspectionReport,
  type ArtifactCompatibilityPlan,
  type ArtifactInspectionReportContract,
  type ArtifactSubmissionFailure,
  type Job,
} from '@voidfall/contracts';
import { analyzeArtifactCompatibility } from '@voidfall/artifact-compatibility';
import { ArtifactInspectionService } from '@voidfall/artifact-inspection';
import { ArtifactReviewError, createRepositories, type Database } from '@voidfall/database';

const ARTIFACT_LEASE_MS = 5 * 60_000;

/**
 * Durable runner for the Phase 8.3 artifact jobs.
 *
 * It reuses the existing SKIP LOCKED queue. The payload carries an opaque
 * submission reference only: no root, no path and no bytes cross the queue.
 * Reading the quarantined bytes and describing the target runtimes are both
 * injected, so this runner never resolves a filesystem location itself, never
 * executes an artifact and never installs one.
 */

/** Reads quarantined bytes by content hash. The location stays with the store. */
export interface QuarantinedArtifactReader {
  read(sha256: string): Promise<Uint8Array>;
}

/** Describes the runtimes a submission must be judged against. */
export interface CompatibilityPlanFactory {
  build(input: {
    readonly submissionId: string;
    readonly serverInstanceId: string;
    readonly filename: string;
    readonly inspection: ArtifactInspectionReportContract;
  }): Promise<ArtifactCompatibilityPlan>;
}

export type ArtifactWorkerResult =
  | { readonly processed: false }
  | {
      readonly processed: true;
      readonly jobId: string;
      readonly submissionId: string;
      readonly outcome: 'inspected' | 'analyzed' | 'failed';
    };

interface ArtifactJobParameters {
  readonly submissionId: string;
  readonly expectedVersion: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Extracts the opaque reference from a job payload. The payload must contain
 * exactly the two reviewed parameters; anything else is refused before the
 * artifact packages are touched at all.
 */
function exactParameters(payload: unknown): ArtifactJobParameters | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const document = payload as Record<string, unknown>;
  if (document['schemaVersion'] !== 1) return undefined;
  const parameters = document['parameters'];
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return undefined;
  }
  const record = parameters as Record<string, unknown>;
  if (Object.keys(record).length !== 2) return undefined;
  const submissionId = record['submissionId'];
  const expectedVersion = record['expectedVersion'];
  if (typeof submissionId !== 'string' || !UUID.test(submissionId)) return undefined;
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return undefined;
  }
  return { submissionId, expectedVersion };
}

/** Maps a refusal to the closed set of publishable submission failures. */
function failureFor(stage: ArtifactSubmissionFailure['stage'], error: unknown): ArtifactSubmissionFailure {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { readonly code: unknown }).code)
      : '';
  if (code === 'not-a-zip-container') return { code, stage };
  if (code === 'truncated-archive') return { code, stage };
  if (code === 'encrypted-entry') return { code, stage };
  if (code === 'hash-mismatch') return { code, stage };
  if (code === 'content-too-large') return { code, stage };
  if (code === 'unsupported-zip-feature') return { code: 'unsupported-archive-feature', stage };
  if (code === 'invalid-metadata') return { code: 'metadata-unreadable', stage };
  return { code: stage === 'compatibility' ? 'analysis-failed' : 'quarantine-rejected', stage };
}

/**
 * Leases at most one artifact job and runs the stage it names. An inspection
 * that succeeds enqueues the analysis; nothing else chains automatically, and a
 * refusal is recorded on the submission as a closed failure code rather than a
 * silent stall.
 */
export async function runArtifactWorkerOnce(input: {
  readonly database: Database;
  readonly workerId: string;
  readonly reader: QuarantinedArtifactReader;
  readonly planFactory: CompatibilityPlanFactory;
  readonly inspectionService?: ArtifactInspectionService;
  readonly now?: Date;
}): Promise<ArtifactWorkerResult> {
  const repositories = createRepositories(input.database);
  const now = input.now ?? new Date();
  const job = await repositories.jobs.lease({
    workerId: input.workerId,
    acceptedTypes: ['artifact.inspect', 'artifact.analyze'],
    now,
    leaseMs: ARTIFACT_LEASE_MS,
  });
  if (job === undefined) return { processed: false };

  const failJob = async (code: string, submissionId: string): Promise<ArtifactWorkerResult> => {
    await repositories.jobs.appendEvent({
      jobId: job.id,
      stage: 'artifact-failed',
      level: 'error',
      message: 'The artifact job did not complete.',
      occurredAt: now,
      metadata: { code, submissionId },
    });
    const failed = await repositories.jobs.fail(
      job.id,
      input.workerId,
      { code, message: 'The artifact job failed.', retryable: false },
      now,
    );
    if (!failed) throw new Error('The artifact job lease was lost before failure was recorded.');
    return { processed: true, jobId: job.id, submissionId, outcome: 'failed' };
  };

  const parameters = exactParameters(job.payload);
  if (parameters === undefined) return failJob('ARTIFACT_PAYLOAD_INVALID', 'unknown');

  const submission = await repositories.artifactReview.findById(parameters.submissionId);
  if (submission === undefined) return failJob('ARTIFACT_SUBMISSION_NOT_FOUND', parameters.submissionId);
  const serverInstanceId = await repositories.artifactReview.serverInstanceIdFor(
    parameters.submissionId,
  );
  if (serverInstanceId === undefined) {
    return failJob('ARTIFACT_SUBMISSION_NOT_FOUND', parameters.submissionId);
  }

  /** Records a refusal on the submission before the job is failed. */
  const blockSubmission = async (
    failure: ArtifactSubmissionFailure,
    code: string,
  ): Promise<ArtifactWorkerResult> => {
    try {
      const current = await repositories.artifactReview.findById(parameters.submissionId);
      if (current !== undefined && current.state !== 'blocked') {
        await repositories.artifactReview.transition({
          submissionId: parameters.submissionId,
          to: 'blocked',
          expectedVersion: current.version,
          failure,
          now,
        });
      }
    } catch (error) {
      // The submission moved under us; the job still fails, and the state the
      // other writer recorded is the one that stands.
      if (!(error instanceof ArtifactReviewError)) throw error;
    }
    return failJob(code, parameters.submissionId);
  };

  if (job.type === 'artifact.inspect') {
    let content: Uint8Array;
    try {
      content = await input.reader.read(submission.sha256);
    } catch (error) {
      return blockSubmission(failureFor('quarantine', error), 'ARTIFACT_CONTENT_UNAVAILABLE');
    }

    const service = input.inspectionService ?? new ArtifactInspectionService({ clock: () => now });
    let inspected: ReturnType<ArtifactInspectionService['inspect']>;
    try {
      inspected = service.inspect({ content, expectedSha256: submission.sha256, inspectedAt: now });
    } catch (error) {
      return blockSubmission(failureFor('inspection', error), 'ARTIFACT_INSPECTION_REFUSED');
    }

    // Nothing is stored before it satisfies the public contract, so a report
    // that could not be published can never become the record of an artifact.
    const validated = validateArtifactInspectionReport(inspected);
    if (!validated.success) {
      return blockSubmission({ code: 'metadata-unreadable', stage: 'inspection' }, 'ARTIFACT_REPORT_INVALID');
    }
    const report: ArtifactInspectionReportContract = validated.value;

    try {
      await repositories.artifactReview.recordInspection({
        submissionId: parameters.submissionId,
        expectedVersion: parameters.expectedVersion,
        report,
        now,
      });
    } catch (error) {
      if (error instanceof ArtifactReviewError) {
        return failJob(`ARTIFACT_${error.code.toUpperCase().replaceAll('-', '_')}`, parameters.submissionId);
      }
      throw error;
    }

    const stored = await repositories.artifactReview.findById(parameters.submissionId);
    if (stored === undefined) return failJob('ARTIFACT_SUBMISSION_NOT_FOUND', parameters.submissionId);

    // The analysis is a separate durable job, so a crash between the two
    // resumes from the queue instead of losing the inspection.
    const analysisJob: Job = {
      schemaVersion: 1,
      id: randomUUID(),
      type: 'artifact.analyze',
      resource: { type: 'artifact-submission', id: parameters.submissionId },
      status: 'queued',
      stage: 'queued',
      priority: 50,
      payload: {
        schemaVersion: 1,
        parameters: { submissionId: parameters.submissionId, expectedVersion: stored.version },
      },
      idempotencyKey: `artifact-analyze-${parameters.submissionId}-${stored.version}`,
      requestedBy: submission.submittedBy,
      correlationId: job.correlationId,
      availableAt: now.toISOString(),
      attempt: 0,
      maxAttempts: 1,
    };
    await repositories.jobs.enqueue(analysisJob);

    await repositories.jobs.appendEvent({
      jobId: job.id,
      stage: 'artifact-inspected',
      level: 'info',
      message: 'The artifact was inspected without being loaded or executed.',
      occurredAt: now,
      metadata: {
        submissionId: parameters.submissionId,
        loaders: [...report.loaders],
        modIds: report.mods.map((mod) => mod.modId).sort(),
        metadataIssues: report.metadataIssues.length,
      },
    });
    const completed = await repositories.jobs.complete(
      job.id,
      input.workerId,
      { submissionId: parameters.submissionId, sha256: report.sha256, state: stored.state },
      now,
    );
    if (!completed) throw new Error('The artifact job lease was lost before completion.');
    return { processed: true, jobId: job.id, submissionId: parameters.submissionId, outcome: 'inspected' };
  }

  const inspection = await repositories.artifactReview.findInspectionReport(parameters.submissionId);
  if (inspection === undefined) {
    return blockSubmission({ code: 'analysis-failed', stage: 'compatibility' }, 'ARTIFACT_INSPECTION_MISSING');
  }

  let plan: ArtifactCompatibilityPlan;
  try {
    plan = await input.planFactory.build({
      submissionId: parameters.submissionId,
      serverInstanceId,
      filename: submission.filename,
      inspection,
    });
  } catch (error) {
    return blockSubmission(failureFor('compatibility', error), 'ARTIFACT_PLAN_UNAVAILABLE');
  }

  let analyzed;
  try {
    const report = analyzeArtifactCompatibility(plan);
    analyzed = await repositories.artifactReview.recordCompatibility({
      submissionId: parameters.submissionId,
      expectedVersion: parameters.expectedVersion,
      report,
      now,
    });
  } catch (error) {
    if (error instanceof ArtifactReviewError) {
      return failJob(`ARTIFACT_${error.code.toUpperCase().replaceAll('-', '_')}`, parameters.submissionId);
    }
    return blockSubmission(failureFor('compatibility', error), 'ARTIFACT_ANALYSIS_REFUSED');
  }

  await repositories.jobs.appendEvent({
    jobId: job.id,
    stage: 'artifact-analyzed',
    level: 'info',
    message: 'The artifact was judged against its target runtimes.',
    occurredAt: now,
    metadata: {
      submissionId: parameters.submissionId,
      state: analyzed.state,
      verdict: analyzed.analysis.verdict ?? 'unknown',
      blockerCount: analyzed.analysis.blockerCount,
      provenBlockerCount: analyzed.analysis.provenBlockerCount,
    },
  });
  const completed = await repositories.jobs.complete(
    job.id,
    input.workerId,
    {
      submissionId: parameters.submissionId,
      state: analyzed.state,
      blockerCount: analyzed.analysis.blockerCount,
      provenBlockerCount: analyzed.analysis.provenBlockerCount,
    },
    now,
  );
  if (!completed) throw new Error('The artifact job lease was lost before completion.');
  return { processed: true, jobId: job.id, submissionId: parameters.submissionId, outcome: 'analyzed' };
}
