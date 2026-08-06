import { randomUUID } from 'node:crypto';

import type { ActorRef, Job, ScheduleStep, ServerOperation, ServerSchedule } from '@voidfall/contracts';
import { OperationalPersistenceError, type Repositories } from '@voidfall/database';

import type { ScheduleStepExecutor } from './scheduler-loop.js';

/**
 * The default schedule step executor.
 *
 * It does not perform the work. It enqueues the same durable operation the
 * control API would have enqueued had an operator asked, and then waits for
 * that operation to settle. Everything a scheduled backup or restart needs —
 * the exclusive lock, the idempotency, the one-in-flight rule, the receipt —
 * already exists on that path, and a scheduler that reached around it would be
 * a second way to start a server with none of those properties.
 *
 * The waiting is the part worth stating plainly. Reporting a step as succeeded
 * the moment its job was queued would record "the nightly restart completed"
 * for a restart that had not been attempted yet, and `postRestartVerified`
 * would be affirming a boot nobody watched. So the step is not done until the
 * operation is.
 *
 * Two of the four step kinds are refused rather than approximated, because the
 * facts they need have no approved provider yet. Both refusals name what is
 * missing, and both stop the run — a guard that cannot be evaluated must not be
 * treated as passed, and a warning that cannot be sent must not be treated as
 * sent while the restart goes ahead anyway.
 */

export type ScheduleStepFailureCode =
  | 'no-approved-broadcast-command'
  | 'no-approved-player-provider'
  | 'operation-in-flight'
  | 'operation-rejected'
  | 'operation-did-not-settle'
  | 'backup-not-recorded'
  | 'step-failed';

export interface DurableScheduleExecutorOptions {
  readonly repositories: Repositories;
  /** The server this agent is responsible for; another server's schedule is refused. */
  readonly serverInstanceId: string;
  /**
   * How long a step will wait for its operation before giving up on knowing.
   * Bounded by the scheduler's own step lease: waiting past it would mean
   * holding a run another agent has already been allowed to reclaim.
   */
  readonly settleTimeoutMs?: number;
  readonly pollMilliseconds?: number;
  readonly clock?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_SETTLE_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_MS = 2_000;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds).unref();
  });
}

/**
 * Names what a step enqueues, from the run and the step's position alone.
 *
 * Deterministic on purpose. The identifier is the idempotency key, so a run
 * that is retried against the same occurrence finds the operation it already
 * created instead of starting a second one — and a schedule holding two backup
 * steps gets two distinct names rather than one collision.
 */
function stepKey(runId: string, stepIndex: number): string {
  return `sched:${runId}:${String(stepIndex)}`;
}

function backupIdFor(runId: string, stepIndex: number): string {
  // The backup id has its own alphabet and must start with a letter, which a
  // bare uuid does not.
  return `sched-${runId}-${String(stepIndex)}`;
}

