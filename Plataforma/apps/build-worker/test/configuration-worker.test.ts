import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import type {
  ConfigurationOperationCommand,
  ConfigurationOperationResult,
  Job,
} from '@voidfall/contracts';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import {
  runConfigurationWorkerOnce,
  type ConfigurationOperationExecutor,
} from '../src/configuration-worker.js';

const databases: Database[] = [];
const NOW = new Date('2026-08-04T12:00:00.000Z');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

afterEach(async () => {
  while (databases.length > 0) await databases.pop()?.close();
});

function command(
  overrides: Partial<ConfigurationOperationCommand> = {},
): ConfigurationOperationCommand {
  return {
    schemaVersion: 1,
    operation: 'update',
    serverInstanceId: randomUUID(),
    resourceId: 'openloader-advanced-options',
    revisionId: 'worker-update-1',
    sourceRevisionId: null,
    expectedCurrentSha256: HASH_A,
    expectedStateVersion: 1,
    reasonCode: 'operator-request',
    correlationId: randomUUID(),
    actor: { type: 'panel-user', id: randomUUID() },
    changes: [{ name: 'dataPacks.enabled', value: false }],
    ...overrides,
  } as ConfigurationOperationCommand;
}

function queuedJob(type: Job['type'], parameters: Job['payload']['parameters']): Job {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    type,
    resource: { type: 'server-instance', id: 'voidfall-test' },
    status: 'queued',
    stage: 'queued',
    priority: 50,
    payload: { schemaVersion: 1, parameters },
    idempotencyKey: `configuration:${randomUUID()}`,
    requestedBy: { type: 'panel-user', id: randomUUID() },
    correlationId: randomUUID(),
    availableAt: NOW.toISOString(),
    attempt: 0,
    maxAttempts: 3,
  };
}

