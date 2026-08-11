import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { hashPassword } from '@voidfall/authentication';
import { validateDatapackLoadOrderObservationAcceptance } from '@voidfall/contracts';
import {
  ECOSYSTEM_ANALYSIS_SCHEMA_VERSION,
  ECOSYSTEM_ANALYZER_VERSION,
  type EcosystemAnalysis,
} from '@voidfall/ecosystem-analysis';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type { FastifyInstance } from 'fastify';

import { buildControlApi } from '../src/app.js';

const resources: Array<{ app: FastifyInstance; database: Database }> = [];
const NOW = new Date('2026-08-10T21:00:00.000Z');
const INVENTORY_SHA256 = 'a'.repeat(64);
const ANALYSIS_ID = 'b'.repeat(64);
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

function analysisDocument(inventorySha256: string): EcosystemAnalysis {
  return {
    schemaVersion: ECOSYSTEM_ANALYSIS_SCHEMA_VERSION,
    analyzerVersion: ECOSYSTEM_ANALYZER_VERSION,
    analysisId: ANALYSIS_ID,
    inventorySha256,
    generatedAt: NOW.toISOString(),
    mods: [],
    systems: [],
    configurations: [],
    datapacks: [],
    datapackResources: [],
    datapackConflicts: [],
    relationships: [],
    evidence: [],
    issues: [],
    graph: { entities: [], relationshipIds: [] },
    summary: {
      mods: 0,
      systems: 0,
      configurations: 0,
      datapacks: 0,
      datapackResources: 0,
      datapackConflicts: 0,
      relationships: 0,
      issues: 0,
    },
  };
}

async function fixture(options: {
  readonly role?: 'owner' | 'read-only';
  readonly linked?: boolean;
  readonly analysis?: boolean;
} = {}) {
  const role = options.role ?? 'owner';
  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const password = 'datapack-load-order-api-password';
  const email = `${role}-${randomUUID()}@voidfall.invalid`;
  const user = await repositories.users.create({
    email,
    displayName: `${role} datapack fixture`,
    passwordHash: await hashPassword(password),
    roles: [role],
  });
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: `datapack-observation-${randomUUID()}`,
    displayName: 'Datapack observation fixture',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '1.20.1-47.4.4',
    maxPlayers: 20,
  });
  const workspace = await repositories.workspaces.register({
    slug: `datapack-workspace-${randomUUID()}`,
    displayName: 'Datapack workspace fixture',
    rootPath: 'C:\\synthetic-registered-workspace',
    kind: 'server',
    createdBy: { type: 'panel-user', id: user.id },
  });
  if (options.linked !== false) {
    await repositories.servers.setRuntime({
      id: server.id,
      runDirectory: workspace.rootPath,
      runtime: {
        family: 'forge',
        shape: 'args-file',
        entry: 'args.txt',
        evidence: 'synthetic-fixture',
      },
      detectedAt: NOW,
      workspaceId: workspace.workspaceId,
    });
  }
  const inventory = await repositories.workspaces.recordScan({
    workspaceId: workspace.workspaceId,
    inventorySha256: INVENTORY_SHA256,
    totalFiles: 0,
    totalBytes: 0,
    totalMods: 0,
    document: {},
    scannedBy: { type: 'panel-user', id: user.id },
    scannedAt: NOW,
  });
  if (options.analysis !== false) {
    await repositories.ecosystemAnalysis.save({
      workspaceId: workspace.workspaceId,
      inventoryId: inventory.inventoryId,
      document: analysisDocument(INVENTORY_SHA256),
    });
  }

  const app = await buildControlApi({ database, cookieSecure: false, clock: () => NOW });
  resources.push({ app, database });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  assert.equal(login.statusCode, 200);

  return {
    app,
    database,
    repositories,
    server,
    workspace,
    cookie: String(login.headers['set-cookie']).split(';')[0] ?? '',
    csrfToken: login.json<{ csrfToken: string }>().csrfToken,
  };
}

const requestBody = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  analysisId: ANALYSIS_ID,
  expectedInventorySha256: INVENTORY_SHA256,
  idempotencyKey: 'datapack-observation-request-0001',
  reasonCode: 'operator-request',
  ...overrides,
});

