import assert from 'node:assert/strict';
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';
import {
  backupManifestSha256,
  BackupOperationError,
  FilesystemBackupService,
  parseBackupManifest,
  type BackupConsistencyLease,
  type BackupFileCopier,
  type CreateBackupPlan,
  type OfflineExclusiveBackupGuard,
} from '../src/index.js';

const acquiredAt = '2026-08-03T12:00:00.000Z';
const operationTime = '2026-08-03T12:05:00.000Z';

class TrackingOfflineGuard implements OfflineExclusiveBackupGuard {
  active = false;
  calls = 0;

  async runWithExclusiveOfflineAccess<T>(
    operation: (lease: BackupConsistencyLease) => Promise<T>,
  ): Promise<T> {
    this.calls += 1;
    assert.equal(this.active, false);
    this.active = true;
    try {
      return await operation({ method: 'offline-exclusive-v1', acquiredAt });
    } finally {
      this.active = false;
    }
  }
}

class GuardAwareCopier implements BackupFileCopier {
  constructor(
    private readonly guard: TrackingOfflineGuard,
    private readonly repositoryRoot: string,
  ) {}

  async copyFile(source: string, destination: string): Promise<void> {
    if (!resolve(source).startsWith(resolve(this.repositoryRoot))) {
      assert.equal(this.guard.active, true);
    }
    await copyFile(source, destination);
  }
}

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly world: string;
  readonly configuration: string;
  readonly restoreRoot: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'voidfall-backup-fixture-'));
  const repository = join(root, 'repository');
  const world = join(root, 'source-world');
  const configuration = join(root, 'source-configuration');
  const restoreRoot = join(root, 'isolated-restores');
  await Promise.all([
    mkdir(repository),
    mkdir(join(world, 'region'), { recursive: true }),
    mkdir(configuration),
    mkdir(restoreRoot),
  ]);
  await Promise.all([
    writeFile(join(world, 'level.dat'), 'level-v1', 'utf8'),
    writeFile(join(world, 'region', 'r.0.0.mca'), Buffer.from([0, 1, 2, 3, 255])),
    writeFile(join(configuration, 'servidor.json'), '{"mensagem":"Olá VoidFall"}', 'utf8'),
  ]);
  return { root, repository, world, configuration, restoreRoot };
}

function createPlan(fixture: Fixture, backupId = 'backup-0001'): CreateBackupPlan {
  return {
    backupId,
    serverInstanceId: 'voidfall-primary',
    serverRelease: '1.20.1-forge-47.4.4',
    retentionPolicyId: 'manual-reviewed',
    scope: 'complete',
    sources: [
      { logicalName: 'world', path: fixture.world },
      { logicalName: 'server-config', path: fixture.configuration },
    ],
  };
}

function createService(
  fixture: Fixture,
  guard: OfflineExclusiveBackupGuard = new TrackingOfflineGuard(),
  fileCopier?: BackupFileCopier,
): FilesystemBackupService {
  return new FilesystemBackupService({
    repositoryRoot: fixture.repository,
    guard,
    limits: { minimumFreeBytesAfterCopy: 0 },
    clock: () => new Date(operationTime),
    ...(fileCopier === undefined ? {} : { fileCopier }),
  });
}

function rejectsWithCode(code: BackupOperationError['code']) {
  return (error: unknown): boolean =>
    error instanceof BackupOperationError && error.code === code;
}

async function removeFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

