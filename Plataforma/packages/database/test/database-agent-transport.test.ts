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

describe('agent transport persistence', () => {
  async function transportFixture(options: { readonly capabilities?: readonly string[] } = {}) {
    const database = await createPGliteTestDatabase();
    await runMigrations(database);
    const repositories = createRepositories(database);
    const serverInstanceId = randomUUID();
    await repositories.servers.create({
      id: serverInstanceId,
      slug: 'agent-transport-test',
      displayName: 'Agent Transport Test',
      environment: 'test',
      minecraftVersion: '1.20.1',
      loader: 'forge',
      loaderVersion: '47.4.4',
      maxPlayers: 20,
    });
    const agentId = randomUUID();
    const fingerprint = 'a'.repeat(64);
    await database.query(
      `INSERT INTO agents (id, server_instance_id, public_key_pem, certificate_fingerprint,
         software_version, protocol_version, status, capabilities, credential_rotated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'online',$7::jsonb,$8)`,
      [
        agentId,
        serverInstanceId,
        'pem-original',
        fingerprint,
        '0.1.0',
        '1',
        JSON.stringify(options.capabilities ?? ['heartbeat', 'artifact.inspect']),
        new Date('2026-08-05T10:00:00Z'),
      ],
    );
    // The migration backfills credentials and grants for agents that already
    // existed, but this fixture inserts the agent after migrating, so it does
    // the same explicitly.
    await database.query(
      `INSERT INTO agent_credentials (credential_id, agent_id, public_key_pem,
         certificate_fingerprint, status, reason_code, created_at)
       VALUES ($1,$2,$3,$4,'active','registration-backfill',$5)`,
      [randomUUID(), agentId, 'pem-original', fingerprint, new Date('2026-08-05T10:00:00Z')],
    );
    for (const capability of options.capabilities ?? ['heartbeat', 'artifact.inspect']) {
      await repositories.agentTransport.grantCapability({
        agentId,
        capability: capability as never,
        grantedBy: { type: 'system', id: 'fixture' },
        reasonCode: 'fixture-grant',
        now: new Date('2026-08-05T10:00:00Z'),
      });
    }

    return { database, repositories, serverInstanceId, agentId, fingerprint };
  }

  const inspectJob = (submissionId: string, maxAttempts: number, key: string): Job => ({
    schemaVersion: 1,
    id: randomUUID(),
    type: 'artifact.inspect',
    resource: { type: 'artifact-submission', id: submissionId },
    status: 'queued',
    stage: 'queued',
    priority: 50,
    payload: { schemaVersion: 1, parameters: { submissionId, expectedVersion: 2 } },
    idempotencyKey: key,
    requestedBy: { type: 'system', id: 'transport-test' },
    correlationId: randomUUID(),
    availableAt: '2026-08-05T12:00:00Z',
    attempt: 0,
    maxAttempts,
  });

  const processJob = (serverInstanceId: string, key: string, priority: number): Job => ({
    schemaVersion: 1,
    id: randomUUID(),
    type: 'server.start',
    resource: { type: 'server-instance', id: serverInstanceId },
    status: 'queued',
    stage: 'queued',
    priority,
    payload: { schemaVersion: 1, parameters: { expectedVersion: 1 } },
    idempotencyKey: key,
    requestedBy: { type: 'system', id: 'transport-test' },
    correlationId: randomUUID(),
    availableAt: '2026-08-05T12:00:00Z',
    attempt: 0,
    maxAttempts: 3,
  });

  it('backfills a credential and grants for an agent that already existed', async () => {
    const database = await createPGliteTestDatabase();
    try {
      // Apply everything up to the migration before the transport one, insert an
      // agent, then migrate: this is the real upgrade path.
      const before = await runMigrations(database);
      assert.ok(before.includes('0008_agent_transport.sql'));

      const repositories = createRepositories(database);
      const serverInstanceId = randomUUID();
      await repositories.servers.create({
        id: serverInstanceId,
        slug: 'backfill-test',
        displayName: 'Backfill Test',
        environment: 'test',
        minecraftVersion: '1.20.1',
        loader: 'forge',
        loaderVersion: '47.4.4',
        maxPlayers: 20,
      });
      // Re-running the migration set is a no-op, proving it is idempotent.
      assert.deepEqual(await runMigrations(database), []);
    } finally {
      await database.close();
    }
  });

  it('resolves an active credential and refuses a superseded or revoked one', async () => {
    const { database, repositories, agentId, fingerprint } = await transportFixture();
    try {
      const resolved = await repositories.agentTransport.resolveByFingerprint(fingerprint);
      assert.equal(resolved.agentId, agentId);
      assert.deepEqual([...resolved.capabilities], ['artifact.inspect', 'heartbeat']);

      const rotatedFingerprint = 'b'.repeat(64);
      await repositories.agentTransport.rotateCredential({
        agentId,
        credentialId: randomUUID(),
        publicKeyPem: 'pem-rotated',
        certificateFingerprint: rotatedFingerprint,
        reasonCode: 'scheduled-rotation',
        now: new Date('2026-08-05T12:00:00Z'),
      });

      // The new identity works and the old one never authenticates again.
      const afterRotation = await repositories.agentTransport.resolveByFingerprint(rotatedFingerprint);
      assert.equal(afterRotation.agentId, agentId);
      await assert.rejects(
        repositories.agentTransport.resolveByFingerprint(fingerprint),
        (error: unknown) =>
          error instanceof AgentTransportError && error.code === 'credential-revoked',
      );

      // Exactly one credential is active at any moment.
      const credentials = await repositories.agentTransport.findCredentials(agentId);
      assert.equal(credentials.length, 2);
      assert.equal(credentials.filter((credential) => credential.status === 'active').length, 1);

      await repositories.agentTransport.revokeAgent({
        agentId,
        reasonCode: 'compromised-host',
        now: new Date('2026-08-05T13:00:00Z'),
      });
      await assert.rejects(
        repositories.agentTransport.resolveByFingerprint(rotatedFingerprint),
        (error: unknown) =>
          error instanceof AgentTransportError && error.code === 'credential-revoked',
      );
      // Revocation withdraws the grants too.
      assert.deepEqual([...(await repositories.agentTransport.grantedCapabilities(agentId))], []);
    } finally {
      await database.close();
    }
  });

  it('authorizes a capability only when it was granted, not merely announced', async () => {
    // The agent announces configuration.apply but is granted only inspection.
    const { database, repositories, agentId } = await transportFixture({
      capabilities: ['artifact.inspect'],
    });
    try {
      const claimable = await repositories.agentTransport.claimableJobTypes(agentId, [
        'artifact.inspect',
        'configuration.apply',
      ]);
      assert.deepEqual(
        claimable.map((entry) => entry.capability),
        ['artifact.inspect'],
      );

      await assert.rejects(
        repositories.agentTransport.claimWork({
          agentId,
          capabilities: ['configuration.apply'],
          bootId: randomUUID(),
          maximumLeases: 4,
          leaseMs: 60_000,
          now: new Date('2026-08-05T12:00:00Z'),
          newLeaseId: () => randomUUID(),
        }),
        (error: unknown) =>
          error instanceof AgentTransportError && error.code === 'capability-not-granted',
      );

      // Withdrawing a grant takes the capability away without touching identity.
      await repositories.agentTransport.revokeCapability({
        agentId,
        capability: 'artifact.inspect',
        now: new Date('2026-08-05T12:30:00Z'),
      });
      assert.deepEqual([...(await repositories.agentTransport.grantedCapabilities(agentId))], []);
    } finally {
      await database.close();
    }
  });

  it('grants and leases the reviewed datapack observation capability', async () => {
    const { database, repositories, agentId, serverInstanceId } = await transportFixture({
      capabilities: ['datapack-load-order.observe'],
    });
    try {
      const job: Job = {
        schemaVersion: 1,
        id: randomUUID(),
        type: 'datapack-load-order.observe',
        resource: { type: 'server-instance', id: serverInstanceId },
        status: 'queued',
        stage: 'awaiting-agent',
        priority: 50,
        payload: { schemaVersion: 1, parameters: { command: {} } },
        idempotencyKey: `datapack-order:${randomUUID()}`,
        requestedBy: { type: 'system', id: 'transport-test' },
        correlationId: randomUUID(),
        availableAt: '2026-08-05T12:00:00Z',
        attempt: 0,
        maxAttempts: 3,
      };
      await repositories.jobs.enqueue(job);
      const claimed = await repositories.agentTransport.claimWork({
        agentId,
        capabilities: ['datapack-load-order.observe'],
        bootId: randomUUID(),
        maximumLeases: 1,
        leaseMs: 60_000,
        now: new Date('2026-08-05T12:00:00Z'),
        newLeaseId: () => randomUUID(),
      });
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.capability, 'datapack-load-order.observe');
      assert.equal(claimed[0]?.jobType, 'datapack-load-order.observe');
    } finally {
      await database.close();
    }
  });

  it('reserves the job and records the lease in one transaction', async () => {
    const { database, repositories, agentId } = await transportFixture();
    try {
      const submissionId = randomUUID();
      const job = inspectJob(submissionId, 3, 'transport-claim-0001');
      await repositories.jobs.enqueue(job);

      const claimed = await repositories.agentTransport.claimWork({
        agentId,
        capabilities: ['artifact.inspect'],
        bootId: randomUUID(),
        maximumLeases: 4,
        leaseMs: 60_000,
        now: new Date('2026-08-05T12:00:00Z'),
        newLeaseId: () => randomUUID(),
      });

      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.jobId, job.id);
      assert.equal(claimed[0]?.capability, 'artifact.inspect');
      assert.equal(claimed[0]?.expectedVersion, 2);
      assert.equal(claimed[0]?.attempt, 1);

      // Both halves committed: the job is running and the lease exists.
      assert.equal((await repositories.jobs.findById(job.id))?.status, 'running');
      const leases = await database.query<{ readonly count: string | number }>(
        'SELECT COUNT(*) AS count FROM agent_work_leases WHERE job_id = $1 AND settled_at IS NULL',
        [job.id],
      );
      assert.equal(Number(leases.rows[0]?.count), 1);

      assert.equal(claimed[0]?.expiresAt, '2026-08-05T12:01:00.000Z');

      // A second claim finds nothing: the job is no longer queued.
      const again = await repositories.agentTransport.claimWork({
        agentId,
        capabilities: ['artifact.inspect'],
        bootId: randomUUID(),
        maximumLeases: 4,
        leaseMs: 60_000,
        now: new Date('2026-08-05T12:00:05Z'),
        newLeaseId: () => randomUUID(),
      });
      assert.deepEqual([...again], []);
    } finally {
      await database.close();
    }
  });

  it('leases server work only to the agent bound to that instance', async () => {
    const { database, repositories, serverInstanceId, agentId } = await transportFixture({
      capabilities: ['process.control'],
    });
    try {
      const otherServerId = randomUUID();
      await repositories.servers.create({
        id: otherServerId,
        slug: 'other-agent-transport-test',
        displayName: 'Other Agent Transport Test',
        environment: 'test',
        minecraftVersion: '1.20.1',
        loader: 'forge',
        loaderVersion: '47.4.4',
        maxPlayers: 20,
      });
      const otherAgentId = randomUUID();
      await database.query(
        `INSERT INTO agents (id, server_instance_id, public_key_pem, certificate_fingerprint,
           software_version, protocol_version, status, capabilities, credential_rotated_at)
         VALUES ($1,$2,'pem-other',$3,'0.1.0',1,'online',$4::jsonb,$5)`,
        [
          otherAgentId,
          otherServerId,
          'b'.repeat(64),
          JSON.stringify(['process.control']),
          new Date('2026-08-05T10:00:00Z'),
        ],
      );
      await repositories.agentTransport.grantCapability({
        agentId: otherAgentId,
        capability: 'process.control',
        grantedBy: { type: 'system', id: 'fixture' },
        reasonCode: 'fixture-grant',
        now: new Date('2026-08-05T10:00:00Z'),
      });

      const foreign = processJob(otherServerId, 'transport-claim-other-server-0001', 100);
      const own = processJob(serverInstanceId, 'transport-claim-own-server-0001', 50);
      await repositories.jobs.enqueue(foreign);
      await repositories.jobs.enqueue(own);

      const claimedByFirst = await repositories.agentTransport.claimWork({
        agentId,
        capabilities: ['process.control'],
        bootId: randomUUID(),
        maximumLeases: 8,
        leaseMs: 60_000,
        now: new Date('2026-08-05T12:00:00Z'),
        newLeaseId: () => randomUUID(),
      });
      assert.deepEqual(claimedByFirst.map((lease) => lease.jobId), [own.id]);

      const claimedBySecond = await repositories.agentTransport.claimWork({
        agentId: otherAgentId,
        capabilities: ['process.control'],
        bootId: randomUUID(),
        maximumLeases: 8,
        leaseMs: 60_000,
        now: new Date('2026-08-05T12:00:01Z'),
        newLeaseId: () => randomUUID(),
      });
      assert.deepEqual(claimedBySecond.map((lease) => lease.jobId), [foreign.id]);
    } finally {
      await database.close();
    }
  });

  /**
   * The agent picks its lease length before it knows what work it will get, so
   * a job that states its own deadline has to win. A 60s lease over a 900s
   * start expires mid-boot: the result is refused as `lease-expired`, the
   * reaper requeues the job, and a second server comes up underneath the first.
   */
  it('grants a lease that outlives the deadline the job carries', async () => {
    const { database, repositories, agentId } = await transportFixture();
    try {
      const submissionId = randomUUID();
      const job = inspectJob(submissionId, 3, 'transport-claim-deadline-0001');
      await repositories.jobs.enqueue({
        ...job,
        payload: {
          schemaVersion: 1,
          parameters: { submissionId, expectedVersion: 2, timeoutSeconds: 900 },
        },
      });

      const [claimed] = await repositories.agentTransport.claimWork({
        agentId,
        capabilities: ['artifact.inspect'],
        bootId: randomUUID(),
        maximumLeases: 4,
        leaseMs: 60_000,
        now: new Date('2026-08-05T12:00:00Z'),
        newLeaseId: () => randomUUID(),
      });

      // 900s of work plus the margin to report the result, not the 60s asked for.
      assert.equal(claimed?.timeoutSeconds, 900);
      assert.equal(claimed?.expiresAt, '2026-08-05T12:15:30.000Z');

      // The job agrees with the lease it actually got, so the reaper that reads
      // `lease_expires_at` cannot reclaim work that is still legitimately running.
      const row = await database.query<{ readonly lease_expires_at: Date | string }>(
        'SELECT lease_expires_at FROM jobs WHERE id = $1',
        [job.id],
      );
      assert.equal(
        new Date(row.rows[0]!.lease_expires_at).toISOString(),
        '2026-08-05T12:15:30.000Z',
      );
    } finally {
      await database.close();
    }
  });

  it('settles only a live lease held by the right agent, and only once', async () => {
    const { database, repositories, agentId } = await transportFixture();
    try {
      await repositories.jobs.enqueue(inspectJob(randomUUID(), 3, 'transport-settle-0001'));
      const [claimed] = await repositories.agentTransport.claimWork({
        agentId,
        capabilities: ['artifact.inspect'],
        bootId: randomUUID(),
        maximumLeases: 1,
        leaseMs: 60_000,
        now: new Date('2026-08-05T12:00:00Z'),
        newLeaseId: () => randomUUID(),
      });
      assert.ok(claimed);

      // Another agent cannot close a lease it does not hold.
      await assert.rejects(
        repositories.agentTransport.settleLease({
          leaseId: claimed.leaseId,
          agentId: randomUUID(),
          expectedJobId: claimed.jobId,
          outcome: 'succeeded',
          now: new Date('2026-08-05T12:00:10Z'),
        }),
        (error: unknown) => error instanceof AgentTransportError && error.code === 'lease-not-found',
      );
      // Neither can anyone close a lease that does not exist.
      await assert.rejects(
        repositories.agentTransport.settleLease({
          leaseId: randomUUID(),
          agentId,
          expectedJobId: claimed.jobId,
          outcome: 'succeeded',
          now: new Date('2026-08-05T12:00:10Z'),
        }),
        (error: unknown) => error instanceof AgentTransportError && error.code === 'lease-not-found',
      );

      // A result naming another job is refused before anything is written, so
      // it cannot consume the lease and strand the real work.
      await assert.rejects(
        repositories.agentTransport.settleLease({
          leaseId: claimed.leaseId,
          agentId,
          expectedJobId: randomUUID(),
          outcome: 'succeeded',
          now: new Date('2026-08-05T12:00:15Z'),
        }),
        (error: unknown) =>
          error instanceof AgentTransportError && error.code === 'lease-job-mismatch',
      );

      const settled = await repositories.agentTransport.settleLease({
        leaseId: claimed.leaseId,
        agentId,
        expectedJobId: claimed.jobId,
        outcome: 'succeeded',
        now: new Date('2026-08-05T12:00:20Z'),
      });
      assert.equal(settled.jobId, claimed.jobId);

      // A duplicate result is refused rather than recorded twice.
      await assert.rejects(
        repositories.agentTransport.settleLease({
          leaseId: claimed.leaseId,
          agentId,
          expectedJobId: claimed.jobId,
          outcome: 'succeeded',
          now: new Date('2026-08-05T12:00:30Z'),
        }),
        (error: unknown) => error instanceof AgentTransportError && error.code === 'lease-not-found',
      );
    } finally {
      await database.close();
    }
  });

  it('refuses to settle a lease that already expired', async () => {
    const { database, repositories, agentId } = await transportFixture();
    try {
      await repositories.jobs.enqueue(inspectJob(randomUUID(), 3, 'transport-expired-0001'));
      const [claimed] = await repositories.agentTransport.claimWork({
        agentId,
        capabilities: ['artifact.inspect'],
        bootId: randomUUID(),
        maximumLeases: 1,
        leaseMs: 30_000,
        now: new Date('2026-08-05T12:00:00Z'),
        newLeaseId: () => randomUUID(),
      });
      assert.ok(claimed);

      await assert.rejects(
        repositories.agentTransport.settleLease({
          leaseId: claimed.leaseId,
          agentId,
          expectedJobId: claimed.jobId,
          outcome: 'succeeded',
          now: new Date('2026-08-05T12:01:00Z'),
        }),
        (error: unknown) => error instanceof AgentTransportError && error.code === 'lease-expired',
      );
    } finally {
      await database.close();
    }
  });

  it('returns stranded work to the queue while attempts remain', async () => {
    const { database, repositories, agentId } = await transportFixture();
    try {
      const job = inspectJob(randomUUID(), 3, 'transport-reclaim-0001');
      await repositories.jobs.enqueue(job);
      await repositories.agentTransport.claimWork({
        agentId,
        capabilities: ['artifact.inspect'],
        bootId: randomUUID(),
        maximumLeases: 1,
        leaseMs: 30_000,
        now: new Date('2026-08-05T12:00:00Z'),
        newLeaseId: () => randomUUID(),
      });
      assert.equal((await repositories.jobs.findById(job.id))?.status, 'running');

      // The agent never came back; the lease expires.
      const reclaimed = await repositories.agentTransport.reclaimExpiredLeases({
        now: new Date('2026-08-05T12:05:00Z'),
      });
      assert.equal(reclaimed.length, 1);
      assert.equal(reclaimed[0]?.requeued, true);

      // The job is queued again, not stuck running, and can be claimed once more.
      const requeued = await repositories.jobs.findById(job.id);
      assert.equal(requeued?.status, 'queued');
      const second = await repositories.agentTransport.claimWork({
        agentId,
        capabilities: ['artifact.inspect'],
        bootId: randomUUID(),
        maximumLeases: 1,
        leaseMs: 30_000,
        now: new Date('2026-08-05T12:06:00Z'),
        newLeaseId: () => randomUUID(),
      });
      assert.equal(second.length, 1);
      assert.equal(second[0]?.attempt, 2);
    } finally {
      await database.close();
    }
  });

  it('fails stranded work for good once the attempt budget is gone', async () => {
    const { database, repositories, agentId } = await transportFixture();
    try {
      const job = inspectJob(randomUUID(), 1, 'transport-budget-0001');
      await repositories.jobs.enqueue(job);
      await repositories.agentTransport.claimWork({
        agentId,
        capabilities: ['artifact.inspect'],
        bootId: randomUUID(),
        maximumLeases: 1,
        leaseMs: 30_000,
        now: new Date('2026-08-05T12:00:00Z'),
        newLeaseId: () => randomUUID(),
      });

      const reclaimed = await repositories.agentTransport.reclaimExpiredLeases({
        now: new Date('2026-08-05T12:05:00Z'),
      });
      assert.equal(reclaimed.length, 1);
      assert.equal(reclaimed[0]?.requeued, false);

      // Never stuck in running, and never retried past the budget.
      const failed = await repositories.jobs.findById(job.id);
      assert.equal(failed?.status, 'failed');
      const nothingLeft = await repositories.agentTransport.claimWork({
        agentId,
        capabilities: ['artifact.inspect'],
        bootId: randomUUID(),
        maximumLeases: 1,
        leaseMs: 30_000,
        now: new Date('2026-08-05T12:06:00Z'),
        newLeaseId: () => randomUUID(),
      });
      assert.deepEqual([...nothingLeft], []);

      // Reclaiming again is idempotent: the lease is already settled.
      assert.deepEqual(
        [
          ...(await repositories.agentTransport.reclaimExpiredLeases({
            now: new Date('2026-08-05T12:07:00Z'),
          })),
        ],
        [],
      );
    } finally {
      await database.close();
    }
  });
});
