import type { ScheduleRun, ScheduleStep, ServerSchedule } from '@voidfall/contracts';

import type { Database } from './database.js';

/**
 * Schedules and their runs.
 *
 * Two properties do the real work here:
 *
 *  - **One run per occurrence**, enforced by a unique constraint on
 *    `(schedule_id, scheduled_for)`. Deduplication is the database's job, not a
 *    scheduler's bookkeeping: two schedulers waking at once cannot both believe
 *    they won, and one catching up after a crash cannot re-fire a window.
 *  - **Claims expire.** A scheduler that dies mid-run releases its claim by
 *    lapsing rather than by anything it has to do on the way down — which it
 *    cannot be relied on to do, since it died.
 */

export type SchedulePersistenceErrorCode =
  | 'schedule-exists'
  | 'unknown-schedule'
  | 'occurrence-claimed'
  | 'invalid-transition';

export class SchedulePersistenceError extends Error {
  public readonly code: SchedulePersistenceErrorCode;

  public constructor(code: SchedulePersistenceErrorCode) {
    super(`schedule:${code}`);
    this.name = 'SchedulePersistenceError';
    this.code = code;
  }
}

interface ScheduleRow {
  readonly schedule_id: string;
  readonly server_instance_id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly timezone: string;
  readonly trigger_hour: number | string;
  readonly trigger_minute: number | string;
  readonly weekdays: readonly (number | string)[] | string;
  readonly steps: readonly ScheduleStep[] | string;
  readonly reason_code: string;
  readonly next_run_at: Date | string | null;
  readonly last_run_at: Date | string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface RunRow {
  readonly run_id: string;
  readonly schedule_id: string;
  readonly server_instance_id: string;
  readonly scheduled_for: Date | string;
  readonly status: ScheduleRun['status'];
  readonly claimed_at: Date | string;
  readonly lease_expires_at: Date | string;
  readonly completed_at: Date | string | null;
  readonly step_index: number | string;
  readonly failure_code: string | null;
  readonly post_restart_verified: boolean | null;
}

function isoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

/**
 * Reads a `smallint[]`, which some drivers hand back as the literal `{0,6}`
 * rather than as an array.
 */
function readWeekdays(value: readonly (number | string)[] | string): number[] {
  if (typeof value !== 'string') return value.map(Number);
  const inner = value.replace(/^\{/u, '').replace(/\}$/u, '').trim();
  if (inner === '') return [];
  return inner.split(',').map(Number);
}

function mapSchedule(row: ScheduleRow): ServerSchedule {
  const weekdays = readWeekdays(row.weekdays);
  return {
    schemaVersion: 1,
    scheduleId: row.schedule_id,
    serverInstanceId: row.server_instance_id,
    name: row.name,
    enabled: row.enabled,
    trigger: {
      timezone: row.timezone,
      hour: Number(row.trigger_hour),
      minute: Number(row.trigger_minute),
      weekdays: [...weekdays].sort((left, right) => left - right),
    },
    steps: parseJson<readonly ScheduleStep[]>(row.steps) as ScheduleStep[],
    reasonCode: row.reason_code,
    nextRunAt: row.next_run_at === null ? null : isoString(row.next_run_at),
    lastRunAt: row.last_run_at === null ? null : isoString(row.last_run_at),
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
  };
}

function mapRun(row: RunRow): ScheduleRun {
  return {
    schemaVersion: 1,
    runId: row.run_id,
    scheduleId: row.schedule_id,
    serverInstanceId: row.server_instance_id,
    scheduledFor: isoString(row.scheduled_for),
    status: row.status,
    claimedAt: isoString(row.claimed_at),
    leaseExpiresAt: isoString(row.lease_expires_at),
    completedAt: row.completed_at === null ? null : isoString(row.completed_at),
    stepIndex: Number(row.step_index),
    failureCode: row.failure_code,
    postRestartVerified: row.post_restart_verified,
  };
}

export class ScheduleRepository {
  public constructor(private readonly database: Database) {}

