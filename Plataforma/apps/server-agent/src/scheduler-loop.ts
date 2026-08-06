import { randomUUID } from 'node:crypto';

import type { ScheduleStep, ServerSchedule } from '@voidfall/contracts';
import { SchedulePersistenceError, type Repositories } from '@voidfall/database';
import { missedOccurrences, nextRunAfter, ScheduleError } from '@voidfall/server-schedule';

/**
 * The scheduler loop.
 *
 * It does four things and refuses to improvise a fifth:
 *
 *  - **Claim.** One occurrence at a time, through the database's unique
 *    constraint on `(schedule_id, scheduled_for)`. Two agents waking together
 *    cannot both believe they won.
 *  - **Catch up honestly.** Occurrences missed while nothing was running are
 *    recorded as skipped, never executed. Running yesterday's maintenance
 *    window now would restart a live server at an hour nobody chose.
 *  - **Renew.** The lease is extended between steps, so a long backup does not
 *    look abandoned while it is working.
 *  - **Stop cleanly.** On shutdown a claimed run is settled rather than left
 *    holding a lease until it lapses, so a restart is not delayed by the
 *    previous process's timeout.
 *
 * What it does *not* do is decide what a step means. Steps are dispatched to
 * an injected executor; the loop owns timing and ownership, and nothing else.
 */

export interface ScheduleStepExecutor {
  /**
   * Runs one step. Returning `skip` stops the run without failing it — the
   * maintenance check saying "not now" is a fact, not an error.
   */
  execute(input: {
    readonly schedule: ServerSchedule;
    readonly step: ScheduleStep;
    readonly runId: string;
    /**
     * Where the step sits in the schedule. Passed so an executor can name what
     * it enqueues deterministically: a schedule may hold two backup steps, and
     * an identifier derived from the run alone would collide between them —
     * while a random one would turn an honest replay into a second snapshot.
     */
    readonly stepIndex: number;
  }): Promise<{ readonly outcome: 'continue' | 'skip' | 'failed'; readonly failureCode?: string }>;
}

export interface SchedulerLoopOptions {
  readonly repositories: Repositories;
  readonly serverInstanceId: string;
  /** Identifies this agent as the claimant, so a takeover is attributable. */
  readonly agentId: string;
  readonly executor: ScheduleStepExecutor;
  readonly leaseSeconds?: number;
  readonly pollMilliseconds?: number;
  readonly clock?: () => Date;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly onEvent?: (event: SchedulerEvent) => void;
}

export type SchedulerEvent =
  | { readonly kind: 'claimed'; readonly runId: string; readonly scheduleId: string }
  | { readonly kind: 'skipped'; readonly scheduleId: string; readonly reason: 'missed' | 'check' }
  | { readonly kind: 'settled'; readonly runId: string; readonly status: string }
  | { readonly kind: 'contended'; readonly scheduleId: string }
  | { readonly kind: 'reclaimed'; readonly runId: string }
  | { readonly kind: 'error' }
  | { readonly kind: 'stopped' };

