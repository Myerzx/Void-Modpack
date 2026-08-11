import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import {
  computeAgentPayloadHash,
  createOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  signAgentEnvelope,
} from '@voidfall/authentication';
import type { AgentEnvelope } from '@voidfall/contracts';
import {
  createRepositories,
  runMigrations,
  type Database,
} from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type { FastifyInstance } from 'fastify';
import { buildControlApi } from '../src/app.js';

const resources: Array<{ app: FastifyInstance; database: Database }> = [];

afterEach(async () => {
  while (resources.length > 0) {
    const resource = resources.pop();
    if (resource !== undefined) {
      await resource.app.close();
      await resource.database.close();
    }
  }
});

async function fixture(role: 'owner' | 'read-only' = 'owner') {
  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const password = 'control-api-test-password';
  const user = await repositories.users.create({
    email: `${role}@voidfall.invalid`,
    displayName: `${role} fixture`,
    passwordHash: await hashPassword(password),
    roles: [role],
  });
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'voidfall-test',
    displayName: 'VoidFall Test',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '1.20.1-47.4.4',
    maxPlayers: 20,
  });
  const now = new Date('2026-08-03T12:00:00.000Z');
  const app = await buildControlApi({
    database,
    cookieSecure: false,
    clock: () => now,
    agentTransportVerifier: (request, expected) =>
      request.headers['x-test-certificate'] === expected,
  });
  resources.push({ app, database });
  return { app, database, repositories, password, server, user, now };
}

async function login(app: FastifyInstance, email: string, password: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  assert.equal(response.statusCode, 200);
  const setCookie = response.headers['set-cookie'];
  assert.equal(typeof setCookie, 'string');
  return {
    cookie: (setCookie as string).split(';')[0] ?? '',
    body: response.json<{ csrfToken: string }>(),
  };
}

describe('panel sessions and RBAC', () => {
  it('rejects malformed credentials and rate-limits repeated login attempts', async () => {
    const context = await fixture('owner');
    const malformed = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'not-an-email', password: '' },
    });
    assert.equal(malformed.statusCode, 400);

    const statusCodes: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'missing@voidfall.invalid', password: 'invalid-password' },
      });
      statusCodes.push(response.statusCode);
    }
    assert.equal(statusCodes.includes(429), true);
  });

  it('uses opaque cookies, CSRF and revocation for an owner session', async () => {
    const context = await fixture('owner');
    const auth = await login(context.app, 'owner@voidfall.invalid', context.password);
    assert.equal(auth.cookie.includes(context.password), false);

    const servers = await context.app.inject({
      method: 'GET',
      url: '/api/v1/servers',
      headers: { cookie: auth.cookie },
    });
    assert.equal(servers.statusCode, 200);
    assert.equal(servers.json<{ dataQuality: string }>().dataQuality, 'stored');

    const missingCsrf = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: auth.cookie },
    });
    assert.equal(missingCsrf.statusCode, 403);

    const logout = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: auth.cookie, 'x-csrf-token': auth.body.csrfToken },
    });
    assert.equal(logout.statusCode, 204);
    const revoked = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: auth.cookie },
    });
    assert.equal(revoked.statusCode, 401);
  });

  it('denies audit access by default and records the authorization decision', async () => {
    const context = await fixture('read-only');
    const auth = await login(context.app, 'read-only@voidfall.invalid', context.password);
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: { cookie: auth.cookie },
    });
    assert.equal(response.statusCode, 403);
    const events = await context.repositories.audit.list();
    assert.equal(events.some((event) => event.action === 'authorization.denied'), true);
  });
});

describe('agent registration and heartbeat identity', () => {
  it('accepts one provision use and rejects replayed heartbeat nonces', async () => {
    const context = await fixture();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const agentId = randomUUID();
    const provisioningToken = createOpaqueToken();
    const certificateFingerprint = 'c'.repeat(64);
    await context.repositories.agents.createProvisioningToken({
      serverInstanceId: context.server.id,
      tokenHash: hashOpaqueToken(provisioningToken),
      expiresAt: new Date(context.now.getTime() + 60_000),
      createdAt: context.now,
    });
    const registrationPayload = {
      provisioningToken,
      agentId,
      serverInstanceId: context.server.id,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      certificateFingerprint,
      softwareVersion: '0.1.0',
      capabilities: ['heartbeat', 'datapack-load-order.observe'],
    };
    const registration = await context.app.inject({
      method: 'POST',
      url: '/agent/v1/register/complete',
      payload: registrationPayload,
    });
    assert.equal(registration.statusCode, 201);
    const reused = await context.app.inject({
      method: 'POST',
      url: '/agent/v1/register/complete',
      payload: { ...registrationPayload, agentId: randomUUID() },
    });
    assert.equal(reused.statusCode, 401);

    const payload: AgentEnvelope['payload'] = {
      schemaVersion: 1,
      data: {
        status: 'online',
        observedAt: context.now.toISOString(),
        protocolVersion: 1,
        softwareVersion: '0.1.0',
        capabilities: ['heartbeat'],
      },
    };
    const unsigned: Omit<AgentEnvelope, 'signature'> = {
      schemaVersion: 1,
      messageId: randomUUID(),
      correlationId: randomUUID(),
      agentId,
      serverInstanceId: context.server.id,
      kind: 'heartbeat',
      issuedAt: context.now.toISOString(),
      expiresAt: new Date(context.now.getTime() + 60_000).toISOString(),
      nonce: createOpaqueToken(),
      payloadHash: computeAgentPayloadHash({ payload }),
      payload,
    };
    const heartbeat = signAgentEnvelope(unsigned, privateKey, 'agent-test-key');
    const wrongTransport = await context.app.inject({
      method: 'POST',
      url: '/agent/v1/heartbeat',
      headers: { 'x-test-certificate': 'd'.repeat(64) },
      payload: heartbeat,
    });
    assert.equal(wrongTransport.statusCode, 401);
    const invalidSignature = await context.app.inject({
      method: 'POST',
      url: '/agent/v1/heartbeat',
      headers: { 'x-test-certificate': certificateFingerprint },
      payload: {
        ...heartbeat,
        signature: { ...heartbeat.signature, value: 'a'.repeat(86) },
      },
    });
    assert.equal(invalidSignature.statusCode, 401);
    const accepted = await context.app.inject({
      method: 'POST',
      url: '/agent/v1/heartbeat',
      headers: { 'x-test-certificate': certificateFingerprint },
      payload: heartbeat,
    });
    assert.equal(accepted.statusCode, 200);
    const replay = await context.app.inject({
      method: 'POST',
      url: '/agent/v1/heartbeat',
      headers: { 'x-test-certificate': certificateFingerprint },
      payload: heartbeat,
    });
    assert.equal(replay.statusCode, 409);
  });

  it('rejects a heartbeat when transport identity or signature does not match', async () => {
    const context = await fixture();
    const missing = await context.app.inject({
      method: 'POST',
      url: '/agent/v1/heartbeat',
      payload: {},
    });
    assert.equal(missing.statusCode, 400);
  });
});
