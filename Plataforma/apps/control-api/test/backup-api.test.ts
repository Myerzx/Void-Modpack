import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { hashPassword } from '@voidfall/authentication';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type { FastifyInstance } from 'fastify';

import { buildControlApi } from '../src/app.js';

/**
 * Phase 10.3 backup and restore routes.
 *
 * No repository of bytes exists here and no world is copied: these prove the
 * control plane's side — authorization, the catalogue, the one-in-flight rule,
 * and the preconditions a restore must clear before any agent is asked to
 * overwrite anything.
 */

const resources: Array<{ app: FastifyInstance; database: Database }> = [];
const NOW = new Date('2026-08-05T12:00:00.000Z');

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
  const password = 'backup-api-test-password';
  await repositories.users.create({
    email: `${role}@voidfall.invalid`,
    displayName: `${role} fixture`,
    passwordHash: await hashPassword(password),
    roles: [role],
  });
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'voidfall-backup-test',
    displayName: 'VoidFall Backup Test',
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
    cookie: (login.headers['set-cookie'] as string).split(';')[0] ?? '',
    csrfToken: login.json<{ csrfToken: string }>().csrfToken,
  };
}

type Context = Awaited<ReturnType<typeof fixture>>;

function post(context: Context, url: string, payload: unknown) {
  return context.app.inject({
    method: 'POST',
    url,
    headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
    payload: payload as Record<string, unknown>,
  });
}

const createBody = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  backupId: 'backup-0001',
  scope: 'complete',
  idempotencyKey: 'backup-create-000001',
  reasonCode: 'operator-request',
  ...overrides,
});

/** Records a stop that actually finished, which a restore requires. */
async function completedStop(context: Context, outcome: 'succeeded' | 'failed') {
  const accepted = await context.repositories.operations.accept({
    operationId: randomUUID(),
    serverInstanceId: context.server.id,
    kind: 'server.stop',
    idempotencyKey: `stop-${randomUUID().slice(0, 8)}-0001`,
    correlationId: randomUUID(),
    requestedBy: { type: 'panel-user', id: randomUUID() },
    reasonCode: 'operator-request',
    now: NOW,
  });
  const settled = await context.repositories.operations.settle({
    operationId: accepted.operation.operationId,
    eventId: randomUUID(),
    expectedVersion: accepted.operation.version,
    outcome,
    ...(outcome === 'failed' ? { failureCode: 'operation-failed' as const } : {}),
    observedLifecycle: outcome === 'succeeded' ? 'offline' : 'online',
    now: NOW,
  });
  return settled;
}

/**
 * Marks a backup available so a restore has something legitimate to name.
 *
 * The backup operation is settled as well as the catalogue row: only one
 * operation may be in flight per server, so leaving it running would block the
 * stop a restore requires — which is the rule working, not a test artefact.
 */
async function availableBackup(context: Context, backupId = 'backup-0001') {
  const created = await post(context, `/api/v1/servers/${context.server.id}/backups`, {
    ...createBody({ backupId }),
  });
  assert.equal(created.statusCode, 202);
  await context.repositories.backups.complete({
    backupId,
    sizeBytes: 1_024,
    fileCount: 3,
    manifestSha256: 'a'.repeat(64),
    sealKeyId: 'primary-seal',
    encryptionKeyId: 'primary-cipher',
    now: NOW,
  });
  const page = await context.repositories.operations.list({
    serverInstanceId: context.server.id,
    kinds: ['backup.create'],
    limit: 10,
    offset: 0,
  });
  const operation = page.operations[0];
  if (operation === undefined) throw new Error('the backup operation was not recorded');
  await context.repositories.operations.settle({
    operationId: operation.operationId,
    eventId: randomUUID(),
    expectedVersion: operation.version,
    outcome: 'succeeded',
    observedLifecycle: 'offline',
    now: NOW,
  });
}

async function observeOffline(context: Context): Promise<void> {
  const agentId = randomUUID();
  const tokenHash = 'f'.repeat(64);
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
    certificateFingerprint: 'e'.repeat(64),
    softwareVersion: '0.1.0-test',
    capabilities: ['backup.verify-restore'],
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
}

