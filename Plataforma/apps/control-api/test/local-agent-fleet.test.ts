import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { ServerInstance } from '@voidfall/database';

import { LocalAgentFleet } from '../src/local-agent-fleet.js';

function instance(id: string, version: number): ServerInstance {
  return {
    id,
    slug: id,
    displayName: id,
    environment: 'local',
    desiredState: 'stopped',
    observedState: 'unknown',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '47.4.4',
    maxPlayers: 20,
    version,
    runDirectory: null,
    runtime: null,
    runtimeDetectedAt: null,
  };
}

describe('local agent fleet', () => {
  it('runs every instance and replaces only the binding whose version changed', async () => {
    const firstId = randomUUID();
    const secondId = randomUUID();
    let instances = [instance(firstId, 1), instance(secondId, 1)];
    const starts = new Map<string, number>();
    const stops = new Map<string, number>();
    const fleet = new LocalAgentFleet({
      listInstances: async () => instances,
      createProcess: async (server) => ({
        description: server.id,
        run: async (signal) =>
          new Promise<void>((resolve) => {
            starts.set(server.id, (starts.get(server.id) ?? 0) + 1);
            signal.addEventListener(
              'abort',
              () => {
                stops.set(server.id, (stops.get(server.id) ?? 0) + 1);
                resolve();
              },
              { once: true },
            );
          }),
      }),
    });

    await fleet.synchronize();
    assert.deepEqual(fleet.activeServerInstanceIds, [firstId, secondId].sort());
    assert.equal(starts.get(firstId), 1);
    assert.equal(starts.get(secondId), 1);

    instances = [instance(firstId, 1), instance(secondId, 2)];
    await fleet.synchronize();
    assert.equal(starts.get(firstId), 1);
    assert.equal(starts.get(secondId), 2);
    assert.equal(stops.get(secondId), 1);

    await fleet.shutdown();
    assert.equal(stops.get(firstId), 1);
    assert.equal(stops.get(secondId), 2);
  });

  it('does not start an agent after shutdown races an in-flight synchronization', async () => {
    const serverInstanceId = randomUUID();
    let releaseList!: (instances: readonly ServerInstance[]) => void;
    const listed = new Promise<readonly ServerInstance[]>((resolve) => {
      releaseList = resolve;
    });
    let starts = 0;
    const fleet = new LocalAgentFleet({
      listInstances: () => listed,
      createProcess: async () => ({
        description: 'late agent',
        run: async () => {
          starts += 1;
        },
      }),
    });

    const synchronizing = fleet.synchronize();
    const shuttingDown = fleet.shutdown();
    releaseList([instance(serverInstanceId, 1)]);
    await Promise.all([synchronizing, shuttingDown]);

    assert.equal(starts, 0);
    assert.deepEqual(fleet.activeServerInstanceIds, []);
  });
});
