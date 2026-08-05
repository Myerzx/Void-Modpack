import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateMetricSnapshot, type MetricReading } from '@voidfall/contracts';

import {
  aggregateReadings,
  evaluateAlerts,
  groupLogEntries,
  markStaleReadings,
  normalizeLogMessage,
  reconcileAlerts,
  TelemetryError,
  unavailableReading,
} from '../src/index.js';

/**
 * Phase 10.4 metrics, logs and alerts.
 *
 * Everything here is pure. No host is read, no process is started and no
 * Minecraft server is contacted — the point of these functions is that what
 * gets reported and what fires is decided before anything touches a machine.
 */

const NOW = new Date('2026-08-05T12:00:00.000Z');

function reading(overrides: Partial<MetricReading> = {}): MetricReading {
  return {
    name: 'host.memory.available.bytes',
    value: 1_000,
    source: 'host-agent',
    quality: 'measured',
    observedAt: NOW.toISOString(),
    unavailableReason: null,
    ...overrides,
  } as MetricReading;
}

describe('a reading carries a value or a reason it has none', () => {
  it('refuses a reading that is both measured and unavailable', () => {
    assert.equal(
      validateMetricSnapshot({
        schemaVersion: 1,
        serverInstanceId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63702',
        collectedAt: NOW.toISOString(),
        readings: [reading({ unavailableReason: 'collector-failed' })],
      }).success,
      false,
    );
  });

  it('refuses a reading that is neither', () => {
    assert.equal(
      validateMetricSnapshot({
        schemaVersion: 1,
        serverInstanceId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63702',
        collectedAt: NOW.toISOString(),
        readings: [reading({ value: null, quality: 'unavailable', unavailableReason: null })],
      }).success,
      false,
    );
  });

  it('refuses anything but an approved provider claiming to have measured tick timing', () => {
    const snapshot = (source: string) => ({
      schemaVersion: 1,
      serverInstanceId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63702',
      collectedAt: NOW.toISOString(),
      readings: [reading({ name: 'game.tps', value: 19.8, source: source as never })],
    });
    // This is the fabricated metric the phase forbids: the host agent cannot
    // see inside a running server, so a TPS from it would be invented.
    assert.equal(validateMetricSnapshot(snapshot('host-agent')).success, false);
    assert.equal(validateMetricSnapshot(snapshot('jvm')).success, false);
    assert.equal(validateMetricSnapshot(snapshot('game-provider')).success, true);
  });

  it('builds the unavailable reading for a metric nothing measures', () => {
    const tps = unavailableReading({
      name: 'game.tps',
      observedAt: NOW.toISOString(),
      reason: 'no-approved-provider',
    });
    assert.equal(tps.value, null);
    assert.equal(tps.source, 'none');
    assert.equal(tps.quality, 'unavailable');
    assert.equal(
      validateMetricSnapshot({
        schemaVersion: 1,
        serverInstanceId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63702',
        collectedAt: NOW.toISOString(),
        readings: [tps],
      }).success,
      true,
    );
  });

  it('refuses a snapshot reporting one metric twice', () => {
    assert.equal(
      validateMetricSnapshot({
        schemaVersion: 1,
        serverInstanceId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63702',
        collectedAt: NOW.toISOString(),
        readings: [reading(), reading({ value: 2_000 })],
      }).success,
      false,
    );
  });
});

