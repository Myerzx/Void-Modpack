import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { hashPassword } from '@voidfall/authentication';
import {
  OPENLOADER_ADVANCED_OPTIONS_V1,
  hashConfigurationSchema,
} from '@voidfall/configuration-schemas';
import type {
  ActorRef,
  AuditEvent,
  CompatibilityIssue,
  Job,
  ModCatalogEntry,
} from '@voidfall/contracts';
import { PANEL_PERMISSIONS, permissionsForRoles } from '@voidfall/permissions';
import {
  AgentTransportError,
  ArtifactReviewError,
  ConfigurationPersistenceError,
  ModCatalogPersistenceError,
  OperationalPersistenceError,
  createRepositories,
  runMigrations,
} from '../src/index.js';
import { createPGliteTestDatabase } from '../src/testing.js';

/**
 * Split out of the former single `database.test.ts`.
 *
 * That file created sixteen WASM Postgres instances in one process, which
 * intermittently tripped a V8 JIT page assertion on the Windows runner. The
 * Node test runner gives each *file* its own process, so splitting by concern
 * bounds how much WASM churn any one process sees. The tests themselves are
 * unchanged.
 */

describe('operational core persistence', () => {
  async function operationalFixture(): Promise<{
    readonly database: Awaited<ReturnType<typeof createPGliteTestDatabase>>;
    readonly repositories: ReturnType<typeof createRepositories>;
    readonly serverInstanceId: string;
    readonly actor: ActorRef;
  }> {
    const database = await createPGliteTestDatabase();
    await runMigrations(database);
    const repositories = createRepositories(database);
    const serverInstanceId = randomUUID();
    await repositories.servers.create({
      id: serverInstanceId,
      slug: 'operational-core-test',
      displayName: 'Operational Core Test',
      environment: 'test',
      minecraftVersion: '1.20.1',
      loader: 'forge',
      loaderVersion: '47.4.4',
      maxPlayers: 20,
    });
    return {
      database,
      repositories,
      serverInstanceId,
      actor: { type: 'panel-user', id: randomUUID() },
    };
  }

  const accept = (serverInstanceId: string, actor: ActorRef, overrides: Record<string, unknown> = {}) => ({
    operationId: randomUUID(),
    serverInstanceId,
    kind: 'server.start' as const,
    idempotencyKey: 'operation-start-0001',
    correlationId: randomUUID(),
    requestedBy: actor,
    reasonCode: 'operator-request',
    now: new Date('2026-08-05T12:00:00Z'),
    ...overrides,
  });

  it('returns the original operation for an honest replay and conflicts on a reused key', async () => {
    const { database, repositories, serverInstanceId, actor } = await operationalFixture();
    try {
      const first = await repositories.operations.accept(accept(serverInstanceId, actor));
      assert.equal(first.replayed, false);
      assert.equal(first.operation.status, 'accepted');

      // The same request under the same key is an honest replay.
      const replay = await repositories.operations.accept(
        accept(serverInstanceId, actor, { operationId: randomUUID() }),
      );
      assert.equal(replay.replayed, true);
      assert.equal(replay.operation.operationId, first.operation.operationId);

      // The same key for a different request is a conflict, never a second run.
      await assert.rejects(
        repositories.operations.accept(
          accept(serverInstanceId, actor, { operationId: randomUUID(), kind: 'server.stop' }),
        ),
        (error: unknown) =>
          error instanceof OperationalPersistenceError && error.code === 'idempotency-conflict',
      );
    } finally {
      await database.close();
    }
  });

  it('allows at most one in-flight operation per server', async () => {
    const { database, repositories, serverInstanceId, actor } = await operationalFixture();
    try {
      await repositories.operations.accept(accept(serverInstanceId, actor));

      await assert.rejects(
        repositories.operations.accept(
          accept(serverInstanceId, actor, {
            operationId: randomUUID(),
            idempotencyKey: 'operation-stop-0002',
            kind: 'server.stop',
          }),
        ),
        (error: unknown) =>
          error instanceof OperationalPersistenceError && error.code === 'operation-in-flight',
      );
    } finally {
      await database.close();
    }
  });

  it('settles an operation with a receipt and frees the server for the next one', async () => {
    const { database, repositories, serverInstanceId, actor } = await operationalFixture();
    try {
      const accepted = await repositories.operations.accept(accept(serverInstanceId, actor));
      const running = await repositories.operations.markRunning({
        operationId: accepted.operation.operationId,
        expectedVersion: accepted.operation.version,
        now: new Date('2026-08-05T12:00:05Z'),
      });
      assert.equal(running.status, 'running');

      const bootId = randomUUID();
      const settled = await repositories.operations.settle({
        operationId: accepted.operation.operationId,
        eventId: randomUUID(),
        expectedVersion: running.version,
        outcome: 'succeeded',
        observedLifecycle: 'online',
        observedPid: 4242,
        bootId,
        now: new Date('2026-08-05T12:00:30Z'),
      });
      assert.equal(settled.status, 'succeeded');
      assert.equal(settled.receipt?.observedPid, 4242);
      assert.equal(settled.receipt?.bootId, bootId);

      // A settled operation is final.
      await assert.rejects(
        repositories.operations.settle({
          operationId: accepted.operation.operationId,
          eventId: randomUUID(),
          expectedVersion: settled.version,
          outcome: 'failed',
          failureCode: 'operation-failed',
          observedLifecycle: 'error',
          now: new Date('2026-08-05T12:00:40Z'),
        }),
        (error: unknown) =>
          error instanceof OperationalPersistenceError && error.code === 'invalid-transition',
      );

      // The server is free again once nothing is in flight.
      assert.equal(await repositories.operations.findInFlight(serverInstanceId), undefined);
      const next = await repositories.operations.accept(
        accept(serverInstanceId, actor, {
          operationId: randomUUID(),
          idempotencyKey: 'operation-stop-0002',
          kind: 'server.stop',
        }),
      );
      assert.equal(next.replayed, false);
    } finally {
      await database.close();
    }
  });

  it('refuses to settle over a version the caller did not read', async () => {
    const { database, repositories, serverInstanceId, actor } = await operationalFixture();
    try {
      const accepted = await repositories.operations.accept(accept(serverInstanceId, actor));
      await assert.rejects(
        repositories.operations.settle({
          operationId: accepted.operation.operationId,
          eventId: randomUUID(),
          expectedVersion: accepted.operation.version + 1,
          outcome: 'succeeded',
          observedLifecycle: 'online',
          now: new Date('2026-08-05T12:00:30Z'),
        }),
        (error: unknown) =>
          error instanceof OperationalPersistenceError && error.code === 'stale-operation',
      );
    } finally {
      await database.close();
    }
  });

  it('writes the outbox event in the same transaction as the state change', async () => {
    const { database, repositories, serverInstanceId, actor } = await operationalFixture();
    try {
      const correlationId = randomUUID();
      const accepted = await repositories.operations.accept(
        accept(serverInstanceId, actor, { correlationId }),
      );
      await repositories.operations.settle({
        operationId: accepted.operation.operationId,
        eventId: randomUUID(),
        expectedVersion: accepted.operation.version,
        outcome: 'failed',
        failureCode: 'agent-refused',
        observedLifecycle: 'error',
        now: new Date('2026-08-05T12:00:30Z'),
      });

      const events = await repositories.outbox.findByCorrelationId(correlationId);
      assert.deepEqual(
        events.map((event) => event.topic),
        ['operation.accepted', 'operation.completed'],
      );
      assert.equal(events[1]?.payload.failureCode, 'agent-refused');
      // Nothing is published until a dispatcher says it delivered.
      assert.ok(events.every((event) => event.publishedAt === null));
    } finally {
      await database.close();
    }
  });

  it('never leaves an event behind when the state change rolls back', async () => {
    const { database, repositories, serverInstanceId, actor } = await operationalFixture();
    try {
      const before = await repositories.outbox.countPending();
      // A settle against a missing operation aborts the whole transaction.
      await assert.rejects(
        repositories.operations.settle({
          operationId: randomUUID(),
          eventId: randomUUID(),
          expectedVersion: 1,
          outcome: 'succeeded',
          observedLifecycle: 'online',
          now: new Date('2026-08-05T12:00:30Z'),
        }),
      );
      assert.equal(await repositories.outbox.countPending(), before);

      // And the conflicting accept above wrote nothing either.
      await repositories.operations.accept(accept(serverInstanceId, actor));
      await assert.rejects(
        repositories.operations.accept(
          accept(serverInstanceId, actor, {
            operationId: randomUUID(),
            idempotencyKey: 'operation-stop-0002',
            kind: 'server.stop',
          }),
        ),
      );
      assert.equal(await repositories.outbox.countPending(), before + 1);
    } finally {
      await database.close();
    }
  });

  it('claims outbox events once and publishes only after delivery', async () => {
    const { database, repositories, serverInstanceId, actor } = await operationalFixture();
    try {
      await repositories.operations.accept(accept(serverInstanceId, actor));
      const owner = randomUUID();
      const claimed = await repositories.outbox.claimPending({
        ownerId: owner,
        limit: 10,
        leaseExpiresAt: new Date('2026-08-05T12:05:00Z'),
        now: new Date('2026-08-05T12:00:10Z'),
      });
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.attempts, 1);

      // A second dispatcher sees nothing while the lease holds.
      const contested = await repositories.outbox.claimPending({
        ownerId: randomUUID(),
        limit: 10,
        leaseExpiresAt: new Date('2026-08-05T12:05:00Z'),
        now: new Date('2026-08-05T12:00:20Z'),
      });
      assert.equal(contested.length, 0);

      // Only the lease owner may mark it delivered.
      const eventId = claimed[0]?.eventId as string;
      assert.equal(await repositories.outbox.markPublished(eventId, randomUUID(), new Date('2026-08-05T12:00:30Z')), false);
      assert.equal(await repositories.outbox.markPublished(eventId, owner, new Date('2026-08-05T12:00:30Z')), true);
      assert.equal(await repositories.outbox.countPending(), 0);
    } finally {
      await database.close();
    }
  });

  it('records an observed pid and reconciles it to unknown once nobody is watching', async () => {
    const { database, repositories, serverInstanceId } = await operationalFixture();
    try {
      const agentId = randomUUID();
      await database.query(
        `INSERT INTO agents (id, server_instance_id, public_key_pem, certificate_fingerprint,
           software_version, protocol_version, status)
         VALUES ($1,$2,$3,$4,$5,$6,'online')`,
        [agentId, serverInstanceId, 'pem', 'a'.repeat(64), '0.1.0', '1'],
      );

      const observed = await repositories.processStates.observe({
        serverInstanceId,
        eventId: randomUUID(),
        lifecycle: 'online',
        observedBy: agentId,
        bootId: randomUUID(),
        observedPid: 4242,
        correlationId: randomUUID(),
        now: new Date('2026-08-05T12:00:00Z'),
      });
      assert.equal(observed.lifecycle, 'online');
      assert.equal(observed.observedPid, 4242);
      assert.equal(observed.stale, false);

      // After a restart nobody is watching, so the honest answer is unknown.
      const reconciled = await repositories.processStates.reconcileStale({
        observedBefore: new Date('2026-08-05T12:10:00Z'),
        now: new Date('2026-08-05T12:11:00Z'),
      });
      assert.equal(reconciled.length, 1);
      assert.equal(reconciled[0]?.lifecycle, 'unknown');
      assert.equal(reconciled[0]?.observedPid, null);
      assert.equal(reconciled[0]?.stale, true);

      const current = await repositories.processStates.find(serverInstanceId);
      assert.equal(current?.lifecycle, 'unknown');
    } finally {
      await database.close();
    }
  });

  it('fences one process ownership generation and rejects stale mutations', async () => {
    const { database, repositories, serverInstanceId } = await operationalFixture();
    try {
      const agentId = randomUUID();
      await database.query(
        `INSERT INTO agents (id, server_instance_id, public_key_pem, certificate_fingerprint,
           software_version, protocol_version, status)
         VALUES ($1,$2,$3,$4,$5,$6,'online')`,
        [agentId, serverInstanceId, 'pem', 'c'.repeat(64), '0.1.0', '1'],
      );
      const firstId = randomUUID();
      const bootId = randomUUID();
      const acquiredAt = new Date('2026-08-05T12:00:00Z');
      const reserved = await repositories.processOwnership.reserve({
        serverInstanceId,
        ownershipId: firstId,
        agentId,
        agentBootId: bootId,
        now: acquiredAt,
      });
      assert.equal(reserved?.status, 'reserved');
      assert.equal(reserved?.pid, null);

      assert.equal(
        await repositories.processOwnership.reserve({
          serverInstanceId,
          ownershipId: randomUUID(),
          agentId,
          agentBootId: randomUUID(),
          now: acquiredAt,
        }),
        undefined,
      );

      const running = await repositories.processOwnership.attachPid({
        ownershipId: firstId,
        pid: 4242,
        now: new Date('2026-08-05T12:00:01Z'),
      });
      assert.equal(running.status, 'running');
      assert.equal(running.pid, 4242);
      assert.equal(running.version, 2);

      const orphaned = await repositories.processOwnership.markOrphaned({
        ownershipId: firstId,
        now: new Date('2026-08-05T12:00:02Z'),
      });
      assert.equal(orphaned.status, 'orphaned');
      assert.equal(orphaned.pid, 4242);
      assert.equal(await repositories.processOwnership.release(randomUUID()), false);
      assert.equal(await repositories.processOwnership.release(firstId), true);
      assert.equal(await repositories.processOwnership.find(serverInstanceId), undefined);
    } finally {
      await database.close();
    }
  });

  it('invalidates a fresh process snapshot immediately when ownership is uncertain', async () => {
    const { database, repositories, serverInstanceId } = await operationalFixture();
    try {
      const agentId = randomUUID();
      await database.query(
        `INSERT INTO agents (id, server_instance_id, public_key_pem, certificate_fingerprint,
           software_version, protocol_version, status)
         VALUES ($1,$2,$3,$4,$5,$6,'online')`,
        [agentId, serverInstanceId, 'pem', 'd'.repeat(64), '0.1.0', '1'],
      );
      await repositories.processStates.observe({
        serverInstanceId,
        eventId: randomUUID(),
        lifecycle: 'online',
        observedBy: agentId,
        bootId: randomUUID(),
        observedPid: 4242,
        correlationId: randomUUID(),
        now: new Date('2026-08-05T12:00:00Z'),
      });

      const correlationId = randomUUID();
      const invalidated = await repositories.processStates.invalidate({
        serverInstanceId,
        eventId: randomUUID(),
        correlationId,
        now: new Date('2026-08-05T12:00:01Z'),
      });
      assert.equal(invalidated?.lifecycle, 'unknown');
      assert.equal(invalidated?.observedPid, null);
      assert.equal(invalidated?.stale, true);
      assert.equal(
        (await repositories.outbox.findByCorrelationId(correlationId))[0]?.topic,
        'process.invalidated',
      );

      // Already-unknown state is idempotent and creates no second event.
      assert.equal(
        await repositories.processStates.invalidate({
          serverInstanceId,
          eventId: randomUUID(),
          correlationId,
          now: new Date('2026-08-05T12:00:02Z'),
        }),
        undefined,
      );
      assert.equal((await repositories.outbox.findByCorrelationId(correlationId)).length, 1);
    } finally {
      await database.close();
    }
  });

  it('invalidates the previous pid atomically when lifecycle work is accepted', async () => {
    const { database, repositories, serverInstanceId, actor } = await operationalFixture();
    try {
      const agentId = randomUUID();
      await database.query(
        `INSERT INTO agents (id, server_instance_id, public_key_pem, certificate_fingerprint,
           software_version, protocol_version, status)
         VALUES ($1,$2,$3,$4,$5,$6,'online')`,
        [agentId, serverInstanceId, 'pem', 'a'.repeat(64), '0.1.0', '1'],
      );
      const previousBootId = randomUUID();
      await repositories.processStates.observe({
        serverInstanceId,
        eventId: randomUUID(),
        lifecycle: 'online',
        observedBy: agentId,
        bootId: previousBootId,
        observedPid: 4242,
        correlationId: randomUUID(),
        now: new Date('2026-08-05T12:00:00Z'),
      });

      const correlationId = randomUUID();
      const accepted = await repositories.operations.acceptProcessControl({
        ...accept(serverInstanceId, actor, {
          kind: 'server.restart',
          correlationId,
          idempotencyKey: 'operation-restart-0001',
          now: new Date('2026-08-05T12:01:00Z'),
        }),
        kind: 'server.restart',
        stateInvalidationEventId: randomUUID(),
      });
      assert.equal(accepted.replayed, false);

      const invalidated = await repositories.processStates.find(serverInstanceId);
      assert.equal(invalidated?.lifecycle, 'unknown');
      assert.equal(invalidated?.observedPid, null);
      assert.equal(invalidated?.bootId, null);
      assert.equal(invalidated?.observedBy, null);
      assert.equal(invalidated?.stale, true);
      assert.equal(invalidated?.version, 2);

      const topics = (await repositories.outbox.findByCorrelationId(correlationId))
        .map((event) => event.topic)
        .sort();
      assert.deepEqual(topics, ['operation.accepted', 'process.invalidated']);

      // Replaying the request after a fresh observation must not invalidate
      // the replacement process a second time.
      const replacementBootId = randomUUID();
      await repositories.processStates.observe({
        serverInstanceId,
        eventId: randomUUID(),
        lifecycle: 'online',
        observedBy: agentId,
        bootId: replacementBootId,
        observedPid: 8484,
        correlationId,
        now: new Date('2026-08-05T12:02:00Z'),
      });
      const replayed = await repositories.operations.acceptProcessControl({
        ...accept(serverInstanceId, actor, {
          operationId: randomUUID(),
          kind: 'server.restart',
          correlationId,
          idempotencyKey: 'operation-restart-0001',
          now: new Date('2026-08-05T12:03:00Z'),
        }),
        kind: 'server.restart',
        stateInvalidationEventId: randomUUID(),
      });
      assert.equal(replayed.replayed, true);
      const current = await repositories.processStates.find(serverInstanceId);
      assert.equal(current?.lifecycle, 'online');
      assert.equal(current?.observedPid, 8484);
      assert.equal(current?.bootId, replacementBootId);
      assert.equal(current?.stale, false);
    } finally {
      await database.close();
    }
  });

  it('pages and filters operations and follows one correlation id', async () => {
    const { database, repositories, serverInstanceId, actor } = await operationalFixture();
    try {
      const correlationId = randomUUID();
      for (const [index, kind] of (['server.start', 'server.stop', 'server.restart'] as const).entries()) {
        const accepted = await repositories.operations.accept(
          accept(serverInstanceId, actor, {
            operationId: randomUUID(),
            idempotencyKey: `operation-seq-000${String(index)}`,
            kind,
            correlationId,
            now: new Date(`2026-08-05T12:0${String(index)}:00Z`),
          }),
        );
        await repositories.operations.settle({
          operationId: accepted.operation.operationId,
          eventId: randomUUID(),
          expectedVersion: accepted.operation.version,
          outcome: 'succeeded',
          observedLifecycle: 'online',
          now: new Date(`2026-08-05T12:0${String(index)}:30Z`),
        });
      }

      const all = await repositories.operations.list({ serverInstanceId, limit: 2, offset: 0 });
      assert.equal(all.total, 3);
      assert.equal(all.operations.length, 2);

      const stops = await repositories.operations.list({
        serverInstanceId,
        kinds: ['server.stop'],
        limit: 50,
        offset: 0,
      });
      assert.equal(stops.total, 1);

      const settledOnly = await repositories.operations.list({
        serverInstanceId,
        statuses: ['accepted', 'running'],
        limit: 50,
        offset: 0,
      });
      assert.equal(settledOnly.total, 0);

      // One correlation id ties the whole sequence together.
      const correlated = await repositories.operations.findByCorrelationId(correlationId);
      assert.equal(correlated.length, 3);
      const events = await repositories.outbox.findByCorrelationId(correlationId);
      assert.equal(events.length, 6);
    } finally {
      await database.close();
    }
  });
});
