import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { hashPassword } from '@voidfall/authentication';
import type { Job } from '@voidfall/contracts';
import { createRepositories, runMigrations } from '../src/index.js';
import { createPGliteTestDatabase } from '../src/testing.js';

describe('PostgreSQL foundation', () => {
  it('applies immutable migrations and seeds deny-by-default RBAC', async () => {
    const database = await createPGliteTestDatabase();
    try {
      assert.deepEqual(await runMigrations(database), ['0001_foundation.sql', '0002_rbac_seed.sql']);
      assert.deepEqual(await runMigrations(database), []);
      const repositories = createRepositories(database);
      const user = await repositories.users.create({
        email: 'owner@voidfall.invalid',
        displayName: 'Owner Fixture',
        passwordHash: await hashPassword('database-test-password'),
        roles: ['owner'],
      });
      const permissions = await repositories.permissions.forUser(user.id);
      assert.equal(permissions.includes('security.manage'), true);
      assert.equal(permissions.includes('server.control.force'), true);
    } finally {
      await database.close();
    }
  });

  it('deduplicates jobs, leases only once and completes a harmless no-op', async () => {
    const database = await createPGliteTestDatabase();
    try {
      await runMigrations(database);
      const repositories = createRepositories(database);
      const now = new Date('2026-08-03T12:00:00.000Z');
      const job: Job = {
        schemaVersion: 1,
        id: randomUUID(),
        type: 'system.noop',
        resource: { type: 'diagnostic', id: 'phase-2-gate' },
        status: 'queued',
        stage: 'queued',
        priority: 10,
        payload: { schemaVersion: 1, parameters: { message: 'safe' } },
        idempotencyKey: 'phase2:noop:0001',
        requestedBy: { type: 'system', id: 'phase-2-test' },
        correlationId: randomUUID(),
        availableAt: now.toISOString(),
        attempt: 0,
        maxAttempts: 3,
      };
      const first = await repositories.jobs.enqueue(job);
      const duplicate = await repositories.jobs.enqueue({ ...job, id: randomUUID() });
      assert.equal(duplicate.id, first.id);

      const workerId = randomUUID();
      const leased = await repositories.jobs.lease({
        workerId,
        acceptedTypes: ['system.noop'],
        now,
        leaseMs: 30_000,
      });
      assert.equal(leased?.status, 'running');
      assert.equal(
        await repositories.jobs.lease({
          workerId: randomUUID(),
          acceptedTypes: ['system.noop'],
          now,
          leaseMs: 30_000,
        }),
        undefined,
      );
      assert.equal(await repositories.jobs.complete(first.id, workerId, { ok: true }, now), true);
      assert.equal((await repositories.jobs.findById(first.id))?.status, 'succeeded');
    } finally {
      await database.close();
    }
  });
});