describe('datapack load-order observation producer', () => {
  it('resolves the registered workspace and queues only the closed command', async () => {
    const context = await fixture();
    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/datapack-load-order/observations`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: requestBody(),
    });

    assert.equal(response.statusCode, 202);
    const acceptance = response.json();
    assert.equal(validateDatapackLoadOrderObservationAcceptance(acceptance).success, true);
    assert.equal(acceptance.workspaceId, context.workspace.workspaceId);
    assert.equal(acceptance.analysisId, ANALYSIS_ID);
    assert.equal(acceptance.inventorySha256, INVENTORY_SHA256);
    assert.equal(acceptance.replayed, false);

    const job = await context.repositories.jobs.findById(acceptance.jobId as string);
    assert.equal(job?.type, 'datapack-load-order.observe');
    assert.deepEqual(Object.keys(job?.payload.parameters ?? {}), ['command']);
    assert.deepEqual(job?.payload.parameters.command, {
      schemaVersion: 1,
      serverInstanceId: context.server.id,
      workspaceId: context.workspace.workspaceId,
      analysisId: ANALYSIS_ID,
      inventorySha256: INVENTORY_SHA256,
    });
    const serialized = JSON.stringify({ acceptance, payload: job?.payload });
    for (const forbidden of ['rootPath', 'worldPath', 'level.dat', 'filename', 'bytes', 'C:\\']) {
      assert.equal(serialized.includes(forbidden), false);
    }

    const events = await context.repositories.audit.list();
    const accepted = events.find(
      (event) => event.action === 'datapack-load-order.observe.requested',
    );
    assert.equal(accepted?.outcome, 'succeeded');
    assert.equal(accepted?.resource.type, 'ecosystem-analysis');
    assert.equal(accepted?.resource.id, ANALYSIS_ID);
  });

  it('replays the public idempotency key without creating a second job', async () => {
    const context = await fixture();
    const request = {
      method: 'POST' as const,
      url: `${BASE}/${context.server.id}/datapack-load-order/observations`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: requestBody(),
    };
    const first = await context.app.inject(request);
    const replay = await context.app.inject(request);

    assert.equal(first.statusCode, 202);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().replayed, true);
    assert.equal(replay.json().jobId, first.json().jobId);
    assert.equal(replay.json().correlationId, first.json().correlationId);
    assert.equal(replay.json().acceptedAt, first.json().acceptedAt);

    const jobs = await context.database.query<{ readonly count: number | string }>(
      "SELECT COUNT(*) AS count FROM jobs WHERE type = 'datapack-load-order.observe'",
    );
    assert.equal(Number(jobs.rows[0]?.count), 1);
  });

  it('fails closed on an unlinked workspace or stale inventory and audits the refusal', async () => {
    const unlinked = await fixture({ linked: false });
    const missingWorkspace = await unlinked.app.inject({
      method: 'POST',
      url: `${BASE}/${unlinked.server.id}/datapack-load-order/observations`,
      headers: { cookie: unlinked.cookie, 'x-csrf-token': unlinked.csrfToken },
      payload: requestBody({ idempotencyKey: 'datapack-observation-unlinked-01' }),
    });
    assert.equal(missingWorkspace.statusCode, 409);

    const stale = await fixture();
    const staleInventory = await stale.app.inject({
      method: 'POST',
      url: `${BASE}/${stale.server.id}/datapack-load-order/observations`,
      headers: { cookie: stale.cookie, 'x-csrf-token': stale.csrfToken },
      payload: requestBody({
        expectedInventorySha256: 'c'.repeat(64),
        idempotencyKey: 'datapack-observation-stale-0001',
      }),
    });
    assert.equal(staleInventory.statusCode, 409);
    const refused = (await stale.repositories.audit.list()).find(
      (event) => event.action === 'datapack-load-order.observe.requested',
    );
    assert.equal(refused?.outcome, 'failed');
    assert.equal(refused?.reason, 'inventory-mismatch');

    for (const context of [unlinked, stale]) {
      const jobs = await context.database.query<{ readonly count: number | string }>(
        "SELECT COUNT(*) AS count FROM jobs WHERE type = 'datapack-load-order.observe'",
      );
      assert.equal(Number(jobs.rows[0]?.count), 0);
    }
  });

  it('requires the dedicated permission and rejects path-bearing extensions', async () => {
    const readOnly = await fixture({ role: 'read-only' });
    const denied = await readOnly.app.inject({
      method: 'POST',
      url: `${BASE}/${readOnly.server.id}/datapack-load-order/observations`,
      headers: { cookie: readOnly.cookie, 'x-csrf-token': readOnly.csrfToken },
      payload: requestBody({ idempotencyKey: 'datapack-observation-denied-001' }),
    });
    assert.equal(denied.statusCode, 403);
    const authorization = (await readOnly.repositories.audit.list()).find(
      (event) => event.action === 'authorization.denied',
    );
    assert.equal(authorization?.resource.id, 'datapacks.observe');

    const owner = await fixture();
    const pathBearing = await owner.app.inject({
      method: 'POST',
      url: `${BASE}/${owner.server.id}/datapack-load-order/observations`,
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken },
      payload: requestBody({
        idempotencyKey: 'datapack-observation-path-00001',
        worldPath: 'world/level.dat',
      }),
    });
    assert.equal(pathBearing.statusCode, 400);

    for (const context of [readOnly, owner]) {
      const jobs = await context.database.query<{ readonly count: number | string }>(
        "SELECT COUNT(*) AS count FROM jobs WHERE type = 'datapack-load-order.observe'",
      );
      assert.equal(Number(jobs.rows[0]?.count), 0);
    }
  });
});
