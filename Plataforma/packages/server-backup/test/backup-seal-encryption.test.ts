import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  assertQuotaAllows,
  BackupOperationError,
  FilesystemBackupService,
  selectExpiredBackups,
  type BackupConsistencyLease,
  type CreateBackupPlan,
  type OfflineExclusiveBackupGuard,
  type StoredBackupSummary,
} from '../src/index.js';

/**
 * Phase 10.3: the authenticated seal, encryption at rest, quotas and retention.
 *
 * Everything runs against temporary directories. No server workspace, no
 * Minecraft installation and no real repository is touched.
 */

const acquiredAt = '2026-08-03T12:00:00.000Z';
const operationTime = '2026-08-03T12:05:00.000Z';

const sealKey = { keyId: 'test-seal', secret: new Uint8Array(32).fill(7) };
const otherSealKey = { keyId: 'other-seal', secret: new Uint8Array(32).fill(9) };
const encryptionKey = { keyId: 'test-cipher', secret: new Uint8Array(32).fill(3) };

class OfflineGuard implements OfflineExclusiveBackupGuard {
  async runWithExclusiveOfflineAccess<T>(
    operation: (lease: BackupConsistencyLease) => Promise<T>,
  ): Promise<T> {
    return operation({ method: 'offline-exclusive-v1', acquiredAt });
  }
}

const WORLD_TEXT = 'level-v1 with a secret seed 8675309';

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly world: string;
  readonly restoreRoot: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'voidfall-backup-seal-'));
  const repository = join(root, 'repository');
  const world = join(root, 'source-world');
  const restoreRoot = join(root, 'isolated-restores');
  await Promise.all([mkdir(repository), mkdir(world, { recursive: true }), mkdir(restoreRoot)]);
  await writeFile(join(world, 'level.dat'), WORLD_TEXT, 'utf8');
  return { root, repository, world, restoreRoot };
}

function plan(backupId = 'backup-0001'): Omit<CreateBackupPlan, 'sources'> {
  return {
    backupId,
    serverInstanceId: 'voidfall-primary',
    serverRelease: '1.20.1-forge-47.4.4',
    retentionPolicyId: 'manual-reviewed',
    scope: 'complete',
  };
}

function service(
  fixture: Fixture,
  options: {
    readonly seal?: typeof sealKey;
    readonly encrypt?: boolean;
    readonly quota?: { maximumBackups: number; maximumTotalBytes: number };
  } = {},
): FilesystemBackupService {
  return new FilesystemBackupService({
    repositoryRoot: fixture.repository,
    guard: new OfflineGuard(),
    sealKey: options.seal ?? sealKey,
    limits: { minimumFreeBytesAfterCopy: 0 },
    clock: () => new Date(operationTime),
    ...(options.encrypt === true ? { encryptionKey } : {}),
    ...(options.quota === undefined ? {} : { quota: options.quota }),
  });
}

function rejectsWithCode(code: BackupOperationError['code']) {
  return (error: unknown): boolean =>
    error instanceof BackupOperationError && error.code === code;
}

