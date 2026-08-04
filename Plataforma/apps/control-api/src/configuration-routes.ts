import { createHash, randomUUID } from 'node:crypto';

import { Type, type Static } from '@sinclair/typebox';
import {
  validateConfigurationApplyRequest,
  validateConfigurationOperationCommand,
  validateConfigurationRollbackRequest,
  validateConfigurationValidationRequest,
  type ActorRef,
  type ConfigurationFieldValue,
  type ConfigurationOperationAcceptance,
  type ConfigurationOperationCommand,
  type ConfigurationResourceState,
  type ConfigurationRevisionPage,
  type ConfigurationRevisionSummary,
  type ConfigurationSchemaCatalog,
  type ConfigurationValidationResult,
  type Job,
} from '@voidfall/contracts';
import type {
  ConfigurationApplicationState,
  PersistedConfigurationRevision,
  Repositories,
} from '@voidfall/database';
import {
  describeReviewedConfiguration,
  evaluateConfigurationChangeSet,
  listReviewedConfigurationIds,
  presentConfigurationValues,
  type ConfigurationValue,
} from '@voidfall/server-configuration';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Authorized configuration endpoints for Phase 7.3.
 *
 * Every route names a registered resource and reviewed fields. No route accepts
 * a path, a root, a schema document or a codec name from the caller, and no
 * response carries a path or a redacted value. Mutations are asynchronous: the
 * API only enqueues a typed command, and the Phase 7.2 state machine owned by
 * the agent capability decides the outcome.
 */

const MAXIMUM_REVISIONS = 50;

/** Reads current values through an authorized typed reader. */
export interface ConfigurationValueReader {
  readConfiguration(
    serverInstanceId: string,
    resourceId: string,
  ): Promise<{
    readonly currentSha256: string;
    readonly values: Readonly<Record<string, ConfigurationValue>>;
  }>;
}

export interface ConfigurationRouteDependencies {
  readonly repositories: Repositories;
  readonly clock: () => Date;
  readonly authenticate: (request: FastifyRequest) => Promise<void>;
  readonly requirePermission: (permission: ConfigurationPermission) => (request: FastifyRequest) => Promise<void>;
  readonly requireCsrf: (request: FastifyRequest) => Promise<void>;
  readonly audit: (input: {
    readonly request: FastifyRequest;
    readonly actor: ActorRef;
    readonly action: string;
    readonly resourceId: string;
    readonly outcome: 'succeeded' | 'failed' | 'denied';
    readonly reason?: string;
  }) => Promise<void>;
  readonly apiError: (statusCode: number, code: string, message: string) => Error;
  /**
   * Optional authorized reader. Without it the API stays deny-by-default:
   * values are reported as unavailable instead of being guessed or cached.
   */
  readonly configurationReader?: ConfigurationValueReader;
}

export type ConfigurationPermission =
  | 'configuration.view'
  | 'configuration.validate'
  | 'configuration.apply'
  | 'configuration.rollback';

const ServerParamsSchema = Type.Object(
  { serverId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);

const ResourceParamsSchema = Type.Object(
  {
    serverId: Type.String({ format: 'uuid' }),
    resourceId: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9._-]{0,63}$' }),
  },
  { additionalProperties: false },
);

const ValidationBodySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    changes: Type.Array(
      Type.Object(
        {
          name: Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9._-]{0,63}$' }),
          value: Type.Union([
            Type.Boolean(),
            Type.Integer({ minimum: -9_007_199_254_740_991, maximum: 9_007_199_254_740_991 }),
            Type.String({ maxLength: 1_024 }),
          ]),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 64 },
    ),
  },
  { additionalProperties: false },
);

const ApplyBodySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    expectedCurrentSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    expectedStateVersion: Type.Integer({ minimum: 1, maximum: 9_007_199_254_740_991 }),
    idempotencyKey: Type.String({ minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }),
    reasonCode: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9._-]{0,63}$' }),
    changes: ValidationBodySchema.properties.changes,
  },
  { additionalProperties: false },
);

const RollbackBodySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    targetRevisionId: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9._-]{0,63}$' }),
    expectedCurrentSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    expectedStateVersion: Type.Integer({ minimum: 1, maximum: 9_007_199_254_740_991 }),
    idempotencyKey: Type.String({ minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }),
    reasonCode: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9._-]{0,63}$' }),
  },
  { additionalProperties: false },
);

type ServerParams = Static<typeof ServerParamsSchema>;
type ResourceParams = Static<typeof ResourceParamsSchema>;
type ValidationBody = Static<typeof ValidationBodySchema>;
type ApplyBody = Static<typeof ApplyBodySchema>;
type RollbackBody = Static<typeof RollbackBodySchema>;

function reviewedResourceIds(): ReadonlySet<string> {
  return new Set(listReviewedConfigurationIds());
}

/**
 * Derives the durable correlation identifier of an operation from its public
 * idempotency key and target.
 *
 * It must be deterministic: the queue deduplicates by hashing the whole
 * request, so a random correlation id would make an honest replay look like a
 * different request and wrongly reject it. The per-request HTTP correlation id
 * stays separate and is what the audit event carries.
 */
function operationCorrelationId(
  idempotencyKey: string,
  serverId: string,
  resourceId: string,
): string {
  const hex = createHash('sha256')
    .update(`voidfall-configuration-operation:${serverId}:${resourceId}:${idempotencyKey}`)
    .digest('hex');
  // Pin the version and variant nibbles so the value is a well-formed UUID.
  const variant = ((Number.parseInt(hex.slice(17, 18), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(18, 21)}`,
    hex.slice(21, 33),
  ].join('-');
}

function revisionSummary(
  revision: PersistedConfigurationRevision,
  state: ConfigurationApplicationState,
): ConfigurationRevisionSummary {
  return {
    revisionId: revision.revisionId,
    operation: revision.operation,
    status: revision.status,
    sourceRevisionId: revision.sourceRevisionId,
    expectedCurrentSha256: revision.expectedCurrentSha256,
    previousSha256: revision.previousSha256,
    currentSha256: revision.currentSha256,
    requestedFields: [...revision.requestedFields],
    changedFields: revision.changedFields === null ? null : [...revision.changedFields],
    restartRequired: revision.restartRequired,
    actor: revision.actor,
    reasonCode: revision.reasonCode,
    correlationId: revision.correlationId,
    failureCode: revision.status === 'failed' ? revision.failureCode : null,
    // Only an applied revision that is not already the current one can be
    // restored; the durable state machine re-checks this before mutating.
    rollbackEligible:
      revision.status === 'applied' && state.lastAppliedRevisionId !== revision.revisionId,
    createdAt: revision.createdAt,
    completedAt: revision.completedAt,
  } satisfies ConfigurationRevisionSummary;
}

export function registerConfigurationRoutes(
  app: FastifyInstance,
  dependencies: ConfigurationRouteDependencies,
): void {
  const { repositories, clock, authenticate, requirePermission, requireCsrf, audit, apiError } =
    dependencies;

  function panelActor(request: FastifyRequest): ActorRef {
    const auth = request.authContext;
    if (auth === undefined) throw apiError(401, 'AUTH_REQUIRED', 'Autenticação necessária.');
    return { type: 'panel-user', id: auth.user.id };
  }

  /** Resolves a registered, reviewed resource or fails without echoing input. */
  async function requireRegisteredResource(serverId: string, resourceId: string) {
    if (!reviewedResourceIds().has(resourceId)) {
      throw apiError(404, 'CONFIGURATION_RESOURCE_UNKNOWN', 'Recurso de configuração desconhecido.');
    }
    const [resource, state] = await Promise.all([
      repositories.configuration.resource(serverId, resourceId),
      repositories.configuration.state(serverId, resourceId),
    ]);
    if (resource === undefined || state === undefined) {
      throw apiError(404, 'CONFIGURATION_RESOURCE_UNKNOWN', 'Recurso de configuração desconhecido.');
    }
    return { resource, state };
  }

  async function readValues(
    serverId: string,
    resourceId: string,
  ): Promise<{ readonly available: boolean; readonly values: readonly ConfigurationFieldValue[]; readonly currentSha256: string | null }> {
    const reader = dependencies.configurationReader;
    if (reader === undefined) return { available: false, values: [], currentSha256: null };
    try {
      const read = await reader.readConfiguration(serverId, resourceId);
      return {
        available: true,
        values: presentConfigurationValues(resourceId, read.values),
        currentSha256: read.currentSha256,
      };
    } catch {
      // A reader failure must never expose a path or a partial value.
      return { available: false, values: [], currentSha256: null };
    }
  }

  app.get<{ Params: ServerParams }>(
    '/api/v1/servers/:serverId/configuration/schemas',
    {
      schema: { params: ServerParamsSchema },
      preHandler: [authenticate, requirePermission('configuration.view')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request): Promise<ConfigurationSchemaCatalog> => {
      const schemas = [];
      for (const resourceId of listReviewedConfigurationIds()) {
        const resource = await repositories.configuration.resource(
          request.params.serverId,
          resourceId,
        );
        schemas.push(describeReviewedConfiguration(resourceId, resource !== undefined));
      }
      return {
        schemaVersion: 1,
        serverInstanceId: request.params.serverId,
        generatedAt: clock().toISOString(),
        schemas,
      } satisfies ConfigurationSchemaCatalog;
    },
  );

  app.get<{ Params: ResourceParams }>(
    '/api/v1/servers/:serverId/configuration/resources/:resourceId',
    {
      schema: { params: ResourceParamsSchema },
      preHandler: [authenticate, requirePermission('configuration.view')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request): Promise<ConfigurationResourceState> => {
      const { serverId, resourceId } = request.params;
      const { resource, state } = await requireRegisteredResource(serverId, resourceId);
      const descriptor = describeReviewedConfiguration(resourceId, true);
      const read = await readValues(serverId, resourceId);
      return {
        schemaVersion: 1,
        serverInstanceId: serverId,
        resourceId,
        schemaId: resource.schemaId,
        definitionVersion: descriptor.definitionVersion,
        definitionSha256: resource.schemaSha256,
        status: state.status,
        currentSha256: state.currentSha256,
        stateVersion: state.version,
        updatedAt: state.updatedAt,
        pendingRevisionId: state.pendingRevisionId,
        lastAppliedRevisionId: state.lastAppliedRevisionId,
        lastFailedRevisionId: state.lastFailedRevisionId,
        restartRequired: descriptor.restartRequired,
        valuesAvailable: read.available,
        values: [...read.values],
      } satisfies ConfigurationResourceState;
    },
  );

  app.get<{ Params: ResourceParams }>(
    '/api/v1/servers/:serverId/configuration/resources/:resourceId/revisions',
    {
      schema: { params: ResourceParamsSchema },
      preHandler: [authenticate, requirePermission('configuration.view')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request): Promise<ConfigurationRevisionPage> => {
      const { serverId, resourceId } = request.params;
      const { state } = await requireRegisteredResource(serverId, resourceId);
      const revisions = await repositories.configuration.listRevisions(
        serverId,
        resourceId,
        MAXIMUM_REVISIONS,
      );
      return {
        schemaVersion: 1,
        serverInstanceId: serverId,
        resourceId,
        revisions: revisions.map((revision) => revisionSummary(revision, state)),
      } satisfies ConfigurationRevisionPage;
    },
  );

  app.post<{ Params: ResourceParams; Body: ValidationBody }>(
    '/api/v1/servers/:serverId/configuration/resources/:resourceId/validate',
    {
      schema: { params: ResourceParamsSchema, body: ValidationBodySchema },
      preHandler: [authenticate, requireCsrf, requirePermission('configuration.validate')],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request): Promise<ConfigurationValidationResult> => {
      const { serverId, resourceId } = request.params;
      await requireRegisteredResource(serverId, resourceId);
      if (!validateConfigurationValidationRequest(request.body).success) {
        throw apiError(400, 'CONFIGURATION_REQUEST_INVALID', 'Solicitação inválida.');
      }

      const evaluation = evaluateConfigurationChangeSet(resourceId, request.body.changes);

      // Comparing against the current document is best effort: without an
      // authorized reader the caller is told the diff is unknown, not empty.
      let changedFields: string[] | null = null;
      if (evaluation.valid) {
        const read = await readValues(serverId, resourceId);
        if (read.available) {
          const current = new Map(
            read.values.flatMap((field) =>
              field.redacted ? [] : ([[field.name, field.value]] as const),
            ),
          );
          changedFields = request.body.changes
            .filter((change) => current.get(change.name) !== change.value)
            .map((change) => change.name)
            .sort();
        }
      }

      return {
        schemaVersion: 1,
        resourceId,
        applied: false,
        valid: evaluation.valid,
        issues: [...evaluation.issues],
        restartRequired: evaluation.restartRequired,
        changedFields,
      } satisfies ConfigurationValidationResult;
    },
  );

  /**
   * Enqueues a typed command. Idempotency is public and durable: the queue
   * deduplicates by key and refuses the same key for a different request, so a
   * replay returns the original job instead of creating a second revision.
   */
  async function enqueueOperation(input: {
    readonly request: FastifyRequest;
    readonly serverId: string;
    readonly resourceId: string;
    readonly jobType: Extract<Job['type'], 'configuration.apply' | 'configuration.rollback'>;
    readonly idempotencyKey: string;
    readonly command: ConfigurationOperationCommand;
  }): Promise<ConfigurationOperationAcceptance> {
    if (!validateConfigurationOperationCommand(input.command).success) {
      throw apiError(400, 'CONFIGURATION_REQUEST_INVALID', 'Solicitação inválida.');
    }
    const now = clock();
    const job: Job = {
      schemaVersion: 1,
      id: randomUUID(),
      type: input.jobType,
      resource: { type: 'server-instance', id: input.serverId },
      status: 'queued',
      stage: 'queued',
      priority: 50,
      payload: { schemaVersion: 1, parameters: { command: input.command } },
      idempotencyKey: input.idempotencyKey,
      requestedBy: input.command.actor,
      correlationId: input.command.correlationId,
      availableAt: now.toISOString(),
      attempt: 0,
      maxAttempts: 1,
    };

    let enqueued: Job;
    try {
      enqueued = await repositories.jobs.enqueue(job);
    } catch {
      // The key was reused for a different request: refuse rather than apply
      // something the caller did not ask for.
      throw apiError(
        409,
        'CONFIGURATION_IDEMPOTENCY_CONFLICT',
        'A chave de idempotência já foi usada para outra solicitação.',
      );
    }
    const replayed = enqueued.id !== job.id;

    await audit({
      request: input.request,
      actor: input.command.actor,
      action:
        input.jobType === 'configuration.apply' ? 'configuration.apply' : 'configuration.rollback',
      resourceId: input.resourceId,
      outcome: 'succeeded',
      reason: replayed ? 'idempotent replay' : input.command.reasonCode,
    });

    return {
      schemaVersion: 1,
      jobId: enqueued.id,
      revisionId: input.command.revisionId,
      resourceId: input.resourceId,
      operation: input.command.operation,
      status:
        enqueued.status === 'queued' ||
        enqueued.status === 'running' ||
        enqueued.status === 'succeeded' ||
        enqueued.status === 'failed'
          ? enqueued.status
          : 'queued',
      idempotencyKey: input.idempotencyKey,
      replayed,
      correlationId: enqueued.correlationId,
      acceptedAt: now.toISOString(),
    } satisfies ConfigurationOperationAcceptance;
  }

  /**
   * Derives the revision identifier from the public idempotency key so a replay
   * always maps to the same revision and can never open a second one.
   */
  function revisionIdFor(prefix: 'cfg' | 'rbk', idempotencyKey: string): string {
    const normalized = idempotencyKey.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-').slice(0, 56);
    return `${prefix}-${normalized}`.replaceAll(/-+/gu, '-').slice(0, 64);
  }

  app.post<{ Params: ResourceParams; Body: ApplyBody }>(
    '/api/v1/servers/:serverId/configuration/resources/:resourceId/apply',
    {
      schema: { params: ResourceParamsSchema, body: ApplyBodySchema },
      preHandler: [authenticate, requireCsrf, requirePermission('configuration.apply')],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { serverId, resourceId } = request.params;
      const { state } = await requireRegisteredResource(serverId, resourceId);
      if (!validateConfigurationApplyRequest(request.body).success) {
        throw apiError(400, 'CONFIGURATION_REQUEST_INVALID', 'Solicitação inválida.');
      }

      const evaluation = evaluateConfigurationChangeSet(resourceId, request.body.changes);
      if (!evaluation.valid) {
        await audit({
          request,
          actor: panelActor(request),
          action: 'configuration.apply',
          resourceId,
          outcome: 'failed',
          reason: 'change set rejected by the reviewed schema',
        });
        throw apiError(422, 'CONFIGURATION_CHANGES_INVALID', 'Alterações inválidas para o schema revisado.');
      }
      if (
        state.currentSha256 !== request.body.expectedCurrentSha256 ||
        state.version !== request.body.expectedStateVersion
      ) {
        throw apiError(
          409,
          'CONFIGURATION_STATE_STALE',
          'A configuração mudou desde a leitura; recarregue antes de aplicar.',
        );
      }

      const acceptance = await enqueueOperation({
        request,
        serverId,
        resourceId,
        jobType: 'configuration.apply',
        idempotencyKey: request.body.idempotencyKey,
        command: {
          schemaVersion: 1,
          operation: 'update',
          serverInstanceId: serverId,
          resourceId,
          revisionId: revisionIdFor('cfg', request.body.idempotencyKey),
          sourceRevisionId: null,
          expectedCurrentSha256: request.body.expectedCurrentSha256,
          expectedStateVersion: request.body.expectedStateVersion,
          reasonCode: request.body.reasonCode,
          correlationId: operationCorrelationId(
            request.body.idempotencyKey,
            serverId,
            resourceId,
          ),
          actor: panelActor(request),
          changes: [...request.body.changes],
        },
      });
      return reply.code(acceptance.replayed ? 200 : 202).send(acceptance);
    },
  );

  app.post<{ Params: ResourceParams; Body: RollbackBody }>(
    '/api/v1/servers/:serverId/configuration/resources/:resourceId/rollback',
    {
      schema: { params: ResourceParamsSchema, body: RollbackBodySchema },
      preHandler: [authenticate, requireCsrf, requirePermission('configuration.rollback')],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { serverId, resourceId } = request.params;
      const { state } = await requireRegisteredResource(serverId, resourceId);
      if (!validateConfigurationRollbackRequest(request.body).success) {
        throw apiError(400, 'CONFIGURATION_REQUEST_INVALID', 'Solicitação inválida.');
      }

      const target = await repositories.configuration.revision(request.body.targetRevisionId);
      if (
        target === undefined ||
        target.serverInstanceId !== serverId ||
        target.resourceId !== resourceId ||
        target.status !== 'applied'
      ) {
        throw apiError(
          404,
          'CONFIGURATION_REVISION_NOT_ELIGIBLE',
          'A revisão informada não está elegível para rollback.',
        );
      }
      if (
        state.currentSha256 !== request.body.expectedCurrentSha256 ||
        state.version !== request.body.expectedStateVersion
      ) {
        throw apiError(
          409,
          'CONFIGURATION_STATE_STALE',
          'A configuração mudou desde a leitura; recarregue antes de reverter.',
        );
      }

      const acceptance = await enqueueOperation({
        request,
        serverId,
        resourceId,
        jobType: 'configuration.rollback',
        idempotencyKey: request.body.idempotencyKey,
        command: {
          schemaVersion: 1,
          operation: 'rollback',
          serverInstanceId: serverId,
          resourceId,
          revisionId: revisionIdFor('rbk', request.body.idempotencyKey),
          sourceRevisionId: target.revisionId,
          expectedCurrentSha256: request.body.expectedCurrentSha256,
          expectedStateVersion: request.body.expectedStateVersion,
          reasonCode: request.body.reasonCode,
          correlationId: operationCorrelationId(
            request.body.idempotencyKey,
            serverId,
            resourceId,
          ),
          actor: panelActor(request),
          changes: [],
        },
      });
      return reply.code(acceptance.replayed ? 200 : 202).send(acceptance);
    },
  );
}