describe('backup creation', () => {
  it('accepts a durable operation, queues one job and catalogues the backup', async () => {
    const context = await fixture();
    const response = await post(context, `/api/v1/servers/${context.server.id}/backups`, createBody());
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().status, 'creating');
    assert.equal(response.json().backupId, 'backup-0001');
    // Totals are unknown until an agent measures them, and the record says so
    // rather than reporting zero.
    assert.equal(response.json().sizeBytes, null);
    assert.equal(response.json().manifestSha256, null);

    const operations = await context.repositories.operations.list({
      serverInstanceId: context.server.id,
      limit: 10,
      offset: 0,
    });
    assert.equal(operations.operations.length, 1);
    assert.equal(operations.operations[0]?.kind, 'backup.create');
    // The target travels on the operation, so nothing on the queue names it.
    assert.equal(operations.operations[0]?.backupId, 'backup-0001');

    const jobs = await context.database.query('SELECT type, payload FROM jobs');
    assert.equal(jobs.rowCount, 1);
    const serialized = JSON.stringify(jobs.rows[0]);
    for (const forbidden of ['path', 'repository', 'directory', 'key']) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });

  it('refuses a second backup while one is in flight', async () => {
    const context = await fixture();
    assert.equal(
      (await post(context, `/api/v1/servers/${context.server.id}/backups`, createBody())).statusCode,
      202,
    );
    const second = await post(
      context,
      `/api/v1/servers/${context.server.id}/backups`,
      createBody({ backupId: 'backup-0002', idempotencyKey: 'backup-create-000002' }),
    );
    assert.equal(second.statusCode, 409);
  });

  it('refuses reusing a backup identifier', async () => {
    const context = await fixture();
    await availableBackup(context);
    const reused = await post(
      context,
      `/api/v1/servers/${context.server.id}/backups`,
      createBody({ idempotencyKey: 'backup-create-000009' }),
    );
    // A backup id names one snapshot forever; reusing one would make two
    // different worlds share a name.
    assert.equal(reused.statusCode, 409);
  });

  it('refuses a backup from a role that may only look', async () => {
    const context = await fixture({ role: 'read-only' });
    assert.equal(
      (await post(context, `/api/v1/servers/${context.server.id}/backups`, createBody())).statusCode,
      403,
    );
    const listing = await context.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${context.server.id}/backups`,
      headers: { cookie: context.cookie },
    });
    assert.equal(listing.statusCode, 200);
    assert.deepEqual(listing.json().backups, []);
  });
});

describe('restore preconditions', () => {
  const restoreBody = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    backupId: 'backup-0001',
    idempotencyKey: 'backup-restore-00001',
    reasonCode: 'operator-request',
    acknowledgesDataLoss: true,
    afterStopOperationId: randomUUID(),
    verificationBoot: true,
    ...overrides,
  });

  it('requires a preceding stop that actually succeeded', async () => {
    const context = await fixture();
    await availableBackup(context);
    const url = `/api/v1/servers/${context.server.id}/backups/restore`;

    // No such stop.
    assert.equal((await post(context, url, restoreBody())).statusCode, 409);

    // A stop that did not finish is not a stop.
    const failed = await completedStop(context, 'failed');
    assert.equal(
      (await post(context, url, restoreBody({ afterStopOperationId: failed.operationId }))).statusCode,
      409,
    );

    const stopped = await completedStop(context, 'succeeded');
    const accepted = await post(
      context,
      url,
      restoreBody({ afterStopOperationId: stopped.operationId }),
    );
    assert.equal(accepted.statusCode, 202);
    assert.equal(accepted.json().kind, 'backup.restore');
    assert.equal(accepted.json().backupId, 'backup-0001');
  });

  it('will not let a restore be reached by omitting the acknowledgement', async () => {
    const context = await fixture();
    await availableBackup(context);
    const stopped = await completedStop(context, 'succeeded');
    const { acknowledgesDataLoss: _dropped, ...withoutAcknowledgement } = restoreBody({
      afterStopOperationId: stopped.operationId,
    });
    const response = await post(
      context,
      `/api/v1/servers/${context.server.id}/backups/restore`,
      withoutAcknowledgement,
    );
    assert.equal(response.statusCode, 400);
  });

  it('refuses restoring from a backup that is not available', async () => {
    const context = await fixture();
    // Still being written.
    assert.equal(
      (await post(context, `/api/v1/servers/${context.server.id}/backups`, createBody())).statusCode,
      202,
    );
    // The backup operation has to finish before a stop can be accepted: one
    // operation in flight per server, which is the rule under test elsewhere.
    const page = await context.repositories.operations.list({
      serverInstanceId: context.server.id,
      kinds: ['backup.create'],
      limit: 10,
      offset: 0,
    });
    const backupOperation = page.operations[0];
    assert.notEqual(backupOperation, undefined);
    await context.repositories.operations.settle({
      operationId: backupOperation?.operationId ?? '',
      eventId: randomUUID(),
      expectedVersion: backupOperation?.version ?? 1,
      outcome: 'succeeded',
      observedLifecycle: 'offline',
      now: NOW,
    });
    const stopped = await completedStop(context, 'succeeded');
    const response = await post(
      context,
      `/api/v1/servers/${context.server.id}/backups/restore`,
      restoreBody({ afterStopOperationId: stopped.operationId }),
    );
    assert.equal(response.statusCode, 409);

    // And one retention already removed is gone, not missing.
    await context.repositories.backups.complete({
      backupId: 'backup-0001',
      sizeBytes: 1,
      fileCount: 1,
      manifestSha256: 'b'.repeat(64),
      sealKeyId: 'primary-seal',
      encryptionKeyId: null,
      now: NOW,
    });
    await context.repositories.backups.markPruned('backup-0001', NOW);
    const pruned = await post(
      context,
      `/api/v1/servers/${context.server.id}/backups/restore`,
      restoreBody({ afterStopOperationId: stopped.operationId, idempotencyKey: 'backup-restore-00002' }),
    );
    assert.equal(pruned.statusCode, 409);
  });

  it('refuses a restore naming a backup from another server', async () => {
    const context = await fixture();
    await availableBackup(context);
    const otherServer = await context.repositories.servers.create({
      id: randomUUID(),
      slug: 'voidfall-other',
      displayName: 'Other',
      environment: 'test',
      minecraftVersion: '1.20.1',
      loader: 'forge',
      loaderVersion: '1.20.1-47.4.4',
      maxPlayers: 20,
    });
    const stopped = await completedStop(context, 'succeeded');
    const response = await post(
      context,
      `/api/v1/servers/${otherServer.id}/backups/restore`,
      restoreBody({ afterStopOperationId: stopped.operationId }),
    );
    assert.equal(response.statusCode, 404);
  });
});

describe('isolated restore verification', () => {
  const body = {
    schemaVersion: 1,
    backupId: 'backup-0001',
    idempotencyKey: 'backup-verify-restore-0001',
    reasonCode: 'operator-rehearsal',
  };

  it('queues a non-destructive operation only in a current offline window', async () => {
    const context = await fixture();
    await availableBackup(context);
    const url = `/api/v1/servers/${context.server.id}/backups/verify-restore`;
    assert.equal((await post(context, url, body)).statusCode, 409);

    await observeOffline(context);
    const accepted = await post(context, url, body);
    assert.equal(accepted.statusCode, 202);
    assert.equal(accepted.json().kind, 'backup.verify-restore');
    assert.equal(accepted.json().backupId, 'backup-0001');

    const jobs = await context.database.query<{ readonly type: string; readonly payload: unknown }>(
      'SELECT type, payload FROM jobs WHERE type = $1',
      ['backup.verify-restore'],
    );
    assert.equal(jobs.rowCount, 1);
    const serialized = JSON.stringify(jobs.rows[0]);
    for (const forbidden of ['path', 'directory', 'repository', 'restoreRoot']) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });

  it('does not accept destructive or path-bearing fields', async () => {
    const context = await fixture();
    await availableBackup(context);
    await observeOffline(context);
    const response = await post(
      context,
      `/api/v1/servers/${context.server.id}/backups/verify-restore`,
      { ...body, acknowledgesDataLoss: true, restoredRoot: 'H:/private' },
    );
    assert.equal(response.statusCode, 400);
  });
});

describe('the backup catalogue', () => {
  it('will not report a backup as available before it was measured', async () => {
    const context = await fixture();
    await post(context, `/api/v1/servers/${context.server.id}/backups`, createBody());
    // The database refuses the transition rather than storing a half-known
    // "available" row a panel would offer for restore.
    await assert.rejects(
      context.database.query(
        `UPDATE server_backups SET status = 'available' WHERE backup_id = 'backup-0001'`,
      ),
    );
  });

  it('records a failure with its code and keeps the row', async () => {
    const context = await fixture();
    await post(context, `/api/v1/servers/${context.server.id}/backups`, createBody());
    await context.repositories.backups.fail({
      backupId: 'backup-0001',
      failureCode: 'insufficient-space',
      now: NOW,
    });
    const listing = await context.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${context.server.id}/backups`,
      headers: { cookie: context.cookie },
    });
    assert.equal(listing.json().backups[0].status, 'failed');
    assert.equal(listing.json().backups[0].failureCode, 'insufficient-space');
  });
});
