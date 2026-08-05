import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateScheduleRun, validateServerSchedule } from '@voidfall/contracts';

import { missedOccurrences, nextRunAfter, occurrenceKey, ScheduleError } from '../src/index.js';

/**
 * Phase 10.5 schedules.
 *
 * Pure arithmetic on a wall clock in a named zone. Nothing here starts a
 * server, takes a backup or contacts anything — the point is that *when* a
 * maintenance window falls is decided, and testable, before any of that runs.
 */

const uuid = '018f6b8c-76a3-7d10-9f2e-1d9e52a63702';
const otherUuid = '018f6b8c-76a3-7d10-9f2e-1d9e52a63703';

function trigger(overrides: Record<string, unknown> = {}) {
  return {
    timezone: 'America/Sao_Paulo',
    hour: 4,
    minute: 0,
    weekdays: [] as number[],
    ...overrides,
  };
}

describe('a local time needs its zone', () => {
  it('fires at the stated local hour, not the host hour', () => {
    // São Paulo is UTC-3, so 04:00 local is 07:00Z. A scheduler that ignored
    // the zone would restart a peak-hours server at 04:00Z — 01:00 local.
    const next = nextRunAfter({
      trigger: trigger(),
      after: new Date('2026-08-05T00:00:00.000Z'),
    });
    assert.equal(next.toISOString(), '2026-08-05T07:00:00.000Z');
  });

  it('advances past an occurrence it is standing on', () => {
    // Exactly the firing instant. Returning it would re-run the window that
    // just completed.
    const next = nextRunAfter({
      trigger: trigger(),
      after: new Date('2026-08-05T07:00:00.000Z'),
    });
    assert.equal(next.toISOString(), '2026-08-06T07:00:00.000Z');
  });

  it('honours weekdays in the target zone, not in UTC', () => {
    // Sunday only. The zone decides which day a given instant falls on, and
    // near midnight the two disagree.
    const next = nextRunAfter({
      trigger: trigger({ weekdays: [0], hour: 22, minute: 0 }),
      after: new Date('2026-08-05T00:00:00.000Z'),
    });
    // 2026-08-09 is a Sunday; 22:00 local is 01:00Z on the Monday.
    assert.equal(next.toISOString(), '2026-08-10T01:00:00.000Z');
  });

  it('keeps the local time steady across a DST transition', () => {
    // Europe/London moves to BST on 2026-03-29. A scheduler adding fixed
    // 24-hour blocks drifts an hour and stays drifted.
    const before = nextRunAfter({
      trigger: trigger({ timezone: 'Europe/London', hour: 4, minute: 0 }),
      after: new Date('2026-03-27T12:00:00.000Z'),
    });
    assert.equal(before.toISOString(), '2026-03-28T04:00:00.000Z');
    const after = nextRunAfter({
      trigger: trigger({ timezone: 'Europe/London', hour: 4, minute: 0 }),
      after: before,
    });
    // Still 04:00 local, now one hour earlier in UTC.
    assert.equal(after.toISOString(), '2026-03-29T03:00:00.000Z');
  });

  it('does not skip a run whose local hour does not exist that day', () => {
    // Clocks jump 01:00 -> 02:00 in London on 2026-03-29, so 01:30 never
    // happens. A nightly run must not vanish once a year.
    const next = nextRunAfter({
      trigger: trigger({ timezone: 'Europe/London', hour: 1, minute: 30 }),
      after: new Date('2026-03-29T00:00:00.000Z'),
    });
    assert.ok(next.getTime() > Date.parse('2026-03-29T00:00:00.000Z'));
    // It lands on that day, not silently on the next one.
    assert.ok(next.getTime() < Date.parse('2026-03-30T00:00:00.000Z'));
  });

  it('refuses a trigger it cannot resolve', () => {
    assert.throws(
      () => nextRunAfter({ trigger: trigger({ timezone: 'Mars/Olympus' }), after: new Date() }),
      (error: unknown) => error instanceof ScheduleError,
    );
    assert.throws(
      () => nextRunAfter({ trigger: trigger({ hour: 25 }), after: new Date() }),
      (error: unknown) => error instanceof ScheduleError,
    );
  });
});

