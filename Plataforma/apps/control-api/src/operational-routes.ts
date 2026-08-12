import { Type, type Static } from '@sinclair/typebox';
import {
  DEFAULT_ADMINISTRATIVE_PAGE,
  MAXIMUM_ADMINISTRATIVE_PAGE,
  type AuditEvent,
  type ServerOperation,
  type ServerOperationKind,
  type ServerOperationPage,
  type ServerOperationStatus,
  type ServerProcessState,
} from '@voidfall/contracts';
import type { Repositories } from '@voidfall/database';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Administrative read endpoints for the Phase 9.1 operational core.
 *
 * Every listing here is bounded and filterable: there is no route that can be
 * asked for an unbounded scan, and the limit is clamped at the route and again
 * in the repository.
 *
 * The correlation view is the point of the slice. One identifier ties the
 * operation, the durable job and the audit events together, so an operator can
 * follow a single request across all three instead of guessing from timestamps.
 *
 * Nothing here mutates. Phase 9.1 gives the operational core memory; the
 * transport that would actually run an operation belongs to Phase 9.2.
 */

export type OperationalPermission = 'server.view' | 'audit.view';

export interface OperationalRouteDependencies {
  readonly repositories: Repositories;
  readonly authenticate: (request: FastifyRequest) => Promise<void>;
  readonly requirePermission: (
    permission: OperationalPermission,
  ) => (request: FastifyRequest) => Promise<void>;
  readonly apiError: (statusCode: number, code: string, message: string) => Error;
}

/**
 * A query parameter always arrives as a string, and this API deliberately runs
 * its validator without type coercion, so a page bound is declared as digits
 * and converted explicitly rather than silently coerced.
 */
const NumericQuerySchema = Type.String({ pattern: '^[0-9]{1,7}$' });

