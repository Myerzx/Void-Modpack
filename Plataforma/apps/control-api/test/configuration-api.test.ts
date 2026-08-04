import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { hashPassword } from '@voidfall/authentication';
import {
  OPENLOADER_ADVANCED_OPTIONS_V1 as OPENLOADER_SCHEMA_V1,
  hashConfigurationSchema,
} from '@voidfall/configuration-schemas';
import {
  validateConfigurationOperationAcceptance,
  validateConfigurationResourceState,
  validateConfigurationRevisionPage,
  validateConfigurationSchemaCatalog,
  validateConfigurationValidationResult,
} from '@voidfall/contracts';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type { FastifyInstance } from 'fastify';

import { buildControlApi, type ConfigurationValueReader } from '../src/app.js';

const resources: Array<{ app: FastifyInstance; database: Database }> = [];
const NOW = new Date('2026-08-04T12:00:00.000Z');
const RESOURCE_ID = 'openloader-advanced-options';
const BASE = `/api/v1/servers`;

afterEach(async () => {
  while (resources.length > 0) {
    const resource = resources.pop();
    if (resource !== undefined) {
      await resource.app.close();
      await resource.database.close();
    }
  }
});

function digest(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

function openLoaderDocument(dataPacks: boolean, resourcePacks: boolean): string {
  return `${JSON.stringify(
    {
      resourcePacks: { enabled: resourcePacks, additionalFolders: [] },
      dataPacks: { enabled: dataPacks, additionalFolders: [] },
    },
    null,
    2,
  )}\n`;
}

/** In-memory authorized reader standing in for the agent transport. */
function reader(values: Record<string, boolean>, sha256: string): ConfigurationValueReader {
  return {
    async readConfiguration() {
      return { currentSha256: sha256, values };
    },
  };
}

async function fixture(options: {
  readonly role?: 'owner' | 'read-only';
  readonly register?: boolean;
  readonly configurationReader?: ConfigurationValueReader;
} = {}) {
  const role = options.role ?? 'owner';
  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const password = 'configuration-api-test-password';
  const user = await repositories.users.create({
    email: `${role}@voidfall.invalid`,
    displayName: `${role} fixture`,
    passwordHash: await hashPassword(password),
    roles: [role],
  });
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'voidfall-configuration-test',
    displayName: 'VoidFall Configuration Test',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '1.20.1-47.4.4',
    maxPlayers: 20,
  });
  const original = openLoaderDocument(true, true);

  if (options.register !== false) {
    await repositories.configuration.registerSchema({
      revisionId: 'openloader-schema-1',
      schema: OPENLOADER_SCHEMA_V1,
      expectedSchemaSha256: null,
      actorId: user.id,
      reasonCode: 'phase-7-3-fixture',
      createdAt: NOW.toISOString(),
    });
    await repositories.configuration.registerResource({
      serverInstanceId: server.id,
      resourceId: RESOURCE_ID,
      expectedSchemaSha256: hashConfigurationSchema(OPENLOADER_SCHEMA_V1),
      initialCurrentSha256: digest(original),
      createdAt: NOW.toISOString(),
    });
  }

  const app = await buildControlApi({
    database,
    cookieSecure: false,
    clock: () => NOW,
    agentTransportVerifier: (request, expected) =>
      request.headers['x-test-certificate'] === expected,
    ...(options.configurationReader === undefined
      ? {}
      : { configurationReader: options.configurationReader }),
  });
  resources.push({ app, database });

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: `${role}@voidfall.invalid`, password },
  });
  assert.equal(login.statusCode, 200);
  const setCookie = login.headers['set-cookie'];
  assert.equal(typeof setCookie, 'string');

  return {
    app,
    database,
    repositories,
    server,
    user,
    original,
    cookie: (setCookie as string).split(';')[0] ?? '',
    csrfToken: login.json<{ csrfToken: string }>().csrfToken,
  };
}

