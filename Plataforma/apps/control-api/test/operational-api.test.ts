import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { hashPassword } from '@voidfall/authentication';
import { validateServerOperationPage } from '@voidfall/contracts';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type { FastifyInstance } from 'fastify';

import { buildControlApi } from '../src/app.js';

/**
 * Phase 9.1 administrative reads.
 *
 * Every listing is bounded, every filter is validated, and one correlation
 * identifier ties an operation, its job and the audit chain together.
 */

const resources: Array<{ app: FastifyInstance; database: Database }> = [];
const NOW = new Date('2026-08-05T12:00:00.000Z');
const BASE = '/api/v1/servers';

afterEach(async () => {
  while (resources.length > 0) {
    const resource = resources.pop();
    if (resource !== undefined) {
      await resource.app.close();
      await resource.database.close();
    }
  }
});

async function fixture(options: { readonly role?: 'owner' | 'read-only' } = {}) {
  const role = options.role ?? 'owner';
  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const password = 'operational-api-test-password';
  const user = await repositories.users.create({
    email: `${role}@voidfall.invalid`,
    displayName: `${role} fixture`,
    passwordHash: await hashPassword(password),
    roles: [role],
  });
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'voidfall-operational-test',
    displayName: 'VoidFall Operational Test',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '1.20.1-47.4.4',
    maxPlayers: 20,
  });

  const app = await buildControlApi({
    database,
    cookieSecure: false,
    clock: () => NOW,
    agentTransportVerifier: () => true,
  });
  resources.push({ app, database });

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: `${role}@voidfall.invalid`, password },
  });
  assert.equal(login.statusCode, 200);

  return {
    app,
    database,
    repositories,
    server,
    user,
    cookie: (login.headers['set-cookie'] as string).split(';')[0] ?? '',
    csrfToken: login.json<{ csrfToken: string }>().csrfToken,
  };
}

