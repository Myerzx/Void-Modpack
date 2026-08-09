import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { hashPassword } from '@voidfall/authentication';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type { FastifyInstance } from 'fastify';

import { buildControlApi } from '../src/app.js';

/**
 * Phase 10.1 process and console routes.
 *
 * No Minecraft process is involved: these prove the control plane's side —
 * authorization, idempotency, one operation in flight, the closed catalogue
 * and the separate force-kill flow.
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
  const password = 'process-api-test-password';
  const user = await repositories.users.create({
    email: `${role}@voidfall.invalid`,
    displayName: `${role} fixture`,
    passwordHash: await hashPassword(password),
    roles: [role],
  });
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'voidfall-process-test',
    displayName: 'VoidFall Process Test',
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

const control = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  action: 'start',
  idempotencyKey: 'process-control-0001',
  reasonCode: 'operator-request',
  timeoutSeconds: 60,
  ...overrides,
});

describe('process control', () => {
  it('accepts a durable operation and queues exactly one job', async () => {
    const context = await fixture();
    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/process/control`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: control(),
    });

    assert.equal(response.statusCode, 202);
    assert.equal(response.json().kind, 'server.start');
    assert.equal(response.json().status, 'running');
    assert.notEqual(response.json().jobId, null);

    const job = await context.repositories.jobs.findById(response.json().jobId as string);
    assert.equal(job?.type, 'server.start');
    // The request carried no path, executable or command anywhere.
    const serialized = JSON.stringify(job?.payload);
    for (const forbidden of ['path', 'executable', 'cwd', 'command', 'java']) {
      assert.equal(serialized.includes(forbidden), false);
    }
  });

  it('never exposes the previous online pid as current while a restart is in flight', async () => {
    const context = await fixture();
    const agentId = randomUUID();
    await context.repositories.agents.createProvisioningToken({
      serverInstanceId: context.server.id,
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(NOW.getTime() + 60_000),
      createdAt: NOW,
    });
    await context.repositories.agents.register({
      agentId,
      serverInstanceId: context.server.id,
      tokenHash: 'a'.repeat(64),
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
      certificateFingerprint: 'b'.repeat(64),
      softwareVersion: '0.1.0-test',
      capabilities: ['process.control'],
      now: NOW,
    });
    const oldBootId = randomUUID();
    await context.repositories.processStates.observe({
      serverInstanceId: context.server.id,
      eventId: randomUUID(),
      lifecycle: 'online',
      observedBy: agentId,
      observedPid: 4242,
      bootId: oldBootId,
      correlationId: randomUUID(),
      now: NOW,
    });

    const restartPayload = control({
      action: 'restart',
      idempotencyKey: 'process-restart-transition-0001',
    });
    const accepted = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/process/control`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: restartPayload,
    });
    assert.equal(accepted.statusCode, 202);

    const duringRestart = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/process-state`,
      headers: { cookie: context.cookie },
    });
    assert.equal(duringRestart.statusCode, 200);
    assert.deepEqual(
      {
        lifecycle: duringRestart.json().lifecycle,
        observedPid: duringRestart.json().observedPid,
        bootId: duringRestart.json().bootId,
        observedBy: duringRestart.json().observedBy,
        stale: duringRestart.json().stale,
      },
      {
        lifecycle: 'unknown',
        observedPid: null,
        bootId: null,
        observedBy: null,
        stale: true,
      },
    );

    const replacementBootId = randomUUID();
    await context.repositories.processStates.observe({
      serverInstanceId: context.server.id,
      eventId: randomUUID(),
      lifecycle: 'online',
      observedBy: agentId,
      observedPid: 8484,
      bootId: replacementBootId,
      correlationId: accepted.json().correlationId as string,
      now: new Date(NOW.getTime() + 60_000),
    });

    // An honest retry returns the existing operation and cannot stale the new
    // readiness observation or resurrect the previous PID.
    const replay = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/process/control`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: restartPayload,
    });
    assert.equal(replay.statusCode, 202);
    assert.equal(replay.json().operationId, accepted.json().operationId);

    const afterReadiness = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/process-state`,
      headers: { cookie: context.cookie },
    });
    assert.equal(afterReadiness.json().lifecycle, 'online');
    assert.equal(afterReadiness.json().observedPid, 8484);
    assert.equal(afterReadiness.json().bootId, replacementBootId);
    assert.equal(afterReadiness.json().stale, false);
  });

  it('replays an idempotent request without a second operation or job', async () => {
    const context = await fixture();
    const first = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/process/control`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: control(),
    });
    const second = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/process/control`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: control(),
    });

    assert.equal(second.statusCode, 202);
    assert.equal(second.json().operationId, first.json().operationId);
    const jobs = await context.database.query<{ readonly count: string | number }>(
      "SELECT COUNT(*) AS count FROM jobs WHERE type = 'server.start'",
    );
    assert.equal(Number(jobs.rows[0]?.count), 1);
  });

  it('refuses a second operation while one is in flight', async () => {
    const context = await fixture();
    await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/process/control`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: control(),
    });
    const conflicting = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/process/control`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: control({ action: 'stop', idempotencyKey: 'process-control-0002' }),
    });

    assert.equal(conflicting.statusCode, 409);
    assert.equal(conflicting.json().error.code, 'PROCESS_OPERATION_IN_FLIGHT');
  });

  it('returns a state conflict without queuing work when restart is already impossible', async () => {
    const context = await fixture();
    const agentId = randomUUID();
    const tokenHash = 'a'.repeat(64);
    await context.repositories.agents.createProvisioningToken({
      serverInstanceId: context.server.id,
      tokenHash,
      expiresAt: new Date(NOW.getTime() + 60_000),
      createdAt: NOW,
    });
    await context.repositories.agents.register({
      agentId,
      serverInstanceId: context.server.id,
      tokenHash,
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
      certificateFingerprint: 'b'.repeat(64),
      softwareVersion: '0.1.0-test',
      capabilities: ['process.control'],
      now: NOW,
    });
    await context.repositories.processStates.observe({
      serverInstanceId: context.server.id,
      eventId: randomUUID(),
      lifecycle: 'offline',
      observedBy: agentId,
      correlationId: randomUUID(),
      now: NOW,
    });

    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/process/control`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: control({ action: 'restart', idempotencyKey: 'process-restart-offline-0001' }),
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'PROCESS_STATE_CONFLICT');
    const counts = await context.database.query<{
      readonly operations: string | number;
      readonly jobs: string | number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM server_operations) AS operations,
         (SELECT COUNT(*) FROM jobs) AS jobs`,
    );
    assert.equal(Number(counts.rows[0]?.operations), 0);
    assert.equal(Number(counts.rows[0]?.jobs), 0);
    const stillOffline = await context.repositories.processStates.find(context.server.id);
    assert.equal(stillOffline?.lifecycle, 'offline');
    assert.equal(stillOffline?.stale, false);
  });

  it('binds each action to its own permission', async () => {
    const readOnly = await fixture({ role: 'read-only' });
    const denied = await readOnly.app.inject({
      method: 'POST',
      url: `${BASE}/${readOnly.server.id}/process/control`,
      headers: { cookie: readOnly.cookie, 'x-csrf-token': readOnly.csrfToken },
      payload: control(),
    });
    assert.equal(denied.statusCode, 403);
  });

  it('requires CSRF on every mutation', async () => {
    const context = await fixture();
    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/process/control`,
      headers: { cookie: context.cookie, 'x-csrf-token': 'not-the-token' },
      payload: control(),
    });
    assert.equal(response.statusCode, 403);
  });
});

describe('force kill', () => {
  const forceKill = (afterId: string, overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    idempotencyKey: 'process-force-kill-0001',
    reasonCode: 'unresponsive-process',
    acknowledgesDataLoss: true,
    afterGracefulOperationId: afterId,
    ...overrides,
  });

  it('refuses a kill that no graceful stop precedes', async () => {
    const context = await fixture();
    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/process/force-kill`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: forceKill(randomUUID()),
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'PROCESS_FORCE_REQUIRES_STOP');
  });

  it('refuses a kill while the graceful stop has not failed', async () => {
    const context = await fixture();
    const stop = await context.repositories.operations.accept({
      operationId: randomUUID(),
      serverInstanceId: context.server.id,
      kind: 'server.stop',
      idempotencyKey: 'process-stop-pending-01',
      correlationId: randomUUID(),
      requestedBy: { type: 'panel-user', id: context.user.id },
      reasonCode: 'operator-request',
      now: NOW,
    });

    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/process/force-kill`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: forceKill(stop.operation.operationId),
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'PROCESS_FORCE_NOT_JUSTIFIED');
  });

  it('accepts a kill only after the graceful stop actually failed', async () => {
    const context = await fixture();
    const stop = await context.repositories.operations.accept({
      operationId: randomUUID(),
      serverInstanceId: context.server.id,
      kind: 'server.stop',
      idempotencyKey: 'process-stop-failed-01',
      correlationId: randomUUID(),
      requestedBy: { type: 'panel-user', id: context.user.id },
      reasonCode: 'operator-request',
      now: NOW,
    });
    await context.repositories.operations.settle({
      operationId: stop.operation.operationId,
      eventId: randomUUID(),
      expectedVersion: stop.operation.version,
      outcome: 'failed',
      failureCode: 'timed-out',
      observedLifecycle: 'stopping',
      now: NOW,
    });

    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/process/force-kill`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: forceKill(stop.operation.operationId),
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().kind, 'server.force-kill');
  });

  it('refuses a kill that does not acknowledge data loss', async () => {
    const context = await fixture();
    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/process/force-kill`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: forceKill(randomUUID(), { acknowledgesDataLoss: false }),
    });
    // The schema refuses it before any of the flow runs.
    assert.equal(response.statusCode, 400);
  });

  it('keeps force kill behind its own permission', async () => {
    // administrator holds every permission except the four reserved ones,
    // and server.control.force is one of them.
    const database = await createPGliteTestDatabase();
    await runMigrations(database);
    const repositories = createRepositories(database);
    const password = 'process-api-test-password';
    await repositories.users.create({
      email: 'administrator@voidfall.invalid',
      displayName: 'administrator fixture',
      passwordHash: await hashPassword(password),
      roles: ['administrator'],
    });
    const server = await repositories.servers.create({
      id: randomUUID(),
      slug: 'voidfall-force-test',
      displayName: 'Force Test',
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
      payload: { email: 'administrator@voidfall.invalid', password },
    });
    const cookie = (login.headers['set-cookie'] as string).split(';')[0] ?? '';

    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/${server.id}/process/force-kill`,
      headers: { cookie, 'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken },
      payload: forceKill(randomUUID()),
    });
    assert.equal(response.statusCode, 403);
  });
});

describe('console', () => {
  it('publishes the closed catalogue and refuses anything outside it', async () => {
    const context = await fixture();
    const catalogue = await context.app.inject({
      method: 'GET',
      url: '/api/v1/console/commands',
      headers: { cookie: context.cookie },
    });
    assert.equal(catalogue.statusCode, 200);
    assert.deepEqual(catalogue.json().commands, ['list-players', 'save-all']);

    const refused = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/console/command`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: {
        schemaVersion: 1,
        command: 'op voidfall',
        idempotencyKey: 'console-command-0001',
        reasonCode: 'operator-request',
      },
    });
    assert.equal(refused.statusCode, 400);
  });

  it('reads the console forward by cursor', async () => {
    const context = await fixture();
    await context.repositories.console.append({
      serverInstanceId: context.server.id,
      lines: [
        { stream: 'stdout', text: 'primeira', occurredAt: NOW },
        { stream: 'stdout', text: 'segunda', occurredAt: NOW },
      ],
      retainLines: 100,
      now: NOW,
    });

    const page = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/console?limit=1`,
      headers: { cookie: context.cookie },
    });
    assert.equal(page.statusCode, 200);
    assert.equal(page.json().lines.length, 1);
    assert.equal(page.json().hasMore, true);

    const next = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/console?from=${String(page.json().nextCursor)}`,
      headers: { cookie: context.cookie },
    });
    assert.equal(next.json().lines[0].text, 'segunda');
  });

  it('opens the console at its newest window', async () => {
    const context = await fixture();
    await context.repositories.console.append({
      serverInstanceId: context.server.id,
      lines: ['one', 'two', 'three'].map((text) => ({
        stream: 'stdout' as const,
        text,
        occurredAt: NOW,
      })),
      retainLines: 100,
      now: NOW,
    });

    const response = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/console?tail=true&limit=2`,
      headers: { cookie: context.cookie },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().lines.map((line: { text: string }) => line.text), [
      'two',
      'three',
    ]);
    assert.equal(response.json().nextCursor, 4);

    const conflicting = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/console?tail=true&from=1`,
      headers: { cookie: context.cookie },
    });
    assert.equal(conflicting.statusCode, 400);
  });

  it('refuses a malformed cursor or an oversized page', async () => {
    const context = await fixture();
    for (const query of ['from=abc', 'limit=9999', 'from=0']) {
      const response = await context.app.inject({
        method: 'GET',
        url: `${BASE}/${context.server.id}/console?${query}`,
        headers: { cookie: context.cookie },
      });
      assert.equal(response.statusCode, 400, `expected ${query} to be refused`);
    }
  });
});
