import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { createRepositories, runMigrations, type Database, type Repositories } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type {
  MinecraftProcessAdapter,
  ProcessObservation,
  ProcessLaunchPlan,
} from '@voidfall/minecraft-process';

import {
  OfflineGuardError,
  createOfflineExclusiveBackupGuard,
  createOfflineExclusiveConfigurationGuard,
  createOfflineExclusiveDatapackLoadOrderGuard,
} from '../src/offline-guards.js';

/**
 * The guards that make `offline-exclusive-v1` an assertion.
 *
 * No Minecraft process is started anywhere here: the adapter is scripted, which
 * is the point — what is under test is what the guard refuses, and a real
 * process would make the refusals hard to arrange and impossible to trust.
 */

const NOW = new Date('2026-08-05T02:00:00.000Z');
const LOCK_NAME = 'minecraft-exclusive';

const databases: Database[] = [];

afterEach(async () => {
  while (databases.length > 0) await databases.pop()?.close();
});

/** Answers `inspect` from a script, so a start mid-operation is arrangeable. */
class ScriptedAdapter implements MinecraftProcessAdapter {
  #states: ProcessObservation['state'][];
  public inspections = 0;

  public constructor(states: readonly ProcessObservation['state'][]) {
    this.#states = [...states];
  }

  async inspect(): Promise<ProcessObservation> {
    this.inspections += 1;
    const state = this.#states.length > 1 ? (this.#states.shift() as ProcessObservation['state']) : (this.#states[0] as ProcessObservation['state']);
    return { state, observedAt: NOW.toISOString(), source: 'process-adapter' };
  }

  async start(_plan: ProcessLaunchPlan): Promise<ProcessObservation> {
    throw new Error('The guard must never start anything.');
  }

  async requestGracefulStop(): Promise<ProcessObservation> {
    throw new Error('The guard must never stop anything.');
  }

  readOutput(): never {
    throw new Error('The guard must never read output.');
  }
}

async function fixture(): Promise<{
  readonly repositories: Repositories;
  readonly serverId: string;
  readonly agentId: string;
}> {
  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  databases.push(database);
  const repositories = createRepositories(database);
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'voidfall-guard-test',
    displayName: 'VoidFall Guard Test',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '1.20.1-47.4.4',
    maxPlayers: 20,
  });
  return { repositories, serverId: server.id, agentId: randomUUID() };
}

async function holdLock(
  context: Awaited<ReturnType<typeof fixture>>,
  overrides: { readonly ownerId?: string; readonly expiresAt?: Date; readonly operation?: string } = {},
): Promise<void> {
  await context.repositories.operationalLocks.acquire({
    serverInstanceId: context.serverId,
    lockName: LOCK_NAME,
    ownerId: overrides.ownerId ?? context.agentId,
    operation: overrides.operation ?? 'backup.create',
    acquiredAt: NOW.toISOString(),
    leaseExpiresAt: (overrides.expiresAt ?? new Date(NOW.getTime() + 3_600_000)).toISOString(),
  });
}

function backupGuard(
  context: Awaited<ReturnType<typeof fixture>>,
  adapter: MinecraftProcessAdapter,
) {
  return createOfflineExclusiveBackupGuard({
    repositories: context.repositories,
    adapter,
    serverInstanceId: context.serverId,
    ownsLock: (lease) => lease.ownerId === context.agentId,
    clock: () => NOW,
  });
}