describe('filesystem backup and isolated restore', () => {
  it('creates a guarded canonical snapshot and restores it into a new directory', async () => {
    const fixture = await createFixture();
    try {
      const guard = new TrackingOfflineGuard();
      const service = createService(
        fixture,
        guard,
        new GuardAwareCopier(guard, fixture.repository),
      );
      const backup = await service.createBackup(createPlan(fixture));
      const snapshot = join(fixture.repository, 'snapshots', backup.backupId);
      const serializedManifest = await readFile(join(snapshot, 'manifest.json'), 'utf8');
      const manifest = parseBackupManifest(serializedManifest);

      assert.equal(guard.calls, 1);
      assert.equal(guard.active, false);
      assert.equal(backup.consistencyMethod, 'offline-exclusive-v1');
      assert.equal(backup.manifestSha256, backupManifestSha256(manifest));
      assert.deepEqual(manifest.sources, [
        { logicalName: 'server-config' },
        { logicalName: 'world' },
      ]);
      assert.deepEqual(
        manifest.entries.map((entry) => entry.path),
        [...manifest.entries.map((entry) => entry.path)].sort(),
      );
      assert.equal(manifest.totals.files, 3);
      assert.equal(manifest.totals.directories, 3);
      assert.equal(serializedManifest.includes(fixture.root), false);
      assert.equal(serializedManifest.includes('Servidor/workspace'), false);
      assert.equal(serializedManifest.includes('Launcher/workspace'), false);
      assert.equal(JSON.stringify(backup).includes(fixture.root), false);
      assert.equal(Object.isFrozen(backup), true);
      assert.equal(Object.isFrozen(backup.totals), true);

      await writeFile(join(fixture.world, 'level.dat'), 'mutated-after-backup', 'utf8');
      const restoreService = createService(fixture);
      const restored = await restoreService.restoreBackup({
        backupId: backup.backupId,
        isolatedParentRoot: fixture.restoreRoot,
        targetName: 'restore-check',
      });

      assert.equal(
        await readFile(join(fixture.restoreRoot, 'restore-check', 'world', 'level.dat'), 'utf8'),
        'level-v1',
      );
      assert.equal(
        await readFile(
          join(fixture.restoreRoot, 'restore-check', 'server-config', 'servidor.json'),
          'utf8',
        ),
        '{"mensagem":"Olá VoidFall"}',
      );
      assert.equal(restored.manifestSha256, backup.manifestSha256);
      assert.equal(restored.restoredAt, operationTime);
      assert.equal(JSON.stringify(restored).includes(fixture.root), false);
      assert.equal(Object.isFrozen(restored), true);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('requires the offline guard and creates no staging when consistency is unavailable', async () => {
    const fixture = await createFixture();
    try {
      const guard: OfflineExclusiveBackupGuard = {
        runWithExclusiveOfflineAccess: async () => {
          throw new Error(`private path: ${fixture.world}`);
        },
      };
      const service = createService(fixture, guard);
      await assert.rejects(service.createBackup(createPlan(fixture)), (error: unknown) => {
        assert.equal(error instanceof BackupOperationError, true);
        assert.equal(error instanceof Error && error.message.includes(fixture.world), false);
        return rejectsWithCode('consistency-unavailable')(error);
      });
      assert.deepEqual(await readdir(fixture.repository), []);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('never overwrites an existing snapshot or isolated restore target', async () => {
    const fixture = await createFixture();
    try {
      const service = createService(fixture);
      const plan = createPlan(fixture);
      await service.createBackup(plan);
      const manifestPath = join(fixture.repository, 'snapshots', plan.backupId, 'manifest.json');
      const originalManifest = await readFile(manifestPath, 'utf8');

      await assert.rejects(service.createBackup(plan), rejectsWithCode('destination-conflict'));
      assert.equal(await readFile(manifestPath, 'utf8'), originalManifest);

      const existingTarget = join(fixture.restoreRoot, 'restore-check');
      await mkdir(existingTarget);
      await writeFile(join(existingTarget, 'sentinel.txt'), 'preserve-me', 'utf8');
      await assert.rejects(
        service.restoreBackup({
          backupId: plan.backupId,
          isolatedParentRoot: fixture.restoreRoot,
          targetName: 'restore-check',
        }),
        rejectsWithCode('destination-conflict'),
      );
      assert.equal(await readFile(join(existingTarget, 'sentinel.txt'), 'utf8'), 'preserve-me');
    } finally {
      await removeFixture(fixture);
    }
  });

  it('rejects tampered payloads and manifests before creating a restore target', async () => {
    const fixture = await createFixture();
    try {
      const service = createService(fixture);
      await service.createBackup(createPlan(fixture, 'backup-0002'));
      const snapshot = join(fixture.repository, 'snapshots', 'backup-0002');
      await writeFile(join(snapshot, 'payload', 'world', 'level.dat'), 'tampered', 'utf8');
      await assert.rejects(
        service.restoreBackup({
          backupId: 'backup-0002',
          isolatedParentRoot: fixture.restoreRoot,
          targetName: 'tampered-payload',
        }),
        rejectsWithCode('integrity-mismatch'),
      );

      await service.createBackup(createPlan(fixture, 'backup-0003'));
      const manifestPath = join(
        fixture.repository,
        'snapshots',
        'backup-0003',
        'manifest.json',
      );
      const manifestValue = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        entries: Array<{ path: string }>;
      };
      assert.ok(manifestValue.entries[0]);
      manifestValue.entries[0].path = '../escape';
      await writeFile(manifestPath, JSON.stringify(manifestValue), 'utf8');
      await assert.rejects(
        service.restoreBackup({
          backupId: 'backup-0003',
          isolatedParentRoot: fixture.restoreRoot,
          targetName: 'tampered-manifest',
        }),
        rejectsWithCode('integrity-mismatch'),
      );

      await service.createBackup(createPlan(fixture, 'backup-0016'));
      const caseManifestPath = join(
        fixture.repository,
        'snapshots',
        'backup-0016',
        'manifest.json',
      );
      const caseManifest = JSON.parse(await readFile(caseManifestPath, 'utf8')) as {
        entries: Array<{ path: string; type: string; sizeBytes?: number; sha256?: string }>;
        totals: { files: number; directories: number; bytes: number };
      };
      const fileEntry = caseManifest.entries.find(
        (entry) => entry.type === 'file' && entry.path === 'server-config/servidor.json',
      );
      assert.ok(fileEntry);
      caseManifest.entries.push({
        ...fileEntry,
        path: 'server-config/SERVIDOR.JSON',
      });
      caseManifest.entries.sort((left, right) => left.path.localeCompare(right.path));
      caseManifest.totals.files += 1;
      caseManifest.totals.bytes += fileEntry.sizeBytes ?? 0;
      await writeFile(caseManifestPath, JSON.stringify(caseManifest), 'utf8');
      await assert.rejects(
        service.restoreBackup({
          backupId: 'backup-0016',
          isolatedParentRoot: fixture.restoreRoot,
          targetName: 'case-collision',
        }),
        rejectsWithCode('integrity-mismatch'),
      );
      assert.deepEqual(await readdir(fixture.restoreRoot), []);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('rejects symlinks, junctions and hardlinks without publishing a snapshot', async () => {
    const fixture = await createFixture();
    try {
      const service = createService(fixture);
      const outside = join(fixture.root, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'secret.txt'), 'not-for-backup', 'utf8');
      const linkedDirectory = join(fixture.world, 'linked-directory');
      await symlink(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(
        service.createBackup(createPlan(fixture, 'backup-0004')),
        rejectsWithCode('unsupported-entry'),
      );
      await unlink(linkedDirectory);

      await link(join(fixture.world, 'level.dat'), join(fixture.world, 'level-hardlink.dat'));
      await assert.rejects(
        service.createBackup(createPlan(fixture, 'backup-0005')),
        rejectsWithCode('unsupported-entry'),
      );
      assert.deepEqual(await readdir(join(fixture.repository, 'snapshots')), []);
    } finally {
      await removeFixture(fixture);
    }
  });

  it(
    'rejects special Unix socket entries',
    { skip: process.platform === 'win32' },
    async () => {
      const fixture = await createFixture();
      const socketPath = join(fixture.world, 'unexpected.sock');
      const server = createServer();
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          server.once('error', rejectListen);
          server.listen(socketPath, resolveListen);
        });
        await assert.rejects(
          createService(fixture).createBackup(createPlan(fixture, 'backup-0015')),
          rejectsWithCode('unsupported-entry'),
        );
      } finally {
        if (server.listening) {
          await new Promise<void>((resolveClose, rejectClose) =>
            server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
          );
        }
        await removeFixture(fixture);
      }
    },
  );

  it('rejects overlapping sources, logical-name collisions and unsafe identifiers', async () => {
    const fixture = await createFixture();
    try {
      const service = createService(fixture);
      await assert.rejects(
        service.createBackup({
          ...createPlan(fixture, 'backup-0006'),
          sources: [
            { logicalName: 'world', path: fixture.world },
            { logicalName: 'region', path: join(fixture.world, 'region') },
          ],
        }),
        rejectsWithCode('unsafe-path'),
      );
      await assert.rejects(
        service.createBackup({
          ...createPlan(fixture, 'backup-0007'),
          sources: [
            { logicalName: 'world', path: fixture.world },
            { logicalName: 'world', path: fixture.configuration },
          ],
        }),
        rejectsWithCode('invalid-plan'),
      );
      await assert.rejects(
        service.createBackup(createPlan(fixture, '../escape')),
        rejectsWithCode('invalid-plan'),
      );
    } finally {
      await removeFixture(fixture);
    }
  });

  it('applies size limits before staging and cleans a private partial after copy failure', async () => {
    const fixture = await createFixture();
    try {
      const limitedService = new FilesystemBackupService({
        repositoryRoot: fixture.repository,
        guard: new TrackingOfflineGuard(),
        limits: {
          maximumFileBytes: 3,
          maximumTotalBytes: 100,
          minimumFreeBytesAfterCopy: 0,
        },
      });
      await assert.rejects(
        limitedService.createBackup(createPlan(fixture, 'backup-0008')),
        rejectsWithCode('limit-exceeded'),
      );

      const totalLimitedService = new FilesystemBackupService({
        repositoryRoot: fixture.repository,
        guard: new TrackingOfflineGuard(),
        limits: {
          maximumFileBytes: 40,
          maximumTotalBytes: 40,
          minimumFreeBytesAfterCopy: 0,
        },
      });
      await assert.rejects(
        totalLimitedService.createBackup(createPlan(fixture, 'backup-0012')),
        rejectsWithCode('limit-exceeded'),
      );

      const depthLimitedService = new FilesystemBackupService({
        repositoryRoot: fixture.repository,
        guard: new TrackingOfflineGuard(),
        limits: { maximumDepth: 1, minimumFreeBytesAfterCopy: 0 },
      });
      await assert.rejects(
        depthLimitedService.createBackup(createPlan(fixture, 'backup-0013')),
        rejectsWithCode('limit-exceeded'),
      );

      const countLimitedService = new FilesystemBackupService({
        repositoryRoot: fixture.repository,
        guard: new TrackingOfflineGuard(),
        limits: { maximumFiles: 1, minimumFreeBytesAfterCopy: 0 },
      });
      await assert.rejects(
        countLimitedService.createBackup(createPlan(fixture, 'backup-0017')),
        rejectsWithCode('limit-exceeded'),
      );

      const spaceLimitedService = new FilesystemBackupService({
        repositoryRoot: fixture.repository,
        guard: new TrackingOfflineGuard(),
        limits: { minimumFreeBytesAfterCopy: Number.MAX_SAFE_INTEGER },
      });
      await assert.rejects(
        spaceLimitedService.createBackup(createPlan(fixture, 'backup-0014')),
        rejectsWithCode('insufficient-space'),
      );

      let copies = 0;
      const failingCopier: BackupFileCopier = {
        copyFile: async (source, destination) => {
          copies += 1;
          if (copies === 2) throw new Error('injected private copy failure');
          await copyFile(source, destination);
        },
      };
      const failingService = createService(
        fixture,
        new TrackingOfflineGuard(),
        failingCopier,
      );
      await assert.rejects(
        failingService.createBackup(createPlan(fixture, 'backup-0009')),
        rejectsWithCode('filesystem-failure'),
      );
      assert.deepEqual(await readdir(join(fixture.repository, 'staging')), []);
      assert.deepEqual(await readdir(join(fixture.repository, 'snapshots')), []);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('detects corruption introduced during restore and removes only its partial target', async () => {
    const fixture = await createFixture();
    try {
      await createService(fixture).createBackup(createPlan(fixture, 'backup-0010'));
      let corrupted = false;
      const corruptingCopier: BackupFileCopier = {
        copyFile: async (source, destination) => {
          await copyFile(source, destination);
          if (!corrupted) {
            corrupted = true;
            await appendFile(destination, 'corruption', 'utf8');
          }
        },
      };
      const restoreService = createService(
        fixture,
        new TrackingOfflineGuard(),
        corruptingCopier,
      );
      await assert.rejects(
        restoreService.restoreBackup({
          backupId: 'backup-0010',
          isolatedParentRoot: fixture.restoreRoot,
          targetName: 'corrupt-copy',
        }),
        rejectsWithCode('integrity-mismatch'),
      );
      assert.deepEqual(await readdir(fixture.restoreRoot), []);
    } finally {
      await removeFixture(fixture);
    }
  });

  it('rejects invalid clocks without exposing internal configuration', async () => {
    const fixture = await createFixture();
    try {
      const service = new FilesystemBackupService({
        repositoryRoot: fixture.repository,
        guard: new TrackingOfflineGuard(),
        limits: { minimumFreeBytesAfterCopy: 0 },
        clock: () => new Date(Number.NaN),
      });
      await assert.rejects(service.createBackup(createPlan(fixture, 'backup-0011')), (error) => {
        assert.equal(JSON.stringify(error).includes(fixture.root), false);
        return rejectsWithCode('invalid-plan')(error);
      });
    } finally {
      await removeFixture(fixture);
    }
  });
});