describe('aggregation into retained buckets', () => {
  it('keeps the shape and how many samples made it', () => {
    const buckets = aggregateReadings({
      bucketSeconds: 60,
      readings: [
        reading({ value: 10, observedAt: '2026-08-05T12:00:05.000Z' }),
        reading({ value: 30, observedAt: '2026-08-05T12:00:35.000Z' }),
        reading({ value: 20, observedAt: '2026-08-05T12:00:59.000Z' }),
        reading({ value: 99, observedAt: '2026-08-05T12:01:05.000Z' }),
      ],
    });
    assert.equal(buckets.length, 2);
    assert.deepEqual(
      buckets.map((bucket) => [bucket.bucketStart, bucket.minimum, bucket.maximum, bucket.average, bucket.sampleCount]),
      [
        ['2026-08-05T12:00:00.000Z', 10, 30, 20, 3],
        ['2026-08-05T12:01:00.000Z', 99, 99, 99, 1],
      ],
    );
  });

  it('takes the worst quality rather than averaging it', () => {
    const buckets = aggregateReadings({
      bucketSeconds: 60,
      readings: [
        reading({ value: 10, quality: 'measured' }),
        reading({ value: 20, quality: 'measured', observedAt: '2026-08-05T12:00:10.000Z' }),
        reading({ value: 30, quality: 'stale', observedAt: '2026-08-05T12:00:20.000Z' }),
      ],
    });
    // Two measured and one stale is a stale bucket. Calling it measured is how
    // a stale number gets presented as current.
    assert.equal(buckets[0]?.quality, 'stale');
  });

  it('drops readings without a value instead of counting them as zero', () => {
    const buckets = aggregateReadings({
      bucketSeconds: 60,
      readings: [
        reading({ value: 100 }),
        unavailableReading({
          name: 'host.memory.available.bytes',
          observedAt: '2026-08-05T12:00:30.000Z',
          reason: 'collector-failed',
        }),
      ],
    });
    // A gap is not a measurement of nothing: averaging the zero in would report
    // healthy memory exactly when the collector stopped working.
    assert.equal(buckets[0]?.average, 100);
    assert.equal(buckets[0]?.sampleCount, 1);
  });

  it('refuses a bucket built from a source that cannot measure that metric', () => {
    assert.throws(
      () =>
        aggregateReadings({
          bucketSeconds: 60,
          readings: [reading({ name: 'game.mspt', value: 42, source: 'host-agent' })],
        }),
      (error: unknown) => error instanceof TelemetryError && error.code === 'invalid-reading',
    );
  });

  it('marks readings past the freshness window as stale rather than hiding them', () => {
    const marked = markStaleReadings({
      now: NOW,
      freshnessSeconds: 60,
      readings: [
        reading({ observedAt: '2026-08-05T11:59:30.000Z' }),
        reading({ name: 'host.load.1m', value: 2, observedAt: '2026-08-05T11:50:00.000Z' }),
      ],
    });
    assert.equal(marked[0]?.quality, 'measured');
    assert.equal(marked[1]?.quality, 'stale');
    // A stale number an operator can see and distrust beats a blank that looks
    // like a system with nothing to report.
    assert.equal(marked[1]?.value, 2);
  });
});

describe('alerts', () => {
  const observed = { serverCrashed: false, agentLastSeenAt: NOW.toISOString(), failedJobCount: 0 };

  const capacity = (freeBytes: number): MetricReading[] => [
    reading({ name: 'host.disk.free.bytes', value: freeBytes }),
    reading({ name: 'host.disk.total.bytes', value: 1_000 }),
  ];

  it('fires warning then critical as the disk fills', () => {
    assert.deepEqual(
      evaluateAlerts({ readings: capacity(500), observed, now: NOW }).map((alert) => alert.kind),
      [],
    );
    const warning = evaluateAlerts({ readings: capacity(100), observed, now: NOW });
    assert.equal(warning[0]?.kind, 'disk.low');
    assert.equal(warning[0]?.severity, 'warning');
    const critical = evaluateAlerts({ readings: capacity(20), observed, now: NOW });
    assert.equal(critical[0]?.severity, 'critical');
    // The alert names the reading that raised it, or an operator has a red
    // badge and no way to check whether it is still true.
    assert.equal(critical[0]?.metricName, 'host.disk.free.bytes');
    assert.equal(critical[0]?.observedValue, 20);
  });

  it('does not fire on a reading nothing measured', () => {
    const alerts = evaluateAlerts({
      readings: [
        unavailableReading({
          name: 'host.disk.free.bytes',
          observedAt: NOW.toISOString(),
          reason: 'collector-failed',
        }),
        reading({ name: 'host.disk.total.bytes', value: 1_000 }),
      ],
      observed,
      now: NOW,
    });
    assert.equal(
      alerts.some((alert) => alert.kind === 'disk.low'),
      false,
    );
  });

  it('treats an agent never heard from as offline', () => {
    const never = evaluateAlerts({
      readings: [],
      observed: { ...observed, agentLastSeenAt: null },
      now: NOW,
    });
    assert.equal(
      never.some((alert) => alert.kind === 'agent.offline'),
      true,
    );
    const late = evaluateAlerts({
      readings: [],
      observed: { ...observed, agentLastSeenAt: '2026-08-05T11:50:00.000Z' },
      now: NOW,
    });
    assert.equal(
      late.some((alert) => alert.kind === 'agent.offline'),
      true,
    );
  });

  it('raises a crash and a failed job as their own alerts', () => {
    const alerts = evaluateAlerts({
      readings: [],
      observed: { serverCrashed: true, agentLastSeenAt: NOW.toISOString(), failedJobCount: 3 },
      now: NOW,
    });
    assert.deepEqual(
      alerts.map((alert) => alert.kind).sort(),
      ['job.failed', 'server.crashed'],
    );
    assert.equal(alerts.find((alert) => alert.kind === 'job.failed')?.observedValue, 3);
  });

  it('refuses thresholds where critical is not the tighter bound', () => {
    assert.throws(
      () =>
        evaluateAlerts({
          readings: [],
          observed,
          now: NOW,
          thresholds: { diskFreeWarningRatio: 0.05, diskFreeCriticalRatio: 0.15 },
        }),
      (error: unknown) => error instanceof TelemetryError,
    );
  });

  it('will not resolve an alert because its metric went silent', () => {
    const open = [{ kind: 'disk.low' as const, alertId: 'alert-1' }];
    // Nothing is measuring the disk any more. That looks identical to a disk
    // that stopped filling, and treating silence as recovery is how a full disk
    // goes unnoticed.
    const silent = reconcileAlerts({
      open,
      candidates: [],
      readings: [
        unavailableReading({
          name: 'host.disk.free.bytes',
          observedAt: NOW.toISOString(),
          reason: 'collector-failed',
        }),
      ],
    });
    assert.deepEqual(silent.toResolve, []);

    // A live reading below the threshold no longer raising it *is* recovery.
    const recovered = reconcileAlerts({
      open,
      candidates: [],
      readings: [reading({ name: 'host.disk.free.bytes', value: 900 })],
    });
    assert.deepEqual(recovered.toResolve, ['alert-1']);
  });

  it('does not reopen an alert that is already open', () => {
    const result = reconcileAlerts({
      open: [{ kind: 'disk.low', alertId: 'alert-1' }],
      candidates: evaluateAlerts({ readings: capacity(20), observed, now: NOW }),
      readings: capacity(20),
    });
    assert.deepEqual(result.toOpen, []);
  });
});

