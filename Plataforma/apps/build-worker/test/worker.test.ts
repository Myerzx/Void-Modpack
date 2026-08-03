import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import type { Job } from '@voidfall/contracts';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import { runModpackBuildWorkerOnce, runNoopWorkerOnce } from '../src/worker.js';

const databases: Database[] = [];

afterEach(async () => {
  while (databases.length > 0) await databases.pop()?.close();
});

function queuedJob(
  type: Job['type'],
  now: Date,
  parameters: Job['payload']['parameters'] = {},
): Job {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    type,
    resource: { type: 'system', id: 'phase-2-fixture' },
    status: 'queued',
    stage: 'queued',
    priority: 50,
    payload: { schemaVersion: 1, parameters },
    idempotencyKey: `phase-2:${randomUUID()}`,
    requestedBy: { type: 'system', id: 'test-suite' },
    correlationId: randomUUID(),
    availableAt: now.toISOString(),
    attempt: 0,
    maxAttempts: 3,
  };
}

describe('Phase 2 no-op worker', () => {
  it('leases, records and completes only a system.noop job', async () => {
    const database = await createPGliteTestDatabase();
    databases.push(database);
    await runMigrations(database);
    const repositories = createRepositories(database);
    const now = new Date('2026-08-03T12:00:00.000Z');
    const noop = await repositories.jobs.enqueue(queuedJob('system.noop', now));
    const operational = await repositories.jobs.enqueue(queuedJob('server.start', now));
    const workerId = randomUUID();

    assert.deepEqual(await runNoopWorkerOnce({ database, workerId, now }), {
      processed: true,
      jobId: noop.id,
    });
    assert.equal((await repositories.jobs.findById(noop.id))?.status, 'succeeded');
    assert.equal((await repositories.jobs.findById(operational.id))?.status, 'queued');
    assert.deepEqual(await runNoopWorkerOnce({ database, workerId, now }), { processed: false });

    const events = await database.query<{ sequence: number; stage: string }>(
      'SELECT sequence, stage FROM job_events WHERE job_id = $1 ORDER BY sequence',
      [noop.id],
    );
    assert.deepEqual(events.rows, [
      { sequence: 1, stage: 'noop-execution' },
      { sequence: 2, stage: 'completed' },
    ]);
  });
});

describe('Phase 5 isolated modpack build worker', () => {
  it('passes only a validated opaque plan ID and stores a sanitized candidate result', async () => {
    const database = await createPGliteTestDatabase();
    databases.push(database);
    await runMigrations(database);
    const repositories = createRepositories(database);
    const now = new Date('2026-08-03T17:00:00.000Z');
    const job = await repositories.jobs.enqueue(
      queuedJob('modpack.build', now, { planId: 'release-plan-20260803' }),
    );
    const observed: string[] = [];
    const result = await runModpackBuildWorkerOnce({
      database,
      workerId: randomUUID(),
      now,
      executor: {
        execute: async (planId) => {
          observed.push(planId);
          return {
            version: '1.0.0',
            buildId: 'build-20260803-170000-worker',
            manifestSha256: 'a'.repeat(64),
            files: 2,
            bytes: 1_024,
            stableEligible: false,
          };
        },
      },
    });
    assert.deepEqual(result, { processed: true, jobId: job.id, outcome: 'candidate' });
    assert.deepEqual(observed, ['release-plan-20260803']);
    const stored = await repositories.jobs.findById(job.id);
    assert.equal(stored?.status, 'succeeded');
    assert.deepEqual(stored?.result, {
      version: '1.0.0',
      buildId: 'build-20260803-170000-worker',
      manifestSha256: 'a'.repeat(64),
      files: 2,
      bytes: 1_024,
      stableEligible: false,
    });
  });

  it('fails closed for payload injection without invoking the executor', async () => {
    const database = await createPGliteTestDatabase();
    databases.push(database);
    await runMigrations(database);
    const repositories = createRepositories(database);
    const now = new Date('2026-08-03T17:00:00.000Z');
    const job = await repositories.jobs.enqueue(
      queuedJob('modpack.build', now, { planId: 'safe-plan', sourceRoot: 'C:\\private' }),
    );
    let invoked = false;
    const result = await runModpackBuildWorkerOnce({
      database,
      workerId: randomUUID(),
      now,
      executor: {
        execute: async () => {
          invoked = true;
          throw new Error('must not execute');
        },
      },
    });
    assert.equal(invoked, false);
    assert.deepEqual(result, { processed: true, jobId: job.id, outcome: 'failed' });
    const stored = await repositories.jobs.findById(job.id);
    assert.equal(stored?.status, 'failed');
    assert.equal(stored?.error?.code, 'BUILD_PAYLOAD_INVALID');
  });

  it('records executor failures without exposing the thrown message', async () => {
    const database = await createPGliteTestDatabase();
    databases.push(database);
    await runMigrations(database);
    const repositories = createRepositories(database);
    const now = new Date('2026-08-03T17:00:00.000Z');
    const job = await repositories.jobs.enqueue(
      queuedJob('modpack.build', now, { planId: 'release-plan-20260803' }),
    );
    await runModpackBuildWorkerOnce({
      database,
      workerId: randomUUID(),
      now,
      executor: { execute: async () => { throw new Error('C:\\secret\\release-key.pem'); } },
    });
    const stored = await repositories.jobs.findById(job.id);
    assert.equal(stored?.error?.code, 'BUILD_EXECUTION_FAILED');
    assert.equal(JSON.stringify(stored).includes('release-key.pem'), false);
  });
});