describe('the offline-exclusive guard', () => {
  it('opens the window and hands back what the operation produced', async () => {
    const context = await fixture();
    await holdLock(context);
    const adapter = new ScriptedAdapter(['offline']);

    const leases: unknown[] = [];
    const value = await backupGuard(context, adapter).runWithExclusiveOfflineAccess(async (lease) => {
      leases.push(lease);
      return 'copied';
    });

    assert.equal(value, 'copied');
    assert.deepEqual(leases, [{ method: 'offline-exclusive-v1', acquiredAt: NOW.toISOString() }]);
    // Checked before the work and again after it, not once and hoped.
    assert.equal(adapter.inspections, 2);
  });

  it('refuses when nothing holds the exclusive lock', async () => {
    const context = await fixture();
    // Offline, but unheld. Being offline at one instant means nothing on its
    // own: without the lock an operator's start can land mid-copy.
    const adapter = new ScriptedAdapter(['offline']);
    await assert.rejects(
      backupGuard(context, adapter).runWithExclusiveOfflineAccess(async () => 'copied'),
      (error: unknown) =>
        error instanceof OfflineGuardError && error.reason === 'exclusive-lock-not-held',
    );
    // Refused before the adapter was even consulted, and before any work ran.
    assert.equal(adapter.inspections, 0);
  });

  it('refuses a lock held by somebody else', async () => {
    const context = await fixture();
    await holdLock(context, { ownerId: randomUUID() });
    await assert.rejects(
      backupGuard(context, new ScriptedAdapter(['offline'])).runWithExclusiveOfflineAccess(
        async () => 'copied',
      ),
      (error: unknown) =>
        error instanceof OfflineGuardError && error.reason === 'exclusive-lock-not-held',
    );
  });

  it('refuses a lock whose lease has lapsed since it was taken', async () => {
    const context = await fixture();
    await holdLock(context, { expiresAt: new Date(NOW.getTime() + 60_000) });
    // An hour later the lease is long gone. A row still saying we hold it is
    // not the same as holding it, and acting on the difference is how two
    // processes end up in the same window.
    const guard = createOfflineExclusiveBackupGuard({
      repositories: context.repositories,
      adapter: new ScriptedAdapter(['offline']),
      serverInstanceId: context.serverId,
      ownsLock: (lease) => lease.ownerId === context.agentId,
      clock: () => new Date(NOW.getTime() + 3_600_000),
    });
    await assert.rejects(
      guard.runWithExclusiveOfflineAccess(async () => 'copied'),
      (error: unknown) =>
        error instanceof OfflineGuardError && error.reason === 'exclusive-lock-not-held',
    );
  });

  it('refuses while the server is still running', async () => {
    const context = await fixture();
    await holdLock(context);
    let ran = false;
    await assert.rejects(
      backupGuard(context, new ScriptedAdapter(['online'])).runWithExclusiveOfflineAccess(
        async () => {
          ran = true;
          return 'copied';
        },
      ),
      (error: unknown) => error instanceof OfflineGuardError && error.reason === 'server-not-offline',
    );
    assert.equal(ran, false);
  });

  it('catches a server that came up while the work was running', async () => {
    const context = await fixture();
    await holdLock(context);
    // Offline when the window opened, running by the time it closed. The copy
    // was taken from a world in an unknown state, and a failed backup is far
    // better than a bad one nobody knows is bad.
    const adapter = new ScriptedAdapter(['offline', 'online']);
    await assert.rejects(
      backupGuard(context, adapter).runWithExclusiveOfflineAccess(async () => 'copied'),
      (error: unknown) =>
        error instanceof OfflineGuardError && error.reason === 'server-started-during-operation',
    );
  });

  it('recognises the configuration window by what the lock was taken for', async () => {
    const context = await fixture();
    // The persistent configuration service mints an owner id of its own, so the
    // window cannot be recognised by owner the way a backup's can.
    await holdLock(context, { ownerId: randomUUID(), operation: 'configuration.update' });
    const guard = createOfflineExclusiveConfigurationGuard({
      repositories: context.repositories,
      adapter: new ScriptedAdapter(['offline']),
      serverInstanceId: context.serverId,
      ownsLock: (lease) => lease.operation.startsWith('configuration.'),
      clock: () => NOW,
    });

    const leases: unknown[] = [];
    const value = await guard.runWithExclusiveOfflineAccess('openloader-advanced-options', async (lease) => {
      leases.push(lease);
      return 'written';
    });

    assert.equal(value, 'written');
    // The configuration lease carries a Date where the backup lease carries an
    // ISO string; the services validate them differently.
    assert.deepEqual(leases, [{ method: 'offline-exclusive-v1', acquiredAt: NOW }]);
  });

  it('does not let a backup window pass as a configuration one', async () => {
    const context = await fixture();
    await holdLock(context, { operation: 'backup.create' });
    const guard = createOfflineExclusiveConfigurationGuard({
      repositories: context.repositories,
      adapter: new ScriptedAdapter(['offline']),
      serverInstanceId: context.serverId,
      ownsLock: (lease) => lease.operation.startsWith('configuration.'),
      clock: () => NOW,
    });
    await assert.rejects(
      guard.runWithExclusiveOfflineAccess('openloader-advanced-options', async () => 'written'),
      (error: unknown) =>
        error instanceof OfflineGuardError && error.reason === 'exclusive-lock-not-held',
    );
  });

  it('opens a datapack observation window only for its exact durable operation', async () => {
    const context = await fixture();
    await holdLock(context, { operation: 'datapack-load-order.observe' });
    const adapter = new ScriptedAdapter(['offline']);
    const guard = createOfflineExclusiveDatapackLoadOrderGuard({
      repositories: context.repositories,
      adapter,
      serverInstanceId: context.serverId,
      ownsLock: (lease) => lease.ownerId === context.agentId &&
        lease.operation === 'datapack-load-order.observe',
      clock: () => NOW,
    });

    const leases: unknown[] = [];
    const value = await guard.runWithExclusiveOfflineAccess(async (lease) => {
      leases.push(lease);
      return 'observed';
    });

    assert.equal(value, 'observed');
    assert.deepEqual(leases, [{ method: 'offline-exclusive-v1', acquiredAt: NOW.toISOString() }]);
    assert.equal(adapter.inspections, 2);
  });

  it('does not let another operation impersonate datapack observation', async () => {
    const context = await fixture();
    await holdLock(context, { operation: 'backup.create' });
    const adapter = new ScriptedAdapter(['offline']);
    const guard = createOfflineExclusiveDatapackLoadOrderGuard({
      repositories: context.repositories,
      adapter,
      serverInstanceId: context.serverId,
      ownsLock: (lease) => lease.ownerId === context.agentId &&
        lease.operation === 'datapack-load-order.observe',
      clock: () => NOW,
    });

    await assert.rejects(
      guard.runWithExclusiveOfflineAccess(async () => 'observed'),
      (error: unknown) => error instanceof OfflineGuardError &&
        error.reason === 'exclusive-lock-not-held',
    );
    assert.equal(adapter.inspections, 0);
  });
});
