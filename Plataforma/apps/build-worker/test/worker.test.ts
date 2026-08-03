import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import type { Job } from '@voidfall/contracts';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import { runNoopWorkerOnce } from '../src/worker.js';

const databases: Database[] = [];

afterEach(async () => {
  while (databases.length > 0) await databases.pop()?.close();
});

function queuedJob(type: Job['type'], now: Date): Job {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    type,
    resource: { type: 'system', id: 'phase-2-fixture' },
    status: 'queued',
    stage: 'queued',
    priority: 50,
    payload: { schemaVersion: 1, parameters: {} },
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
