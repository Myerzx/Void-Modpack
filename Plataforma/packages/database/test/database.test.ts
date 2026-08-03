import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { hashPassword } from '@voidfall/authentication';
import type { AuditEvent, Job } from '@voidfall/contracts';
import { createRepositories, runMigrations } from '../src/index.js';
import { createPGliteTestDatabase } from '../src/testing.js';

describe('PostgreSQL foundation', () => {
  it('applies immutable migrations and seeds deny-by-default RBAC', async () => {
    const database = await createPGliteTestDatabase();
    try {
      assert.deepEqual(await runMigrations(database), [
        '0001_foundation.sql',
        '0002_rbac_seed.sql',
        '0003_audit_chain.sql',
      ]);
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

  it('chains administrative audit events transactionally and exports a verified range', async () => {
    const database = await createPGliteTestDatabase();
    try {
      await runMigrations(database);
      const repositories = createRepositories(database);
      const correlationId = randomUUID();
      const baseEvent: AuditEvent = {
        schemaVersion: 1,
        id: randomUUID(),
        occurredAt: '2026-08-03T12:00:00.000Z',
        correlationId,
        actor: { type: 'system', id: 'database-test' },
        source: 'system',
        action: 'player.profile.observed',
        resource: { type: 'player', id: randomUUID() },
        outcome: 'succeeded',
        metadata: { revision: 1 },
      };
      const first = await repositories.audit.append(baseEvent);
      const [second, third] = await Promise.all([
        repositories.audit.append({
          ...baseEvent,
          id: randomUUID(),
          occurredAt: '2026-08-03T12:01:00.000Z',
          action: 'player.profile.updated',
          metadata: { revision: 2 },
        }),
        repositories.audit.append({
          ...baseEvent,
          id: randomUUID(),
          occurredAt: '2026-08-03T12:01:01.000Z',
          action: 'player.permission.updated',
          metadata: { revision: 3 },
        }),
      ]);
      assert.equal(first.sequence, 1);
      assert.deepEqual([second.sequence, third.sequence].sort(), [2, 3]);
      const verification = await repositories.audit.verifyPartition('administrative');
      assert.equal(verification.valid, true);
      assert.equal(verification.recordCount, 3);
      const artifact = await repositories.audit.exportPartition('administrative', {
        exportId: randomUUID(),
        generatedAt: '2026-08-03T12:02:00.000Z',
      });
      assert.equal(artifact.manifest.recordCount, 3);
      assert.equal(artifact.content.trimEnd().split('\n').length, 3);
      const listed = await repositories.audit.list();
      assert.equal(listed.length, 3);
      assert.ok(listed.every((event) => event.integrity !== undefined));
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