const ServerParamsSchema = Type.Object(
  { serverId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);

const OperationParamsSchema = Type.Object(
  {
    serverId: Type.String({ format: 'uuid' }),
    operationId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false },
);

const CorrelationParamsSchema = Type.Object(
  { correlationId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);

const OperationQuerySchema = Type.Object(
  {
    status: Type.Optional(
      Type.Union([
        Type.Literal('accepted'),
        Type.Literal('running'),
        Type.Literal('succeeded'),
        Type.Literal('failed'),
        Type.Literal('rejected'),
      ]),
    ),
    kind: Type.Optional(
      Type.Union([
        Type.Literal('server.start'),
        Type.Literal('server.stop'),
        Type.Literal('server.restart'),
        Type.Literal('server.command'),
        Type.Literal('server.force-kill'),
        Type.Literal('backup.create'),
        Type.Literal('backup.verify-restore'),
        Type.Literal('backup.restore'),
        Type.Literal('configuration.apply'),
        Type.Literal('configuration.rollback'),
        Type.Literal('artifact.install'),
      ]),
    ),
    limit: Type.Optional(NumericQuerySchema),
    offset: Type.Optional(NumericQuerySchema),
  },
  { additionalProperties: false },
);

const AuditQuerySchema = Type.Object(
  {
    correlationId: Type.Optional(Type.String({ format: 'uuid' })),
    action: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-z][a-z0-9._-]{0,127}$' })),
    outcome: Type.Optional(
      Type.Union([
        Type.Literal('succeeded'),
        Type.Literal('failed'),
        Type.Literal('denied'),
        Type.Literal('cancelled'),
      ]),
    ),
    limit: Type.Optional(NumericQuerySchema),
    offset: Type.Optional(NumericQuerySchema),
  },
  { additionalProperties: false },
);

type ServerParams = Static<typeof ServerParamsSchema>;
type OperationParams = Static<typeof OperationParamsSchema>;
type CorrelationParams = Static<typeof CorrelationParamsSchema>;
type OperationQuery = Static<typeof OperationQuerySchema>;
type AuditQuery = Static<typeof AuditQuerySchema>;

export interface CorrelationView {
  readonly schemaVersion: 1;
  readonly correlationId: string;
  readonly operations: readonly ServerOperation[];
  readonly jobIds: readonly string[];
  readonly auditEvents: readonly AuditEvent[];
  readonly outboxTopics: readonly string[];
}

export function registerOperationalRoutes(
  app: FastifyInstance,
  dependencies: OperationalRouteDependencies,
): void {
  const { repositories, authenticate, requirePermission, apiError } = dependencies;

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
      throw apiError(400, 'INVALID_PAGE', 'Paginação inválida.');
    }
    return value;
  }

  async function requireServer(serverId: string): Promise<void> {
    const server = await repositories.servers.findById(serverId);
    if (server === undefined) throw apiError(404, 'SERVER_NOT_FOUND', 'Servidor não encontrado.');
  }

  app.get<{ Params: ServerParams; Querystring: OperationQuery }>(
    '/api/v1/servers/:serverId/operations',
    {
      schema: { params: ServerParamsSchema, querystring: OperationQuerySchema },
      preHandler: [authenticate, requirePermission('server.view')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { serverId } = request.params;
      await requireServer(serverId);
      const statuses: readonly ServerOperationStatus[] =
        request.query.status === undefined ? [] : [request.query.status];
      const kinds: readonly ServerOperationKind[] =
        request.query.kind === undefined ? [] : [request.query.kind];

      const page: ServerOperationPage = await repositories.operations.list({
        serverInstanceId: serverId,
        statuses,
        kinds,
        limit: boundedNumber(request.query.limit, DEFAULT_ADMINISTRATIVE_PAGE, 1, MAXIMUM_ADMINISTRATIVE_PAGE),
        offset: boundedNumber(request.query.offset, 0, 0, 1_000_000),
      });
      return page;
    },
  );

  app.get<{ Params: OperationParams }>(
    '/api/v1/servers/:serverId/operations/:operationId',
    {
      schema: { params: OperationParamsSchema },
      preHandler: [authenticate, requirePermission('server.view')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { serverId, operationId } = request.params;
      await requireServer(serverId);
      const operation = await repositories.operations.findById(operationId);
      if (operation === undefined || operation.serverInstanceId !== serverId) {
        throw apiError(404, 'OPERATION_NOT_FOUND', 'Operação não encontrada.');
      }
      return operation;
    },
  );

  /**
   * The last state an agent reported.
   *
   * A state nobody is observing is reported as `unknown` and `stale` rather
   * than as the last thing somebody saw, because after a restart the control
   * plane genuinely does not know what the process is doing.
   */
  app.get<{ Params: ServerParams }>(
    '/api/v1/servers/:serverId/process-state',
    {
      schema: { params: ServerParamsSchema },
      preHandler: [authenticate, requirePermission('server.view')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { serverId } = request.params;
      await requireServer(serverId);
      const state: ServerProcessState | undefined = await repositories.processStates.find(serverId);
      if (state === undefined) {
        // Never observed is not the same as offline.
        return {
          schemaVersion: 1 as const,
          serverInstanceId: serverId,
          lifecycle: 'unknown' as const,
          observedPid: null,
          bootId: null,
          observedBy: null,
          observedAt: new Date(0).toISOString(),
          stale: true,
          version: 0,
          observed: false,
        };
      }
      return { ...state, observed: true };
    },
  );

  /**
   * Follows one correlation identifier across the operation, the durable job
   * and the audit chain. It exposes audit events, so it is gated on the audit
   * permission rather than on server visibility.
   */
  app.get<{ Params: CorrelationParams }>(
    '/api/v1/correlations/:correlationId',
    {
      schema: { params: CorrelationParamsSchema },
      preHandler: [authenticate, requirePermission('audit.view')],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { correlationId } = request.params;
      const operations = await repositories.operations.findByCorrelationId(correlationId);
      const audit = await repositories.audit.listPage({
        correlationId,
        limit: MAXIMUM_ADMINISTRATIVE_PAGE,
        offset: 0,
      });
      const outbox = await repositories.outbox.findByCorrelationId(correlationId);

      const view: CorrelationView = {
        schemaVersion: 1,
        correlationId,
        operations,
        jobIds: [
          ...new Set(operations.flatMap((operation) => (operation.jobId === null ? [] : [operation.jobId]))),
        ],
        auditEvents: audit.events,
        outboxTopics: [...new Set(outbox.map((event) => event.topic))].sort(),
      };
      return view;
    },
  );

  app.get<{ Querystring: AuditQuery }>(
    '/api/v1/audit/page',
    {
      schema: { querystring: AuditQuerySchema },
      preHandler: [authenticate, requirePermission('audit.view')],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request) => {
      const limit = boundedNumber(
        request.query.limit,
        DEFAULT_ADMINISTRATIVE_PAGE,
        1,
        MAXIMUM_ADMINISTRATIVE_PAGE,
      );
      const offset = boundedNumber(request.query.offset, 0, 0, 1_000_000);
      const page = await repositories.audit.listPage({
        limit,
        offset,
        ...(request.query.correlationId === undefined
          ? {}
          : { correlationId: request.query.correlationId }),
        ...(request.query.action === undefined ? {} : { action: request.query.action }),
        ...(request.query.outcome === undefined ? {} : { outcome: request.query.outcome }),
      });
      return {
        schemaVersion: 1 as const,
        events: page.events,
        total: page.total,
        limit,
        offset,
      };
    },
  );
}
