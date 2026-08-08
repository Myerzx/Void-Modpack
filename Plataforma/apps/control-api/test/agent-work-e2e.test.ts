import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { hashPassword } from '@voidfall/authentication';
import type { Job } from '@voidfall/contracts';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type { FastifyInstance } from 'fastify';

// The agent transport and supervisor are imported from source. `npm run check`
// typechecks before it builds the apps, so depending on a sibling app's emitted
// declarations would fail on a clean checkout.
import type { AgentFetch, AgentIdentity } from '../../server-agent/src/agent-client.js';
import { AgentSupervisor } from '../../server-agent/src/supervisor.js';
import { AgentWorkTransport } from '../../server-agent/src/work-transport.js';
import { buildControlApi } from '../src/app.js';

/**
 * Phase 9.2 end to end: the Control API leases work, a real supervisor claims
 * it over the outbound protocol, runs a harmless handler, reports the result,
 * and the job and audit chain close.
 *
 * No Minecraft process is involved. The handler observes a lifecycle and
 * returns; nothing here starts, stops or signals anything.
 */

const resources: Array<{ app: FastifyInstance; database: Database }> = [];
const NOW = new Date('2026-08-05T12:00:00.000Z');

/** One clock for both sides, so advancing time advances it for the API too. */
function testClock(): { now: () => Date; advance: (ms: number) => void } {
  let current = NOW;
  return {
    now: () => current,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

afterEach(async () => {
  while (resources.length > 0) {
    const resource = resources.pop();
    if (resource !== undefined) {
      await resource.app.close();
      await resource.database.close();
    }
  }
});

async function fixture() {
  const clock = testClock();
  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);

  await repositories.users.create({
    email: 'owner@voidfall.invalid',
    displayName: 'Owner fixture',
    passwordHash: await hashPassword('agent-e2e-test-password'),
    roles: ['owner'],
  });
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'voidfall-agent-e2e',
    displayName: 'VoidFall Agent E2E',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '1.20.1-47.4.4',
    maxPlayers: 20,
  });

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const agentId = randomUUID();
  const fingerprint = 'c'.repeat(64);

  await database.query(
    `INSERT INTO agents (id, server_instance_id, public_key_pem, certificate_fingerprint,
       software_version, protocol_version, status, capabilities, credential_rotated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'online',$7::jsonb,$8)`,
    [
      agentId,
      server.id,
      publicKeyPem,
      fingerprint,
      '0.1.0',
      '1',
      JSON.stringify(['heartbeat', 'artifact.inspect']),
      NOW,
    ],
  );
  await database.query(
    `INSERT INTO agent_credentials (credential_id, agent_id, public_key_pem,
       certificate_fingerprint, status, reason_code, created_at)
     VALUES ($1,$2,$3,$4,'active','fixture',$5)`,
    [randomUUID(), agentId, publicKeyPem, fingerprint, NOW],
  );
  await repositories.agentTransport.grantCapability({
    agentId,
    capability: 'artifact.inspect',
    grantedBy: { type: 'system', id: 'fixture' },
    reasonCode: 'fixture-grant',
    now: NOW,
  });

  const app = await buildControlApi({
    database,
    cookieSecure: false,
    clock: clock.now,
    // The transport check stands in for mTLS: the presented fingerprint must
    // match the agent's current credential.
    agentTransportVerifier: (request, expected) =>
      request.headers['x-test-certificate'] === expected,
  });
  resources.push({ app, database });

  const identity: AgentIdentity = {
    agentId,
    serverInstanceId: server.id,
    privateKey,
    keyId: 'agent-key-1',
  };

  const agentFetch: AgentFetch = async (url, init) => {
    const response = await app.inject({
      method: 'POST',
      url: url.pathname,
      headers: { ...init.headers, 'x-test-certificate': fingerprint },
      payload: init.body,
    });
    return {
      ok: response.statusCode < 400,
      status: response.statusCode,
      json: async () => response.json(),
    };
  };

  const transport = new AgentWorkTransport({
    baseUrl: 'http://control.invalid',
    allowInsecureDevelopment: true,
    fetch: agentFetch,
  });

  return {
    app,
    database,
    repositories,
    server,
    agentId,
    fingerprint,
    identity,
    transport,
    agentFetch,
    clock,
  };
}

