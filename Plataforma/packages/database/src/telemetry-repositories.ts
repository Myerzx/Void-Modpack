import type {
  AlertContract,
  AlertKind,
  AlertSeverity,
  MetricBucket,
  MetricName,
  MetricQuality,
  MetricSource,
} from '@voidfall/contracts';

import type { Database } from './database.js';

/**
 * Metric buckets and alerts.
 *
 * Buckets are upserted rather than inserted: a collector reporting the same
 * window twice must fold into the existing row, not create a second one that
 * would double every average read from it.
 *
 * Alerts are opened at most once per kind per server, enforced by a partial
 * unique index. A collector running every thirty seconds would otherwise raise
 * a new "disk is low" every thirty seconds, and the one alert an operator
 * needed to see would be buried under copies of itself.
 */

export type TelemetryPersistenceErrorCode = 'invalid-bucket' | 'invalid-alert';

export class TelemetryPersistenceError extends Error {
  public readonly code: TelemetryPersistenceErrorCode;

  public constructor(code: TelemetryPersistenceErrorCode) {
    super(`telemetry:${code}`);
    this.name = 'TelemetryPersistenceError';
    this.code = code;
  }
}

interface BucketRow {
  readonly metric_name: MetricName;
  readonly bucket_start: Date | string;
  readonly bucket_seconds: number | string;
  readonly minimum: number | string;
  readonly maximum: number | string;
  readonly average: number | string;
  readonly sample_count: number | string;
  readonly source: MetricSource;
  readonly quality: MetricQuality;
}

interface AlertRow {
  readonly alert_id: string;
  readonly server_instance_id: string;
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  readonly status: 'open' | 'resolved';
  readonly raised_at: Date | string;
  readonly resolved_at: Date | string | null;
  readonly metric_name: MetricName | null;
  readonly observed_value: number | string | null;
  readonly threshold: number | string | null;
  readonly source: MetricSource;
}

function isoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function numeric(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

function mapBucket(row: BucketRow): MetricBucket {
  return {
    name: row.metric_name,
    bucketStart: isoString(row.bucket_start),
    bucketSeconds: numeric(row.bucket_seconds),
    minimum: numeric(row.minimum),
    maximum: numeric(row.maximum),
    average: numeric(row.average),
    sampleCount: numeric(row.sample_count),
    source: row.source,
    quality: row.quality,
  };
}

function mapAlert(row: AlertRow): AlertContract {
  return {
    schemaVersion: 1,
    alertId: row.alert_id,
    serverInstanceId: row.server_instance_id,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    raisedAt: isoString(row.raised_at),
    resolvedAt: row.resolved_at === null ? null : isoString(row.resolved_at),
    metricName: row.metric_name,
    observedValue: row.observed_value === null ? null : numeric(row.observed_value),
    threshold: row.threshold === null ? null : numeric(row.threshold),
    source: row.source,
  };
}

const MAXIMUM_BUCKETS = 2_000;

export class TelemetryRepository {
  public constructor(private readonly database: Database) {}

  /**
   * Stores buckets, folding a window reported twice into the row already there.
   *
   * The fold is computed in SQL from both sides rather than read-then-written:
   * two collectors reporting the same window concurrently must not be able to
   * lose one another's samples in the gap between a read and a write.
   */
  public async recordBuckets(input: {
    readonly serverInstanceId: string;
    readonly buckets: readonly MetricBucket[];
    readonly now: Date;
  }): Promise<number> {
    if (input.buckets.length > MAXIMUM_BUCKETS) {
      throw new TelemetryPersistenceError('invalid-bucket');
    }
    let stored = 0;
    for (const bucket of input.buckets) {
      if (
        !Number.isFinite(bucket.minimum) ||
        !Number.isFinite(bucket.maximum) ||
        !Number.isFinite(bucket.average) ||
        bucket.minimum > bucket.average ||
        bucket.average > bucket.maximum
      ) {
        throw new TelemetryPersistenceError('invalid-bucket');
      }
      await this.database.query(
        `INSERT INTO server_metric_buckets (
           server_instance_id, metric_name, bucket_start, bucket_seconds,
           minimum, maximum, average, sample_count, source, quality, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (server_instance_id, metric_name, bucket_start) DO UPDATE SET
           minimum = LEAST(server_metric_buckets.minimum, EXCLUDED.minimum),
           maximum = GREATEST(server_metric_buckets.maximum, EXCLUDED.maximum),
           average = (
             server_metric_buckets.average * server_metric_buckets.sample_count
             + EXCLUDED.average * EXCLUDED.sample_count
           ) / (server_metric_buckets.sample_count + EXCLUDED.sample_count),
           sample_count = server_metric_buckets.sample_count + EXCLUDED.sample_count,
           -- A merged bucket is only as good as its worse half.
           quality = CASE
             WHEN server_metric_buckets.quality = 'stale' OR EXCLUDED.quality = 'stale' THEN 'stale'
             WHEN server_metric_buckets.quality = 'derived' OR EXCLUDED.quality = 'derived' THEN 'derived'
             ELSE server_metric_buckets.quality
           END`,
        [
          input.serverInstanceId,
          bucket.name,
          bucket.bucketStart,
          bucket.bucketSeconds,
          bucket.minimum,
          bucket.maximum,
          bucket.average,
          bucket.sampleCount,
          bucket.source,
          bucket.quality,
          input.now.toISOString(),
        ],
      );
      stored += 1;
    }
    return stored;
  }

  public async readSeries(input: {
    readonly serverInstanceId: string;
    readonly names: readonly MetricName[];
    readonly since: Date;
    readonly limit?: number;
  }): Promise<readonly MetricBucket[]> {
    if (input.names.length === 0) return Object.freeze([]);
    const bounded = Math.min(Math.max(input.limit ?? 500, 1), MAXIMUM_BUCKETS);
    const result = await this.database.query<BucketRow>(
      `SELECT metric_name, bucket_start, bucket_seconds, minimum, maximum, average,
              sample_count, source, quality
         FROM server_metric_buckets
        WHERE server_instance_id = $1
          AND metric_name = ANY($2::text[])
          AND bucket_start >= $3
        ORDER BY metric_name ASC, bucket_start ASC
        LIMIT $4`,
      [input.serverInstanceId, input.names, input.since.toISOString(), bounded],
    );
    return result.rows.map(mapBucket);
  }

  /**
   * Discards buckets past the retention window.
   *
   * Retention is the reason buckets exist rather than samples, so it has to be
   * something that actually runs — not a policy recorded and never applied.
   */
  public async pruneBuckets(before: Date): Promise<number> {
    const result = await this.database.query(
      'DELETE FROM server_metric_buckets WHERE bucket_start < $1',
      [before.toISOString()],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Opens an alert, or leaves the existing open one alone.
   *
   * Returns the alert either way, so a caller cannot tell a fresh raise from a
   * repeat and be tempted to notify on both.
   */
  public async openAlert(input: {
    readonly alertId: string;
    readonly serverInstanceId: string;
    readonly kind: AlertKind;
    readonly severity: AlertSeverity;
    readonly metricName: MetricName | null;
    readonly observedValue: number | null;
    readonly threshold: number | null;
    readonly source: MetricSource;
    readonly now: Date;
  }): Promise<AlertContract> {
    const inserted = await this.database.query<AlertRow>(
      `INSERT INTO server_alerts (
         alert_id, server_instance_id, kind, severity, status, raised_at,
         metric_name, observed_value, threshold, source
       ) VALUES ($1,$2,$3,$4,'open',$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        input.alertId,
        input.serverInstanceId,
        input.kind,
        input.severity,
        input.now.toISOString(),
        input.metricName,
        input.observedValue,
        input.threshold,
        input.source,
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return mapAlert(row);

    const existing = await this.database.query<AlertRow>(
      `SELECT * FROM server_alerts
        WHERE server_instance_id = $1 AND kind = $2 AND status = 'open'`,
      [input.serverInstanceId, input.kind],
    );
    const open = existing.rows[0];
    if (open === undefined) throw new TelemetryPersistenceError('invalid-alert');
    return mapAlert(open);
  }

  public async resolveAlert(alertId: string, now: Date): Promise<void> {
    await this.database.query(
      `UPDATE server_alerts SET status = 'resolved', resolved_at = $2
        WHERE alert_id = $1 AND status = 'open'`,
      [alertId, now.toISOString()],
    );
  }

  public async listAlerts(input: {
    readonly serverInstanceId: string;
    readonly status?: 'open' | 'resolved';
    readonly limit?: number;
  }): Promise<readonly AlertContract[]> {
    const bounded = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const parameters: unknown[] = [input.serverInstanceId];
    let clause = '';
    if (input.status !== undefined) {
      parameters.push(input.status);
      clause = ` AND status = $${parameters.length}`;
    }
    parameters.push(bounded);
    const result = await this.database.query<AlertRow>(
      `SELECT * FROM server_alerts
        WHERE server_instance_id = $1${clause}
        ORDER BY raised_at DESC, alert_id ASC
        LIMIT $${parameters.length}`,
      parameters,
    );
    return result.rows.map(mapAlert);
  }
}
