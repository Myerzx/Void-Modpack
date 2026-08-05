import { Type, type Static } from '@sinclair/typebox';
import { ContractSchemaVersion, IsoDateTimeSchema, UuidSchema } from './common.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationResult,
} from './validation.js';

/**
 * Public contracts for the Phase 10.4 metrics, logs and alerts.
 *
 * Every value carries where it came from and how good it is. That is not
 * decoration: this platform can measure the host, the process and the JVM, but
 * it cannot see inside a running Minecraft server without an in-game provider,
 * and TPS/MSPT are exactly the numbers an operator most wants. A panel that
 * showed a plausible-looking tick rate nobody measured would be worse than one
 * that showed nothing, so "unavailable" is a first-class reading with its own
 * source rather than a gap to be filled with an estimate.
 *
 * A reading therefore has a value **or** a reason it has none. It never has a
 * default standing in for one.
 */

/** Where a reading came from. A closed set; nothing else may claim to measure. */
export const MetricSourceSchema = Type.Union([
  /** The agent reading its own host: disk, memory, load. */
  Type.Literal('host-agent'),
  /** The process adapter: liveness, pid, resident memory of the child. */
  Type.Literal('process-adapter'),
  /** The JVM's own instrumentation, read by the agent. */
  Type.Literal('jvm'),
  /**
   * An approved in-game provider. The only source that can report tick timing,
   * and the one this deployment has not connected.
   */
  Type.Literal('game-provider'),
  /** Nothing measured this. Pairs only with a null value. */
  Type.Literal('none'),
]);

/**
 * How much the reading is worth.
 *
 * `derived` is called out separately from `measured` because a number computed
 * from others fails differently: it can be self-consistent and wrong when an
 * input was stale.
 */
export const MetricQualitySchema = Type.Union([
  Type.Literal('measured'),
  Type.Literal('derived'),
  Type.Literal('stale'),
  Type.Literal('unavailable'),
]);

export const MetricNameSchema = Type.Union([
  Type.Literal('host.disk.free.bytes'),
  Type.Literal('host.disk.total.bytes'),
  Type.Literal('host.memory.available.bytes'),
  Type.Literal('host.memory.total.bytes'),
  Type.Literal('host.load.1m'),
  Type.Literal('process.resident.bytes'),
  Type.Literal('process.uptime.seconds'),
  Type.Literal('jvm.heap.used.bytes'),
  Type.Literal('jvm.heap.max.bytes'),
  Type.Literal('jvm.gc.pause.millis'),
  Type.Literal('game.tps'),
  Type.Literal('game.mspt'),
  Type.Literal('game.players.online'),
]);

/**
 * One reading.
 *
 * `value` and `unavailableReason` are exclusive and exhaustive: exactly one of
 * them is present, so a consumer cannot accidentally render a missing number as
 * zero.
 */
export const MetricReadingSchema = Type.Object(
  {
    name: MetricNameSchema,
    value: Type.Union([Type.Number(), Type.Null()]),
    source: MetricSourceSchema,
    quality: MetricQualitySchema,
    observedAt: IsoDateTimeSchema,
    unavailableReason: Type.Union([
      Type.Literal('no-approved-provider'),
      Type.Literal('server-offline'),
      Type.Literal('collector-failed'),
      Type.Literal('not-collected'),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export const MetricSnapshotSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    serverInstanceId: UuidSchema,
    collectedAt: IsoDateTimeSchema,
    readings: Type.Array(MetricReadingSchema, { maxItems: 64 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/metric-snapshot.schema.json',
    additionalProperties: false,
  },
);

/**
 * An aggregated bucket.
 *
 * Retention keeps buckets, not raw samples: an operator asking "was memory
 * tight last week" needs a shape, and keeping every sample forever to answer it
 * is how a metrics store becomes the largest table in the database.
 *
 * `sampleCount` travels with the aggregate so a bucket built from two readings
 * is not read with the same confidence as one built from sixty.
 */
export const MetricBucketSchema = Type.Object(
  {
    name: MetricNameSchema,
    bucketStart: IsoDateTimeSchema,
    bucketSeconds: Type.Integer({ minimum: 10, maximum: 86_400 }),
    minimum: Type.Number(),
    maximum: Type.Number(),
    average: Type.Number(),
    sampleCount: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    source: MetricSourceSchema,
    quality: MetricQualitySchema,
  },
  { additionalProperties: false },
);

export const MetricSeriesSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    serverInstanceId: UuidSchema,
    buckets: Type.Array(MetricBucketSchema, { maxItems: 2_000 }),
    /**
     * Metrics the caller asked about that nothing is measuring. Reported so the
     * panel can say "not available" rather than draw an empty chart that looks
     * like a healthy zero.
     */
    unavailable: Type.Array(
      Type.Object(
        {
          name: MetricNameSchema,
          source: MetricSourceSchema,
          reason: Type.Union([
            Type.Literal('no-approved-provider'),
            Type.Literal('server-offline'),
            Type.Literal('collector-failed'),
            Type.Literal('not-collected'),
          ]),
        },
        { additionalProperties: false },
      ),
      { maxItems: 64 },
    ),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/metric-series.schema.json',
    additionalProperties: false,
  },
);

export const AlertKindSchema = Type.Union([
  Type.Literal('disk.low'),
  Type.Literal('memory.low'),
  Type.Literal('server.crashed'),
  Type.Literal('agent.offline'),
  Type.Literal('job.failed'),
]);

export const AlertSeveritySchema = Type.Union([
  Type.Literal('warning'),
  Type.Literal('critical'),
]);

/**
 * An open or resolved alert.
 *
 * An alert names the reading that raised it. Without that an operator has a
 * red badge and no way to check whether it is still true.
 */
export const AlertSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    alertId: UuidSchema,
    serverInstanceId: UuidSchema,
    kind: AlertKindSchema,
    severity: AlertSeveritySchema,
    status: Type.Union([Type.Literal('open'), Type.Literal('resolved')]),
    raisedAt: IsoDateTimeSchema,
    resolvedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
    /** The metric that raised it, when a metric did. */
    metricName: Type.Union([MetricNameSchema, Type.Null()]),
    observedValue: Type.Union([Type.Number(), Type.Null()]),
    threshold: Type.Union([Type.Number(), Type.Null()]),
    source: MetricSourceSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/alert.schema.json',
    additionalProperties: false,
  },
);

