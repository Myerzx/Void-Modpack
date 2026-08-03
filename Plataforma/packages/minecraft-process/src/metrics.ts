import { availableParallelism, freemem, totalmem, uptime } from 'node:os';
import type { ObservedProcessState } from './state-machine.js';

export type MetricUnit = 'bytes' | 'seconds' | 'count' | 'process-id' | 'percent';
export type MetricQuality = 'real' | 'calculated' | 'unavailable';
export type MetricSource =
  | 'node:os'
  | 'node:os:derived'
  | 'process-adapter'
  | 'process-adapter:derived'
  | 'portable-runtime';
export type MetricUnavailableReason =
  | 'not-running'
  | 'process-error'
  | 'not-observed'
  | 'unsupported-portable-runtime';

export interface AvailableMetric {
  readonly status: 'available';
  readonly value: number;
  readonly unit: MetricUnit;
  readonly quality: 'real' | 'calculated';
  readonly source: MetricSource;
  readonly collectedAt: string;
}

export interface UnavailableMetric {
  readonly status: 'unavailable';
  readonly unit: MetricUnit;
  readonly quality: 'unavailable';
  readonly source: MetricSource;
  readonly collectedAt: string;
  readonly reason: MetricUnavailableReason;
}

export type MetricValue = AvailableMetric | UnavailableMetric;

export interface HostMetricsSample {
  readonly totalMemoryBytes: number;
  readonly freeMemoryBytes: number;
  readonly uptimeSeconds: number;
  readonly availableCpuCount: number;
}

export interface HostMetricsSampler {
  sample(): HostMetricsSample;
}

export class NodeHostMetricsSampler implements HostMetricsSampler {
  sample(): HostMetricsSample {
    return {
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
      uptimeSeconds: uptime(),
      availableCpuCount: availableParallelism(),
    };
  }
}

export interface ProcessMetricsObservation {
  readonly state: ObservedProcessState;
  readonly observedAt: string;
  readonly pid?: number;
  readonly startedAt?: string;
}

export interface MinecraftMetricsSnapshotOptions {
  readonly host: HostMetricsSample;
  readonly process: ProcessMetricsObservation;
  readonly clock?: () => Date;
}

export interface ProcessMetricState {
  readonly value: ObservedProcessState;
  readonly source: 'process-adapter';
  readonly observedAt: string;
}

export interface MinecraftMetricsSnapshot {
  readonly collectedAt: string;
  readonly host: {
    readonly totalMemory: AvailableMetric;
    readonly freeMemory: AvailableMetric;
    readonly usedMemory: AvailableMetric;
    readonly uptime: AvailableMetric;
    readonly availableCpuCount: AvailableMetric;
  };
  readonly process: {
    readonly state: ProcessMetricState;
    readonly pid: MetricValue;
    readonly uptime: MetricValue;
    readonly cpuPercent: MetricValue;
    readonly residentMemory: MetricValue;
  };
}

function timestamp(value: Date, field: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${field} is invalid.`);
  }
  return value.toISOString();
}

function parseTimestamp(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} is invalid.`);
  }
  return parsed;
}

function validateFiniteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} is invalid.`);
  }
}

function validateHostSample(sample: HostMetricsSample): void {
  validateFiniteNonNegative(sample.totalMemoryBytes, 'totalMemoryBytes');
  validateFiniteNonNegative(sample.freeMemoryBytes, 'freeMemoryBytes');
  validateFiniteNonNegative(sample.uptimeSeconds, 'uptimeSeconds');
  if (!Number.isSafeInteger(sample.totalMemoryBytes) || sample.totalMemoryBytes === 0) {
    throw new Error('totalMemoryBytes is invalid.');
  }
  if (!Number.isSafeInteger(sample.freeMemoryBytes)) {
    throw new Error('freeMemoryBytes is invalid.');
  }
  if (sample.freeMemoryBytes > sample.totalMemoryBytes) {
    throw new Error('freeMemoryBytes cannot exceed totalMemoryBytes.');
  }
  if (
    !Number.isSafeInteger(sample.availableCpuCount) ||
    sample.availableCpuCount < 1 ||
    sample.availableCpuCount > 65_536
  ) {
    throw new Error('availableCpuCount is invalid.');
  }
}

function available(
  value: number,
  unit: MetricUnit,
  quality: AvailableMetric['quality'],
  source: MetricSource,
  collectedAt: string,
): AvailableMetric {
  validateFiniteNonNegative(value, 'metric value');
  return Object.freeze({ status: 'available', value, unit, quality, source, collectedAt });
}

function unavailable(
  unit: MetricUnit,
  source: MetricSource,
  reason: MetricUnavailableReason,
  collectedAt: string,
): UnavailableMetric {
  return Object.freeze({
    status: 'unavailable',
    unit,
    quality: 'unavailable',
    source,
    collectedAt,
    reason,
  });
}

function unavailableReason(state: ObservedProcessState): MetricUnavailableReason {
  if (state === 'offline') return 'not-running';
  if (state === 'error') return 'process-error';
  return 'not-observed';
}

export function createMinecraftMetricsSnapshot(
  options: MinecraftMetricsSnapshotOptions,
): MinecraftMetricsSnapshot {
  validateHostSample(options.host);
  const collectedDate = options.clock?.() ?? new Date();
  const collectedAt = timestamp(collectedDate, 'metrics clock');
  const stateObservedAt = timestamp(
    parseTimestamp(options.process.observedAt, 'process observedAt'),
    'process observedAt',
  );
  const state = options.process.state;
  const active = state === 'starting' || state === 'online' || state === 'stopping';
  let pid: MetricValue;
  let processUptime: MetricValue;
  let unsupportedReason: MetricUnavailableReason;

  if (active) {
    const processPid = options.process.pid;
    if (typeof processPid !== 'number' || !Number.isSafeInteger(processPid) || processPid < 1) {
      throw new Error('Active process PID is invalid.');
    }
    if (options.process.startedAt === undefined) {
      throw new Error('Active process startedAt is missing.');
    }
    const startedAt = parseTimestamp(options.process.startedAt, 'process startedAt');
    if (collectedDate.getTime() < startedAt.getTime()) {
      throw new Error('Metrics clock precedes process startedAt.');
    }
    pid = available(
      processPid,
      'process-id',
      'real',
      'process-adapter',
      collectedAt,
    );
    processUptime = available(
      (collectedDate.getTime() - startedAt.getTime()) / 1_000,
      'seconds',
      'calculated',
      'process-adapter:derived',
      collectedAt,
    );
    unsupportedReason = 'unsupported-portable-runtime';
  } else {
    const reason = unavailableReason(state);
    pid = unavailable('process-id', 'process-adapter', reason, collectedAt);
    processUptime = unavailable('seconds', 'process-adapter:derived', reason, collectedAt);
    unsupportedReason = reason;
  }

  return Object.freeze({
    collectedAt,
    host: Object.freeze({
      totalMemory: available(
        options.host.totalMemoryBytes,
        'bytes',
        'real',
        'node:os',
        collectedAt,
      ),
      freeMemory: available(
        options.host.freeMemoryBytes,
        'bytes',
        'real',
        'node:os',
        collectedAt,
      ),
      usedMemory: available(
        options.host.totalMemoryBytes - options.host.freeMemoryBytes,
        'bytes',
        'calculated',
        'node:os:derived',
        collectedAt,
      ),
      uptime: available(
        options.host.uptimeSeconds,
        'seconds',
        'real',
        'node:os',
        collectedAt,
      ),
      availableCpuCount: available(
        options.host.availableCpuCount,
        'count',
        'real',
        'node:os',
        collectedAt,
      ),
    }),
    process: Object.freeze({
      state: Object.freeze({
        value: state,
        source: 'process-adapter',
        observedAt: stateObservedAt,
      }),
      pid,
      uptime: processUptime,
      cpuPercent: unavailable(
        'percent',
        'portable-runtime',
        unsupportedReason,
        collectedAt,
      ),
      residentMemory: unavailable(
        'bytes',
        'portable-runtime',
        unsupportedReason,
        collectedAt,
      ),
    }),
  });
}