describe('structured log grouping', () => {
  it('folds occurrences of one fault onto a single group', () => {
    const entries = Array.from({ length: 50 }, (_, index) => ({
      level: 'error' as const,
      message: `Failed to load chunk 12${index} at 2026-08-05T12:00:0${index % 10}Z`,
      occurredAt: `2026-08-05T12:00:${String(index % 60).padStart(2, '0')}.000Z`,
      correlationId: `018f6b8c-76a3-7d10-9f2e-1d9e52a6370${index % 10}`,
    }));
    const groups = groupLogEntries(entries);
    // Fifty lines, one problem. Reading them as fifty is how the other problem
    // in the same window goes unseen.
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.occurrences, 50);
    // Correlation samples are bounded; the group is not a copy of the log.
    assert.ok((groups[0]?.correlationIds.length ?? 0) <= 5);
  });

  it('keeps genuinely different faults apart', () => {
    const groups = groupLogEntries([
      { level: 'error', message: 'Failed to load chunk 1', occurredAt: '2026-08-05T12:00:00.000Z', correlationId: null },
      { level: 'error', message: 'Failed to save world', occurredAt: '2026-08-05T12:00:01.000Z', correlationId: null },
      { level: 'warn', message: 'Failed to load chunk 2', occurredAt: '2026-08-05T12:00:02.000Z', correlationId: null },
    ]);
    // Three groups: two different messages, plus the same message at a
    // different level, which is a different fact about the system.
    assert.equal(groups.length, 3);
  });

  it('redacts while it normalises, because a group is shown on a screen', () => {
    const template = normalizeLogMessage(
      'auth failed for 203.0.113.7 with password=hunter2 at C:\\Servers\\void',
    );
    assert.equal(template.includes('hunter2'), false);
    assert.equal(template.includes('203.0.113.7'), false);
    assert.equal(template.includes('Servers'), false);
  });

  it('gives the same fingerprint to the same fault seen twice', () => {
    const groups = groupLogEntries([
      {
        level: 'error',
        message: 'timeout after 30000ms talking to 10.0.0.1',
        occurredAt: '2026-08-05T12:00:00.000Z',
        correlationId: null,
      },
      {
        level: 'error',
        message: 'timeout after 45000ms talking to 10.0.0.2',
        occurredAt: '2026-08-05T12:00:01.000Z',
        correlationId: null,
      },
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.occurrences, 2);
  });
});
