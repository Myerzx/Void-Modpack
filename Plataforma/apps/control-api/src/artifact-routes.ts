import { randomUUID } from 'node:crypto';

import { Type, type Static } from '@sinclair/typebox';
import {
  validateArtifactReviewDecisionRequest,
  type ActorRef,
  type ArtifactSubmission,
  type ArtifactSubmissionDetail,
  type ArtifactSubmissionPage,
  type ArtifactSubmissionState,
  type ArtifactUploadAcceptance,
  type Job,
} from '@voidfall/contracts';
import { ArtifactReviewError, type Repositories } from '@voidfall/database';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Authenticated artifact review endpoints for Phase 8.3.
 *
 * The upload is streamed to an injected quarantine store: this module never
 * resolves a root, never writes a file and never holds a whole artifact in
 * memory. Nothing it returns carries a path, a quarantine location or bytes.
 *
 * Approval changes a review state. No route here installs, copies or promotes
 * an artifact, and none of them can reach a Minecraft runtime.
 */

/** Streams bytes into quarantine and reports what was actually stored. */
export interface ArtifactQuarantineStore {
  quarantineStream(input: {
    readonly filename: string;
    readonly declaredSizeBytes: number;
    readonly expectedSha256: string;
    readonly content: AsyncIterable<Uint8Array>;
    readonly receivedAt: Date;
  }): Promise<{ readonly sha256: string; readonly sizeBytes: number }>;
}

export type ArtifactPermission = 'mods.view' | 'mods.manage' | 'mods.classify';

export interface ArtifactRouteDependencies {
  readonly repositories: Repositories;
  readonly clock: () => Date;
  readonly authenticate: (request: FastifyRequest) => Promise<void>;
  readonly requirePermission: (permission: ArtifactPermission) => (request: FastifyRequest) => Promise<void>;
  readonly requireCsrf: (request: FastifyRequest) => Promise<void>;
  readonly audit: (input: {
    readonly request: FastifyRequest;
    readonly actor: ActorRef;
    readonly action: string;
    readonly submissionId: string;
    readonly outcome: 'succeeded' | 'failed' | 'denied';
    readonly reason?: string;
  }) => Promise<void>;
  readonly apiError: (statusCode: number, code: string, message: string) => Error;
  /**
   * Optional store. Without it the API stays deny-by-default: an upload is
   * refused rather than accepted into a place nobody configured.
   */
  readonly quarantineStore?: ArtifactQuarantineStore;
  readonly maximumArtifactBytes?: number;
}

const DEFAULT_MAXIMUM_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_PAGE = 100;
const DEFAULT_PAGE = 50;

const ServerParamsSchema = Type.Object(
  { serverId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);

const SubmissionParamsSchema = Type.Object(
  {
    serverId: Type.String({ format: 'uuid' }),
    submissionId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false },
);

const ListQuerySchema = Type.Object(
  {
    state: Type.Optional(
      Type.Union([
        Type.Literal('uploaded'),
        Type.Literal('quarantined'),
        Type.Literal('analyzing'),
        Type.Literal('blocked'),
        Type.Literal('reviewable'),
        Type.Literal('approved'),
        Type.Literal('rejected'),
      ]),
    ),
    // A query parameter arrives as a string and this API runs its validator
    // without coercion, so a bound is declared as digits and converted here.
    limit: Type.Optional(Type.String({ pattern: '^[0-9]{1,7}$' })),
    offset: Type.Optional(Type.String({ pattern: '^[0-9]{1,7}$' })),
  },
  { additionalProperties: false },
);

const DecisionBodySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    decision: Type.Union([Type.Literal('approve'), Type.Literal('reject')]),
    reasonCode: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9._-]{0,63}$' }),
    analyzedSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    expectedVersion: Type.Integer({ minimum: 1, maximum: 9_007_199_254_740_991 }),
    reviewedSide: Type.Optional(
      Type.Union([Type.Literal('client'), Type.Literal('server'), Type.Literal('both')]),
    ),
  },
  { additionalProperties: false },
);

type ServerParams = Static<typeof ServerParamsSchema>;
type SubmissionParams = Static<typeof SubmissionParamsSchema>;
type ListQuery = Static<typeof ListQuerySchema>;
type DecisionBody = Static<typeof DecisionBodySchema>;

const SHA256 = /^[a-f0-9]{64}$/u;
/**
 * A filename may not carry a separator, a traversal or a control character.
 * The control character guard is checked by code point rather than a regex
 * literal, so an encoding accident in this source file cannot weaken it — the
 * same rule Phase 8.1 applies to a ZIP entry name.
 */
function safeFilename(value: string): boolean {
  if (value.length < 1 || value.length > 255) return false;
  if (value === '.' || value === '..') return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return false;
    if (character === '/' || character === '\\') return false;
  }
  return true;
}

