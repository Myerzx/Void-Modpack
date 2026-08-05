import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  BackupOperationError,
  FilesystemBackupService,
  type BackupConsistencyLease,
  type OfflineExclusiveBackupGuard,
} from '../src/index.js';

/**
 * The disaster-recovery rehearsal.
 *
 * This is the drill the phase asks for, run as a test so it cannot rot: lose
 * the world entirely, recover it from a sealed encrypted snapshot, and prove
 * byte-for-byte that what came back is what was lost.
 *
 * It runs against temporary directories. No real server, no real repository and
 * no Minecraft process is involved — the rehearsal proves the mechanism, not
 * that any particular deployment is configured.
 *
 * Three failure modes are rehearsed alongside the happy path, because a drill
 * that only proves the good case proves the least interesting thing:
 *
 *   1. the repository is intact but the key is gone;
 *   2. the repository was tampered with while nobody was looking;
 *   3. the destination is already occupied.
 */

const sealKey = { keyId: 'rehearsal-seal', secret: new Uint8Array(32).fill(11) };
const encryptionKey = { keyId: 'rehearsal-cipher', secret: new Uint8Array(32).fill(13) };

class OfflineGuard implements OfflineExclusiveBackupGuard {
  public stopped = false;

  async runWithExclusiveOfflineAccess<T>(
    operation: (lease: BackupConsistencyLease) => Promise<T>,
  ): Promise<T> {
    // Standing in for the exclusive offline window: the server is stopped for
    // the duration and nothing else may touch the world.
    this.stopped = true;
    try {
      return await operation({
        method: 'offline-exclusive-v1',
        acquiredAt: '2026-08-05T02:00:00.000Z',
      });
    } finally {
      this.stopped = false;
    }
  }
}

/** What the world holds before the disaster. */
const WORLD = new Map<string, string>([
  ['level.dat', 'level format 19133, seed 8675309'],
  ['region/r.0.0.mca', 'chunk data for spawn'],
  ['region/r.0.1.mca', 'chunk data north of spawn'],
  ['playerdata/uuid-1.dat', 'inventory and position'],
]);

async function writeWorld(root: string): Promise<void> {
  for (const [relativePath, content] of WORLD) {
    const target = join(root, ...relativePath.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

async function readTree(root: string): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      const child = join(directory, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child, relative);
        continue;
      }
      contents.set(relative, await readFile(child, 'utf8'));
    }
  };
  await walk(root, '');
  return contents;
}

describe('disaster recovery rehearsal', () => {
  it('loses a world entirely and recovers it byte for byte from a sealed encrypted snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'voidfall-dr-rehearsal-'));
    try {
      const repository = join(root, 'repository');
      const world = join(root, 'world');
      const recoveryArea = join(root, 'recovery');
      await Promise.all([mkdir(repository), mkdir(world), mkdir(recoveryArea)]);
      await writeWorld(world);
      const before = await readTree(world);
      assert.equal(before.size, WORLD.size);

      const guard = new OfflineGuard();
      const backup = new FilesystemBackupService({
        repositoryRoot: repository,
        guard,
        sealKey,
        encryptionKey,
        limits: { minimumFreeBytesAfterCopy: 0 },
        clock: () => new Date('2026-08-05T02:05:00.000Z'),
      });

      // --- Step 1: take the backup, with the server offline. -----------------
      const receipt = await backup.createBackup({
        backupId: 'rehearsal-0001',
        serverInstanceId: 'voidfall-primary',
        serverRelease: '1.20.1-forge-47.4.4',
        retentionPolicyId: 'rehearsal',
        scope: 'world',
        sources: [{ logicalName: 'world', path: world }],
      });
      assert.equal(receipt.consistencyMethod, 'offline-exclusive-v1');
      assert.equal(receipt.totals.files, WORLD.size);

      // --- Step 2: verify it *before* needing it. ----------------------------
      // A backup nobody has verified is a backup nobody knows they have.
      const verified = await backup.verifyBackup('rehearsal-0001');
      assert.equal(verified.manifestSha256, receipt.manifestSha256);

      // --- Step 3: the disaster. --------------------------------------------
      await rm(world, { recursive: true, force: true });
      assert.equal(
        await readdir(root).then((names) => names.includes('world')),
        false,
      );

      // --- Step 4: recover into an isolated area, never over a live path. ----
      const restored = await backup.restoreBackup({
        backupId: 'rehearsal-0001',
        isolatedParentRoot: recoveryArea,
        targetName: 'recovered',
      });
      assert.equal(restored.manifestSha256, receipt.manifestSha256);

      // --- Step 5: prove what came back is what was lost. --------------------
      const after = await readTree(join(recoveryArea, 'recovered', 'world'));
      assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rehearses the three ways a recovery fails, so none of them is a surprise', async () => {
    const root = await mkdtemp(join(tmpdir(), 'voidfall-dr-failures-'));
    try {
      const repository = join(root, 'repository');
      const world = join(root, 'world');
      const recoveryArea = join(root, 'recovery');
      await Promise.all([mkdir(repository), mkdir(world), mkdir(recoveryArea)]);
      await writeWorld(world);

      const options = {
        repositoryRoot: repository,
        guard: new OfflineGuard(),
        sealKey,
        limits: { minimumFreeBytesAfterCopy: 0 },
        clock: () => new Date('2026-08-05T02:05:00.000Z'),
      } as const;
      const backup = new FilesystemBackupService({ ...options, encryptionKey });
      await backup.createBackup({
        backupId: 'rehearsal-0001',
        serverInstanceId: 'voidfall-primary',
        serverRelease: '1.20.1-forge-47.4.4',
        retentionPolicyId: 'rehearsal',
        scope: 'world',
        sources: [{ logicalName: 'world', path: world }],
      });

      // 1. The repository survived; the key did not. This is the failure an
      //    encrypted repository makes possible, and it has to be rehearsed:
      //    the bytes are intact and completely useless.
      const withoutKey = new FilesystemBackupService(options);
      await assert.rejects(
        withoutKey.restoreBackup({
          backupId: 'rehearsal-0001',
          isolatedParentRoot: recoveryArea,
          targetName: 'no-key',
        }),
        (error: unknown) =>
          error instanceof BackupOperationError && error.code === 'integrity-mismatch',
      );

      // 2. Someone edited the repository. The seal catches it before a single
      //    byte is written to the recovery area.
      const sealPath = join(repository, 'snapshots', 'rehearsal-0001', 'seal.json');
      const seal = JSON.parse(await readFile(sealPath, 'utf8')) as Record<string, string>;
      const mac = seal['mac'] ?? '';
      seal['mac'] = `${mac.slice(0, 63)}${mac.endsWith('0') ? '1' : '0'}`;
      await writeFile(sealPath, JSON.stringify(seal), 'utf8');
      await assert.rejects(
        backup.restoreBackup({
          backupId: 'rehearsal-0001',
          isolatedParentRoot: recoveryArea,
          targetName: 'tampered',
        }),
        (error: unknown) =>
          error instanceof BackupOperationError && error.code === 'integrity-mismatch',
      );
      assert.deepEqual(await readdir(recoveryArea), []);

      // 3. The destination is occupied. A restore refuses rather than merging
      //    an old world into whatever is already sitting there.
      await mkdir(join(recoveryArea, 'occupied'));
      await assert.rejects(
        backup.restoreBackup({
          backupId: 'rehearsal-0001',
          isolatedParentRoot: recoveryArea,
          targetName: 'occupied',
        }),
        (error: unknown) => error instanceof BackupOperationError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
