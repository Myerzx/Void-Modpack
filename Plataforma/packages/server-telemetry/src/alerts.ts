import type { AlertKind, AlertSeverity, MetricName, MetricReading, MetricSource } from '@voidfall/contracts';

import { TelemetryError } from './aggregation.js';

/**
 * Alert evaluation.
 *
 * Pure functions over readings and observed facts, so what fires is decided —
 * and testable — before anything is written or sent.
 *
 * Two rules shape all of it:
 *
 *  - **An unavailable reading never clears an alert.** A collector that stopped
 *    working looks exactly like a disk that stopped filling, and treating the
 *    silence as good news is how a full disk goes unnoticed.
 *  - **An alert names the reading that raised it.** Without that an operator has
 *    a red badge and no way to check whether it is still true.
 */

export interface AlertThresholds {
  /** Fraction of disk free below which the alert fires. */
  readonly diskFreeWarningRatio: number;
  readonly diskFreeCriticalRatio: number;
  readonly memoryAvailableWarningRatio: number;
  readonly memoryAvailableCriticalRatio: number;
  /** How long without a heartbeat before an agent counts as offline. */
  readonly agentOfflineSeconds: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = Object.freeze({
  diskFreeWarningRatio: 0.15,
  diskFreeCriticalRatio: 0.05,
  memoryAvailableWarningRatio: 0.15,
  memoryAvailableCriticalRatio: 0.05,
  agentOfflineSeconds: 180,
});

export interface CandidateAlert {
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  readonly metricName: MetricName | null;
  readonly observedValue: number | null;
  readonly threshold: number | null;
  readonly source: MetricSource;
}

export interface AlertEvaluationInput {
  readonly readings: readonly MetricReading[];
  readonly thresholds?: Partial<AlertThresholds>;
  /** Facts the metrics cannot carry. */
  readonly observed: {
    /** The process exited without having been asked to. */
    readonly serverCrashed: boolean;
    /** When the agent was last heard from, or `null` if never. */
    readonly agentLastSeenAt: string | null;
    /** Jobs that ended in failure and have not been acknowledged. */
    readonly failedJobCount: number;
  };
  readonly now: Date;
}

function resolveThresholds(overrides?: Partial<AlertThresholds>): AlertThresholds {
  const merged = { ...DEFAULT_ALERT_THRESHOLDS, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isFinite(value) || value <= 0) throw new TelemetryError('invalid-window');
    if (key.endsWith('Ratio') && value >= 1) throw new TelemetryError('invalid-window');
  }
  if (
    merged.diskFreeCriticalRatio >= merged.diskFreeWarningRatio ||
    merged.memoryAvailableCriticalRatio >= merged.memoryAvailableWarningRatio
  ) {
    // Critical must be the tighter bound, or every warning would also be
    // critical and the distinction would carry no information.
    throw new TelemetryError('invalid-window');
  }
  return Object.freeze(merged);
}

/** A reading only counts for an alert when something actually measured it. */
function usableReading(
  readings: readonly MetricReading[],
  name: MetricName,
): MetricReading | undefined {
  const reading = readings.find((candidate) => candidate.name === name);
  if (reading === undefined || reading.value === null) return undefined;
  if (reading.quality === 'unavailable') return undefined;
  return reading;
}

function ratioAlert(input: {
  readonly kind: AlertKind;
  readonly freeName: MetricName;
  readonly totalName: MetricName;
  readonly readings: readonly MetricReading[];
  readonly warningRatio: number;
  readonly criticalRatio: number;
}): CandidateAlert | undefined {
  const free = usableReading(input.readings, input.freeName);
  const total = usableReading(input.readings, input.totalName);
  if (free === undefined || total === undefined) return undefined;
  if (total.value === null || free.value === null || total.value <= 0) return undefined;

  const ratio = free.value / total.value;
  if (ratio > input.warningRatio) return undefined;
  const critical = ratio <= input.criticalRatio;
  return Object.freeze({
    kind: input.kind,
    severity: critical ? ('critical' as const) : ('warning' as const),
    metricName: input.freeName,
    observedValue: free.value,
    // The absolute figure the ratio corresponds to, so an operator sees the
    // number the alert is actually about rather than having to recompute it.
    threshold: Number(
      (total.value * (critical ? input.criticalRatio : input.warningRatio)).toFixed(0),
    ),
    // A ratio is computed from two readings, so it is derived even when both
    // inputs were measured.
    source: free.source,
  });
}