export function registerArtifactRoutes(
  app: FastifyInstance,
  dependencies: ArtifactRouteDependencies,
): void {
  const {
    repositories,
    clock,
    authenticate,
    requirePermission,
    requireCsrf,
    audit,
    apiError,
  } = dependencies;
  const maximumArtifactBytes = dependencies.maximumArtifactBytes ?? DEFAULT_MAXIMUM_ARTIFACT_BYTES;

  // The artifact body is handed to the route as a stream. Without this the
  // framework would either refuse the media type or buffer a whole artifact in
  // memory before any limit could be applied.
  app.addContentTypeParser(
    'application/octet-stream',
    (_request, payload, done: (error: Error | null, body?: unknown) => void) => {
      done(null, payload);
    },
  );

  /** Refuses a bound the caller tried to argue past, rather than clamping it. */
  function boundedNumber(
    raw: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw apiError(400, 'ARTIFACT_REQUEST_INVALID', 'Paginação inválida.');
    }
    return value;
  }

  function panelActor(request: FastifyRequest): ActorRef {
    const auth = request.authContext;
    if (auth === undefined) throw apiError(401, 'AUTH_REQUIRED', 'Autenticação necessária.');
    return { type: 'panel-user', id: auth.user.id };
  }

  async function requireServer(serverId: string): Promise<void> {
    const server = await repositories.servers.findById(serverId);
    if (server === undefined) throw apiError(404, 'SERVER_NOT_FOUND', 'Servidor não encontrado.');
  }

  async function requireSubmission(
    serverId: string,
    submissionId: string,
  ): Promise<ArtifactSubmission> {
    await requireServer(serverId);
    const submission = await repositories.artifactReview.findById(submissionId);
    if (submission === undefined) {
      throw apiError(404, 'ARTIFACT_NOT_FOUND', 'Artefato não encontrado.');
    }
    return submission;
  }

  /**
   * Streams an uploaded artifact into quarantine.
   *
   * The caller declares the size and the digest up front; the store verifies
   * both while it streams, so bytes that do not match what was announced never
   * become a submission. The body is consumed as a stream and is never bound
   * to a JSON parser or buffered as a whole.
   */
  app.post<{ Params: ServerParams }>(
    '/api/v1/servers/:serverId/artifacts',
    {
      schema: { params: ServerParamsSchema },
      preHandler: [authenticate, requireCsrf, requirePermission('mods.manage')],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { serverId } = request.params;
      await requireServer(serverId);

      const store = dependencies.quarantineStore;
      if (store === undefined) {
        throw apiError(503, 'ARTIFACT_QUARANTINE_UNAVAILABLE', 'Quarentena indisponível.');
      }

      const filename = request.headers['x-artifact-filename'];
      const declaredSha256 = request.headers['x-artifact-sha256'];
      const declaredLength = request.headers['content-length'];
      if (
        typeof filename !== 'string' ||
        !safeFilename(filename) ||
        typeof declaredSha256 !== 'string' ||
        !SHA256.test(declaredSha256) ||
        typeof declaredLength !== 'string'
      ) {
        throw apiError(400, 'ARTIFACT_REQUEST_INVALID', 'Solicitação de upload inválida.');
      }
      const declaredSizeBytes = Number(declaredLength);
      if (!Number.isSafeInteger(declaredSizeBytes) || declaredSizeBytes < 1) {
        throw apiError(400, 'ARTIFACT_REQUEST_INVALID', 'Solicitação de upload inválida.');
      }
      // The limit is enforced before a single byte is read.
      if (declaredSizeBytes > maximumArtifactBytes) {
        throw apiError(413, 'ARTIFACT_TOO_LARGE', 'Artefato acima do limite permitido.');
      }

      const now = clock();
      let stored: { readonly sha256: string; readonly sizeBytes: number };
      try {
        stored = await store.quarantineStream({
          filename,
          declaredSizeBytes,
          expectedSha256: declaredSha256,
          content: request.raw,
          receivedAt: now,
        });
      } catch {
        await audit({
          request,
          actor: panelActor(request),
          action: 'artifact.upload',
          submissionId: 'unknown',
          outcome: 'failed',
          reason: 'quarantine refused the stream',
        });
        throw apiError(422, 'ARTIFACT_QUARANTINE_REJECTED', 'O artefato foi recusado na quarentena.');
      }

      const created = await repositories.artifactReview.create({
        submissionId: randomUUID(),
        serverInstanceId: serverId,
        filename,
        sha256: stored.sha256,
        sizeBytes: stored.sizeBytes,
        submittedBy: panelActor(request),
        now,
      });

      let jobId: string | null = null;
      if (!created.replayed) {
        const quarantined = await repositories.artifactReview.transition({
          submissionId: created.submission.submissionId,
          to: 'quarantined',
          expectedVersion: created.submission.version,
          now,
        });
        const job: Job = {
          schemaVersion: 1,
          id: randomUUID(),
          type: 'artifact.inspect',
          resource: { type: 'artifact-submission', id: quarantined.submissionId },
          status: 'queued',
          stage: 'queued',
          priority: 50,
          payload: {
            schemaVersion: 1,
            parameters: {
              submissionId: quarantined.submissionId,
              expectedVersion: quarantined.version,
            },
          },
          idempotencyKey: `artifact-inspect-${quarantined.submissionId}`,
          requestedBy: panelActor(request),
          correlationId: request.correlationId,
          availableAt: now.toISOString(),
          attempt: 0,
          maxAttempts: 1,
        };
        const enqueued = await repositories.jobs.enqueue(job);
        jobId = enqueued.id;
      }

      const current =
        (await repositories.artifactReview.findById(created.submission.submissionId)) ??
        created.submission;

      await audit({
        request,
        actor: panelActor(request),
        action: 'artifact.upload',
        submissionId: current.submissionId,
        outcome: 'succeeded',
        reason: created.replayed ? 'identical content already under review' : 'quarantined',
      });

      const acceptance: ArtifactUploadAcceptance = {
        schemaVersion: 1,
        submissionId: current.submissionId,
        sha256: current.sha256,
        sizeBytes: current.sizeBytes,
        state: current.state,
        jobId,
        replayed: created.replayed,
        acceptedAt: now.toISOString(),
      };
      return reply.code(created.replayed ? 200 : 202).send(acceptance);
    },
  );

  app.get<{ Params: ServerParams; Querystring: ListQuery }>(
    '/api/v1/servers/:serverId/artifacts',
    {
      schema: { params: ServerParamsSchema, querystring: ListQuerySchema },
      preHandler: [authenticate, requirePermission('mods.view')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { serverId } = request.params;
      await requireServer(serverId);
      const states: readonly ArtifactSubmissionState[] =
        request.query.state === undefined ? [] : [request.query.state];

      const page: ArtifactSubmissionPage = await repositories.artifactReview.list({
        serverInstanceId: serverId,
        states,
        limit: boundedNumber(request.query.limit, DEFAULT_PAGE, 1, MAXIMUM_PAGE),
        offset: boundedNumber(request.query.offset, 0, 0, 1_000_000),
      });
      return page;
    },
  );

  app.get<{ Params: SubmissionParams }>(
    '/api/v1/servers/:serverId/artifacts/:submissionId',
    {
      schema: { params: SubmissionParamsSchema },
      preHandler: [authenticate, requirePermission('mods.view')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { serverId, submissionId } = request.params;
      const submission = await requireSubmission(serverId, submissionId);
      const inspection = await repositories.artifactReview.findInspectionReport(submissionId);
      const compatibility = await repositories.artifactReview.findCompatibilityReport(submissionId);

      const detail: ArtifactSubmissionDetail = {
        schemaVersion: 1,
        submission,
        inspection: inspection ?? null,
        compatibility: compatibility ?? null,
      };
      return detail;
    },
  );

  /**
   * Records a human decision. It carries the reviewed hash and the record
   * version, so a decision taken against an analysis that has since changed is
   * refused instead of applied. Approval alters the review state only.
   */
  app.post<{ Params: SubmissionParams; Body: DecisionBody }>(
    '/api/v1/servers/:serverId/artifacts/:submissionId/decision',
    {
      schema: { params: SubmissionParamsSchema, body: DecisionBodySchema },
      preHandler: [authenticate, requireCsrf, requirePermission('mods.classify')],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { serverId, submissionId } = request.params;
      await requireSubmission(serverId, submissionId);
      if (!validateArtifactReviewDecisionRequest(request.body).success) {
        throw apiError(400, 'ARTIFACT_REQUEST_INVALID', 'Solicitação inválida.');
      }

      const actor = panelActor(request);
      const decision = request.body.decision === 'approve' ? 'approved' : 'rejected';
      try {
        const updated = await repositories.artifactReview.recordDecision({
          submissionId,
          decisionId: randomUUID(),
          decision,
          actor,
          reasonCode: request.body.reasonCode,
          analyzedSha256: request.body.analyzedSha256,
          expectedVersion: request.body.expectedVersion,
          ...(request.body.reviewedSide === undefined
            ? {}
            : { reviewedSide: request.body.reviewedSide }),
          now: clock(),
        });
        await audit({
          request,
          actor,
          action: `artifact.${decision}`,
          submissionId,
          outcome: 'succeeded',
          reason: request.body.reasonCode,
        });
        return updated;
      } catch (error) {
        if (!(error instanceof ArtifactReviewError)) throw error;
        await audit({
          request,
          actor,
          action: `artifact.${decision}`,
          submissionId,
          outcome: 'failed',
          reason: error.code,
        });
        if (error.code === 'stale-submission' || error.code === 'analysis-mismatch') {
          throw apiError(
            409,
            'ARTIFACT_REVIEW_STALE',
            'A análise mudou desde a leitura; recarregue antes de decidir.',
          );
        }
        if (error.code === 'invalid-transition') {
          throw apiError(
            422,
            'ARTIFACT_DECISION_NOT_ALLOWED',
            'A decisão não é permitida para o estado atual do artefato.',
          );
        }
        throw apiError(404, 'ARTIFACT_NOT_FOUND', 'Artefato não encontrado.');
      }
    },
  );
}
