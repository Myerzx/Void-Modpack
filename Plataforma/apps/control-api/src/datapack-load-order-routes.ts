import { createHash, randomUUID } from 'node:crypto';

import { Type, type Static } from '@sinclair/typebox';
import {
  DatapackLoadOrderObservationRequestSchema,
  validateDatapackLoadOrderObservationCommand,
  validateDatapackLoadOrderObservationRequest,
  type ActorRef,
  type DatapackLoadOrderObservationAcceptance,
  type DatapackLoadOrderObservationCommand,
  type DatapackLoadOrderObservationRequest,
  type Job,
} from '@voidfall/contracts';
import type { Repositories } from '@voidfall/database';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Control-plane producer for the bounded effective datapack-order observation.
 *
 * The route accepts no filesystem coordinate. It resolves the only registered
 * server workspace for the instance, pins an immutable ecosystem analysis and
 * queues the closed agent command. Reading the world remains the Server Agent's
 * responsibility and can only happen after its independent capability grant.
 */

export type DatapackLoadOrderPermission = 'datapacks.observe';

export interface DatapackLoadOrderRouteDependencies {
  readonly repositories: Repositories;
  readonly clock: () => Date;
  readonly authenticate: (request: FastifyRequest) => Promise<void>;
  readonly requirePermission: (
    permission: DatapackLoadOrderPermission,
  ) => (request: FastifyRequest) => Promise<void>;
  readonly requireCsrf: (request: FastifyRequest) => Promise<void>;
  readonly audit: (input: {
    readonly request: FastifyRequest;
    readonly actor: ActorRef;
    readonly action: string;
    readonly analysisId: string;
    readonly outcome: 'succeeded' | 'failed' | 'denied';
    readonly reason?: string;
  }) => Promise<void>;
  readonly apiError: (statusCode: number, code: string, message: string) => Error;
}

