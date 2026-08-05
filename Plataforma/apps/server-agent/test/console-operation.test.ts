import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { AgentWorkLease } from '@voidfall/contracts';
import { createRepositories, runMigrations } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type {
  MinecraftConsoleAdapter,
  MinecraftConsoleCommand,
} from '@voidfall/minecraft-process';

import { createConsoleCommandHandler } from '../src/console-operation.js';

/**
 * The console capability against a scripted adapter. No Minecraft process is
 * started anywhere here; the adapter records what it was asked to dispatch.
 */

const NOW = new Date('2026-08-05T12:00:00.000Z');

function consoleAdapter(options: { readonly refuse?: boolean } = {}): MinecraftConsoleAdapter & {
  readonly dispatched: MinecraftConsoleCommand[];
} {
  const dispatched: MinecraftConsoleCommand[] = [];
  return {
    dispatched,
    async inspect() {
      return { state: 'online', observedAt: NOW.toISOString(), source: 'process-adapter', pid: 4242 };
    },
    readConsole() {
      return {
        readAt: NOW.toISOString(),
        source: 'process-adapter',
        stdout: { lines: [{ text: 'There are 0 players', truncated: false }], sourceTruncated: false, viewTruncated: false },
        stderr: { lines: [], sourceTruncated: false, viewTruncated: false },
      };
    },
    async requestConsoleCommand(command) {
      if (options.refuse === true) throw new Error('server is not online');
      dispatched.push(command);
      return {
        command,
        dispatchedAt: NOW.toISOString(),
        source: 'process-adapter',
        state: 'online',
      };
    },
  };
}

async function fixture() {
  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const serverInstanceId = randomUUID();
  await repositories.servers.create({
    id: serverInstanceId,
    slug: 'console-capability-test',
    displayName: 'Console Capability Test',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '47.4.4',
    maxPlayers: 20,
  });
  return { database, repositories, serverInstanceId, agentId: randomUUID() };
}

function lease(overrides: Partial<AgentWorkLease> = {}): AgentWorkLease {
  return {
    schemaVersion: 1,
    leaseId: randomUUID(),
    jobId: randomUUID(),
    capability: 'console.command',
    jobType: 'server.command',
    correlationId: randomUUID(),
    parameters: { resourceType: 'server-instance', resourceId: randomUUID(), expectedVersion: 1 },
    leasedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    attempt: 1,
    ...overrides,
  };
}

/** Records a console operation the way the route does, and returns its job id. */
async function queuedCommand(
  context: Awaited<ReturnType<typeof fixture>>,
  command: 'list-players' | 'save-all',
): Promise<string> {
  const jobId = randomUUID();
  await context.repositories.jobs.enqueue({
    schemaVersion: 1,
    id: jobId,
    type: 'server.command',
    resource: { type: 'server-instance', id: context.serverInstanceId },
    status: 'queued',
    stage: 'queued',
    priority: 70,
    payload: { schemaVersion: 1, parameters: { serverInstanceId: context.serverInstanceId } },
    idempotencyKey: `console-command-${jobId.slice(0, 8)}-0001`,
    requestedBy: { type: 'panel-user', id: randomUUID() },
    correlationId: randomUUID(),
    availableAt: NOW.toISOString(),
    attempt: 0,
    maxAttempts: 1,
  });
  const accepted = await context.repositories.operations.accept({
    operationId: randomUUID(),
    serverInstanceId: context.serverInstanceId,
    kind: 'server.command',
    idempotencyKey: `console-op-${jobId.slice(0, 8)}-0001`,
    correlationId: randomUUID(),
    requestedBy: { type: 'panel-user', id: randomUUID() },
    reasonCode: 'operator-request',
    consoleCommand: command,
    jobId,
    now: NOW,
  });
  assert.equal(accepted.operation.consoleCommand, command);
  return jobId;
}