describe('operation listings', () => {
  it('pages, filters and bounds the operation list', async () => {
    const context = await fixture();
    const correlationId = randomUUID();

    for (const [index, kind] of (['server.start', 'server.stop'] as const).entries()) {
      const accepted = await context.repositories.operations.accept({
        operationId: randomUUID(),
        serverInstanceId: context.server.id,
        kind,
        idempotencyKey: `operation-seq-000${String(index)}`,
        correlationId,
        requestedBy: { type: 'panel-user', id: context.user.id },
        reasonCode: 'operator-request',
        now: NOW,
      });
      await context.repositories.operations.settle({
        operationId: accepted.operation.operationId,
        eventId: randomUUID(),
        expectedVersion: accepted.operation.version,
        outcome: 'succeeded',
        observedLifecycle: 'online',
        now: new Date('2026-08-05T12:00:30.000Z'),
      });
    }

    const all = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/operations`,
      headers: { cookie: context.cookie },
    });
    assert.equal(all.statusCode, 200);
    assert.equal(validateServerOperationPage(all.json()).success, true);
    assert.equal(all.json().total, 2);

    const filtered = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/operations?kind=server.stop`,
      headers: { cookie: context.cookie },
    });
    assert.equal(filtered.json().total, 1);

    const paged = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/operations?limit=1&offset=1`,
      headers: { cookie: context.cookie },
    });
    assert.equal(paged.json().operations.length, 1);
    assert.equal(paged.json().total, 2);

    // The bound cannot be argued past.
    const overLimit = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/operations?limit=5000`,
      headers: { cookie: context.cookie },
    });
    assert.equal(overLimit.statusCode, 400);

    const unknownFilter = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/operations?kind=server.rm-rf`,
      headers: { cookie: context.cookie },
    });
    assert.equal(unknownFilter.statusCode, 400);
  });

  it('returns an operation only through the server that owns it', async () => {
    const context = await fixture();
    const accepted = await context.repositories.operations.accept({
      operationId: randomUUID(),
      serverInstanceId: context.server.id,
      kind: 'server.start',
      idempotencyKey: 'operation-owned-0001',
      correlationId: randomUUID(),
      requestedBy: { type: 'panel-user', id: context.user.id },
      reasonCode: 'operator-request',
      now: NOW,
    });

    const found = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/operations/${accepted.operation.operationId}`,
      headers: { cookie: context.cookie },
    });
    assert.equal(found.statusCode, 200);
    assert.equal(found.json().status, 'accepted');
    // A receipt does not exist before the operation settles.
    assert.equal(found.json().receipt, null);

    const missingServer = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${randomUUID()}/operations/${accepted.operation.operationId}`,
      headers: { cookie: context.cookie },
    });
    assert.equal(missingServer.statusCode, 404);
  });
});

describe('observed process state', () => {
  it('reports never-observed as unknown rather than offline', async () => {
    const context = await fixture();
    const response = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/process-state`,
      headers: { cookie: context.cookie },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().lifecycle, 'unknown');
    assert.equal(response.json().observed, false);
    assert.equal(response.json().stale, true);
    assert.equal(response.json().observedPid, null);
  });

  it('reports what an agent observed, including the pid and its boot', async () => {
    const context = await fixture();
    const agentId = randomUUID();
    await context.database.query(
      `INSERT INTO agents (id, server_instance_id, public_key_pem, certificate_fingerprint,
         software_version, protocol_version, status)
       VALUES ($1,$2,$3,$4,$5,$6,'online')`,
      [agentId, context.server.id, 'pem', 'a'.repeat(64), '0.1.0', '1'],
    );
    const bootId = randomUUID();
    await context.repositories.processStates.observe({
      serverInstanceId: context.server.id,
      eventId: randomUUID(),
      lifecycle: 'online',
      observedBy: agentId,
      bootId,
      observedPid: 4242,
      correlationId: randomUUID(),
      now: NOW,
    });

    const response = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/process-state`,
      headers: { cookie: context.cookie },
    });
    assert.equal(response.json().lifecycle, 'online');
    assert.equal(response.json().observedPid, 4242);
    assert.equal(response.json().bootId, bootId);
    assert.equal(response.json().stale, false);
    assert.equal(response.json().observed, true);
  });
});

describe('correlation view', () => {
  it('ties an operation, its job and the audit chain to one identifier', async () => {
    const context = await fixture();
    // The login itself produced an audit event under its own correlation id;
    // this one belongs to the operation.
    const correlationId = randomUUID();
    const accepted = await context.repositories.operations.accept({
      operationId: randomUUID(),
      serverInstanceId: context.server.id,
      kind: 'server.start',
      idempotencyKey: 'operation-correlated-0001',
      correlationId,
      requestedBy: { type: 'panel-user', id: context.user.id },
      reasonCode: 'operator-request',
      now: NOW,
    });
    await context.repositories.audit.append({
      schemaVersion: 1,
      id: randomUUID(),
      occurredAt: NOW.toISOString(),
      correlationId,
      actor: { type: 'panel-user', id: context.user.id },
      source: 'api',
      action: 'server.start',
      resource: { type: 'server-instance', id: context.server.id },
      outcome: 'succeeded',
    });

    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/correlations/${correlationId}`,
      headers: { cookie: context.cookie },
    });

    assert.equal(response.statusCode, 200);
    const view = response.json();
    assert.equal(view.correlationId, correlationId);
    assert.equal(view.operations.length, 1);
    assert.equal(view.operations[0].operationId, accepted.operation.operationId);
    assert.equal(view.auditEvents.length, 1);
    assert.equal(view.auditEvents[0].action, 'server.start');
    assert.deepEqual(view.outboxTopics, ['operation.accepted']);
  });

  it('keeps the correlation and audit views behind the audit permission', async () => {
    const readOnly = await fixture({ role: 'read-only' });

    const correlation = await readOnly.app.inject({
      method: 'GET',
      url: `/api/v1/correlations/${randomUUID()}`,
      headers: { cookie: readOnly.cookie },
    });
    assert.equal(correlation.statusCode, 403);

    const audit = await readOnly.app.inject({
      method: 'GET',
      url: '/api/v1/audit/page',
      headers: { cookie: readOnly.cookie },
    });
    assert.equal(audit.statusCode, 403);

    // Server visibility is enough to read operations, and read-only has it.
    const operations = await readOnly.app.inject({
      method: 'GET',
      url: `${BASE}/${readOnly.server.id}/operations`,
      headers: { cookie: readOnly.cookie },
    });
    assert.equal(operations.statusCode, 200);
  });
});

describe('audit paging', () => {
  it('bounds and filters the audit listing instead of scanning it', async () => {
    const context = await fixture();
    const correlationId = randomUUID();
    for (const action of ['server.start', 'server.stop', 'server.start']) {
      await context.repositories.audit.append({
        schemaVersion: 1,
        id: randomUUID(),
        occurredAt: NOW.toISOString(),
        correlationId,
        actor: { type: 'panel-user', id: context.user.id },
        source: 'api',
        action,
        resource: { type: 'server-instance', id: context.server.id },
        outcome: 'succeeded',
      });
    }

    const filtered = await context.app.inject({
      method: 'GET',
      url: `/api/v1/audit/page?action=server.start&limit=1`,
      headers: { cookie: context.cookie },
    });
    assert.equal(filtered.statusCode, 200);
    assert.equal(filtered.json().total, 2);
    assert.equal(filtered.json().events.length, 1);
    assert.equal(filtered.json().limit, 1);

    const byCorrelation = await context.app.inject({
      method: 'GET',
      url: `/api/v1/audit/page?correlationId=${correlationId}`,
      headers: { cookie: context.cookie },
    });
    assert.equal(byCorrelation.json().total, 3);

    // Neither an oversized page nor a malformed filter is accepted.
    for (const query of ['limit=5000', 'action=Server.Start', 'outcome=whatever']) {
      const response = await context.app.inject({
        method: 'GET',
        url: `/api/v1/audit/page?${query}`,
        headers: { cookie: context.cookie },
      });
      assert.equal(response.statusCode, 400, `expected ${query} to be refused`);
    }
  });
});