const inspectJob = (submissionId: string, key: string, maxAttempts = 3): Job => ({
  schemaVersion: 1,
  id: randomUUID(),
  type: 'artifact.inspect',
  resource: { type: 'artifact-submission', id: submissionId },
  status: 'queued',
  stage: 'queued',
  priority: 50,
  payload: { schemaVersion: 1, parameters: { submissionId, expectedVersion: 2 } },
  idempotencyKey: key,
  requestedBy: { type: 'system', id: 'agent-e2e' },
  correlationId: randomUUID(),
  availableAt: NOW.toISOString(),
  attempt: 0,
  maxAttempts,
});

describe('Phase 9.2 end-to-end agent work', () => {
  it('carries one job from the queue through the agent to completion and audit', async () => {
    const context = await fixture();
    const job = inspectJob(randomUUID(), 'agent-e2e-job-0001');
    await context.repositories.jobs.enqueue(job);

    const observed: string[] = [];
    const supervisor = new AgentSupervisor({
      identity: context.identity,
      transport: context.transport,
      handlers: {
        'artifact.inspect': async (lease) => {
          observed.push(lease.jobId);
          // A harmless handler: it observes, it does not act on the runtime.
          return { outcome: 'succeeded', observedLifecycle: 'offline' };
        },
      },
      clock: () => NOW,
    });

    const waitMs = await supervisor.runOnce();
    assert.equal(waitMs, 0);
    assert.deepEqual(observed, [job.id]);

    // The job completed through the agent, not through a worker.
    const completed = await context.repositories.jobs.findById(job.id);
    assert.equal(completed?.status, 'succeeded');

    // The lease is settled, so nothing is left to reclaim.
    const open = await context.database.query<{ readonly count: string | number }>(
      'SELECT COUNT(*) AS count FROM agent_work_leases WHERE settled_at IS NULL',
    );
    assert.equal(Number(open.rows[0]?.count), 0);

    // The observation reached the Phase 9.1 state and its outbox event.
    const state = await context.repositories.processStates.find(context.server.id);
    assert.equal(state?.lifecycle, 'offline');
    assert.equal(state?.stale, false);

    // Both sides of the exchange are audited.
    const audited = await context.database.query<{ readonly action: string }>(
      "SELECT action FROM audit_events WHERE action LIKE 'agent.work.%' ORDER BY action",
    );
    assert.deepEqual(
      audited.rows.map((row) => row.action),
      ['agent.work.claim', 'agent.work.result'],
    );
  });

  it('settles the operation the job was created for, not only the job', async () => {
    const context = await fixture();
    await context.repositories.agentTransport.grantCapability({
      agentId: context.identity.agentId,
      capability: 'process.control',
      grantedBy: { type: 'system', id: 'fixture' },
      reasonCode: 'fixture-grant',
      now: NOW,
    });

    // A start, accepted the way the process route accepts one.
    const startJobId = randomUUID();
    const correlationId = randomUUID();
    await context.repositories.jobs.enqueue({
      schemaVersion: 1,
      id: startJobId,
      type: 'server.start',
      resource: { type: 'server-instance', id: context.server.id },
      status: 'queued',
      stage: 'queued',
      priority: 50,
      payload: { schemaVersion: 1, parameters: { serverInstanceId: context.server.id } },
      idempotencyKey: 'agent-e2e-start-0001',
      requestedBy: { type: 'system', id: 'agent-e2e' },
      correlationId,
      availableAt: NOW.toISOString(),
      attempt: 0,
      maxAttempts: 3,
    });
    const { operation: accepted } = await context.repositories.operations.accept({
      operationId: randomUUID(),
      serverInstanceId: context.server.id,
      kind: 'server.start',
      idempotencyKey: 'agent-e2e-operation-0001',
      correlationId,
      requestedBy: { type: 'panel-user', id: randomUUID() },
      reasonCode: 'e2e',
      jobId: startJobId,
      now: NOW,
    });

    const supervisor = new AgentSupervisor({
      identity: context.identity,
      transport: context.transport,
      handlers: {
        'process.control': async () => ({ outcome: 'succeeded', observedLifecycle: 'online' }),
      },
      clock: () => NOW,
    });
    await supervisor.runOnce();

    // The job completing and the operation completing were two different
    // facts, and only the first was ever written. The agent started the
    // server, released the lease and went idle — and the operation stayed
    // `running`, so every later control call answered in-flight. In practice
    // the panel could start a server and then never stop it.
    const settled = await context.repositories.operations.findById(accepted.operationId);
    assert.equal(settled?.status, 'succeeded');
    assert.equal(await context.repositories.operations.findInFlight(context.server.id), undefined);

    // And the observation is where the listing reads it from.
    const state = await context.repositories.processStates.find(context.server.id);
    assert.equal(state?.lifecycle, 'online');
  });

  it('refuses a claim for a capability that was never granted', async () => {
    const context = await fixture();
    await context.repositories.jobs.enqueue(inspectJob(randomUUID(), 'agent-e2e-denied-0001'));

    const supervisor = new AgentSupervisor({
      identity: context.identity,
      transport: context.transport,
      // The agent offers a capability the control plane never granted.
      handlers: { 'configuration.apply': async () => ({ outcome: 'succeeded' }) },
      clock: () => NOW,
    });

    await assert.rejects(supervisor.runOnce(), /HTTP 403/u);
    const audited = await context.database.query<{ readonly outcome: string }>(
      "SELECT outcome FROM audit_events WHERE action = 'agent.work.claim'",
    );
    assert.deepEqual(
      audited.rows.map((row) => row.outcome),
      ['denied'],
    );
  });

  it('refuses a revoked identity even with a valid signature', async () => {
    const context = await fixture();
    await context.repositories.jobs.enqueue(inspectJob(randomUUID(), 'agent-e2e-revoked-0001'));
    await context.repositories.agentTransport.revokeAgent({
      agentId: context.agentId,
      reasonCode: 'compromised-host',
      now: NOW,
    });

    const supervisor = new AgentSupervisor({
      identity: context.identity,
      transport: context.transport,
      handlers: { 'artifact.inspect': async () => ({ outcome: 'succeeded' }) },
      clock: () => NOW,
    });

    await assert.rejects(supervisor.runOnce(), /HTTP 401/u);
  });

  it('refuses a replayed envelope', async () => {
    const context = await fixture();
    await context.repositories.jobs.enqueue(inspectJob(randomUUID(), 'agent-e2e-replay-0001'));

    const { createWorkClaimEnvelope } = await import('../../server-agent/src/work-transport.js');
    const envelope = createWorkClaimEnvelope(context.identity, {
      capabilities: ['artifact.inspect'],
      leaseSeconds: 60,
      bootId: randomUUID(),
      issuedAt: NOW,
    });

    const first = await context.transport.claim(envelope);
    assert.equal(first.leases.length, 1);
    // The very same signed envelope, sent again.
    await assert.rejects(context.transport.claim(envelope), /HTTP 409/u);
  });

  it('recovers work stranded by an agent that crashed mid-lease', async () => {
    const context = await fixture();
    const job = inspectJob(randomUUID(), 'agent-e2e-crash-0001');
    await context.repositories.jobs.enqueue(job);

    // First run claims the work and then the agent disappears without
    // reporting: no result envelope is ever sent.
    const crashed = new AgentSupervisor({
      identity: context.identity,
      transport: context.transport,
      handlers: {
        'artifact.inspect': async () => {
          throw new Error('agent died mid-lease');
        },
      },
      clock: () => NOW,
    });
    // Claim only; the handler failure would normally be reported, so instead
    // the lease is taken directly to model a hard crash.
    const claimed = await context.repositories.agentTransport.claimWork({
      agentId: context.agentId,
      capabilities: ['artifact.inspect'],
      bootId: crashed.bootId,
      maximumLeases: 1,
      leaseMs: 30_000,
      now: NOW,
      newLeaseId: () => randomUUID(),
    });
    assert.equal(claimed.length, 1);
    assert.equal((await context.repositories.jobs.findById(job.id))?.status, 'running');

    // The lease expires and the control plane returns the work to the queue.
    context.clock.advance(120_000);
    const reclaimed = await context.repositories.agentTransport.reclaimExpiredLeases({
      now: context.clock.now(),
    });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0]?.requeued, true);
    assert.equal((await context.repositories.jobs.findById(job.id))?.status, 'queued');

    // A fresh agent run — a new boot id — picks the same work up and finishes
    // it. The job ran once to completion, never twice concurrently.
    const restarted = new AgentSupervisor({
      identity: context.identity,
      transport: context.transport,
      handlers: { 'artifact.inspect': async () => ({ outcome: 'succeeded' }) },
      clock: context.clock.now,
    });
    assert.notEqual(restarted.bootId, crashed.bootId);
    await restarted.runOnce();

    assert.equal((await context.repositories.jobs.findById(job.id))?.status, 'succeeded');
    const leases = await context.database.query<{ readonly outcome: string | null }>(
      'SELECT outcome FROM agent_work_leases WHERE job_id = $1 ORDER BY leased_at',
      [job.id],
    );
    // Two leases existed in total: the stranded one and the one that finished.
    assert.deepEqual(
      leases.rows.map((row) => row.outcome),
      ['failed', 'succeeded'],
    );
  });

  it('survives the control plane going away and coming back', async () => {
    const context = await fixture();
    await context.repositories.jobs.enqueue(inspectJob(randomUUID(), 'agent-e2e-outage-0001'));

    let apiDown = true;
    const flakyTransport = new AgentWorkTransport({
      baseUrl: 'http://control.invalid',
      allowInsecureDevelopment: true,
      fetch: async (url, init) => {
        if (apiDown) return { ok: false, status: 503, json: async () => ({}) };
        return context.agentFetch(url, init);
      },
    });

    const waits: number[] = [];
    const controller = new AbortController();
    const supervisor = new AgentSupervisor({
      identity: context.identity,
      transport: flakyTransport,
      handlers: { 'artifact.inspect': async () => ({ outcome: 'succeeded' }) },
      minimumBackoffMs: 1_000,
      maximumBackoffMs: 8_000,
      clock: () => NOW,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        // The API comes back after two failed cycles.
        if (waits.length === 2) apiDown = false;
        if (waits.length >= 3) controller.abort();
      },
    });

    await supervisor.run(controller.signal);
    // It backed off while the API was down and then made progress.
    assert.deepEqual(waits.slice(0, 2), [1_000, 2_000]);
    const jobs = await context.database.query<{ readonly status: string }>(
      "SELECT status FROM jobs WHERE type = 'artifact.inspect'",
    );
    assert.deepEqual(
      jobs.rows.map((row) => row.status),
      ['succeeded'],
    );
  });

  it('refuses a duplicate result and one that names another job', async () => {
    const context = await fixture();
    const job = inspectJob(randomUUID(), 'agent-e2e-duplicate-0001');
    await context.repositories.jobs.enqueue(job);

    const { createWorkResultEnvelope, createWorkClaimEnvelope } = await import(
      '../../server-agent/src/work-transport.js'
    );
    const claim = await context.transport.claim(
      createWorkClaimEnvelope(context.identity, {
        capabilities: ['artifact.inspect'],
        leaseSeconds: 60,
        bootId: randomUUID(),
        issuedAt: NOW,
      }),
    );
    const lease = claim.leases[0];
    assert.ok(lease);

    // A result that names a different job than the lease covers is refused.
    await assert.rejects(
      context.transport.report(
        createWorkResultEnvelope(context.identity, {
          leaseId: lease.leaseId,
          jobId: randomUUID(),
          correlationId: lease.correlationId,
          outcome: 'succeeded',
          issuedAt: NOW,
        }),
      ),
      /HTTP 409/u,
    );

    await context.transport.report(
      createWorkResultEnvelope(context.identity, {
        leaseId: lease.leaseId,
        jobId: lease.jobId,
        correlationId: lease.correlationId,
        outcome: 'succeeded',
        issuedAt: NOW,
      }),
    );

    // Reporting the same lease twice is refused rather than applied again.
    await assert.rejects(
      context.transport.report(
        createWorkResultEnvelope(context.identity, {
          leaseId: lease.leaseId,
          jobId: lease.jobId,
          correlationId: lease.correlationId,
          outcome: 'succeeded',
          issuedAt: NOW,
        }),
      ),
      /HTTP 404/u,
    );
  });
});