const ServerParamsSchema = Type.Object(
  { serverId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
type ServerParams = Static<typeof ServerParamsSchema>;

function derivedRequestIdentity(
  serverInstanceId: string,
  analysisId: string,
  publicIdempotencyKey: string,
): string {
  return createHash('sha256')
    .update(
      `voidfall-datapack-load-order-observation:${serverInstanceId}:${analysisId}:${publicIdempotencyKey}`,
    )
    .digest('hex');
}

function correlationIdFrom(identity: string): string {
  const variant = ((Number.parseInt(identity.slice(17, 18), 16) & 0x3) | 0x8).toString(16);
  return [
    identity.slice(0, 8),
    identity.slice(8, 12),
    `8${identity.slice(13, 16)}`,
    `${variant}${identity.slice(18, 21)}`,
    identity.slice(21, 33),
  ].join('-');
}

function acceptanceStatus(status: Job['status']): DatapackLoadOrderObservationAcceptance['status'] {
  return status === 'queued' ||
    status === 'running' ||
    status === 'succeeded' ||
    status === 'failed'
    ? status
    : 'queued';
}

export function registerDatapackLoadOrderRoutes(
  app: FastifyInstance,
  dependencies: DatapackLoadOrderRouteDependencies,
): void {
  const { repositories, clock, authenticate, requirePermission, requireCsrf, audit, apiError } =
    dependencies;

  function panelActor(request: FastifyRequest): ActorRef {
    const auth = request.authContext;
    if (auth === undefined) throw apiError(401, 'AUTH_REQUIRED', 'Autenticação necessária.');
    return { type: 'panel-user', id: auth.user.id };
  }

  async function refuse(input: {
    readonly request: FastifyRequest;
    readonly actor: ActorRef;
    readonly analysisId: string;
    readonly reason: string;
    readonly statusCode: number;
    readonly code: string;
    readonly message: string;
  }): Promise<never> {
    await audit({
      request: input.request,
      actor: input.actor,
      action: 'datapack-load-order.observe.requested',
      analysisId: input.analysisId,
      outcome: 'failed',
      reason: input.reason,
    });
    throw apiError(input.statusCode, input.code, input.message);
  }

  app.post<{ Params: ServerParams; Body: DatapackLoadOrderObservationRequest }>(
    '/api/v1/servers/:serverId/datapack-load-order/observations',
    {
      schema: {
        params: ServerParamsSchema,
        body: DatapackLoadOrderObservationRequestSchema,
      },
      preHandler: [authenticate, requireCsrf, requirePermission('datapacks.observe')],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const actor = panelActor(request);
      if (!validateDatapackLoadOrderObservationRequest(request.body).success) {
        throw apiError(400, 'DATAPACK_OBSERVATION_REQUEST_INVALID', 'Solicitação inválida.');
      }

      const server = await repositories.servers.findById(request.params.serverId);
      if (server === undefined) {
        return refuse({
          request,
          actor,
          analysisId: request.body.analysisId,
          reason: 'server-not-found',
          statusCode: 404,
          code: 'DATAPACK_OBSERVATION_SERVER_NOT_FOUND',
          message: 'Instância não encontrada.',
        });
      }

      const workspace = await repositories.workspaces.findServerByInstanceId(server.id);
      if (workspace === undefined) {
        return refuse({
          request,
          actor,
          analysisId: request.body.analysisId,
          reason: 'server-workspace-not-linked',
          statusCode: 409,
          code: 'DATAPACK_OBSERVATION_WORKSPACE_NOT_LINKED',
          message: 'A instância não possui um workspace de servidor vinculado.',
        });
      }

      const analysis = await repositories.ecosystemAnalysis.findByAnalysisId({
        workspaceId: workspace.workspaceId,
        analysisId: request.body.analysisId,
      });
      if (analysis === undefined) {
        return refuse({
          request,
          actor,
          analysisId: request.body.analysisId,
          reason: 'analysis-not-found',
          statusCode: 404,
          code: 'DATAPACK_OBSERVATION_ANALYSIS_NOT_FOUND',
          message: 'Análise não encontrada para o workspace vinculado.',
        });
      }
      if (analysis.inventorySha256 !== request.body.expectedInventorySha256) {
        return refuse({
          request,
          actor,
          analysisId: request.body.analysisId,
          reason: 'inventory-mismatch',
          statusCode: 409,
          code: 'DATAPACK_OBSERVATION_INVENTORY_STALE',
          message: 'O inventário da análise difere do inventário revisado.',
        });
      }
      if (
        analysis.document.analysisId !== analysis.analysisId ||
        analysis.document.inventorySha256 !== analysis.inventorySha256
      ) {
        return refuse({
          request,
          actor,
          analysisId: request.body.analysisId,
          reason: 'stored-analysis-invalid',
          statusCode: 409,
          code: 'DATAPACK_OBSERVATION_ANALYSIS_INVALID',
          message: 'A análise persistida não corresponde à identidade registrada.',
        });
      }

      const command: DatapackLoadOrderObservationCommand = {
        schemaVersion: 1,
        serverInstanceId: server.id,
        workspaceId: workspace.workspaceId,
        analysisId: analysis.analysisId,
        inventorySha256: analysis.inventorySha256,
      };
      if (!validateDatapackLoadOrderObservationCommand(command).success) {
        return refuse({
          request,
          actor,
          analysisId: request.body.analysisId,
          reason: 'resolved-command-invalid',
          statusCode: 409,
          code: 'DATAPACK_OBSERVATION_COMMAND_INVALID',
          message: 'A identidade resolvida não forma um comando válido.',
        });
      }

      const identity = derivedRequestIdentity(
        server.id,
        analysis.analysisId,
        request.body.idempotencyKey,
      );
      const now = clock();
      const job: Job = {
        schemaVersion: 1,
        id: randomUUID(),
        type: 'datapack-load-order.observe',
        resource: { type: 'server-instance', id: server.id },
        status: 'queued',
        stage: 'queued',
        priority: 40,
        payload: { schemaVersion: 1, parameters: { command } },
        idempotencyKey: `datapack-observe:${identity}`,
        requestedBy: actor,
        correlationId: correlationIdFrom(identity),
        availableAt: now.toISOString(),
        attempt: 0,
        maxAttempts: 1,
      };

      let enqueued: Job;
      try {
        enqueued = await repositories.jobs.enqueue(job);
      } catch {
        return refuse({
          request,
          actor,
          analysisId: analysis.analysisId,
          reason: 'idempotency-conflict',
          statusCode: 409,
          code: 'DATAPACK_OBSERVATION_IDEMPOTENCY_CONFLICT',
          message: 'A chave de idempotência já foi usada para outra solicitação.',
        });
      }
      const replayed = enqueued.id !== job.id;

      await audit({
        request,
        actor,
        action: 'datapack-load-order.observe.requested',
        analysisId: analysis.analysisId,
        outcome: 'succeeded',
        reason: replayed ? 'idempotent-replay' : request.body.reasonCode,
      });

      const acceptance: DatapackLoadOrderObservationAcceptance = {
        schemaVersion: 1,
        jobId: enqueued.id,
        serverInstanceId: server.id,
        workspaceId: workspace.workspaceId,
        analysisId: analysis.analysisId,
        inventorySha256: analysis.inventorySha256,
        status: acceptanceStatus(enqueued.status),
        idempotencyKey: request.body.idempotencyKey,
        replayed,
        correlationId: enqueued.correlationId,
        acceptedAt: enqueued.availableAt,
      };
      return reply.code(replayed ? 200 : 202).send(acceptance);
    },
  );
}