  public async create(input: {
    readonly schedule: Omit<ServerSchedule, 'schemaVersion' | 'lastRunAt' | 'createdAt' | 'updatedAt'>;
    readonly now: Date;
  }): Promise<ServerSchedule> {
    const { schedule } = input;
    try {
      const result = await this.database.query<ScheduleRow>(
        `INSERT INTO server_schedules (
           schedule_id, server_instance_id, name, enabled, timezone, trigger_hour,
           trigger_minute, weekdays, steps, reason_code, next_run_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$12)
         RETURNING *`,
        [
          schedule.scheduleId,
          schedule.serverInstanceId,
          schedule.name,
          schedule.enabled,
          schedule.trigger.timezone,
          schedule.trigger.hour,
          schedule.trigger.minute,
          [...schedule.trigger.weekdays].sort((left, right) => left - right),
          JSON.stringify(schedule.steps),
          schedule.reasonCode,
          schedule.enabled ? schedule.nextRunAt : null,
          input.now.toISOString(),
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new SchedulePersistenceError('unknown-schedule');
      return mapSchedule(row);
    } catch (error) {
      if (error instanceof SchedulePersistenceError) throw error;
      throw new SchedulePersistenceError('schedule-exists');
    }
  }

  public async findById(scheduleId: string): Promise<ServerSchedule | undefined> {
    const result = await this.database.query<ScheduleRow>(
      'SELECT * FROM server_schedules WHERE schedule_id = $1',
      [scheduleId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapSchedule(row);
  }

  public async listForServer(serverInstanceId: string): Promise<readonly ServerSchedule[]> {
    const result = await this.database.query<ScheduleRow>(
      'SELECT * FROM server_schedules WHERE server_instance_id = $1 ORDER BY name ASC',
      [serverInstanceId],
    );
    return result.rows.map(mapSchedule);
  }

  /**
   * Disables a schedule and clears its next run.
   *
   * Both in one statement: a schedule that was switched off but kept a due time
   * is one a scheduler would still pick up.
   */
  public async setEnabled(input: {
    readonly scheduleId: string;
    readonly enabled: boolean;
    readonly nextRunAt: string | null;
    readonly now: Date;
  }): Promise<ServerSchedule> {
    const result = await this.database.query<ScheduleRow>(
      `UPDATE server_schedules
          SET enabled = $2, next_run_at = $3, updated_at = $4
        WHERE schedule_id = $1
        RETURNING *`,
      [
        input.scheduleId,
        input.enabled,
        input.enabled ? input.nextRunAt : null,
        input.now.toISOString(),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new SchedulePersistenceError('unknown-schedule');
    return mapSchedule(row);
  }

  public async listDue(now: Date, limit = 20): Promise<readonly ServerSchedule[]> {
    const bounded = Math.min(Math.max(limit, 1), 100);
    const result = await this.database.query<ScheduleRow>(
      `SELECT * FROM server_schedules
        WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1
        ORDER BY next_run_at ASC
        LIMIT $2`,
      [now.toISOString(), bounded],
    );
    return result.rows.map(mapSchedule);
  }

  /**
   * Claims one occurrence.
   *
   * The unique constraint on `(schedule_id, scheduled_for)` is what makes this
   * safe: a second claimer's insert fails rather than producing a duplicate
   * run. Only a lapsed claim may be taken over, and taking it over is another
   * conditional statement rather than a delete-then-insert, which would leave a
   * window where the occurrence had no owner at all.
   */
  public async claimOccurrence(input: {
    readonly runId: string;
    readonly scheduleId: string;
    readonly serverInstanceId: string;
    readonly scheduledFor: Date;
    readonly claimedBy: string;
    readonly leaseSeconds: number;
    readonly now: Date;
  }): Promise<ScheduleRun> {
    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseSeconds * 1_000);
    const inserted = await this.database.query<RunRow>(
      `INSERT INTO schedule_runs (
         run_id, schedule_id, server_instance_id, scheduled_for, status,
         claimed_by, claimed_at, lease_expires_at, step_index
       ) VALUES ($1,$2,$3,$4,'claimed',$5,$6,$7,0)
       ON CONFLICT (schedule_id, scheduled_for) DO NOTHING
       RETURNING *`,
      [
        input.runId,
        input.scheduleId,
        input.serverInstanceId,
        input.scheduledFor.toISOString(),
        input.claimedBy,
        input.now.toISOString(),
        leaseExpiresAt.toISOString(),
      ],
    );
    const fresh = inserted.rows[0];
    if (fresh !== undefined) return mapRun(fresh);

    // Someone holds it. Take it over only if their lease actually lapsed.
    const reclaimed = await this.database.query<RunRow>(
      `UPDATE schedule_runs
          SET claimed_by = $3, claimed_at = $4, lease_expires_at = $5, status = 'claimed'
        WHERE schedule_id = $1 AND scheduled_for = $2
          AND status IN ('claimed', 'running')
          AND lease_expires_at <= $4
        RETURNING *`,
      [
        input.scheduleId,
        input.scheduledFor.toISOString(),
        input.claimedBy,
        input.now.toISOString(),
        leaseExpiresAt.toISOString(),
      ],
    );
    const taken = reclaimed.rows[0];
    if (taken !== undefined) return mapRun(taken);
    throw new SchedulePersistenceError('occurrence-claimed');
  }

  /** Advances the step counter, extending the lease while work continues. */
  public async advance(input: {
    readonly runId: string;
    readonly stepIndex: number;
    readonly leaseSeconds: number;
    readonly now: Date;
  }): Promise<ScheduleRun> {
    const result = await this.database.query<RunRow>(
      `UPDATE schedule_runs
          SET status = 'running', step_index = $2, lease_expires_at = $3
        WHERE run_id = $1 AND status IN ('claimed', 'running')
        RETURNING *`,
      [
        input.runId,
        input.stepIndex,
        new Date(input.now.getTime() + input.leaseSeconds * 1_000).toISOString(),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new SchedulePersistenceError('invalid-transition');
    return mapRun(row);
  }

  /**
   * Settles a run, and moves the schedule on.
   *
   * Both happen in one transaction: a run recorded as finished while the
   * schedule still points at the window it just ran would be claimed again the
   * moment anything looked.
   */
  public async settle(input: {
    readonly runId: string;
    readonly status: 'succeeded' | 'failed' | 'skipped';
    readonly failureCode?: string;
    readonly postRestartVerified: boolean | null;
    readonly nextRunAt: string | null;
    readonly now: Date;
  }): Promise<ScheduleRun> {
    return this.database.transaction(async (client) => {
      const settled = await client.query<RunRow>(
        `UPDATE schedule_runs
            SET status = $2, completed_at = $3, failure_code = $4, post_restart_verified = $5
          WHERE run_id = $1 AND status IN ('claimed', 'running')
          RETURNING *`,
        [
          input.runId,
          input.status,
          input.now.toISOString(),
          input.status === 'failed' ? (input.failureCode ?? 'operation-failed') : null,
          input.postRestartVerified,
        ],
      );
      const row = settled.rows[0];
      if (row === undefined) throw new SchedulePersistenceError('invalid-transition');

      await client.query(
        `UPDATE server_schedules
            SET next_run_at = CASE WHEN enabled THEN $2::timestamptz ELSE NULL END,
                last_run_at = $3,
                updated_at = $3
          WHERE schedule_id = $1`,
        [row.schedule_id, input.nextRunAt, input.now.toISOString()],
      );
      return mapRun(row);
    });
  }

  public async listRuns(scheduleId: string, limit = 50): Promise<readonly ScheduleRun[]> {
    const bounded = Math.min(Math.max(limit, 1), 200);
    const result = await this.database.query<RunRow>(
      `SELECT * FROM schedule_runs
        WHERE schedule_id = $1
        ORDER BY scheduled_for DESC
        LIMIT $2`,
      [scheduleId, bounded],
    );
    return result.rows.map(mapRun);
  }

  /**
   * Finds runs whose scheduler stopped reporting.
   *
   * Reported rather than settled here: whether an abandoned run should be
   * retried or recorded as failed depends on which step it died on, and that is
   * the scheduler's decision, not the store's.
   */
  public async listAbandoned(now: Date, limit = 20): Promise<readonly ScheduleRun[]> {
    const bounded = Math.min(Math.max(limit, 1), 100);
    const result = await this.database.query<RunRow>(
      `SELECT * FROM schedule_runs
        WHERE status IN ('claimed', 'running') AND lease_expires_at <= $1
        ORDER BY lease_expires_at ASC
        LIMIT $2`,
      [now.toISOString(), bounded],
    );
    return result.rows.map(mapRun);
  }
}
