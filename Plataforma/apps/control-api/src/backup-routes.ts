import { Type, type Static } from '@sinclair/typebox';
import {
  validateCreateBackupRequest,
  validateRestoreBackupRequest,
  validateVerifyBackupRestoreRequest,
  type ActorRef,
  type BackupPageContract,
  type BackupRecordContract,
  type Job,
  type ServerOperation,
} from '@voidfall/contracts';
import {
  BackupPersistenceError,
  OperationalPersistenceError,
  type Repositories,
} from '@voidfall/database';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Backup and restore endpoints for Phase 10.3.
 *
 * Both go the same way every mutation in this platform goes: RBAC, a durable
 * operation that owns the idempotency and the one-in-flight rule, a queued job,
 * the agent capability under the shared exclusive lock, and a receipt. No route
 * names a directory, a repository or a storage endpoint — where backups live is
 * trusted local configuration on the agent's host.
 *
 * Restore is not modelled as the inverse of backup. Taking a copy is safe;
 * putting one back destroys everything the world became since. It gets its own
 * permission, its own operation kind, its own capability, an explicit
 * acknowledgement with no default, and a required preceding stop that actually
 * succeeded.
 */

export type BackupPermission = 'backups.view' | 'backups.create' | 'backups.restore';

export interface BackupRouteDependencies {
  readonly repositories: Repositories;
  readonly clock: () => Date;
  readonly authenticate: (request: FastifyRequest) => Promise<void>;
  readonly requirePermission: (
    permission: BackupPermission,
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

const IdempotencyKey = Type.String({
  minLength: 16,
  maxLength: 128,
  pattern: '^[A-Za-z0-9._:-]+$',
});
const ReasonCode = Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9._-]{0,63}$' });
const BackupId = ReasonCode;

const CreateBodySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    backupId: BackupId,
    scope: Type.Union([
      Type.Literal('world'),
      Type.Literal('configurations'),
      Type.Literal('complete'),
    ]),
    idempotencyKey: IdempotencyKey,
    reasonCode: ReasonCode,
  },
  { additionalProperties: false },
);

const RestoreBodySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    backupId: BackupId,
    idempotencyKey: IdempotencyKey,
    reasonCode: ReasonCode,
    // No default. Restoring discards everything since the backup was taken.
    acknowledgesDataLoss: Type.Literal(true),
    afterStopOperationId: Type.String({ format: 'uuid' }),
    verificationBoot: Type.Boolean(),
  },
  { additionalProperties: false },
);

const VerifyRestoreBodySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    backupId: BackupId,
    idempotencyKey: IdempotencyKey,
    reasonCode: ReasonCode,
  },
  { additionalProperties: false },
);

type ServerParams = Static<typeof ServerParamsSchema>;
type CreateBody = Static<typeof CreateBodySchema>;
type RestoreBody = Static<typeof RestoreBodySchema>;
type VerifyRestoreBody = Static<typeof VerifyRestoreBodySchema>;

