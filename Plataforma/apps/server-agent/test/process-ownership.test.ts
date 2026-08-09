import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import {
  ProcessOwnershipConflictError,
  WindowsMinecraftProcessAdapter,
  type ProcessLaunchPlan,
  type ProcessRuntime,
  type SpawnedProcess,
} from '@voidfall/minecraft-process';

import {
  DurableProcessOwnershipCoordinator,
  type ProcessLivenessProbe,
} from '../src/process-ownership.js';

const NOW = new Date('2026-08-09T00:00:00.000Z');
const cleanup: Database[] = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.close();
});

class ScriptedLiveness implements ProcessLivenessProbe {
  readonly calls: number[] = [];

  public constructor(private readonly alive: boolean) {}

  public async isAlive(pid: number): Promise<boolean> {
    this.calls.push(pid);
    return this.alive;
  }
}

async function fixture() {
  const database = await createPGliteTestDatabase();
  cleanup.push(database);
  await runMigrations(database);
  const repositories = createRepositories(database);
  const serverInstanceId = randomUUID();
  const agentId = randomUUID();
  await repositories.servers.create({
    id: serverInstanceId,
    slug: 'process-owner-test',
    displayName: 'Process Owner Test',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '47.4.4',
    maxPlayers: 20,
  });
  await database.query(
    `INSERT INTO agents (id, server_instance_id, public_key_pem, certificate_fingerprint,
       software_version, protocol_version, status)
     VALUES ($1,$2,$3,$4,$5,$6,'online')`,
    [agentId, serverInstanceId, 'pem', 'e'.repeat(64), '0.1.0', '1'],
  );
  return { repositories, serverInstanceId, agentId };
}

function coordinator(
  context: Awaited<ReturnType<typeof fixture>>,
  agentBootId: string,
  liveness: ProcessLivenessProbe,
  ownershipId = randomUUID(),
): DurableProcessOwnershipCoordinator {
  return new DurableProcessOwnershipCoordinator({
    repository: context.repositories.processOwnership,
    serverInstanceId: context.serverInstanceId,
    agentId: context.agentId,
    agentBootId,
    liveness,
    clock: () => NOW,
    newOwnershipId: () => ownershipId,
  });
}

function plan(): ProcessLaunchPlan {
  return {
    platform: 'win32',
    executable: 'C:\\Java\\bin\\java.exe',
    args: ['-jar', 'server.jar', 'nogui'],
    cwd: 'D:\\VoidFallFixture\\server',
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
}

function livingHandle(pid: number, ready: boolean): SpawnedProcess {
  return {
    pid,
    getExit: () => undefined,
    readOutput: () => ({
      stdout: ready ? 'Done (1.000s)! For help, type "help"' : 'Loading mods...',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
    requestConsoleCommand: async () => {},
    requestGracefulStop: async () => {},
    forceTerminate: async () => {},
    waitForExit: async () => undefined,
  };
}

describe('durable Minecraft process ownership', () => {
  it('keeps one JVM when the agent falls during boot', async () => {
    const context = await fixture();
    const liveness = new ScriptedLiveness(true);
    let firstSpawns = 0;
    const firstRuntime: ProcessRuntime = {
      spawn: async () => {
        firstSpawns += 1;
        return livingHandle(4_242, false);
      },
    };
    const first = new WindowsMinecraftProcessAdapter({
      runtime: firstRuntime,
      ownership: coordinator(context, randomUUID(), liveness),
    });
    assert.equal((await first.start(plan())).state, 'starting');

    let replacementSpawns = 0;
    const replacement = new WindowsMinecraftProcessAdapter({
      runtime: {
        spawn: async () => {
          replacementSpawns += 1;
          return livingHandle(8_484, false);
        },
      },
      ownership: coordinator(context, randomUUID(), liveness),
    });
    await assert.rejects(replacement.start(plan()), ProcessOwnershipConflictError);
    assert.equal(firstSpawns, 1);
    assert.equal(replacementSpawns, 0);
    assert.equal((await context.repositories.processOwnership.find(context.serverInstanceId))?.pid, 4_242);
  });

  it('marks an online JVM orphaned but never adopts or replaces it', async () => {
    const context = await fixture();
    const liveness = new ScriptedLiveness(true);
    const originalId = randomUUID();
    const original = coordinator(context, randomUUID(), liveness, originalId);
    const lease = await original.acquire();
    await lease.attachPid(4_242);

    const replacement = coordinator(context, randomUUID(), liveness);
    const reconciled = await replacement.reconcile();
    assert.equal(reconciled.kind, 'orphaned');
    await assert.rejects(replacement.acquire(), ProcessOwnershipConflictError);
    const stored = await context.repositories.processOwnership.find(context.serverInstanceId);
    assert.equal(stored?.ownershipId, originalId);
    assert.equal(stored?.status, 'orphaned');
    assert.equal(stored?.pid, 4_242);
  });

  it('fails closed when a restart boot reserved ownership but never attached a PID', async () => {
    const context = await fixture();
    const liveness = new ScriptedLiveness(true);
    const interrupted = coordinator(context, randomUUID(), liveness);
    await interrupted.acquire();

    const replacement = coordinator(context, randomUUID(), liveness);
    assert.equal((await replacement.reconcile()).kind, 'orphaned');
    await assert.rejects(replacement.acquire(), ProcessOwnershipConflictError);
    assert.deepEqual(liveness.calls, []);
    const stored = await context.repositories.processOwnership.find(context.serverInstanceId);
    assert.equal(stored?.status, 'orphaned');
    assert.equal(stored?.pid, null);
  });

  it('treats a reused live PID as uncertain instead of adopting it', async () => {
    const context = await fixture();
    const original = coordinator(context, randomUUID(), new ScriptedLiveness(true));
    const lease = await original.acquire();
    await lease.attachPid(4_242);

    // The probe cannot prove whether 4242 is still the JVM or a reused PID.
    // Its only safe answer is to retain the old generation and refuse launch.
    const reusedPid = new ScriptedLiveness(true);
    const replacement = coordinator(context, randomUUID(), reusedPid);
    await assert.rejects(replacement.acquire(), ProcessOwnershipConflictError);
    assert.deepEqual(reusedPid.calls, [4_242]);
    assert.equal(
      (await context.repositories.processOwnership.find(context.serverInstanceId))?.status,
      'orphaned',
    );
  });

  it('cleans a proven-dead owner and mints a different generation', async () => {
    const context = await fixture();
    const originalId = randomUUID();
    const original = coordinator(
      context,
      randomUUID(),
      new ScriptedLiveness(true),
      originalId,
    );
    const originalLease = await original.acquire();
    await originalLease.attachPid(4_242);

    const replacementId = randomUUID();
    const dead = new ScriptedLiveness(false);
    const replacement = coordinator(context, randomUUID(), dead, replacementId);
    const reconciled = await replacement.reconcile();
    assert.equal(reconciled.kind, 'dead-owner-cleared');
    const newLease = await replacement.acquire();
    await newLease.attachPid(8_484);

    const stored = await context.repositories.processOwnership.find(context.serverInstanceId);
    assert.equal(stored?.ownershipId, replacementId);
    assert.notEqual(stored?.ownershipId, originalId);
    assert.equal(stored?.pid, 8_484);
    assert.deepEqual(dead.calls, [4_242]);
  });
});
