import { Type, type Static } from '@sinclair/typebox';
import {
  validateServerSchedule,
  type ActorRef,
  type ScheduleRun,
  type ServerSchedule,
} from '@voidfall/contracts';
import { SchedulePersistenceError, type Repositories } from '@voidfall/database';
import { nextRunAfter, ScheduleError } from '@voidfall/server-schedule';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Schedule endpoints for Phase 10.5.
 *
 * A schedule is a typed plan from a closed catalogue of steps. No route accepts
 * a command, a path or an executable, so a schedule cannot become a way to run
 * arbitrary work on a timer — which is what a scheduler turns into the moment
 * it accepts a string.
 *
 * The next run is computed here and stored, rather than derived on every read.
 * An operator needs to see *when* a maintenance window will actually fall
 * before agreeing to it, and a stored instant is the same one the scheduler
 * will claim.
 */

export type SchedulePermission = 'schedules.view' | 'schedules.manage';

export interface ScheduleRouteDependencies {
  readonly repositories: Repositories;
  readonly clock: () => Date;
  readonly authenticate: (request: FastifyRequest) => Promise<void>;
  readonly requirePermission: (
    permission: SchedulePermission,
  ) => (request: FastifyRequest) => Promise<void>;
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

const ScheduleParamsSchema = Type.Object(
  { serverId: Type.String({ format: 'uuid' }), scheduleId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);

const StepSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('warn-players'), leadSeconds: Type.Integer({ minimum: 10, maximum: 3_600 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('backup'),
      scope: Type.Union([
        Type.Literal('world'),
        Type.Literal('configurations'),
        Type.Literal('complete'),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('maintenance-check'),
      maximumPlayersOnline: Type.Integer({ minimum: 0, maximum: 1_000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('restart'), timeoutSeconds: Type.Integer({ minimum: 5, maximum: 900 }) },
    { additionalProperties: false },
  ),
]);

const CreateBodySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    name: Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$' }),
    enabled: Type.Boolean(),
    trigger: Type.Object(
      {
        timezone: Type.String({ minLength: 3, maxLength: 64 }),
        hour: Type.Integer({ minimum: 0, maximum: 23 }),
        minute: Type.Integer({ minimum: 0, maximum: 59 }),
        weekdays: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), {
          maxItems: 7,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false },
    ),
    steps: Type.Array(StepSchema, { minItems: 1, maxItems: 8 }),
    reasonCode: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9._-]{0,63}$' }),
  },
  { additionalProperties: false },
);

const EnableBodySchema = Type.Object(
  { schemaVersion: Type.Literal(1), enabled: Type.Boolean() },
  { additionalProperties: false },
);

type ServerParams = Static<typeof ServerParamsSchema>;
type ScheduleParams = Static<typeof ScheduleParamsSchema>;
type CreateBody = Static<typeof CreateBodySchema>;
type EnableBody = Static<typeof EnableBodySchema>;

export function registerScheduleRoutes(
  app: FastifyInstance,
  dependencies: ScheduleRouteDependencies,
): void {
  const { repositories, clock, authenticate, requirePermission, requireCsrf, apiError, newId, audit } =
    dependencies;

  function panelActor(request: FastifyRequest): ActorRef {
    const auth = request.authContext;
    if (auth === undefined) throw apiError(401, 'AUTH_REQUIRED', 'Autenticação necessária.');
    return { type: 'panel-user', id: auth.user.id };
  }

  async function requireServer(serverId: string): Promise<void> {
    const server = await repositories.servers.findById(serverId);
    if (server === undefined) throw apiError(404, 'SERVER_NOT_FOUND', 'Servidor não encontrado.');
  }

  app.get<{ Params: ServerParams }>(
    '/api/v1/servers/:serverId/schedules',
    {
      schema: { params: ServerParamsSchema },
      preHandler: [authenticate, requirePermission('schedules.view')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request): Promise<{ schemaVersion: 1; schedules: ServerSchedule[] }> => {
      await requireServer(request.params.serverId);
      const schedules = await repositories.schedules.listForServer(request.params.serverId);
      return { schemaVersion: 1, schedules: [...schedules] };
    },
  );

  app.get<{ Params: ScheduleParams }>(
    '/api/v1/servers/:serverId/schedules/:scheduleId/runs',
    {
      schema: { params: ScheduleParamsSchema },
      preHandler: [authenticate, requirePermission('schedules.view')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request): Promise<{ schemaVersion: 1; runs: ScheduleRun[] }> => {
      await requireServer(request.params.serverId);
      const schedule = await repositories.schedules.findById(request.params.scheduleId);
      if (schedule === undefined || schedule.serverInstanceId !== request.params.serverId) {
        throw apiError(404, 'SCHEDULE_NOT_FOUND', 'Agendamento não encontrado.');
      }
      const runs = await repositories.schedules.listRuns(request.params.scheduleId);
      return { schemaVersion: 1, runs: [...runs] };
    },
  );

  app.post<{ Params: ServerParams; Body: CreateBody }>(
    '/api/v1/servers/:serverId/schedules',
    {
      schema: { params: ServerParamsSchema, body: CreateBodySchema },
      preHandler: [authenticate, requireCsrf, requirePermission('schedules.manage')],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply): Promise<ServerSchedule> => {
      const { serverId } = request.params;
      await requireServer(serverId);
      const body = request.body;
      const now = clock();

      // Computed before anything is stored, so an unresolvable trigger is
      // refused rather than persisted as a schedule that never fires.
      let nextRunAt: string;
      try {
        nextRunAt = nextRunAfter({ trigger: body.trigger, after: now }).toISOString();
      } catch (error) {
        if (!(error instanceof ScheduleError)) throw error;
        throw apiError(400, 'SCHEDULE_TRIGGER_INVALID', 'Gatilho de agendamento inválido.');
      }

      const candidate = {
        schemaVersion: 1 as const,
        scheduleId: newId(),
        serverInstanceId: serverId,
        name: body.name,
        enabled: body.enabled,
        trigger: body.trigger,
        steps: body.steps,
        reasonCode: body.reasonCode,
        nextRunAt: body.enabled ? nextRunAt : null,
        lastRunAt: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      // The contract owns the step ordering and the closed timezone list, so
      // the route does not re-implement either.
      if (!validateServerSchedule(candidate).success) {
        throw apiError(400, 'SCHEDULE_REQUEST_INVALID', 'Solicitação inválida.');
      }

      const actor = panelActor(request);
      try {
        const created = await repositories.schedules.create({
          schedule: {
            scheduleId: candidate.scheduleId,
            serverInstanceId: serverId,
            name: candidate.name,
            enabled: candidate.enabled,
            trigger: candidate.trigger,
            steps: candidate.steps,
            reasonCode: candidate.reasonCode,
            nextRunAt: candidate.nextRunAt,
          },
          now,
        });
        await audit({
          request,
          actor,
          action: 'schedule.created',
          serverId,
          outcome: 'succeeded',
          reason: body.reasonCode,
        });
        reply.code(201);
        return created;
      } catch (error) {
        await audit({
          request,
          actor,
          action: 'schedule.created',
          serverId,
          outcome: 'failed',
          reason: body.reasonCode,
        });
        if (!(error instanceof SchedulePersistenceError)) throw error;
        throw apiError(409, 'SCHEDULE_EXISTS', 'Já existe um agendamento com esse nome.');
      }
    },
  );

  app.post<{ Params: ScheduleParams; Body: EnableBody }>(
    '/api/v1/servers/:serverId/schedules/:scheduleId/enabled',
    {
      schema: { params: ScheduleParamsSchema, body: EnableBodySchema },
      preHandler: [authenticate, requireCsrf, requirePermission('schedules.manage')],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request): Promise<ServerSchedule> => {
      const { serverId, scheduleId } = request.params;
      await requireServer(serverId);
      const schedule = await repositories.schedules.findById(scheduleId);
      if (schedule === undefined || schedule.serverInstanceId !== serverId) {
        throw apiError(404, 'SCHEDULE_NOT_FOUND', 'Agendamento não encontrado.');
      }

      const now = clock();
      // Re-computed from now rather than reused: a schedule switched back on
      // after a week must not be due for a window that passed while it was off.
      let nextRunAt: string | null = null;
      if (request.body.enabled) {
        try {
          nextRunAt = nextRunAfter({ trigger: schedule.trigger, after: now }).toISOString();
        } catch (error) {
          if (!(error instanceof ScheduleError)) throw error;
          throw apiError(400, 'SCHEDULE_TRIGGER_INVALID', 'Gatilho de agendamento inválido.');
        }
      }

      const updated = await repositories.schedules.setEnabled({
        scheduleId,
        enabled: request.body.enabled,
        nextRunAt,
        now,
      });
      await audit({
        request,
        actor: panelActor(request),
        action: request.body.enabled ? 'schedule.enabled' : 'schedule.disabled',
        serverId,
        outcome: 'succeeded',
        reason: schedule.reasonCode,
      });
      return updated;
    },
  );
}