describe('console command capability', () => {
  it('resolves the reviewed command from the operation and dispatches it', async () => {
    const context = await fixture();
    try {
      const jobId = await queuedCommand(context, 'save-all');
      const adapter = consoleAdapter();
      const handle = createConsoleCommandHandler({
        repositories: context.repositories,
        consoleAdapter: adapter,
        serverInstanceId: context.serverInstanceId,
        agentId: context.agentId,
        bootId: randomUUID(),
        clock: () => NOW,
      });

      const result = await handle(
        lease({
          jobId,
          parameters: {
            resourceType: 'server-instance',
            resourceId: context.serverInstanceId,
            expectedVersion: 1,
          },
        }),
      );

      assert.equal(result.outcome, 'succeeded');
      // The command travelled from the route to the agent, which was the whole
      // gap: nothing carried it before.
      assert.deepEqual(adapter.dispatched, ['save-all']);
      assert.equal(result.observedLifecycle, 'online');
      assert.equal(result.observedPid, 4242);

      // Whatever the command printed was stored, redacted and bounded.
      const page = await context.repositories.console.read({
        serverInstanceId: context.serverInstanceId,
        now: NOW,
      });
      assert.equal(page.lines[0]?.text, 'There are 0 players');
    } finally {
      await context.database.close();
    }
  });

  it('refuses a lease for another server or another job type', async () => {
    const context = await fixture();
    try {
      const jobId = await queuedCommand(context, 'list-players');
      const adapter = consoleAdapter();
      const handle = createConsoleCommandHandler({
        repositories: context.repositories,
        consoleAdapter: adapter,
        serverInstanceId: context.serverInstanceId,
        agentId: context.agentId,
        bootId: randomUUID(),
        clock: () => NOW,
      });

      const otherServer = await handle(lease({ jobId }));
      assert.equal(otherServer.failureCode, 'unsupported-parameters');

      const otherType = await handle(
        lease({
          jobId,
          jobType: 'server.start',
          parameters: {
            resourceType: 'server-instance',
            resourceId: context.serverInstanceId,
            expectedVersion: 1,
          },
        }),
      );
      assert.equal(otherType.failureCode, 'unsupported-parameters');
      // Neither reached the adapter.
      assert.deepEqual(adapter.dispatched, []);
    } finally {
      await context.database.close();
    }
  });

  it('refuses a lease whose operation carries no reviewed command', async () => {
    const context = await fixture();
    try {
      const adapter = consoleAdapter();
      const handle = createConsoleCommandHandler({
        repositories: context.repositories,
        consoleAdapter: adapter,
        serverInstanceId: context.serverInstanceId,
        agentId: context.agentId,
        bootId: randomUUID(),
        clock: () => NOW,
      });

      // No operation exists for this job, so there is no command to run and
      // the capability refuses rather than improvising one.
      const result = await handle(
        lease({
          parameters: {
            resourceType: 'server-instance',
            resourceId: context.serverInstanceId,
            expectedVersion: 1,
          },
        }),
      );
      assert.equal(result.failureCode, 'unsupported-parameters');
      assert.deepEqual(adapter.dispatched, []);
    } finally {
      await context.database.close();
    }
  });

  it('reports a refused command as a closed failure and releases the lock', async () => {
    const context = await fixture();
    try {
      const jobId = await queuedCommand(context, 'list-players');
      const handle = createConsoleCommandHandler({
        repositories: context.repositories,
        consoleAdapter: consoleAdapter({ refuse: true }),
        serverInstanceId: context.serverInstanceId,
        agentId: context.agentId,
        bootId: randomUUID(),
        clock: () => NOW,
      });

      const result = await handle(
        lease({
          jobId,
          parameters: {
            resourceType: 'server-instance',
            resourceId: context.serverInstanceId,
            expectedVersion: 1,
          },
        }),
      );
      assert.equal(result.outcome, 'failed');
      assert.equal(result.failureCode, 'precondition-not-met');

      // The lock was released, so the next operation is not blocked by a
      // command that failed.
      const held = await context.database.query<{ readonly count: string | number }>(
        'SELECT COUNT(*) AS count FROM operational_locks WHERE server_instance_id = $1',
        [context.serverInstanceId],
      );
      assert.equal(Number(held.rows[0]?.count), 0);
    } finally {
      await context.database.close();
    }
  });
});