export function evaluateAlerts(input: AlertEvaluationInput): readonly CandidateAlert[] {
  const thresholds = resolveThresholds(input.thresholds);
  const candidates: CandidateAlert[] = [];

  const disk = ratioAlert({
    kind: 'disk.low',
    freeName: 'host.disk.free.bytes',
    totalName: 'host.disk.total.bytes',
    readings: input.readings,
    warningRatio: thresholds.diskFreeWarningRatio,
    criticalRatio: thresholds.diskFreeCriticalRatio,
  });
  if (disk !== undefined) candidates.push(disk);

  const memory = ratioAlert({
    kind: 'memory.low',
    freeName: 'host.memory.available.bytes',
    totalName: 'host.memory.total.bytes',
    readings: input.readings,
    warningRatio: thresholds.memoryAvailableWarningRatio,
    criticalRatio: thresholds.memoryAvailableCriticalRatio,
  });
  if (memory !== undefined) candidates.push(memory);

  if (input.observed.serverCrashed) {
    candidates.push(
      Object.freeze({
        kind: 'server.crashed' as const,
        severity: 'critical' as const,
        metricName: null,
        observedValue: null,
        threshold: null,
        source: 'process-adapter' as const,
      }),
    );
  }

  // Never heard from counts as offline. Treating an agent that has not yet
  // reported as healthy would hide a deployment that never came up.
  const lastSeen =
    input.observed.agentLastSeenAt === null ? null : Date.parse(input.observed.agentLastSeenAt);
  const offline =
    lastSeen === null ||
    !Number.isFinite(lastSeen) ||
    input.now.getTime() - lastSeen > thresholds.agentOfflineSeconds * 1_000;
  if (offline) {
    candidates.push(
      Object.freeze({
        kind: 'agent.offline' as const,
        severity: 'critical' as const,
        metricName: null,
        observedValue: null,
        threshold: thresholds.agentOfflineSeconds,
        source: 'none' as const,
      }),
    );
  }

  if (input.observed.failedJobCount > 0) {
    candidates.push(
      Object.freeze({
        kind: 'job.failed' as const,
        severity: 'warning' as const,
        metricName: null,
        observedValue: input.observed.failedJobCount,
        threshold: 0,
        source: 'none' as const,
      }),
    );
  }

  return Object.freeze(candidates);
}

/**
 * Decides what to open and what to close.
 *
 * An open alert whose metric became unavailable stays open. The evaluation
 * above cannot see the difference between "the disk recovered" and "nothing is
 * reading the disk any more", so this refuses to resolve on the strength of an
 * absence — silence is not recovery.
 */
export function reconcileAlerts(input: {
  readonly open: readonly { readonly kind: AlertKind; readonly alertId: string }[];
  readonly candidates: readonly CandidateAlert[];
  readonly readings: readonly MetricReading[];
}): {
  readonly toOpen: readonly CandidateAlert[];
  readonly toResolve: readonly string[];
} {
  const candidateKinds = new Set(input.candidates.map((candidate) => candidate.kind));
  const openKinds = new Set(input.open.map((alert) => alert.kind));

  const toOpen = input.candidates.filter((candidate) => !openKinds.has(candidate.kind));

  const metricForKind: Partial<Record<AlertKind, MetricName>> = {
    'disk.low': 'host.disk.free.bytes',
    'memory.low': 'host.memory.available.bytes',
  };

  const toResolve = input.open
    .filter((alert) => {
      if (candidateKinds.has(alert.kind)) return false;
      const metric = metricForKind[alert.kind];
      if (metric === undefined) return true;
      // Resolvable only if something is still measuring it.
      return usableReading(input.readings, metric) !== undefined;
    })
    .map((alert) => alert.alertId);

  return Object.freeze({ toOpen: Object.freeze(toOpen), toResolve: Object.freeze(toResolve) });
}
