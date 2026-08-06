import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import type { ScheduleStep, ServerSchedule } from '@voidfall/contracts';
import { createRepositories, runMigrations, type Database, type Repositories } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';

import { createDurableScheduleExecutor } from '../src/schedule-executor.js';

/**
 * The default schedule step executor against a real database.
 *
 * Nothing here starts a Minecraft process. What is under test is the handoff:
 * a scheduled step enqueues the same durable operation an operator's request
 * would have, and does not call itself done until that operation settles.
 */

const NOW = new Date('2026-08-05T04:00:00.000Z');

const databases: Database[] = [];

afterEach(async () => {
  while (databases.length > 0) {
    await databases.pop()?.close();
  }
});

async function fixture(): Promise<{
  readonly repositories: Repositories;
  readonly serverId: string;
}> {
  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  databases.push(database);
  const repositories = createRepositories(database);
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'voidfall-schedule-test',
    displayName: 'VoidFall Schedule Test',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '1.20.1-47.4.4',
    maxPlayers: 20,
  });
  return { repositories, serverId: server.id };
}

function schedule(serverInstanceId: string, steps: readonly ScheduleStep[]): ServerSchedule {
  return {
    schemaVersion: 1,
    scheduleId: randomUUID(),
    serverInstanceId,
    name: 'Nightly',
    enabled: true,
    trigger: { timezone: 'UTC', hour: 4, minute: 0, weekdays: [] },
    steps: [...steps],
    reasonCode: 'scheduled-maintenance',
    nextRunAt: NOW.toISOString(),
    lastRunAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

/**
 * Stands in for the work loop the executor is waiting on.
 *
 * Injected as the sleep so the handoff runs end to end without a timer: the
 * executor enqueues, waits, and finds the operation settled on its next look —
 * the same sequence a live agent produces, where the supervisor claims the job
 * this step queued while the step is still waiting on it.
 *
 * It settles the backup record too, because that is what the real handler does.
 * Leaving a snapshot in `creating` would block the next one, which is a state
 * no successful backup ever actually leaves behind.
 */
function settleOnFirstWait(
  repositories: Repositories,
  serverId: string,
  outcome: 'succeeded' | 'failed',
): () => Promise<void> {
  let settled = false;
  return async () => {
    if (settled) return;
    settled = true;
    const page = await repositories.operations.list({
      serverInstanceId: serverId,
      statuses: ['accepted', 'running'],
      limit: 1,
      offset: 0,
    });
    const operation = page.operations[0];
    if (operation === undefined) return;

    if (operation.backupId !== null) {
      await (outcome === 'succeeded'
        ? repositories.backups.complete({
            backupId: operation.backupId,
            sizeBytes: 1_024,
            fileCount: 1,
            manifestSha256: 'a'.repeat(64),
            sealKeyId: 'test-seal',
            encryptionKeyId: null,
            now: NOW,
          })
        : repositories.backups.fail({
            backupId: operation.backupId,
            failureCode: 'filesystem-failure',
            now: NOW,
          }));
    }

    await repositories.operations.settle({
      operationId: operation.operationId,
      eventId: randomUUID(),
      expectedVersion: operation.version,
      outcome,
      ...(outcome === 'failed' ? { failureCode: 'operation-failed' as const } : {}),
      observedLifecycle: outcome === 'succeeded' ? 'online' : 'error',
      now: NOW,
    });
  };
}

describe('the durable schedule executor', () => {
  it('enqueues a backup operation, records the snapshot and waits for it', async () => {
    const { repositories, serverId } = await fixture();
    const executor = createDurableScheduleExecutor({
      repositories,
      serverInstanceId: serverId,
      clock: () => NOW,
      sleep: settleOnFirstWait(repositories, serverId, 'succeeded'),
    });
    const runId = randomUUID();
    const plan = schedule(serverId, [{ kind: 'backup', scope: 'world' }]);

    const result = await executor.execute({
      schedule: plan,
      step: plan.steps[0] as ScheduleStep,
      runId,
      stepIndex: 0,
    });
    assert.deepEqual(result, { outcome: 'continue' });

    // The same durable record the control API would have written, so the
    // backup handler has something to read when it claims the job.
    const backups = await repositories.backups.listForServer(serverId);
    assert.equal(backups.length, 1);
    assert.equal(backups[0]?.scope, 'world');

    const operations = await repositories.operations.list({
      serverInstanceId: serverId,
      limit: 10,
      offset: 0,
    });
    assert.equal(operations.total, 1);
    assert.equal(operations.operations[0]?.kind, 'backup.create');
    // Requested by the schedule, not by a person: a clock made this decision,
    // and putting an operator's name on it would misattribute it forever.
    assert.deepEqual(operations.operations[0]?.requestedBy, {
      type: 'system',
      id: plan.scheduleId,
    });
    // A job exists to carry it, and the operation names that job.
    const jobId = operations.operations[0]?.jobId;
    assert.notEqual(jobId, null);
    assert.equal((await repositories.jobs.findById(jobId as string))?.type, 'backup.create');
  });

  it('reports a failed operation as a failed step rather than a completed one', async () => {
    const { repositories, serverId } = await fixture();
    const executor = createDurableScheduleExecutor({
      repositories,
      serverInstanceId: serverId,
      clock: () => NOW,
      sleep: settleOnFirstWait(repositories, serverId, 'failed'),
    });
    const plan = schedule(serverId, [{ kind: 'restart', timeoutSeconds: 60 }]);

    const result = await executor.execute({
      schedule: plan,
      step: plan.steps[0] as ScheduleStep,
      runId: randomUUID(),
      stepIndex: 0,
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.failureCode, 'step-failed');
  });

  it('says it does not know rather than guessing when the operation never settles', async () => {
    const { repositories, serverId } = await fixture();
    let time = NOW.getTime();
    const executor = createDurableScheduleExecutor({
      repositories,
      serverInstanceId: serverId,
      clock: () => new Date(time),
      // Nothing settles the operation; time simply passes.
      sleep: async () => {
        time += 30_000;
      },
    });
    const plan = schedule(serverId, [{ kind: 'restart', timeoutSeconds: 60 }]);

    const result = await executor.execute({
      schedule: plan,
      step: plan.steps[0] as ScheduleStep,
      runId: randomUUID(),
      stepIndex: 0,
    });
    // The operation is still out there. What the run records is that nobody
    // watched it finish, which is the only thing actually known.
    assert.equal(result.outcome, 'failed');
    assert.equal(result.failureCode, 'operation-did-not-settle');
  });

  it('gives two backup steps of one run two distinct snapshots', async () => {
    const { repositories, serverId } = await fixture();
    const runId = randomUUID();
    const plan = schedule(serverId, [
      { kind: 'backup', scope: 'world' },
      { kind: 'backup', scope: 'configurations' },
    ]);

    for (const [stepIndex, step] of plan.steps.entries()) {
      const executor = createDurableScheduleExecutor({
        repositories,
        serverInstanceId: serverId,
        clock: () => NOW,
        sleep: settleOnFirstWait(repositories, serverId, 'succeeded'),
      });
      const result = await executor.execute({ schedule: plan, step, runId, stepIndex });
      assert.deepEqual(result, { outcome: 'continue' }, `step ${String(stepIndex)}`);
    }

    const backups = await repositories.backups.listForServer(serverId);
    // Derived from the run *and* the step's position: from the run alone the
    // two would have collided on one name.
    assert.equal(backups.length, 2);
    assert.equal(new Set(backups.map((backup) => backup.backupId)).size, 2);
    assert.deepEqual(backups.map((backup) => backup.scope).sort(), ['configurations', 'world']);
  });

  it('finds the operation it already created instead of starting a second', async () => {
    const { repositories, serverId } = await fixture();
    const runId = randomUUID();
    const plan = schedule(serverId, [{ kind: 'backup', scope: 'world' }]);
    const step = plan.steps[0] as ScheduleStep;

    const first = createDurableScheduleExecutor({
      repositories,
      serverInstanceId: serverId,
      clock: () => NOW,
      sleep: settleOnFirstWait(repositories, serverId, 'succeeded'),
    });
    await first.execute({ schedule: plan, step, runId, stepIndex: 0 });

    // The same run and the same step, replayed. Nothing random went into the
    // key, so this is recognised as the request it already served.
    const second = createDurableScheduleExecutor({
      repositories,
      serverInstanceId: serverId,
      clock: () => NOW,
      sleep: async () => undefined,
    });
    const result = await second.execute({ schedule: plan, step, runId, stepIndex: 0 });

    assert.deepEqual(result, { outcome: 'continue' });
    const operations = await repositories.operations.list({
      serverInstanceId: serverId,
      limit: 10,
      offset: 0,
    });
    assert.equal(operations.total, 1);
    assert.equal((await repositories.backups.listForServer(serverId)).length, 1);
  });

  it('yields to an operation already in flight instead of pre-empting it', async () => {
    const { repositories, serverId } = await fixture();
    // An operator's stop is running. A scheduled restart that pushed past it
    // would be the schedule doing harm on a timer.
    await repositories.operations.accept({
      operationId: randomUUID(),
      serverInstanceId: serverId,
      kind: 'server.stop',
      idempotencyKey: 'operator-stop-00000001',
      correlationId: randomUUID(),
      requestedBy: { type: 'panel-user', id: randomUUID() },
      reasonCode: 'operator-request',
      now: NOW,
    });

    const executor = createDurableScheduleExecutor({
      repositories,
      serverInstanceId: serverId,
      clock: () => NOW,
      sleep: async () => undefined,
    });
    const plan = schedule(serverId, [{ kind: 'restart', timeoutSeconds: 60 }]);
    const result = await executor.execute({
      schedule: plan,
      step: plan.steps[0] as ScheduleStep,
      runId: randomUUID(),
      stepIndex: 0,
    });

    assert.equal(result.outcome, 'failed');
    assert.equal(result.failureCode, 'operation-in-flight');
  });

  it('refuses the two steps whose facts have no approved provider', async () => {
    const { repositories, serverId } = await fixture();
    const executor = createDurableScheduleExecutor({
      repositories,
      serverInstanceId: serverId,
      clock: () => NOW,
      sleep: async () => undefined,
    });
    const plan = schedule(serverId, [
      { kind: 'warn-players', leadSeconds: 300 },
      { kind: 'maintenance-check', maximumPlayersOnline: 0 },
    ]);

    // No reviewed console command speaks to players. Running the disruption
    // without the warning the author asked for is not their schedule.
    const warn = await executor.execute({
      schedule: plan,
      step: plan.steps[0] as ScheduleStep,
      runId: randomUUID(),
      stepIndex: 0,
    });
    assert.deepEqual(warn, {
      outcome: 'failed',
      failureCode: 'no-approved-broadcast-command',
    });

    // Players online has no approved provider. A guard that cannot be evaluated
    // is not a guard that passed.
    const check = await executor.execute({
      schedule: plan,
      step: plan.steps[1] as ScheduleStep,
      runId: randomUUID(),
      stepIndex: 1,
    });
    assert.deepEqual(check, {
      outcome: 'failed',
      failureCode: 'no-approved-player-provider',
    });

    // Neither enqueued anything.
    const operations = await repositories.operations.list({
      serverInstanceId: serverId,
      limit: 10,
      offset: 0,
    });
    assert.equal(operations.total, 0);
  });

  it('refuses a schedule that belongs to another server', async () => {
    const { repositories, serverId } = await fixture();
    const executor = createDurableScheduleExecutor({
      repositories,
      serverInstanceId: serverId,
      clock: () => NOW,
      sleep: async () => undefined,
    });
    const plan = schedule(randomUUID(), [{ kind: 'backup', scope: 'world' }]);
    const result = await executor.execute({
      schedule: plan,
      step: plan.steps[0] as ScheduleStep,
      runId: randomUUID(),
      stepIndex: 0,
    });

    assert.equal(result.outcome, 'failed');
    const operations = await repositories.operations.list({
      serverInstanceId: serverId,
      limit: 10,
      offset: 0,
    });
    assert.equal(operations.total, 0);
  });
});
