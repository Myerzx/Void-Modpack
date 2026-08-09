import { Type, type Static } from '@sinclair/typebox';
import {
  CONSOLE_COMMANDS,
  jobTypeForProcessAction,
  validateConsoleCommandRequest,
  validateProcessControlRequest,
  validateProcessForceKillRequest,
  type ActorRef,
  type ConsolePage,
  type Job,
  type ServerOperation,
} from '@voidfall/contracts';
import { OperationalPersistenceError, type Repositories } from '@voidfall/database';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Process and console endpoints for Phase 10.1.
 *
 * Every mutation goes the same way: RBAC, a durable operation with its
 * idempotency, a queued job, the agent capability under the shared lock, and a
 * receipt. Nothing here touches a process directly, and no route accepts a
 * path, an executable or free command text.
 *
 * Force kill has its own route, its own permission and its own confirmation.
 * It is never reachable by passing a flag to stop.
 */

export type ProcessPermission =
  | 'server.view'
  | 'server.control.start'
  | 'server.control.stop'
  | 'server.control.restart'
  | 'server.control.force'
  | 'console.view'
  | 'console.command';

export interface ProcessRouteDependencies {
  readonly repositories: Repositories;
  readonly clock: () => Date;
  readonly authenticate: (request: FastifyRequest) => Promise<void>;
  readonly requirePermission: (permission: ProcessPermission) => (request: FastifyRequest) => Promise<void>;
  readonly requireCsrf: (request: FastifyRequest) => Promise<void>;
  readonly apiError: (statusCode: number, code: string, message: string) => Error;
  readonly newId: () => string;
  readonly audit: (input: {
    readonly request: FastifyRequest;
    readonly actor: ActorRef;
    readonly action: string;
    readonly serverId: string;
    readonly outcome: 'succeeded' | 'failed' | 'denied';
    readonly reason?: string;
  }) => Promise<void>;
}

const ServerParamsSchema = Type.Object(
  { serverId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);

const IdempotencyKey = Type.String({
  minLength: 16,
  maxLength: 128,
  pattern: '^[A-Za-z0-9._:-]+$',
});
const ReasonCode = Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9._-]{0,63}$' });

const ControlBodySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    action: Type.Union([Type.Literal('start'), Type.Literal('stop'), Type.Literal('restart')]),
    idempotencyKey: IdempotencyKey,
    reasonCode: ReasonCode,
    timeoutSeconds: Type.Integer({ minimum: 5, maximum: 900 }),
  },
  { additionalProperties: false },
);

const ForceKillBodySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    idempotencyKey: IdempotencyKey,
    reasonCode: ReasonCode,
    // No default: the caller has to say this out loud.
    acknowledgesDataLoss: Type.Literal(true),
    afterGracefulOperationId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false },
);

const CommandBodySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    command: Type.Union([Type.Literal('list-players'), Type.Literal('save-all')]),
    idempotencyKey: IdempotencyKey,
    reasonCode: ReasonCode,
  },
  { additionalProperties: false },
);

const ConsoleQuerySchema = Type.Object(
  {
    // Query values arrive as strings and this API validates without coercion.
    from: Type.Optional(Type.String({ pattern: '^[0-9]{1,15}$' })),
    limit: Type.Optional(Type.String({ pattern: '^[0-9]{1,3}$' })),
    tail: Type.Optional(Type.Literal('true')),
  },
  { additionalProperties: false },
);

type ServerParams = Static<typeof ServerParamsSchema>;
type ControlBody = Static<typeof ControlBodySchema>;
type ForceKillBody = Static<typeof ForceKillBodySchema>;
type CommandBody = Static<typeof CommandBodySchema>;
type ConsoleQuery = Static<typeof ConsoleQuerySchema>;

const ACTION_PERMISSION = Object.freeze({
  start: 'server.control.start',
  stop: 'server.control.stop',
  restart: 'server.control.restart',
}) as Readonly<Record<ControlBody['action'], ProcessPermission>>;