export function registerBackupRoutes(
  app: FastifyInstance,
  dependencies: BackupRouteDependencies,
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

  /**
   * Accepts a durable operation and queues the job that carries it.
   *
   * The operation is accepted first, because it owns the idempotency and the
   * one-in-flight rule: a second request is refused before any job exists to
   * run the work twice.
   */
  async function acceptAndQueue(input: {
    readonly request: FastifyRequest;
    readonly serverId: string;
    readonly kind: ServerOperation['kind'];
    readonly jobType: Job['type'];
    readonly idempotencyKey: string;
    readonly reasonCode: string;
    readonly actionName: string;
    readonly backupId: string;
  }): Promise<{ readonly operation: ServerOperation; readonly replayed: boolean }> {
    const now = clock();
    const actor = panelActor(input.request);

    let accepted;
    try {
      accepted = await repositories.operations.accept({
        operationId: newId(),
        serverInstanceId: input.serverId,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.request.correlationId,
        requestedBy: actor,
        reasonCode: input.reasonCode,
        backupId: input.backupId,
        now,
      });
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
        throw apiError(409, 'BACKUP_OPERATION_IN_FLIGHT', 'Já existe uma operação em andamento.');
      }
      throw apiError(
        409,
        'BACKUP_IDEMPOTENCY_CONFLICT',
        'A chave de idempotência já foi usada para outra solicitação.',
      );
    }

    if (accepted.replayed) return { operation: accepted.operation, replayed: true };

    const job: Job = {
      schemaVersion: 1,
      id: newId(),
      type: input.jobType,
      resource: { type: 'server-instance', id: input.serverId },
      status: 'queued',
      stage: 'queued',
      priority: 60,
      payload: {
        schemaVersion: 1,
        parameters: { serverInstanceId: input.serverId, expectedVersion: accepted.operation.version },
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
    return { operation: running, replayed: false };
  }

  app.get<{ Params: ServerParams }>(
    '/api/v1/servers/:serverId/backups',
    {
      schema: { params: ServerParamsSchema },
      preHandler: [authenticate, requirePermission('backups.view')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request): Promise<BackupPageContract> => {
      await requireServer(request.params.serverId);
      const backups = await repositories.backups.listForServer(request.params.serverId);
      return {
        schemaVersion: 1,
        serverInstanceId: request.params.serverId,
        backups: [...backups],
      } satisfies BackupPageContract;
    },
  );

  app.post<{ Params: ServerParams; Body: CreateBody }>(
    '/api/v1/servers/:serverId/backups',
    {
      schema: { params: ServerParamsSchema, body: CreateBodySchema },
      preHandler: [authenticate, requireCsrf, requirePermission('backups.create')],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply): Promise<BackupRecordContract> => {
      if (!validateCreateBackupRequest(request.body).success) {
        throw apiError(400, 'BACKUP_REQUEST_INVALID', 'Solicitação inválida.');
      }
      const { serverId } = request.params;
      await requireServer(serverId);
      const body = request.body;

      const existing = await repositories.backups.findById(body.backupId);
      if (existing !== undefined) {
        // A backup id is chosen by the caller and names one snapshot forever.
        // Reusing one would make two different worlds share a name.
        throw apiError(409, 'BACKUP_ALREADY_EXISTS', 'Já existe um backup com esse identificador.');
      }

      const accepted = await acceptAndQueue({
        request,
        serverId,
        kind: 'backup.create',
        jobType: 'backup.create',
        idempotencyKey: body.idempotencyKey,
        reasonCode: body.reasonCode,
        actionName: 'backup.requested',
        backupId: body.backupId,
      });

      try {
        const record = await repositories.backups.begin({
          backupId: body.backupId,
          serverInstanceId: serverId,
          scope: body.scope,
          reasonCode: body.reasonCode,
          requestedBy: panelActor(request),
          correlationId: request.correlationId,
          operationId: accepted.operation.operationId,
          now: clock(),
        });
        reply.code(202);
        return record;
      } catch (error) {
        if (!(error instanceof BackupPersistenceError)) throw error;
        if (error.code === 'backup-in-flight') {
          throw apiError(409, 'BACKUP_IN_FLIGHT', 'Já existe um backup em andamento.');
        }
        throw apiError(409, 'BACKUP_ALREADY_EXISTS', 'Já existe um backup com esse identificador.');
      }
    },
  );

  app.post<{ Params: ServerParams; Body: RestoreBody }>(
    '/api/v1/servers/:serverId/backups/restore',
    {
      schema: { params: ServerParamsSchema, body: RestoreBodySchema },
      preHandler: [authenticate, requireCsrf, requirePermission('backups.restore')],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply): Promise<ServerOperation> => {
      if (!validateRestoreBackupRequest(request.body).success) {
        throw apiError(400, 'BACKUP_REQUEST_INVALID', 'Solicitação inválida.');
      }
      const { serverId } = request.params;
      await requireServer(serverId);
      const body = request.body;

      const backup = await repositories.backups.findById(body.backupId);
      if (backup === undefined || backup.serverInstanceId !== serverId) {
        throw apiError(404, 'BACKUP_NOT_FOUND', 'Backup não encontrado.');
      }
      if (backup.status !== 'available') {
        // Restoring from something still being written, that failed, or that
        // retention already removed would put an unknown world on disk.
        throw apiError(409, 'BACKUP_NOT_RESTORABLE', 'O backup não está disponível para restauração.');
      }

      // The preceding stop must exist, belong to this server and have actually
      // succeeded. A restore against a world a server still holds open corrupts
      // both the copy and what it replaced.
      const stop = await repositories.operations.findById(body.afterStopOperationId);
      if (
        stop === undefined ||
        stop.serverInstanceId !== serverId ||
        (stop.kind !== 'server.stop' && stop.kind !== 'server.force-kill')
      ) {
        throw apiError(409, 'BACKUP_STOP_REQUIRED', 'Uma parada do servidor precisa preceder a restauração.');
      }
      if (stop.status !== 'succeeded') {
        throw apiError(409, 'BACKUP_STOP_NOT_CONFIRMED', 'A parada que precede a restauração não foi concluída.');
      }

      const accepted = await acceptAndQueue({
        request,
        serverId,
        kind: 'backup.restore',
        jobType: 'backup.restore',
        idempotencyKey: body.idempotencyKey,
        reasonCode: body.reasonCode,
        actionName: 'backup.restore.requested',
        backupId: body.backupId,
      });
      reply.code(202);
      return accepted.operation;
    },
  );

  app.post<{ Params: ServerParams; Body: VerifyRestoreBody }>(
    '/api/v1/servers/:serverId/backups/verify-restore',
    {
      schema: { params: ServerParamsSchema, body: VerifyRestoreBodySchema },
      preHandler: [authenticate, requireCsrf, requirePermission('backups.restore')],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply): Promise<ServerOperation> => {
      if (!validateVerifyBackupRestoreRequest(request.body).success) {
        throw apiError(400, 'BACKUP_REQUEST_INVALID', 'Solicitação inválida.');
      }
      const { serverId } = request.params;
      await requireServer(serverId);
      const body = request.body;
      const backup = await repositories.backups.findById(body.backupId);
      if (backup === undefined || backup.serverInstanceId !== serverId) {
        throw apiError(404, 'BACKUP_NOT_FOUND', 'Backup não encontrado.');
      }
      if (backup.status !== 'available') {
        throw apiError(
          409,
          'BACKUP_NOT_RESTORABLE',
          'O backup não está disponível para verificação.',
        );
      }
      const observed = await repositories.processStates.find(serverId);
      if (observed === undefined || observed.stale || observed.lifecycle !== 'offline') {
        throw apiError(
          409,
          'BACKUP_OFFLINE_WINDOW_REQUIRED',
          'Desligue o servidor e aguarde uma observação atual antes do teste.',
        );
      }

      const accepted = await acceptAndQueue({
        request,
        serverId,
        kind: 'backup.verify-restore',
        jobType: 'backup.verify-restore',
        idempotencyKey: body.idempotencyKey,
        reasonCode: body.reasonCode,
        actionName: 'backup.restore-verification.requested',
        backupId: body.backupId,
      });
      reply.code(202);
      return accepted.operation;
    },
  );
}