describe('authenticated backup seal', () => {
  it('seals a snapshot and verifies it end to end', async () => {
    const fixture = await createFixture();
    try {
      const backup = service(fixture);
      await backup.createBackup({ ...plan(), sources: [{ logicalName: 'world', path: fixture.world }] });

      const seal = JSON.parse(
        await readFile(join(fixture.repository, 'snapshots', 'backup-0001', 'seal.json'), 'utf8'),
      ) as Record<string, unknown>;
      assert.equal(seal.algorithm, 'hmac-sha256');
      assert.equal(seal.keyId, 'test-seal');
      assert.equal(seal.backupId, 'backup-0001');

      const verified = await backup.verifyBackup('backup-0001');
      assert.match(verified.manifestSha256, /^[a-f0-9]{64}$/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('refuses a manifest rewritten together with its digests', async () => {
    const fixture = await createFixture();
    try {
      const backup = service(fixture);
      await backup.createBackup({ ...plan(), sources: [{ logicalName: 'world', path: fixture.world }] });

      // The attack the seal exists for: rewrite the payload AND the manifest so
      // every SHA-256 in it is internally consistent. Without a key held outside
      // the repository, this passes every check.
      const snapshot = join(fixture.repository, 'snapshots', 'backup-0001');
      const manifestPath = join(snapshot, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        entries: Array<{ path: string; type: string; sizeBytes?: number; sha256?: string }>;
        totals: { files: number; directories: number; bytes: number };
      };
      const forged = 'level-v1 with a secret seed 0000000';
      const { createHash } = await import('node:crypto');
      await writeFile(join(snapshot, 'payload', 'world', 'level.dat'), forged, 'utf8');
      for (const entry of manifest.entries) {
        if (entry.type !== 'file') continue;
        entry.sizeBytes = Buffer.byteLength(forged, 'utf8');
        entry.sha256 = createHash('sha256').update(forged).digest('hex');
      }
      manifest.totals.bytes = Buffer.byteLength(forged, 'utf8');
      await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

      await assert.rejects(backup.verifyBackup('backup-0001'), rejectsWithCode('integrity-mismatch'));
      // And the restore refuses on the same grounds, before writing anything.
      await assert.rejects(
        backup.restoreBackup({
          backupId: 'backup-0001',
          isolatedParentRoot: fixture.restoreRoot,
          targetName: 'attempt',
        }),
        rejectsWithCode('integrity-mismatch'),
      );
      assert.deepEqual(await readdir(fixture.restoreRoot), []);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('refuses a snapshot sealed under a different key', async () => {
    const fixture = await createFixture();
    try {
      await service(fixture).createBackup({
        ...plan(),
        sources: [{ logicalName: 'world', path: fixture.world }],
      });
      await assert.rejects(
        service(fixture, { seal: otherSealKey }).verifyBackup('backup-0001'),
        rejectsWithCode('integrity-mismatch'),
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('refuses a seal lifted from another snapshot', async () => {
    const fixture = await createFixture();
    try {
      const backup = service(fixture);
      const sources = [{ logicalName: 'world', path: fixture.world }];
      await backup.createBackup({ ...plan('backup-0001'), sources });
      await backup.createBackup({ ...plan('backup-0002'), sources });

      const snapshots = join(fixture.repository, 'snapshots');
      await writeFile(
        join(snapshots, 'backup-0002', 'seal.json'),
        await readFile(join(snapshots, 'backup-0001', 'seal.json'), 'utf8'),
        'utf8',
      );
      // The backup id is bound into the MAC input, so a valid seal from one
      // snapshot is not a valid seal on another.
      await assert.rejects(backup.verifyBackup('backup-0002'), rejectsWithCode('integrity-mismatch'));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

describe('payload encryption at rest', () => {
  it('stores ciphertext and restores the original plaintext', async () => {
    const fixture = await createFixture();
    try {
      const backup = service(fixture, { encrypt: true });
      await backup.createBackup({ ...plan(), sources: [{ logicalName: 'world', path: fixture.world }] });

      const storedPath = join(fixture.repository, 'snapshots', 'backup-0001', 'payload', 'world', 'level.dat');
      const stored = await readFile(storedPath);
      // The seed is not on disk in the clear anywhere in the payload.
      assert.equal(stored.includes(Buffer.from('8675309', 'utf8')), false);
      assert.equal(stored.byteLength, Buffer.byteLength(WORLD_TEXT, 'utf8') + 12 + 16);

      const manifest = JSON.parse(
        await readFile(join(fixture.repository, 'snapshots', 'backup-0001', 'manifest.json'), 'utf8'),
      ) as { encryption: { algorithm: string; keyId: string } | null };
      assert.deepEqual(manifest.encryption, { algorithm: 'aes-256-gcm', keyId: 'test-cipher' });

      await backup.restoreBackup({
        backupId: 'backup-0001',
        isolatedParentRoot: fixture.restoreRoot,
        targetName: 'restored',
      });
      // Restoration produces plaintext, not the ciphertext it was holding.
      assert.equal(
        await readFile(join(fixture.restoreRoot, 'restored', 'world', 'level.dat'), 'utf8'),
        WORLD_TEXT,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('records "not encrypted" explicitly rather than by omission', async () => {
    const fixture = await createFixture();
    try {
      await service(fixture).createBackup({
        ...plan(),
        sources: [{ logicalName: 'world', path: fixture.world }],
      });
      const manifest = JSON.parse(
        await readFile(join(fixture.repository, 'snapshots', 'backup-0001', 'manifest.json'), 'utf8'),
      ) as Record<string, unknown>;
      assert.ok('encryption' in manifest);
      assert.equal(manifest.encryption, null);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('refuses to verify or restore an encrypted snapshot without the key', async () => {
    const fixture = await createFixture();
    try {
      await service(fixture, { encrypt: true }).createBackup({
        ...plan(),
        sources: [{ logicalName: 'world', path: fixture.world }],
      });
      const withoutKey = service(fixture);
      await assert.rejects(withoutKey.verifyBackup('backup-0001'), rejectsWithCode('integrity-mismatch'));
      await assert.rejects(
        withoutKey.restoreBackup({
          backupId: 'backup-0001',
          isolatedParentRoot: fixture.restoreRoot,
          targetName: 'attempt',
        }),
        rejectsWithCode('integrity-mismatch'),
      );
      assert.deepEqual(await readdir(fixture.restoreRoot), []);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('refuses a ciphertext altered in the repository', async () => {
    const fixture = await createFixture();
    try {
      const backup = service(fixture, { encrypt: true });
      await backup.createBackup({ ...plan(), sources: [{ logicalName: 'world', path: fixture.world }] });

      const storedPath = join(fixture.repository, 'snapshots', 'backup-0001', 'payload', 'world', 'level.dat');
      const stored = await readFile(storedPath);
      // Flip one bit of ciphertext. GCM's tag catches it on decryption, so the
      // failure happens before any altered byte becomes a restored world.
      const tampered = Buffer.from(stored);
      const target = tampered[20] ?? 0;
      tampered[20] = target ^ 0x01;
      await writeFile(storedPath, tampered);

      await assert.rejects(backup.verifyBackup('backup-0001'), rejectsWithCode('integrity-mismatch'));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

describe('quotas and retention', () => {
  const stored = (id: string, createdAt: string, sizeBytes = 10): StoredBackupSummary => ({
    backupId: id,
    createdAt,
    sizeBytes,
  });

  it('refuses a backup that would breach the quota, before it is taken', async () => {
    const fixture = await createFixture();
    try {
      const backup = service(fixture, { quota: { maximumBackups: 1, maximumTotalBytes: 1_000_000 } });
      const sources = [{ logicalName: 'world', path: fixture.world }];
      await backup.createBackup({ ...plan('backup-0001'), sources });
      await assert.rejects(
        backup.createBackup({ ...plan('backup-0002'), sources }),
        rejectsWithCode('limit-exceeded'),
      );
      // The refused backup left nothing behind — not even a staging directory.
      assert.deepEqual(await readdir(join(fixture.repository, 'snapshots')), ['backup-0001']);
      assert.deepEqual(await readdir(join(fixture.repository, 'staging')), []);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('counts bytes as well as backups', () => {
    assert.throws(
      () =>
        assertQuotaAllows({
          quota: { maximumBackups: 10, maximumTotalBytes: 100 },
          stored: [stored('a', '2026-08-01T00:00:00.000Z', 90)],
          incomingBytes: 20,
        }),
      rejectsWithCode('limit-exceeded'),
    );
    assertQuotaAllows({
      quota: { maximumBackups: 10, maximumTotalBytes: 100 },
      stored: [stored('a', '2026-08-01T00:00:00.000Z', 90)],
      incomingBytes: 10,
    });
  });

  it('keeps the newest regardless of age, and never proposes emptying the repository', () => {
    const now = new Date('2026-08-05T00:00:00.000Z');
    const policy = { policyId: 'p', keepLatest: 2, maximumAgeDays: 7 };
    const backups = [
      stored('old-1', '2026-01-01T00:00:00.000Z'),
      stored('old-2', '2026-02-01T00:00:00.000Z'),
      stored('old-3', '2026-03-01T00:00:00.000Z'),
    ];
    // Every backup is older than the age limit, but the two newest are kept
    // anyway: a retention rule that could empty a repository turns a
    // misconfiguration into total data loss.
    const expired = selectExpiredBackups({ policy, stored: backups, now });
    assert.deepEqual(
      expired.map((backup) => backup.backupId),
      ['old-1'],
    );
  });

  it('keeps anything inside the age window even beyond keepLatest', () => {
    const now = new Date('2026-08-05T00:00:00.000Z');
    const policy = { policyId: 'p', keepLatest: 1, maximumAgeDays: 30 };
    const expired = selectExpiredBackups({
      policy,
      stored: [
        stored('recent-1', '2026-08-04T00:00:00.000Z'),
        stored('recent-2', '2026-08-03T00:00:00.000Z'),
        stored('ancient', '2025-01-01T00:00:00.000Z'),
      ],
      now,
    });
    assert.deepEqual(
      expired.map((backup) => backup.backupId),
      ['ancient'],
    );
  });

  it('refuses a policy that would keep nothing', () => {
    assert.throws(
      () =>
        selectExpiredBackups({
          policy: { policyId: 'p', keepLatest: 0, maximumAgeDays: 1 },
          stored: [],
          now: new Date(operationTime),
        }),
      rejectsWithCode('invalid-plan'),
    );
  });

  it('prunes only what retention released, holding the lock while it does', async () => {
    const fixture = await createFixture();
    try {
      const backup = new FilesystemBackupService({
        repositoryRoot: fixture.repository,
        guard: new OfflineGuard(),
        sealKey,
        limits: { minimumFreeBytesAfterCopy: 0 },
        clock: () => new Date('2026-08-03T12:05:00.000Z'),
        retentionPolicy: { policyId: 'p', keepLatest: 1, maximumAgeDays: 1 },
      });
      const sources = [{ logicalName: 'world', path: fixture.world }];
      await backup.createBackup({ ...plan('backup-0001'), sources });
      await backup.createBackup({ ...plan('backup-0002'), sources });

      // Both were written at the pinned clock, so neither is past the age
      // window and nothing is released yet.
      assert.deepEqual(await backup.pruneExpiredBackups(), []);

      const later = new FilesystemBackupService({
        repositoryRoot: fixture.repository,
        guard: new OfflineGuard(),
        sealKey,
        limits: { minimumFreeBytesAfterCopy: 0 },
        clock: () => new Date('2026-09-03T12:05:00.000Z'),
        retentionPolicy: { policyId: 'p', keepLatest: 1, maximumAgeDays: 1 },
      });
      const removed = await later.pruneExpiredBackups();
      assert.equal(removed.length, 1);
      const surviving = await later.listBackups();
      assert.equal(surviving.length, 1);
      // What survived still verifies: pruning did not disturb it.
      await later.verifyBackup(surviving[0]?.backupId ?? '');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