export function registerProcessRoutes(
  app: FastifyInstance,
  dependencies: ProcessRouteDependencies,
): void {
  const {
    repositories,
    clock,
    authenticate,
    requirePermission,
    requireCsrf,
    apiError,
    newId,
    audit,
  } = dependencies;

  function panelActor(request: FastifyRequest): ActorRef {
    const auth = request.authContext;
    if (auth === undefined) throw apiError(401, 'AUTH_REQUIRED', 'Autenticação necessária.');
    return { type: 'panel-user', id: auth.user.id };
  }

  async function requireServer(serverId: string): Promise<void> {
    const server = await repositories.servers.findById(serverId);
    if (server === undefined) throw apiError(404, 'SERVER_NOT_FOUND', 'Servidor não encontrado.');
  }

  /**
   * Refuses a restart of a server the control plane has just seen stop.
   *
   * A restart is a stop followed by a start, and there is nothing to stop when
   * the server is already offline — the controller would reject it anyway, but
   * only after an operation, a job and a lease had been created, run and
   * settled to say so. Refusing here means no work is created for an action
   * that cannot succeed.
   *
   * Only a **fresh** observation is grounds for refusing. A stale one, or none
   * at all, means the control plane does not know what is running, and in that
   * case the agent is the arbiter: it holds the process and can see the truth.
   * Guessing from an old reading would block a legitimate restart.
   */
  async function refuseRestartOfStoppedServer(
    request: FastifyRequest,
    serverId: string,
    action: 'start' | 'stop' | 'restart',
  ): Promise<void> {
    if (action !== 'restart') return;
    const observed = await repositories.processStates.find(serverId);
    if (observed === undefined || observed.stale || observed.lifecycle !== 'offline') return;

    await audit({
      request,
      actor: panelActor(request),
      action: 'process.restart',
      serverId,
      outcome: 'denied',
      reason: 'server is offline',
    });
    throw apiError(
      409,
      'PROCESS_STATE_CONFLICT',
      'O servidor está parado; um restart exige um servidor no ar. Use iniciar.',
    );
  }

  /**
   * Accepts a durable operation and queues the job that carries it.
   *
   * The operation is accepted first: it owns the idempotency and the
   * one-in-flight rule, so a second request for the same server is refused
   * before any job exists to run twice.
   */
  async function acceptAndQueue(input: {
    readonly request: FastifyRequest;
    readonly serverId: string;
    readonly kind: ServerOperation['kind'];
    readonly jobType: Job['type'];
    readonly idempotencyKey: string;
    readonly reasonCode: string;
    readonly actionName: string;
    readonly consoleCommand?: 'list-players' | 'save-all';
    /** The deadline the caller stated, carried through to the agent. */
    readonly timeoutSeconds?: number;
  }): Promise<ServerOperation> {
    const now = clock();
    const actor = panelActor(input.request);
    const operationId = newId();

    let accepted;
    try {
      const operationInput = {
        operationId,
        serverInstanceId: input.serverId,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.request.correlationId,
        requestedBy: actor,
        reasonCode: input.reasonCode,
        ...(input.consoleCommand === undefined ? {} : { consoleCommand: input.consoleCommand }),
        now,
      };
      accepted =
        input.kind === 'server.start' ||
        input.kind === 'server.stop' ||
        input.kind === 'server.restart' ||
        input.kind === 'server.force-kill'
          ? await repositories.operations.acceptProcessControl({
              ...operationInput,
              kind: input.kind,
              stateInvalidationEventId: newId(),
            })
          : await repositories.operations.accept(operationInput);
    } catch (error) {
      if (!(error instanceof OperationalPersistenceError)) throw error;
      await audit({
        request: input.request,
        actor,
        action: input.actionName,
        serverId: input.serverId,
        outcome: 'failed',
        reason: error.code,
      });
      if (error.code === 'operation-in-flight') {
        throw apiError(409, 'PROCESS_OPERATION_IN_FLIGHT', 'Já existe uma operação em andamento.');
      }
      throw apiError(
        409,
        'PROCESS_IDEMPOTENCY_CONFLICT',
        'A chave de idempotência já foi usada para outra solicitação.',
      );
    }

    // An honest replay returns the original operation and never queues a
    // second job for the same work.
    if (accepted.replayed) return accepted.operation;

    const job: Job = {
      schemaVersion: 1,
      id: newId(),
      type: input.jobType,
      resource: { type: 'server-instance', id: input.serverId },
      status: 'queued',
      stage: 'queued',
      priority: 70,
      payload: {
        schemaVersion: 1,
        parameters: {
          serverInstanceId: input.serverId,
          expectedVersion: accepted.operation.version,
          // The caller has always been able to state this and it went nowhere:
          // validated by the schema, then dropped. The agent fell back to a
          // 60-second default, so every real modded boot timed out and
          // reported failure while the server was still coming up.
          ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
        },
      },
      idempotencyKey: `${input.idempotencyKey}:job`,
      requestedBy: actor,
      correlationId: input.request.correlationId,
      availableAt: now.toISOString(),
      attempt: 0,
      maxAttempts: 1,
    };
    const enqueued = await repositories.jobs.enqueue(job);

    const running = await repositories.operations.markRunning({
      operationId: accepted.operation.operationId,
      expectedVersion: accepted.operation.version,
      jobId: enqueued.id,
      now,
    });

    await audit({
      request: input.request,
      actor,
      action: input.actionName,
      serverId: input.serverId,
      outcome: 'succeeded',
      reason: input.reasonCode,
    });
    return running;
  }

  app.post<{ Params: ServerParams; Body: ControlBody }>(
    '/api/v1/servers/:serverId/process/control',
    {
      schema: { params: ServerParamsSchema, body: ControlBodySchema },
      preHandler: [authenticate, requireCsrf],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { serverId } = request.params;
      await requireServer(serverId);
      if (!validateProcessControlRequest(request.body).success) {
        throw apiError(400, 'PROCESS_REQUEST_INVALID', 'Solicitação inválida.');
      }
      // Each action carries its own permission; holding start never implies
      // the authority to stop.
      await requirePermission(ACTION_PERMISSION[request.body.action])(request);
      await refuseRestartOfStoppedServer(request, serverId, request.body.action);

      const operation = await acceptAndQueue({
        request,
        serverId,
        kind: `server.${request.body.action}` as ServerOperation['kind'],
        jobType: jobTypeForProcessAction(request.body.action) as Job['type'],
        idempotencyKey: request.body.idempotencyKey,
        reasonCode: request.body.reasonCode,
        actionName: `process.${request.body.action}`,
        timeoutSeconds: request.body.timeoutSeconds,
      });
      return reply.code(202).send(operation);
    },
  );

  /**
   * Force kill: a separate route, a separate permission and an explicit
   * acknowledgement. It also requires the graceful stop it follows to exist
   * and to have failed, so a kill can never be the first thing tried.
   */
  app.post<{ Params: ServerParams; Body: ForceKillBody }>(
    '/api/v1/servers/:serverId/process/force-kill',
    {
      schema: { params: ServerParamsSchema, body: ForceKillBodySchema },
      preHandler: [authenticate, requireCsrf, requirePermission('server.control.force')],
      config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { serverId } = request.params;
      await requireServer(serverId);
      if (!validateProcessForceKillRequest(request.body).success) {
        throw apiError(400, 'PROCESS_REQUEST_INVALID', 'Solicitação inválida.');
      }

      const graceful = await repositories.operations.findById(request.body.afterGracefulOperationId);
      if (
        graceful === undefined ||
        graceful.serverInstanceId !== serverId ||
        graceful.kind !== 'server.stop'
      ) {
        throw apiError(
          422,
          'PROCESS_FORCE_REQUIRES_STOP',
          'Um force kill exige a parada graciosa que ele sucede.',
        );
      }
      // Killing is only justified once the graceful attempt actually failed.
      if (graceful.status !== 'failed') {
        await audit({
          request,
          actor: panelActor(request),
          action: 'process.force-kill',
          serverId,
          outcome: 'denied',
          reason: 'graceful stop did not fail',
        });
        throw apiError(
          422,
          'PROCESS_FORCE_NOT_JUSTIFIED',
          'A parada graciosa ainda não falhou; o force kill não é justificado.',
        );
      }

      const operation = await acceptAndQueue({
        request,
        serverId,
        kind: 'server.force-kill',
        jobType: 'server.force-kill',
        idempotencyKey: request.body.idempotencyKey,
        reasonCode: request.body.reasonCode,
        actionName: 'process.force-kill',
      });
      return reply.code(202).send(operation);
    },
  );

  /** The closed catalogue, published so a client never has to guess at it. */
  app.get(
    '/api/v1/console/commands',
    {
      preHandler: [authenticate, requirePermission('console.view')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async () => ({ schemaVersion: 1 as const, commands: [...CONSOLE_COMMANDS] }),
  );

  app.post<{ Params: ServerParams; Body: CommandBody }>(
    '/api/v1/servers/:serverId/console/command',
    {
      schema: { params: ServerParamsSchema, body: CommandBodySchema },
      preHandler: [authenticate, requireCsrf, requirePermission('console.command')],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { serverId } = request.params;
      await requireServer(serverId);
      // The body schema already closes the catalogue; validating again keeps
      // the contract the single authority rather than the route schema.
      if (!validateConsoleCommandRequest(request.body).success) {
        throw apiError(400, 'CONSOLE_COMMAND_INVALID', 'Comando fora do catálogo revisado.');
      }

      const operation = await acceptAndQueue({
        request,
        serverId,
        kind: 'server.command',
        jobType: 'server.command',
        idempotencyKey: request.body.idempotencyKey,
        reasonCode: request.body.reasonCode,
        actionName: 'console.command',
        consoleCommand: request.body.command,
      });
      return reply.code(202).send(operation);
    },
  );

  app.get<{ Params: ServerParams; Querystring: ConsoleQuery }>(
    '/api/v1/servers/:serverId/console',
    {
      schema: { params: ServerParamsSchema, querystring: ConsoleQuerySchema },
      preHandler: [authenticate, requirePermission('console.view')],
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { serverId } = request.params;
      await requireServer(serverId);

      const from = request.query.from === undefined ? undefined : Number(request.query.from);
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      const tail = request.query.tail === 'true';
      if (
        (tail && from !== undefined) ||
        (from !== undefined && (!Number.isSafeInteger(from) || from < 1)) ||
        (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500))
      ) {
        throw apiError(400, 'CONSOLE_CURSOR_INVALID', 'Cursor ou limite inválido.');
      }

      const page: ConsolePage = await repositories.console.read({
        serverInstanceId: serverId,
        ...(from === undefined ? {} : { fromSequence: from }),
        ...(tail ? { tail: true } : {}),
        ...(limit === undefined ? {} : { limit }),
        now: clock(),
      });
      return page;
    },
  );
}