const DEFAULT_LEASE_SECONDS = 900;
const DEFAULT_POLL_MS = 30_000;

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class SchedulerLoop {
  readonly #options: SchedulerLoopOptions;
  /** Runs this process currently holds, so shutdown can release them. */
  readonly #held = new Set<string>();

  public constructor(options: SchedulerLoopOptions) {
    this.#options = options;
  }

  private get leaseSeconds(): number {
    return this.#options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  }

  private now(): Date {
    return (this.#options.clock ?? (() => new Date()))();
  }

  /**
   * One pass: recover what was abandoned, then take what is due.
   *
   * Recovery runs first. A run abandoned by a dead process is holding an
   * occurrence, and picking up new work while an old occurrence sits stuck
   * would let the backlog grow behind the loop.
   */
  public async runOnce(): Promise<number> {
    const { repositories, serverInstanceId } = this.#options;
    const now = this.now();

    await this.#recoverAbandoned(now);

    const due = await repositories.schedules.listDue(now, 10);
    let handled = 0;
    for (const schedule of due) {
      if (schedule.serverInstanceId !== serverInstanceId) continue;
      if (schedule.nextRunAt === null) continue;
      handled += (await this.#handleSchedule(schedule, now)) ? 1 : 0;
    }
    return handled;
  }

  /**
   * Settles runs whose claimant stopped reporting.
   *
   * They are failed rather than resumed. A run that died on an unknown step
   * may have half-applied it, and resuming from a step index the dead process
   * never confirmed is how a restart runs the same restart twice.
   */
  async #recoverAbandoned(now: Date): Promise<void> {
    const abandoned = await this.#options.repositories.schedules.listAbandoned(now, 10);
    for (const run of abandoned) {
      if (run.serverInstanceId !== this.#options.serverInstanceId) continue;
      if (this.#held.has(run.runId)) continue;
      const schedule = await this.#options.repositories.schedules.findById(run.scheduleId);
      const nextRunAt = schedule === null || schedule === undefined ? null : this.#nextRun(schedule, now);
      try {
        await this.#options.repositories.schedules.settle({
          runId: run.runId,
          status: 'failed',
          failureCode: 'scheduler-abandoned',
          postRestartVerified: null,
          nextRunAt,
          now,
        });
        this.#options.onEvent?.({ kind: 'reclaimed', runId: run.runId });
      } catch {
        // Another agent settled it first. Nothing to do, and nothing wrong.
      }
    }
  }

  #nextRun(schedule: ServerSchedule, after: Date): string | null {
    try {
      return nextRunAfter({ trigger: schedule.trigger, after }).toISOString();
    } catch (error) {
      if (!(error instanceof ScheduleError)) throw error;
      // A trigger that stopped resolving disables the schedule rather than
      // wedging the loop on it every cycle.
      return null;
    }
  }

  async #handleSchedule(schedule: ServerSchedule, now: Date): Promise<boolean> {
    const dueAt = new Date(schedule.nextRunAt as string);

    // Anything older than the current occurrence is a window that passed while
    // nothing was running. Recorded as skipped, never executed.
    const missed = missedOccurrences({
      trigger: schedule.trigger,
      since: new Date(dueAt.getTime() - 1),
      now,
      limit: 8,
    });
    const stale = missed.filter((instant) => instant.getTime() < now.getTime() - 60_000);
    for (const instant of stale.slice(0, -1)) {
      await this.#recordSkipped(schedule, instant, now);
    }

    const target = stale.length > 0 ? (stale[stale.length - 1] as Date) : dueAt;
    if (target.getTime() > now.getTime()) return false;

    let run;
    try {
      run = await this.#options.repositories.schedules.claimOccurrence({
        runId: randomUUID(),
        scheduleId: schedule.scheduleId,
        serverInstanceId: schedule.serverInstanceId,
        scheduledFor: target,
        claimedBy: this.#options.agentId,
        leaseSeconds: this.leaseSeconds,
        now,
      });
    } catch (error) {
      if (!(error instanceof SchedulePersistenceError)) throw error;
      // Someone else owns this occurrence. That is the deduplication working.
      this.#options.onEvent?.({ kind: 'contended', scheduleId: schedule.scheduleId });
      return false;
    }

    this.#held.add(run.runId);
    this.#options.onEvent?.({ kind: 'claimed', runId: run.runId, scheduleId: schedule.scheduleId });
    try {
      await this.#executeRun(schedule, run.runId);
    } finally {
      this.#held.delete(run.runId);
    }
    return true;
  }

  async #recordSkipped(schedule: ServerSchedule, instant: Date, now: Date): Promise<void> {
    try {
      const run = await this.#options.repositories.schedules.claimOccurrence({
        runId: randomUUID(),
        scheduleId: schedule.scheduleId,
        serverInstanceId: schedule.serverInstanceId,
        scheduledFor: instant,
        claimedBy: this.#options.agentId,
        leaseSeconds: this.leaseSeconds,
        now,
      });
      await this.#options.repositories.schedules.settle({
        runId: run.runId,
        status: 'skipped',
        postRestartVerified: null,
        nextRunAt: this.#nextRun(schedule, now),
        now,
      });
      this.#options.onEvent?.({ kind: 'skipped', scheduleId: schedule.scheduleId, reason: 'missed' });
    } catch {
      // Already claimed or already recorded. Either way it will not be run.
    }
  }

  async #executeRun(schedule: ServerSchedule, runId: string): Promise<void> {
    let postRestartVerified: boolean | null = null;
    let status: 'succeeded' | 'failed' | 'skipped' = 'succeeded';
    let failureCode: string | undefined;

    for (const [index, step] of schedule.steps.entries()) {
      const now = this.now();
      try {
        // The lease is renewed at every step, so a long backup is not mistaken
        // for an abandoned run by another agent's recovery pass.
        await this.#options.repositories.schedules.advance({
          runId,
          stepIndex: index,
          leaseSeconds: this.leaseSeconds,
          now,
        });
      } catch {
        // The claim was taken from us. Stop rather than keep acting on a run we
        // no longer own — two agents running the same steps is exactly what the
        // lease exists to prevent.
        return;
      }

      const result = await this.#options.executor
        .execute({ schedule, step, runId, stepIndex: index })
        .catch(() => ({ outcome: 'failed' as const, failureCode: 'executor-failed' }));

      if (result.outcome === 'skip') {
        status = 'skipped';
        this.#options.onEvent?.({ kind: 'skipped', scheduleId: schedule.scheduleId, reason: 'check' });
        break;
      }
      if (result.outcome === 'failed') {
        status = 'failed';
        failureCode = result.failureCode ?? 'step-failed';
        if (step.kind === 'restart') postRestartVerified = false;
        break;
      }
      // A restart that reported continue was observed to come back; anything
      // else would have failed the step.
      if (step.kind === 'restart') postRestartVerified = true;
    }

    const now = this.now();
    await this.#options.repositories.schedules
      .settle({
        runId,
        status,
        ...(failureCode === undefined ? {} : { failureCode }),
        postRestartVerified,
        nextRunAt: this.#nextRun(schedule, now),
        now,
      })
      .catch(() => undefined);
    this.#options.onEvent?.({ kind: 'settled', runId, status });
  }

  /**
   * Runs until the signal aborts, then releases what it holds.
   *
   * Releasing on the way out is the difference between a restart that resumes
   * in seconds and one that waits out a fifteen-minute lease.
   */
  public async run(signal: AbortSignal): Promise<void> {
    const sleep = this.#options.sleep ?? defaultSleep;
    const poll = this.#options.pollMilliseconds ?? DEFAULT_POLL_MS;
    while (!signal.aborted) {
      try {
        const handled = await this.runOnce();
        if (handled === 0) await sleep(poll, signal);
      } catch {
        this.#options.onEvent?.({ kind: 'error' });
        await sleep(poll, signal);
      }
    }
    await this.releaseHeldRuns();
    this.#options.onEvent?.({ kind: 'stopped' });
  }

  /**
   * Settles anything this process still holds, as an interrupted run.
   *
   * Recorded as failed with a distinct code rather than silently dropped: an
   * operator looking at why last night's window did not complete should find
   * "the agent was shut down", not an empty gap.
   */
  public async releaseHeldRuns(): Promise<void> {
    const now = this.now();
    for (const runId of [...this.#held]) {
      await this.#options.repositories.schedules
        .settle({
          runId,
          status: 'failed',
          failureCode: 'agent-shutdown',
          postRestartVerified: null,
          nextRunAt: null,
          now,
        })
        .catch(() => undefined);
      this.#held.delete(runId);
    }
  }
}