describe('configuration read endpoints', () => {
  it('lists only the reviewed schema and never a filesystem path', async () => {
    const context = await fixture();
    const response = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/configuration/schemas`,
      headers: { cookie: context.cookie },
    });

    assert.equal(response.statusCode, 200);
    const catalog = response.json();
    assert.equal(validateConfigurationSchemaCatalog(catalog).success, true);
    assert.equal(catalog.schemas.length, 1);
    assert.equal(catalog.schemas[0].resourceId, RESOURCE_ID);
    assert.equal(catalog.schemas[0].registered, true);
    assert.equal(catalog.schemas[0].codecId, 'openloader-advanced-options-v1');
    assert.equal(response.body.includes('config/openloader'), false);
    assert.equal(response.body.includes('advanced_options.json'), false);
  });

  it('reports values as unavailable when no authorized reader is connected', async () => {
    const context = await fixture();
    const response = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}`,
      headers: { cookie: context.cookie },
    });

    assert.equal(response.statusCode, 200);
    const state = response.json();
    assert.equal(validateConfigurationResourceState(state).success, true);
    assert.equal(state.valuesAvailable, false);
    assert.deepEqual(state.values, []);
    assert.equal(state.status, 'registered');
    assert.equal(state.currentSha256, digest(context.original));
    assert.equal(state.restartRequired, true);
  });

  it('publishes reviewed values through an authorized reader', async () => {
    const original = openLoaderDocument(true, true);
    const context = await fixture({
      configurationReader: reader(
        { 'dataPacks.enabled': true, 'resourcePacks.enabled': true },
        digest(original),
      ),
    });
    const response = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}`,
      headers: { cookie: context.cookie },
    });

    const state = response.json();
    assert.equal(validateConfigurationResourceState(state).success, true);
    assert.equal(state.valuesAvailable, true);
    assert.deepEqual(state.values, [
      { name: 'dataPacks.enabled', redacted: false, value: true },
      { name: 'resourcePacks.enabled', redacted: false, value: true },
    ]);
  });

  it('redacts an observation the reviewed policy cannot vouch for', async () => {
    const context = await fixture({
      configurationReader: reader(
        { 'dataPacks.enabled': true, 'rcon.password': 'super-secret' as never },
        digest(openLoaderDocument(true, true)),
      ),
    });
    const response = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}`,
      headers: { cookie: context.cookie },
    });

    assert.equal(response.body.includes('super-secret'), false);
    const state = response.json();
    assert.deepEqual(state.values, [
      { name: 'dataPacks.enabled', redacted: false, value: true },
      { name: 'resourcePacks.enabled', redacted: true },
    ]);
  });

  it('returns an empty revision page before any operation', async () => {
    const context = await fixture();
    const response = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/revisions`,
      headers: { cookie: context.cookie },
    });

    assert.equal(response.statusCode, 200);
    const page = response.json();
    assert.equal(validateConfigurationRevisionPage(page).success, true);
    assert.deepEqual(page.revisions, []);
  });

  it('refuses an unknown resource and an unregistered reviewed resource alike', async () => {
    const registered = await fixture();
    for (const resourceId of ['server-basic', 'openloader-packs']) {
      const response = await registered.app.inject({
        method: 'GET',
        url: `${BASE}/${registered.server.id}/configuration/resources/${resourceId}`,
        headers: { cookie: registered.cookie },
      });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error.code, 'CONFIGURATION_RESOURCE_UNKNOWN');
    }

    const unregistered = await fixture({ register: false });
    const response = await unregistered.app.inject({
      method: 'GET',
      url: `${BASE}/${unregistered.server.id}/configuration/resources/${RESOURCE_ID}`,
      headers: { cookie: unregistered.cookie },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'CONFIGURATION_RESOURCE_UNKNOWN');
  });

  it('rejects a traversal or absolute path in the resource identifier', async () => {
    const context = await fixture();
    for (const resourceId of ['..%2F..%2Fetc%2Fpasswd', 'C%3A%5Cwindows', '%2Fetc%2Fpasswd']) {
      const response = await context.app.inject({
        method: 'GET',
        url: `${BASE}/${context.server.id}/configuration/resources/${resourceId}`,
        headers: { cookie: context.cookie },
      });
      assert.equal(response.statusCode === 400 || response.statusCode === 404, true);
    }
  });
});

describe('configuration authorization', () => {
  it('denies every configuration route to a read-only session and audits it', async () => {
    const context = await fixture({ role: 'read-only' });
    const routes = [
      { method: 'GET' as const, url: `${BASE}/${context.server.id}/configuration/schemas` },
      {
        method: 'GET' as const,
        url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}`,
      },
      {
        method: 'GET' as const,
        url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/revisions`,
      },
    ];
    for (const route of routes) {
      const response = await context.app.inject({ ...route, headers: { cookie: context.cookie } });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error.code, 'PERMISSION_DENIED');
    }

    const apply = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/apply`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: {
        schemaVersion: 1,
        expectedCurrentSha256: digest(context.original),
        expectedStateVersion: 1,
        idempotencyKey: 'configuration-apply-denied-1',
        reasonCode: 'operator-request',
        changes: [{ name: 'dataPacks.enabled', value: false }],
      },
    });
    assert.equal(apply.statusCode, 403);

    const events = await context.repositories.audit.list();
    assert.equal(
      events.some((event) => event.action === 'authorization.denied'),
      true,
    );
    // A denied mutation must not have queued anything.
    const jobs = await context.database.query('SELECT id FROM jobs');
    assert.equal(jobs.rowCount, 0);
  });

  it('requires an authenticated session and a CSRF token for every mutation', async () => {
    const context = await fixture();
    const payload = {
      schemaVersion: 1,
      expectedCurrentSha256: digest(context.original),
      expectedStateVersion: 1,
      idempotencyKey: 'configuration-apply-csrf-1',
      reasonCode: 'operator-request',
      changes: [{ name: 'dataPacks.enabled', value: false }],
    };

    const anonymous = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/apply`,
      payload,
    });
    assert.equal(anonymous.statusCode, 401);

    const missingCsrf = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/apply`,
      headers: { cookie: context.cookie },
      payload,
    });
    assert.equal(missingCsrf.statusCode, 403);
    assert.equal(missingCsrf.json().error.code, 'CSRF_INVALID');

    const wrongCsrf = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/apply`,
      headers: { cookie: context.cookie, 'x-csrf-token': 'not-the-token' },
      payload,
    });
    assert.equal(wrongCsrf.statusCode, 403);

    const jobs = await context.database.query('SELECT id FROM jobs');
    assert.equal(jobs.rowCount, 0);
  });
});

describe('configuration validation without application', () => {
  it('validates a change set without queueing work or creating a revision', async () => {
    const original = openLoaderDocument(true, true);
    const context = await fixture({
      configurationReader: reader(
        { 'dataPacks.enabled': true, 'resourcePacks.enabled': true },
        digest(original),
      ),
    });

    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/validate`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: { schemaVersion: 1, changes: [{ name: 'dataPacks.enabled', value: false }] },
    });

    assert.equal(response.statusCode, 200);
    const result = response.json();
    assert.equal(validateConfigurationValidationResult(result).success, true);
    assert.equal(result.applied, false);
    assert.equal(result.valid, true);
    assert.deepEqual(result.issues, []);
    assert.equal(result.restartRequired, true);
    assert.deepEqual(result.changedFields, ['dataPacks.enabled']);

    const jobs = await context.database.query('SELECT id FROM jobs');
    assert.equal(jobs.rowCount, 0);
    const revisions = await context.database.query('SELECT revision_id FROM configuration_revisions');
    assert.equal(revisions.rowCount, 0);
    const state = await context.repositories.configuration.state(context.server.id, RESOURCE_ID);
    assert.equal(state?.status, 'registered');
    assert.equal(state?.version, 1);
  });

  it('reports an unknown field and a wrong type as typed issues', async () => {
    const context = await fixture();
    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/validate`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: {
        schemaVersion: 1,
        changes: [
          { name: 'rcon.password', value: 'secret' },
          { name: 'dataPacks.enabled', value: 'yes' },
        ],
      },
    });

    assert.equal(response.statusCode, 200);
    const result = response.json();
    assert.equal(result.valid, false);
    assert.equal(result.applied, false);
    assert.deepEqual(result.changedFields, null);
    assert.deepEqual(result.issues, [
      { field: 'rcon.password', code: 'unknown-field' },
      { field: 'dataPacks.enabled', code: 'invalid-type' },
    ]);
    assert.equal(response.body.includes('secret'), false);
  });

  it('refuses a duplicated field at the boundary instead of resolving it', async () => {
    const context = await fixture();
    // The contract treats a repeated field as malformed: silently keeping the
    // first or last value would let a caller smuggle an unreviewed intent.
    const duplicated = [
      { name: 'dataPacks.enabled', value: true },
      { name: 'dataPacks.enabled', value: false },
    ];
    for (const url of [
      `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/validate`,
      `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/apply`,
    ]) {
      const response = await context.app.inject({
        method: 'POST',
        url,
        headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
        payload: url.endsWith('/validate')
          ? { schemaVersion: 1, changes: duplicated }
          : {
              schemaVersion: 1,
              expectedCurrentSha256: digest(context.original),
              expectedStateVersion: 1,
              idempotencyKey: 'configuration-apply-duplicate-1',
              reasonCode: 'operator-request',
              changes: duplicated,
            },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'CONFIGURATION_REQUEST_INVALID');
    }
    const jobs = await context.database.query('SELECT id FROM jobs');
    assert.equal(jobs.rowCount, 0);
  });

  it('says the diff is unknown rather than empty without a reader', async () => {
    const context = await fixture();
    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/validate`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: { schemaVersion: 1, changes: [{ name: 'dataPacks.enabled', value: false }] },
    });

    const result = response.json();
    assert.equal(result.valid, true);
    assert.deepEqual(result.changedFields, null);
  });

  it('refuses an extensible payload at the boundary', async () => {
    const context = await fixture();
    const payloads = [
      { schemaVersion: 1, changes: [{ name: 'dataPacks.enabled', value: false }], extra: 1 },
      { schemaVersion: 1, changes: { 'dataPacks.enabled': false } },
      { schemaVersion: 1, changes: [{ name: 'dataPacks.enabled', value: { nested: true } }] },
      { schemaVersion: 2, changes: [{ name: 'dataPacks.enabled', value: false }] },
      { schemaVersion: 1, changes: [] },
    ];
    for (const payload of payloads) {
      const response = await context.app.inject({
        method: 'POST',
        url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/validate`,
        headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
        payload,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
  });
});

describe('configuration apply and rollback acceptance', () => {
  function applyPayload(context: Awaited<ReturnType<typeof fixture>>, key: string) {
    return {
      schemaVersion: 1,
      expectedCurrentSha256: digest(context.original),
      expectedStateVersion: 1,
      idempotencyKey: key,
      reasonCode: 'operator-request',
      changes: [{ name: 'dataPacks.enabled', value: false }],
    };
  }

  it('queues exactly one typed command and audits the request', async () => {
    const context = await fixture();
    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/apply`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: applyPayload(context, 'configuration-apply-0001'),
    });

    assert.equal(response.statusCode, 202);
    const acceptance = response.json();
    assert.equal(validateConfigurationOperationAcceptance(acceptance).success, true);
    assert.equal(acceptance.replayed, false);
    assert.equal(acceptance.operation, 'update');
    assert.equal(acceptance.status, 'queued');

    const job = await context.repositories.jobs.findById(acceptance.jobId);
    assert.equal(job?.type, 'configuration.apply');
    // The queued payload carries the typed command only: no root and no path.
    const serialized = JSON.stringify(job?.payload);
    assert.equal(serialized.includes('advanced_options.json'), false);
    assert.equal(serialized.includes('configurationRoot'), false);
    assert.equal(Object.keys(job?.payload.parameters ?? {}).length, 1);

    const events = await context.repositories.audit.list();
    const applied = events.find((event) => event.action === 'configuration.apply');
    assert.equal(applied?.outcome, 'succeeded');
    assert.equal(applied?.resource.type, 'configuration-resource');
    // The audit trail records the request without any configuration value.
    assert.equal(JSON.stringify(events).includes('dataPacks.enabled'), false);
  });

  it('replays the same idempotency key without creating a second job', async () => {
    const context = await fixture();
    const payload = applyPayload(context, 'configuration-apply-replay-1');
    const first = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/apply`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload,
    });
    const second = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/apply`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload,
    });

    assert.equal(first.statusCode, 202);
    assert.equal(second.statusCode, 200);
    assert.equal(first.json().jobId, second.json().jobId);
    assert.equal(first.json().revisionId, second.json().revisionId);
    assert.equal(second.json().replayed, true);
    const jobs = await context.database.query('SELECT id FROM jobs');
    assert.equal(jobs.rowCount, 1);
  });

  it('refuses the same key reused for a different request', async () => {
    const context = await fixture();
    await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/apply`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: applyPayload(context, 'configuration-apply-conflict-1'),
    });
    const different = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/apply`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: {
        ...applyPayload(context, 'configuration-apply-conflict-1'),
        changes: [{ name: 'resourcePacks.enabled', value: false }],
      },
    });

    assert.equal(different.statusCode, 409);
    assert.equal(different.json().error.code, 'CONFIGURATION_IDEMPOTENCY_CONFLICT');
    const jobs = await context.database.query('SELECT id FROM jobs');
    assert.equal(jobs.rowCount, 1);
  });

  it('rejects a stale expected hash or state version without queueing', async () => {
    const context = await fixture();
    const staleHash = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/apply`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: {
        ...applyPayload(context, 'configuration-apply-stale-1'),
        expectedCurrentSha256: 'f'.repeat(64),
      },
    });
    const staleVersion = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/apply`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: { ...applyPayload(context, 'configuration-apply-stale-2'), expectedStateVersion: 9 },
    });

    assert.equal(staleHash.statusCode, 409);
    assert.equal(staleHash.json().error.code, 'CONFIGURATION_STATE_STALE');
    assert.equal(staleVersion.statusCode, 409);
    const jobs = await context.database.query('SELECT id FROM jobs');
    assert.equal(jobs.rowCount, 0);
  });

  it('rejects a change set the reviewed schema does not accept', async () => {
    const context = await fixture();
    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/apply`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: {
        ...applyPayload(context, 'configuration-apply-invalid-1'),
        changes: [{ name: 'rcon.password', value: 'secret' }],
      },
    });

    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'CONFIGURATION_CHANGES_INVALID');
    assert.equal(response.body.includes('secret'), false);
    const jobs = await context.database.query('SELECT id FROM jobs');
    assert.equal(jobs.rowCount, 0);
  });

  it('accepts rollback only for an applied revision of the same resource', async () => {
    const context = await fixture();
    const missing = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/rollback`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: {
        schemaVersion: 1,
        targetRevisionId: 'never-existed',
        expectedCurrentSha256: digest(context.original),
        expectedStateVersion: 1,
        idempotencyKey: 'configuration-rollback-missing-1',
        reasonCode: 'operator-request',
      },
    });

    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'CONFIGURATION_REVISION_NOT_ELIGIBLE');
    const jobs = await context.database.query('SELECT id FROM jobs');
    assert.equal(jobs.rowCount, 0);
  });

  it('never returns a stack trace, path or internal message on failure', async () => {
    const context = await fixture();
    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/configuration/resources/${RESOURCE_ID}/apply`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: { ...applyPayload(context, 'configuration-apply-sanitized-1'), expectedStateVersion: 9 },
    });

    const body = response.body;
    assert.equal(body.includes('H:\\'), false);
    assert.equal(body.includes('/home/'), false);
    assert.equal(body.includes('at Object'), false);
    assert.equal(body.includes('node_modules'), false);
    const error = response.json().error;
    assert.deepEqual(Object.keys(error).sort(), ['code', 'correlationId', 'details', 'message']);
    assert.deepEqual(error.details, []);
  });
});