export function createDurableScheduleExecutor(
  options: DurableScheduleExecutorOptions,
): ScheduleStepExecutor {
  const clock = options.clock ?? ((): Date => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const poll = options.pollMilliseconds ?? DEFAULT_POLL_MS;

  /**
   * Waits for an operation to reach a terminal state.
   *
   * A timeout is reported as not having settled, never as either outcome. The
   * operation is still out there; what the run records is that nobody watched
   * it finish, which is the one thing that is actually known.
   */
  async function waitForSettlement(
    operationId: string,
    timeoutMs: number,
  ): Promise<'succeeded' | 'failed' | 'rejected' | 'timed-out'> {
    const deadline = clock().getTime() + timeoutMs;
    for (;;) {
      const operation = await options.repositories.operations.findById(operationId);
      if (operation === undefined) return 'timed-out';
      if (operation.status !== 'accepted' && operation.status !== 'running') {
        return operation.status;
      }
      if (clock().getTime() >= deadline) return 'timed-out';
      await sleep(poll);
    }
  }

  /**
   * Accepts the operation and queues its job, in that order.
   *
   * The operation owns the idempotency and the one-in-flight rule, so it is
   * accepted before any job exists that could run the work twice — the same
   * ordering the control API uses, for the same reason.
   */
  async function acceptAndQueue(input: {
    readonly kind: ServerOperation['kind'];
    readonly jobType: Job['type'];
    readonly idempotencyKey: string;
    readonly reasonCode: string;
    readonly actor: ActorRef;
    readonly correlationId: string;
    readonly backupId?: string;
  }): Promise<
    | { readonly ok: true; readonly operation: ServerOperation; readonly replayed: boolean }
    | { readonly ok: false; readonly failureCode: ScheduleStepFailureCode }
  > {
    const now = clock();
    let accepted;
    try {
      accepted = await options.repositories.operations.accept({
        operationId: randomUUID(),
        serverInstanceId: options.serverInstanceId,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        requestedBy: input.actor,
        reasonCode: input.reasonCode,
        ...(input.backupId === undefined ? {} : { backupId: input.backupId }),
        now,
      });
    } catch (error) {
      if (!(error instanceof OperationalPersistenceError)) throw error;
      // Something else holds the server. The window is not the place to force
      // it: a scheduled restart that pre-empted an operator's running restore
      // would be the schedule doing harm on a timer.
      return {
        ok: false,
        failureCode:
          error.code === 'operation-in-flight' ? 'operation-in-flight' : 'operation-rejected',
      };
    }

    if (accepted.replayed) {
      return { ok: true, operation: accepted.operation, replayed: true };
    }

    const enqueued = await options.repositories.jobs.enqueue({
      schemaVersion: 1,
      id: randomUUID(),
      type: input.jobType,
      resource: { type: 'server-instance', id: options.serverInstanceId },
      status: 'queued',
      stage: 'queued',
      priority: 40,
      payload: {
        schemaVersion: 1,
        parameters: {
          serverInstanceId: options.serverInstanceId,
          expectedVersion: accepted.operation.version,
        },
      },
      idempotencyKey: `${input.idempotencyKey}:job`,
      requestedBy: input.actor,
      correlationId: input.correlationId,
      availableAt: now.toISOString(),
      attempt: 0,
      maxAttempts: 1,
    });
    const running = await options.repositories.operations.markRunning({
      operationId: accepted.operation.operationId,
      expectedVersion: accepted.operation.version,
      jobId: enqueued.id,
      now: clock(),
    });
    return { ok: true, operation: running, replayed: false };
  }

  function settlementOutcome(
    settled: Awaited<ReturnType<typeof waitForSettlement>>,
  ): { readonly outcome: 'continue' | 'failed'; readonly failureCode?: string } {
    if (settled === 'succeeded') return { outcome: 'continue' };
    if (settled === 'timed-out') {
      return { outcome: 'failed', failureCode: 'operation-did-not-settle' };
    }
    return { outcome: 'failed', failureCode: 'step-failed' };
  }

  async function runBackup(
    step: Extract<ScheduleStep, { kind: 'backup' }>,
    schedule: ServerSchedule,
    runId: string,
    stepIndex: number,
    actor: ActorRef,
    correlationId: string,
  ): Promise<{ readonly outcome: 'continue' | 'failed'; readonly failureCode?: string }> {
    const backupId = backupIdFor(runId, stepIndex);
    const queued = await acceptAndQueue({
      kind: 'backup.create',
      jobType: 'backup.create',
      idempotencyKey: stepKey(runId, stepIndex),
      reasonCode: schedule.reasonCode,
      actor,
      correlationId,
      backupId,
    });
    if (!queued.ok) return { outcome: 'failed', failureCode: queued.failureCode };

    // The record the handler reads to learn which snapshot to take. Its absence
    // would leave the job claimable and unservable, so a failure to write it
    // fails the step rather than leaving a job to be refused later.
    if (!queued.replayed) {
      try {
        await options.repositories.backups.begin({
          backupId,
          serverInstanceId: options.serverInstanceId,
          scope: step.scope,
          reasonCode: schedule.reasonCode,
          requestedBy: actor,
          correlationId,
          operationId: queued.operation.operationId,
          now: clock(),
        });
      } catch {
        const existing = await options.repositories.backups.findById(backupId);
        // Already there from the same run replaying is fine; anything else is
        // a snapshot this step cannot account for.
        if (existing === undefined) {
          return { outcome: 'failed', failureCode: 'backup-not-recorded' };
        }
      }
    }

    return settlementOutcome(
      await waitForSettlement(
        queued.operation.operationId,
        options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
      ),
    );
  }

  async function runRestart(
    step: Extract<ScheduleStep, { kind: 'restart' }>,
    schedule: ServerSchedule,
    runId: string,
    stepIndex: number,
    actor: ActorRef,
    correlationId: string,
  ): Promise<{ readonly outcome: 'continue' | 'failed'; readonly failureCode?: string }> {
    const queued = await acceptAndQueue({
      kind: 'server.restart',
      jobType: 'server.restart',
      idempotencyKey: stepKey(runId, stepIndex),
      reasonCode: schedule.reasonCode,
      actor,
      correlationId,
    });
    if (!queued.ok) return { outcome: 'failed', failureCode: queued.failureCode };

    // The step's own timeout bounds the wait, so a schedule that said "give it
    // sixty seconds" is not held for ten minutes by this executor's default.
    return settlementOutcome(
      await waitForSettlement(
        queued.operation.operationId,
        Math.min(
          step.timeoutSeconds * 1_000,
          options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
        ),
      ),
    );
  }

  return {
    async execute({ schedule, step, runId, stepIndex }) {
      if (schedule.serverInstanceId !== options.serverInstanceId) {
        return { outcome: 'failed', failureCode: 'step-failed' };
      }
      // A scheduled operation was requested by the schedule, not by a person.
      // Recording an operator as the actor would put a name on a decision made
      // by a clock.
      const actor: ActorRef = { type: 'system', id: schedule.scheduleId };
      const correlationId = randomUUID();

      switch (step.kind) {
        case 'backup':
          return runBackup(step, schedule, runId, stepIndex, actor, correlationId);
        case 'restart':
          return runRestart(step, schedule, runId, stepIndex, actor, correlationId);
        case 'warn-players':
          // The reviewed console catalogue holds `list-players` and `save-all`
          // and nothing that speaks to players. The author of this schedule
          // asked for a warning before the disruption; running the disruption
          // without it is not the schedule they wrote.
          return { outcome: 'failed', failureCode: 'no-approved-broadcast-command' };
        case 'maintenance-check':
          // Players online has no approved provider, so the check cannot be
          // evaluated. A guard that cannot be evaluated is not a guard that
          // passed, and treating it as one would restart a populated server.
          return { outcome: 'failed', failureCode: 'no-approved-player-provider' };
        default:
          return { outcome: 'failed', failureCode: 'step-failed' };
      }
    },
  };
}
