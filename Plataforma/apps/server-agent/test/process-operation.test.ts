import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { AgentWorkLease } from '@voidfall/contracts';
import type { Repositories } from '@voidfall/database';
import {
  MinecraftProcessController,
  ProcessOwnershipConflictError,
  createMinecraftProcessPlan,
  type MinecraftProcessAdapter,
} from '@voidfall/minecraft-process';

import { createProcessControlHandler } from '../src/process-operation.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');

function offlineAdapter(): MinecraftProcessAdapter {
  return {
    async inspect() {
      return {
        state: 'offline',
        observedAt: NOW.toISOString(),
        source: 'process-adapter',
      };
    },
    async start() {
      throw new Error('restart must be rejected before start');
    },
    async requestGracefulStop() {
      throw new Error('restart must be rejected before stop');
    },
    readOutput() {
      return { stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false };
    },
  };
}

describe('process control capability', () => {
  it('reports an offline restart as state-conflict and releases its durable lock', async () => {
    const serverInstanceId = randomUUID();
    const agentId = randomUUID();
    let releases = 0;
    const repositories = {
      operationalLocks: {
        async acquire() {},
        async release() {
          releases += 1;
        },
      },
    } as unknown as Repositories;
    const controller = new MinecraftProcessController({
      adapter: offlineAdapter(),
      launchPlan: createMinecraftProcessPlan({
        platform: 'win32',
        javaExecutable: 'C:\\Java\\bin\\java.exe',
        serverDirectory: 'C:\\VoidFall\\server',
        serverJar: 'server.jar',
        initialMemoryMiB: 512,
        maximumMemoryMiB: 1_024,
      }),
      clock: () => NOW,
    });
    const handler = createProcessControlHandler({
      repositories,
      controller,
      serverInstanceId,
      agentId,
      bootId: randomUUID(),
      clock: () => NOW,
    });
    const lease: AgentWorkLease = {
      schemaVersion: 1,
      leaseId: randomUUID(),
      jobId: randomUUID(),
      capability: 'process.control',
      jobType: 'server.restart',
      correlationId: randomUUID(),
      parameters: { resourceType: 'server-instance', resourceId: serverInstanceId, expectedVersion: 1 },
      leasedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      attempt: 1,
    };

    assert.deepEqual(await handler(lease), {
      outcome: 'failed',
      failureCode: 'state-conflict',
      observedLifecycle: 'offline',
    });
    assert.equal(releases, 1);
  });

  it('reports uncertain ownership as a precondition with unknown lifecycle', async () => {
    const serverInstanceId = randomUUID();
    const agentId = randomUUID();
    let releases = 0;
    const repositories = {
      operationalLocks: {
        async acquire() {},
        async release() {
          releases += 1;
        },
      },
    } as unknown as Repositories;
    const adapter = offlineAdapter();
    adapter.start = async () => {
      throw new ProcessOwnershipConflictError();
    };
    const controller = new MinecraftProcessController({
      adapter,
      launchPlan: createMinecraftProcessPlan({
        platform: 'win32',
        javaExecutable: 'C:\\Java\\bin\\java.exe',
        serverDirectory: 'C:\\VoidFall\\server',
        serverJar: 'server.jar',
        initialMemoryMiB: 512,
        maximumMemoryMiB: 1_024,
      }),
      clock: () => NOW,
    });
    const handler = createProcessControlHandler({
      repositories,
      controller,
      serverInstanceId,
      agentId,
      bootId: randomUUID(),
      clock: () => NOW,
    });
    const lease: AgentWorkLease = {
      schemaVersion: 1,
      leaseId: randomUUID(),
      jobId: randomUUID(),
      capability: 'process.control',
      jobType: 'server.start',
      correlationId: randomUUID(),
      parameters: {
        resourceType: 'server-instance',
        resourceId: serverInstanceId,
        expectedVersion: 1,
      },
      leasedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      attempt: 1,
    };

    assert.deepEqual(await handler(lease), {
      outcome: 'failed',
      failureCode: 'precondition-not-met',
      observedLifecycle: 'unknown',
    });
    assert.equal(releases, 1);
  });
});