describe('deduplication and crash recovery', () => {
  it('keys a run on the occurrence, not on when it was noticed', () => {
    const scheduledFor = new Date('2026-08-05T07:00:00.000Z');
    // Two schedulers waking at different moments for the same window produce
    // the same key, so one run exists for one occurrence.
    assert.equal(occurrenceKey(uuid, scheduledFor), occurrenceKey(uuid, scheduledFor));
    assert.notEqual(occurrenceKey(uuid, scheduledFor), occurrenceKey(otherUuid, scheduledFor));
  });

  it('reports occurrences missed while nothing was running', () => {
    // Down for three days. Those windows are in the past.
    const missed = missedOccurrences({
      trigger: trigger(),
      since: new Date('2026-08-02T00:00:00.000Z'),
      now: new Date('2026-08-05T12:00:00.000Z'),
    });
    assert.deepEqual(
      missed.map((instant) => instant.toISOString()),
      [
        '2026-08-02T07:00:00.000Z',
        '2026-08-03T07:00:00.000Z',
        '2026-08-04T07:00:00.000Z',
        '2026-08-05T07:00:00.000Z',
      ],
    );
    // They are reported so they can be recorded as skipped — never executed.
    // Running yesterday's window now would restart a live server at an hour
    // nobody chose.
  });

  it('reports nothing missed when the scheduler kept up', () => {
    assert.deepEqual(
      missedOccurrences({
        trigger: trigger(),
        since: new Date('2026-08-05T07:00:00.000Z'),
        now: new Date('2026-08-05T09:00:00.000Z'),
      }),
      [],
    );
  });
});

describe('a schedule is a typed plan, not a script', () => {
  const schedule = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    scheduleId: uuid,
    serverInstanceId: otherUuid,
    name: 'Nightly maintenance',
    enabled: true,
    trigger: trigger(),
    steps: [
      { kind: 'warn-players', leadSeconds: 300 },
      { kind: 'maintenance-check', maximumPlayersOnline: 0 },
      { kind: 'backup', scope: 'world' },
      { kind: 'restart', timeoutSeconds: 300 },
    ],
    reasonCode: 'scheduled-maintenance',
    nextRunAt: '2026-08-06T07:00:00.000Z',
    lastRunAt: null,
    createdAt: '2026-08-05T12:00:00Z',
    updatedAt: '2026-08-05T12:00:00Z',
    ...overrides,
  });

  it('accepts the reviewed plan', () => {
    assert.equal(validateServerSchedule(schedule()).success, true);
  });

  it('refuses a step that is not in the catalogue', () => {
    assert.equal(
      validateServerSchedule(schedule({ steps: [{ kind: 'run-command', command: 'rm -rf /' }] }))
        .success,
      false,
    );
  });

  it('refuses a backup taken after the restart it was meant to precede', () => {
    // Ordering carries meaning: a backup after the restart captures the world
    // the restart produced, not the one an operator wanted preserved.
    assert.equal(
      validateServerSchedule(
        schedule({
          steps: [
            { kind: 'restart', timeoutSeconds: 300 },
            { kind: 'backup', scope: 'world' },
          ],
        }),
      ).success,
      false,
    );
  });

  it('refuses a warning attached to nothing disruptive', () => {
    // Warning players about a run that does not disturb them is noise, and it
    // trains them to ignore the ones that do.
    assert.equal(
      validateServerSchedule(
        schedule({
          steps: [
            { kind: 'warn-players', leadSeconds: 300 },
            { kind: 'backup', scope: 'world' },
          ],
        }),
      ).success,
      false,
    );
  });

  it('refuses an unsupported timezone', () => {
    assert.equal(
      validateServerSchedule(schedule({ trigger: trigger({ timezone: 'Mars/Olympus' }) })).success,
      false,
    );
  });
});

describe('a run reports what it actually did', () => {
  const run = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    runId: uuid,
    scheduleId: otherUuid,
    serverInstanceId: uuid,
    scheduledFor: '2026-08-05T07:00:00Z',
    status: 'claimed',
    claimedAt: '2026-08-05T07:00:01Z',
    leaseExpiresAt: '2026-08-05T07:10:01Z',
    completedAt: null,
    stepIndex: 0,
    failureCode: null,
    postRestartVerified: null,
    ...overrides,
  });

  it('accepts a claimed run and a settled one', () => {
    assert.equal(validateScheduleRun(run()).success, true);
    assert.equal(
      validateScheduleRun(
        run({
          status: 'succeeded',
          completedAt: '2026-08-05T07:05:00Z',
          stepIndex: 4,
          postRestartVerified: true,
        }),
      ).success,
      true,
    );
  });

  it('refuses a successful run that restarted without verifying', () => {
    // Otherwise "succeeded" means only that the command was sent.
    assert.equal(
      validateScheduleRun(
        run({
          status: 'succeeded',
          completedAt: '2026-08-05T07:05:00Z',
          postRestartVerified: false,
        }),
      ).success,
      false,
    );
  });

  it('refuses a failure with no code and a claim that never expires', () => {
    assert.equal(
      validateScheduleRun(run({ status: 'failed', completedAt: '2026-08-05T07:05:00Z' })).success,
      false,
    );
    assert.equal(
      validateScheduleRun(run({ leaseExpiresAt: '2026-08-05T07:00:01Z' })).success,
      false,
    );
  });

  it('treats a skipped run as settled, not as a failure', () => {
    const skipped = validateScheduleRun(
      run({ status: 'skipped', completedAt: '2026-08-05T07:00:05Z' }),
    );
    assert.equal(skipped.success, true);
  });
});