function executorFor(
  result: ConfigurationOperationResult | Error,
  seen: ConfigurationOperationCommand[] = [],
): ConfigurationOperationExecutor {
  return {
    async execute(received) {
      seen.push(received);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function appliedResult(
  overrides: Partial<ConfigurationOperationResult> = {},
): ConfigurationOperationResult {
  return {
    schemaVersion: 1,
    revisionId: 'worker-update-1',
    resourceId: 'openloader-advanced-options',
    operation: 'update',
    outcome: 'applied',
    previousSha256: HASH_A,
    currentSha256: HASH_B,
    changedFields: ['dataPacks.enabled'],
    restartRequired: true,
    failureCode: null,
    completedAt: NOW.toISOString(),
    ...overrides,
  } as ConfigurationOperationResult;
}

async function harness() {
  const database = await createPGliteTestDatabase();
  databases.push(database);
  await runMigrations(database);
  return { database, repositories: createRepositories(database) };
}

describe('durable configuration job runner', () => {
  it('leases only configuration jobs and completes an applied operation', async () => {
    const { database, repositories } = await harness();
    const typed = command();
    const job = await repositories.jobs.enqueue(
      queuedJob('configuration.apply', { command: typed }),
    );
    const unrelated = await repositories.jobs.enqueue(
      queuedJob('modpack.build', { planId: 'phase-7-3' }),
    );
    const seen: ConfigurationOperationCommand[] = [];
    const workerId = randomUUID();

    const outcome = await runConfigurationWorkerOnce({
      database,
      workerId,
      executor: executorFor(appliedResult(), seen),
      now: NOW,
    });

    assert.deepEqual(outcome, {
      processed: true,
      jobId: job.id,
      outcome: 'applied',
      revisionId: 'worker-update-1',
    });
    assert.equal((await repositories.jobs.findById(job.id))?.status, 'succeeded');
    assert.equal((await repositories.jobs.findById(unrelated.id))?.status, 'queued');
    assert.deepEqual(seen, [typed]);
    assert.deepEqual(
      await runConfigurationWorkerOnce({
        database,
        workerId,
        executor: executorFor(appliedResult()),
        now: NOW,
      }),
      { processed: false },
    );
  });

  it('records job events with field names and hashes but no configuration value', async () => {
    const { database, repositories } = await harness();
    const job = await repositories.jobs.enqueue(
      queuedJob('configuration.apply', { command: command() }),
    );

    await runConfigurationWorkerOnce({
      database,
      workerId: randomUUID(),
      executor: executorFor(appliedResult()),
      now: NOW,
    });

    const events = await database.query<{ stage: string; metadata_redacted: unknown }>(
      'SELECT stage, metadata_redacted FROM job_events WHERE job_id = $1 ORDER BY sequence',
      [job.id],
    );
    assert.deepEqual(
      events.rows.map((row) => row.stage),
      ['configuration-dispatch', 'configuration-applied'],
    );
    const serialized = JSON.stringify(events.rows);
    assert.equal(serialized.includes('dataPacks.enabled'), true);
    assert.equal(serialized.includes(HASH_B), true);
    // The field name and hash are safe; the value itself never appears.
    assert.equal(/"value"\s*:/u.test(serialized), false);
  });

  it('fails a job whose payload is not exactly one typed command', async () => {
    const { database, repositories } = await harness();
    const invalidPayloads: Job['payload']['parameters'][] = [
      {},
      { command: { schemaVersion: 1, operation: 'update' } },
      { command: command(), extra: 'x' },
      { command: { ...command(), configurationRoot: 'H:/private' } },
    ];

    for (const parameters of invalidPayloads) {
      const job = await repositories.jobs.enqueue(queuedJob('configuration.apply', parameters));
      const seen: ConfigurationOperationCommand[] = [];
      const outcome = await runConfigurationWorkerOnce({
        database,
        workerId: randomUUID(),
        executor: executorFor(appliedResult(), seen),
        now: NOW,
      });
      assert.equal(outcome.processed, true);
      assert.equal(outcome.processed && outcome.outcome, 'failed');
      assert.equal((await repositories.jobs.findById(job.id))?.status, 'failed');
      // A malformed payload never reaches the agent capability.
      assert.deepEqual(seen, []);
    }
  });

  it('refuses a command whose operation disagrees with the job type', async () => {
    const { database, repositories } = await harness();
    const job = await repositories.jobs.enqueue(
      queuedJob('configuration.rollback', { command: command() }),
    );
    const seen: ConfigurationOperationCommand[] = [];

    await runConfigurationWorkerOnce({
      database,
      workerId: randomUUID(),
      executor: executorFor(appliedResult(), seen),
      now: NOW,
    });

    const failed = await repositories.jobs.findById(job.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.error?.code, 'CONFIGURATION_OPERATION_MISMATCH');
    assert.deepEqual(seen, []);
  });

  it('maps a sanitized agent failure onto the job without retrying it', async () => {
    const { database, repositories } = await harness();
    const job = await repositories.jobs.enqueue(
      queuedJob('configuration.apply', { command: command() }),
    );

    const outcome = await runConfigurationWorkerOnce({
      database,
      workerId: randomUUID(),
      executor: executorFor(
        appliedResult({
          outcome: 'failed',
          previousSha256: null,
          currentSha256: null,
          changedFields: [],
          restartRequired: false,
          failureCode: 'concurrent-modification',
        }),
      ),
      now: NOW,
    });

    assert.equal(outcome.processed && outcome.outcome, 'failed');
    const failed = await repositories.jobs.findById(job.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.error?.code, 'CONFIGURATION_CONCURRENT_MODIFICATION');
    assert.equal(failed?.error?.retryable, false);
  });

  it('fails the job when the agent capability refuses the command outright', async () => {
    const { database, repositories } = await harness();
    const job = await repositories.jobs.enqueue(
      queuedJob('configuration.apply', { command: command() }),
    );

    await runConfigurationWorkerOnce({
      database,
      workerId: randomUUID(),
      executor: executorFor(new Error('agent-configuration:resource-not-authorized')),
      now: NOW,
    });

    const failed = await repositories.jobs.findById(job.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.error?.code, 'CONFIGURATION_COMMAND_REFUSED');
    // The refusal reason stays server-side and never becomes a public message.
    assert.equal(failed?.error?.message.includes('resource-not-authorized'), false);
  });

  it('leases a queued rollback job exactly once', async () => {
    const { database, repositories } = await harness();
    const rollback = command({
      operation: 'rollback',
      revisionId: 'worker-rollback-1',
      sourceRevisionId: 'worker-update-1',
      changes: [],
    });
    const job = await repositories.jobs.enqueue(
      queuedJob('configuration.rollback', { command: rollback }),
    );

    const outcome = await runConfigurationWorkerOnce({
      database,
      workerId: randomUUID(),
      executor: executorFor(
        appliedResult({ revisionId: 'worker-rollback-1', operation: 'rollback' }),
      ),
      now: NOW,
    });

    assert.deepEqual(outcome, {
      processed: true,
      jobId: job.id,
      outcome: 'applied',
      revisionId: 'worker-rollback-1',
    });
    assert.deepEqual(
      await runConfigurationWorkerOnce({
        database,
        workerId: randomUUID(),
        executor: executorFor(appliedResult()),
        now: NOW,
      }),
      { processed: false },
    );
  });
});
