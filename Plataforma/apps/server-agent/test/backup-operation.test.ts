import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { AgentWorkLease, Job } from '@voidfall/contracts';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import {
  FilesystemBackupService,
  type BackupConsistencyLease,
  type OfflineExclusiveBackupGuard,
} from '@voidfall/server-backup';

import { createRestoreVerificationHandler } from '../src/backup-operation.js';

const NOW = new Date('2026-08-12T01:00:00.000Z');
const cleanup: Array<{ readonly database: Database; readonly root: string }> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const target = cleanup.pop();
    if (target !== undefined) {
      await target.database.close();
      await rm(target.root, { recursive: true, force: true });
    }
  }
});

class ImmediateOfflineGuard implements OfflineExclusiveBackupGuard {
  async runWithExclusiveOfflineAccess<T>(
    operation: (lease: BackupConsistencyLease) => Promise<T>,
  ): Promise<T> {
    return operation({ method: 'offline-exclusive-v1', acquiredAt: NOW.toISOString() });
  }
}

describe('isolated restore verification capability', () => {
  it('materialises the named backup and verifies that new root, never the active world', async () => {
    const root = await mkdtemp(join(tmpdir(), 'voidfall-restore-handler-'));
    const database = await createPGliteTestDatabase();
    cleanup.push({ database, root });
    await runMigrations(database);
    const repositories = createRepositories(database);
    const server = await repositories.servers.create({
      id: randomUUID(),
      slug: 'restore-verification',
      displayName: 'Restore Verification',
      environment: 'test',
      minecraftVersion: '1.20.1',
      loader: 'forge',
      loaderVersion: '47.4.4',
      maxPlayers: 1,
    });
    const world = join(root, 'active', 'world');
    const repositoryRoot = join(root, 'repository');
    const isolatedParentRoot = join(root, 'restores');
    await mkdir(world, { recursive: true });
    await mkdir(repositoryRoot, { recursive: true });
    await mkdir(isolatedParentRoot, { recursive: true });
    await writeFile(join(world, 'level.dat'), 'immutable-active-world', 'utf8');

    const backupId = 'backup-0001';
    const service = new FilesystemBackupService({
      repositoryRoot,
      guard: new ImmediateOfflineGuard(),
      sealKey: { keyId: 'test-seal', secret: Buffer.alloc(32, 7) },
      encryptionKey: { keyId: 'test-encryption', secret: Buffer.alloc(32, 9) },
      clock: () => NOW,
    });
    const receipt = await service.createBackup({
      backupId,
      serverInstanceId: server.id,
      serverRelease: '1.20.1-forge-47.4.4',
      retentionPolicyId: 'test',
      scope: 'world',
      sources: [{ logicalName: 'world', path: world }],
    });

    const jobId = randomUUID();
    const job: Job = {
      schemaVersion: 1,
      id: jobId,
      type: 'backup.verify-restore',
      resource: { type: 'server-instance', id: server.id },
      status: 'queued',
      stage: 'queued',
      priority: 60,
      payload: {
        schemaVersion: 1,
        parameters: { serverInstanceId: server.id, expectedVersion: 1 },
      },
      idempotencyKey: 'verify-restore-job-0001',
      requestedBy: { type: 'panel-user', id: randomUUID() },
      correlationId: randomUUID(),
      availableAt: NOW.toISOString(),
      attempt: 0,
      maxAttempts: 1,
    };
    await repositories.jobs.enqueue(job);
    const accepted = await repositories.operations.accept({
      operationId: randomUUID(),
      serverInstanceId: server.id,
      kind: 'backup.verify-restore',
      idempotencyKey: 'verify-restore-operation-0001',
      correlationId: job.correlationId,
      requestedBy: job.requestedBy,
      reasonCode: 'operator-rehearsal',
      backupId,
      jobId,
      now: NOW,
    });
    await repositories.backups.begin({
      backupId,
      serverInstanceId: server.id,
      scope: 'world',
      reasonCode: 'fixture',
      requestedBy: job.requestedBy,
      correlationId: job.correlationId,
      operationId: accepted.operation.operationId,
      now: NOW,
    });
    await repositories.backups.complete({
      backupId,
      sizeBytes: receipt.totals.bytes,
      fileCount: receipt.totals.files,
      manifestSha256: receipt.manifestSha256,
      sealKeyId: 'test-seal',
      encryptionKeyId: 'test-encryption',
      now: NOW,
    });

    let verifiedRoot: string | undefined;
    const handler = createRestoreVerificationHandler({
      repositories,
      backupService: service,
      serverInstanceId: server.id,
      serverRelease: '1.20.1-forge-47.4.4',
      agentId: randomUUID(),
      sources: [{ logicalName: 'world', path: world }],
      retentionPolicyId: 'test',
      sealKeyId: 'test-seal',
      encryptionKeyId: 'test-encryption',
      isolatedParentRoot,
      verifier: {
        async verify(input) {
          verifiedRoot = input.restoredRoot;
          assert.equal(
            await readFile(join(input.restoredRoot, 'world', 'level.dat'), 'utf8'),
            'immutable-active-world',
          );
          return { outcome: 'booted' };
        },
      },
      clock: () => NOW,
    });
    const lease: AgentWorkLease = {
      schemaVersion: 1,
      leaseId: randomUUID(),
      jobId,
      capability: 'backup.verify-restore',
      jobType: 'backup.verify-restore',
      correlationId: job.correlationId,
      parameters: {
        resourceType: 'server-instance',
        resourceId: server.id,
        expectedVersion: 1,
      },
      leasedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 900_000).toISOString(),
      attempt: 1,
    };

    assert.deepEqual(await handler(lease), {
      outcome: 'succeeded',
      observedLifecycle: 'offline',
    });
    assert.notEqual(verifiedRoot, undefined);
    assert.notEqual(verifiedRoot, world);
    assert.equal(await readFile(join(world, 'level.dat'), 'utf8'), 'immutable-active-world');
  });
});
