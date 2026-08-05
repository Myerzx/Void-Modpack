import { Type, type Static } from '@sinclair/typebox';
import {
  requiresGameProvider,
  type AlertPageContract,
  type MetricName,
  type MetricSeries,
} from '@voidfall/contracts';
import type { Repositories } from '@voidfall/database';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Metrics and alerts for Phase 10.4.
 *
 * The defining rule of this surface is that it never invents a number. Every
 * value the panel receives says where it came from and how good it is, and a
 * metric nothing is measuring comes back in an explicit `unavailable` list
 * rather than as an absence the panel would draw as a flat healthy line.
 *
 * Tick timing is the case this exists for. TPS and MSPT are what an operator
 * most wants and the only things this platform cannot see: they need an
 * approved in-game provider, which this deployment has not connected. So they
 * are reported as unavailable, with the reason, on every request.
 */

export type TelemetryPermission = 'metrics.view' | 'logs.view';

export interface TelemetryRouteDependencies {
  readonly repositories: Repositories;
  readonly clock: () => Date;
  readonly authenticate: (request: FastifyRequest) => Promise<void>;
  readonly requirePermission: (
    permission: TelemetryPermission,
  ) => (request: FastifyRequest) => Promise<void>;
  readonly apiError: (statusCode: number, code: string, message: string) => Error;
  /**
   * Whether an approved in-game provider is connected. Absent means no, and
   * the routes say so rather than leaving the caller to guess.
   */
  readonly gameProviderConnected?: boolean;
}

const ServerParamsSchema = Type.Object(
  { serverId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);

const METRIC_NAMES: readonly MetricName[] = Object.freeze([
  'host.disk.free.bytes',
  'host.disk.total.bytes',
  'host.memory.available.bytes',
  'host.memory.total.bytes',
  'host.load.1m',
  'process.resident.bytes',
  'process.uptime.seconds',
  'jvm.heap.used.bytes',
  'jvm.heap.max.bytes',
  'jvm.gc.pause.millis',
  'game.tps',
  'game.mspt',
  'game.players.online',
]);

const MetricsQuerySchema = Type.Object(
  {
    // Query values arrive as strings and this API validates without coercion.
    windowMinutes: Type.Optional(Type.String({ pattern: '^[0-9]{1,5}$' })),
    names: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);

const AlertsQuerySchema = Type.Object(
  { status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('resolved')])) },
  { additionalProperties: false },
);

type ServerParams = Static<typeof ServerParamsSchema>;
type MetricsQuery = Static<typeof MetricsQuerySchema>;
type AlertsQuery = Static<typeof AlertsQuerySchema>;

const DEFAULT_WINDOW_MINUTES = 60;
const MAXIMUM_WINDOW_MINUTES = 10_080;

export function registerTelemetryRoutes(
  app: FastifyInstance,
  dependencies: TelemetryRouteDependencies,
): void {
  const { repositories, clock, authenticate, requirePermission, apiError } = dependencies;
  const providerConnected = dependencies.gameProviderConnected === true;

  async function requireServer(serverId: string): Promise<void> {
    const server = await repositories.servers.findById(serverId);
    if (server === undefined) throw apiError(404, 'SERVER_NOT_FOUND', 'Servidor não encontrado.');
  }

  app.get<{ Params: ServerParams; Querystring: MetricsQuery }>(
    '/api/v1/servers/:serverId/metrics',
    {
      schema: { params: ServerParamsSchema, querystring: MetricsQuerySchema },
      preHandler: [authenticate, requirePermission('metrics.view')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request): Promise<MetricSeries> => {
      const { serverId } = request.params;
      await requireServer(serverId);

      const rawWindow = request.query.windowMinutes;
      const windowMinutes =
        rawWindow === undefined ? DEFAULT_WINDOW_MINUTES : Number.parseInt(rawWindow, 10);
      if (
        !Number.isSafeInteger(windowMinutes) ||
        windowMinutes < 1 ||
        windowMinutes > MAXIMUM_WINDOW_MINUTES
      ) {
        throw apiError(400, 'METRICS_REQUEST_INVALID', 'Solicitação inválida.');
      }

      // An unknown name is refused rather than silently dropped: a caller that
      // misspelled a metric should learn that, not receive an empty chart.
      const requested =
        request.query.names === undefined
          ? METRIC_NAMES
          : request.query.names.split(',').map((name) => name.trim());
      for (const name of requested) {
        if (!(METRIC_NAMES as readonly string[]).includes(name)) {
          throw apiError(400, 'METRICS_REQUEST_INVALID', 'Solicitação inválida.');
        }
      }
      const names = requested as readonly MetricName[];

      // Split before reading: a metric that needs a provider nobody connected
      // has nothing stored, and reporting it as an empty series would look
      // exactly like a healthy zero.
      const measurable = names.filter((name) => providerConnected || !requiresGameProvider(name));
      const unmeasurable = names.filter((name) => !providerConnected && requiresGameProvider(name));

      const since = new Date(clock().getTime() - windowMinutes * 60_000);
      const buckets = await repositories.telemetry.readSeries({
        serverInstanceId: serverId,
        names: measurable,
        since,
      });

      const covered = new Set(buckets.map((bucket) => bucket.name));
      return {
        schemaVersion: 1,
        serverInstanceId: serverId,
        buckets: [...buckets],
        unavailable: [
          ...unmeasurable.map((name) => ({
            name,
            source: 'none' as const,
            reason: 'no-approved-provider' as const,
          })),
          // Measurable, but nothing has reported it in this window. Also said
          // out loud, for the same reason.
          ...measurable
            .filter((name) => !covered.has(name))
            .map((name) => ({
              name,
              source: 'none' as const,
              reason: 'not-collected' as const,
            })),
        ],
      } satisfies MetricSeries;
    },
  );

  app.get<{ Params: ServerParams; Querystring: AlertsQuery }>(
    '/api/v1/servers/:serverId/alerts',
    {
      schema: { params: ServerParamsSchema, querystring: AlertsQuerySchema },
      preHandler: [authenticate, requirePermission('metrics.view')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request): Promise<AlertPageContract> => {
      const { serverId } = request.params;
      await requireServer(serverId);
      const alerts = await repositories.telemetry.listAlerts({
        serverInstanceId: serverId,
        ...(request.query.status === undefined ? {} : { status: request.query.status }),
      });
      return {
        schemaVersion: 1,
        serverInstanceId: serverId,
        alerts: [...alerts],
      } satisfies AlertPageContract;
    },
  );
}