export const AlertPageSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    serverInstanceId: UuidSchema,
    alerts: Type.Array(AlertSchema, { maxItems: 200 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/alert-page.schema.json',
    additionalProperties: false,
  },
);

export type MetricSource = Static<typeof MetricSourceSchema>;
export type MetricQuality = Static<typeof MetricQualitySchema>;
export type MetricName = Static<typeof MetricNameSchema>;
export type MetricReading = Static<typeof MetricReadingSchema>;
export type MetricSnapshot = Static<typeof MetricSnapshotSchema>;
export type MetricBucket = Static<typeof MetricBucketSchema>;
export type MetricSeries = Static<typeof MetricSeriesSchema>;
export type AlertKind = Static<typeof AlertKindSchema>;
export type AlertSeverity = Static<typeof AlertSeveritySchema>;
export type AlertContract = Static<typeof AlertSchema>;
export type AlertPageContract = Static<typeof AlertPageSchema>;

/**
 * Metrics only an in-game provider can produce.
 *
 * Listed explicitly so the refusal is a fact in the contract rather than a
 * convention some collector might quietly break.
 */
export const GAME_PROVIDER_METRICS: readonly MetricName[] = Object.freeze([
  'game.tps',
  'game.mspt',
  'game.players.online',
]);

export function requiresGameProvider(name: MetricName): boolean {
  return (GAME_PROVIDER_METRICS as readonly string[]).includes(name);
}

/** Checks a reading against the rule that a value and its absence are exclusive. */
export function readingIssues(reading: MetricReading): readonly string[] {
  const issues: string[] = [];
  const hasValue = reading.value !== null;
  const hasReason = reading.unavailableReason !== null;
  if (hasValue === hasReason) {
    // Both or neither. Either way a consumer cannot tell a measurement from a
    // gap, which is the one thing this shape exists to prevent.
    issues.push('a reading carries either a value or a reason it has none');
  }
  if (hasValue && reading.quality === 'unavailable') {
    issues.push('an unavailable reading carries no value');
  }
  if (!hasValue && reading.quality !== 'unavailable') {
    issues.push('a reading without a value is unavailable');
  }
  if (hasValue && reading.source === 'none') {
    issues.push('a measured reading names what measured it');
  }
  if (hasValue && !Number.isFinite(reading.value)) {
    issues.push('a reading value is finite');
  }
  // Tick timing cannot come from anywhere but an approved in-game provider.
  // Letting the host agent claim it would be exactly the fabricated metric this
  // phase forbids.
  if (requiresGameProvider(reading.name) && hasValue && reading.source !== 'game-provider') {
    issues.push('this metric is only measurable by an approved in-game provider');
  }
  return issues;
}

export function validateMetricSnapshot(
  value: unknown,
): ContractValidationResult<MetricSnapshot> {
  const result = validateContract(MetricSnapshotSchema, value);
  if (!result.success) return result;
  const issues = result.value.readings.flatMap((reading, index) =>
    readingIssues(reading).map((message) => semanticIssue(`/readings/${index}`, message)),
  );
  // A snapshot naming the same metric twice would leave a consumer picking one
  // arbitrarily and calling it the reading.
  const names = new Set<string>();
  for (const [index, reading] of result.value.readings.entries()) {
    if (names.has(reading.name)) {
      issues.push(semanticIssue(`/readings/${index}`, 'a snapshot reports each metric once'));
    }
    names.add(reading.name);
  }
  return appendSemanticIssues(result, issues);
}

export function validateAlert(value: unknown): ContractValidationResult<AlertContract> {
  const result = validateContract(AlertSchema, value);
  if (!result.success) return result;
  const alert = result.value;
  const issues = [];
  if ((alert.status === 'resolved') !== (alert.resolvedAt !== null)) {
    issues.push(semanticIssue('/resolvedAt', 'only a resolved alert says when it resolved'));
  }
  if (alert.resolvedAt !== null && Date.parse(alert.resolvedAt) < Date.parse(alert.raisedAt)) {
    issues.push(semanticIssue('/resolvedAt', 'an alert cannot resolve before it was raised'));
  }
  if ((alert.metricName === null) !== (alert.observedValue === null)) {
    issues.push(semanticIssue('/observedValue', 'a metric alert carries the value that raised it'));
  }
  return appendSemanticIssues(result, issues);
}

export function validateMetricSeries(value: unknown): ContractValidationResult<MetricSeries> {
  const result = validateContract(MetricSeriesSchema, value);
  if (!result.success) return result;
  const issues = [];
  for (const [index, bucket] of result.value.buckets.entries()) {
    if (bucket.minimum > bucket.average || bucket.average > bucket.maximum) {
      issues.push(semanticIssue(`/buckets/${index}`, 'a bucket average lies within its range'));
    }
    if (requiresGameProvider(bucket.name) && bucket.source !== 'game-provider') {
      issues.push(
        semanticIssue(`/buckets/${index}`, 'this metric is only measurable by an approved in-game provider'),
      );
    }
  }
  return appendSemanticIssues(result, issues);
}
