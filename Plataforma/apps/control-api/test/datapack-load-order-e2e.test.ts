import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { hashPassword } from '@voidfall/authentication';
import { validateDatapackLoadOrderObservationAcceptance } from '@voidfall/contracts';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import {
  ECOSYSTEM_ANALYSIS_SCHEMA_VERSION,
  ECOSYSTEM_ANALYZER_VERSION,
  type EcosystemAnalysis,
} from '@voidfall/ecosystem-analysis';
import type {
  MinecraftProcessAdapter,
  ProcessLaunchPlan,
  ProcessObservation,
} from '@voidfall/minecraft-process';
import type { FastifyInstance } from 'fastify';

import { worldMetadataNbt } from '../../../packages/ecosystem-analysis/test/fixtures/world-metadata-nbt-v1/corpus.js';
import type { AgentFetch, AgentIdentity } from '../../server-agent/src/agent-client.js';
import {
  AGENT_DATAPACK_LOAD_ORDER_CAPABILITY,
  DatapackLoadOrderObservationCapability,
  createDatapackLoadOrderObservationHandler,
} from '../../server-agent/src/datapack-load-order-operation.js';
import { AgentSupervisor } from '../../server-agent/src/supervisor.js';
import { AgentWorkTransport } from '../../server-agent/src/work-transport.js';
import { buildControlApi } from '../src/app.js';

/**
 * Synthetic end-to-end proof for the effective datapack order boundary:
 *
 *   authenticated POST -> durable job -> signed claim/lease -> real agent
 *   handler -> bounded temporary level.dat -> observation + audit persistence.
 *
 * The only filesystem evidence is generated in an OS temporary directory.
 * No private Minecraft runtime is read, written, started or stopped.
 */

const NOW = new Date('2026-08-10T22:00:00.000Z');
const INVENTORY_SHA256 = 'a'.repeat(64);
const ANALYSIS_ID = 'b'.repeat(64);
const PUBLIC_IDEMPOTENCY_KEY = 'datapack-observation-e2e-0001';

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()?.();
});

function analysis(): EcosystemAnalysis {
  return {
    schemaVersion: ECOSYSTEM_ANALYSIS_SCHEMA_VERSION,
    analyzerVersion: ECOSYSTEM_ANALYZER_VERSION,
    analysisId: ANALYSIS_ID,
    inventorySha256: INVENTORY_SHA256,
    generatedAt: NOW.toISOString(),
    mods: [],
    systems: [],
    configurations: [],
    datapacks: [
      {
        datapackId: 'datapack:mns',
        name: 'cte_mns',
        loader: 'openloader',
        rootPath: 'config/openloader/data/cte_mns',
        sha256: 'c'.repeat(64),
        description: null,
        resourceIds: [],
        namespaces: [],
        ownerModId: null,
        relatedModIds: [],
        issueIds: [],
        conflictIds: [],
        evidenceIds: [],
      },
      {
        datapackId: 'datapack:overlay',
        name: 'cte_overlay',
        loader: 'openloader',
        rootPath: 'config/openloader/data/cte_overlay',
        sha256: 'd'.repeat(64),
        description: null,
        resourceIds: [],
        namespaces: [],
        ownerModId: null,
        relatedModIds: [],
        issueIds: [],
        conflictIds: [],
        evidenceIds: [],
      },
    ],
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
      datapacks: 2,
      datapackResources: 0,
      datapackConflicts: 0,
      relationships: 0,
      issues: 0,
    },
  };
}

class OfflineAdapter implements MinecraftProcessAdapter {
  public inspections = 0;

  public async inspect(): Promise<ProcessObservation> {
    this.inspections += 1;
    return { state: 'offline', observedAt: NOW.toISOString(), source: 'process-adapter' };
  }

  public async start(_plan: ProcessLaunchPlan): Promise<ProcessObservation> {
    throw new Error('Datapack observation must never start Minecraft.');
  }

  public async requestGracefulStop(): Promise<ProcessObservation> {
    throw new Error('Datapack observation must never stop Minecraft.');
  }

  public readOutput(): never {
    throw new Error('Datapack observation must never read console output.');
  }
}

async function stack() {
  const root = await mkdtemp(join(tmpdir(), 'voidfall-datapack-observation-e2e-'));
  await mkdir(join(root, 'world'));
  await writeFile(
    join(root, 'world', 'level.dat'),
    worldMetadataNbt({ enabled: ['vanilla', 'data/cte_mns', 'data/cte_overlay'] }),
  );

  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const password = 'datapack-observation-e2e-password';
  const email = 'owner-datapack-e2e@voidfall.invalid';
  const user = await repositories.users.create({
    email,
    displayName: 'Owner datapack E2E',
    passwordHash: await hashPassword(password),
    roles: ['owner'],
  });
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'datapack-observation-e2e',
    displayName: 'Datapack observation E2E',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '1.20.1-47.4.4',
    maxPlayers: 20,
  });
  const workspace = await repositories.workspaces.register({
    slug: 'datapack-observation-e2e-workspace',
    displayName: 'Datapack observation E2E workspace',
    rootPath: root,
    kind: 'server',
    createdBy: { type: 'panel-user', id: user.id },
  });
  await repositories.servers.setRuntime({
    id: server.id,
    runDirectory: root,
    runtime: { family: 'forge', shape: 'args-file', entry: 'args.txt', evidence: 'e2e' },
    detectedAt: NOW,
    workspaceId: workspace.workspaceId,
  });
  const inventory = await repositories.workspaces.recordScan({
    workspaceId: workspace.workspaceId,
    inventorySha256: INVENTORY_SHA256,
    totalFiles: 1,
    totalBytes: 1,
    totalMods: 0,
    document: {},
    scannedBy: { type: 'panel-user', id: user.id },
    scannedAt: NOW,
  });
  await repositories.ecosystemAnalysis.save({
    workspaceId: workspace.workspaceId,
    inventoryId: inventory.inventoryId,
    document: analysis(),
  });

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const agentId = randomUUID();
  const fingerprint = 'e'.repeat(64);
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
      JSON.stringify(['heartbeat', AGENT_DATAPACK_LOAD_ORDER_CAPABILITY]),
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
    capability: AGENT_DATAPACK_LOAD_ORDER_CAPABILITY,
    grantedBy: { type: 'system', id: 'synthetic-e2e' },
    reasonCode: 'synthetic-e2e-explicit-grant',
    now: NOW,
  });

  const app: FastifyInstance = await buildControlApi({
    database,
    cookieSecure: false,
    clock: () => NOW,
    agentTransportVerifier: (request, expected) =>
      request.headers['x-test-certificate'] === expected,
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  const csrfToken = login.json<{ csrfToken: string }>().csrfToken;

  const identity: AgentIdentity = {
    agentId,
    serverInstanceId: server.id,
    privateKey,
    keyId: 'datapack-observation-e2e-key',
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
  const adapter = new OfflineAdapter();
  const capability = new DatapackLoadOrderObservationCapability({
    repositories,
    processAdapter: adapter,
    serverInstanceId: server.id,
    agentId,
    runtime: { workspaceId: workspace.workspaceId, workspaceRoot: root },
    clock: () => NOW,
  });
  const supervisor = new AgentSupervisor({
    identity,
    transport,
    handlers: {
      [AGENT_DATAPACK_LOAD_ORDER_CAPABILITY]: createDatapackLoadOrderObservationHandler({
        repositories,
        capability,
        serverInstanceId: server.id,
        clock: () => NOW,
      }),
    },
    clock: () => NOW,
  });

  teardown.push(async () => {
    await app.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  });

  return {
    app,
    database,
    repositories,
    server,
    workspace,
    root,
    adapter,
    supervisor,
    authHeaders: { cookie, 'x-csrf-token': csrfToken },
  };
}

const requestBody = {
  schemaVersion: 1,
  analysisId: ANALYSIS_ID,
  expectedInventorySha256: INVENTORY_SHA256,
  idempotencyKey: PUBLIC_IDEMPOTENCY_KEY,
  reasonCode: 'operator-request',
};

describe('datapack load-order synthetic end-to-end flow', () => {
  it('carries the POST through lease and handler into one persisted observation and audit trail', async () => {
    const context = await stack();
    const request = {
      method: 'POST' as const,
      url: `/api/v1/servers/${context.server.id}/datapack-load-order/observations`,
      headers: context.authHeaders,
      payload: requestBody,
    };

    const accepted = await context.app.inject(request);
    assert.equal(accepted.statusCode, 202);
    assert.equal(validateDatapackLoadOrderObservationAcceptance(accepted.json()).success, true);
    assert.equal(accepted.json().replayed, false);

    const jobId = accepted.json<{ jobId: string }>().jobId;
    assert.equal((await context.repositories.jobs.findById(jobId))?.status, 'queued');

    assert.equal(await context.supervisor.runOnce(), 0);
    assert.equal((await context.repositories.jobs.findById(jobId))?.status, 'succeeded');
    assert.equal(context.adapter.inspections, 2);

    const observation = await context.repositories.datapackLoadOrder.findByJobId(jobId);
    assert.equal(observation?.workspaceId, context.workspace.workspaceId);
    assert.equal(observation?.analysisId, ANALYSIS_ID);
    assert.equal(observation?.inventorySha256, INVENTORY_SHA256);
    assert.deepEqual(
      observation?.observation.datapacks.map((datapack) => datapack.rootPath),
      ['config/openloader/data/cte_mns', 'config/openloader/data/cte_overlay'],
    );
    assert.equal(observation?.projection.authorizesSemanticEditing, false);

    const leases = await context.database.query<{
      readonly job_id: string;
      readonly outcome: string | null;
      readonly settled_at: Date | string | null;
    }>(
      'SELECT job_id, outcome, settled_at FROM agent_work_leases WHERE job_id = $1',
      [jobId],
    );
    assert.equal(leases.rows.length, 1);
    assert.equal(leases.rows[0]?.outcome, 'succeeded');
    assert.notEqual(leases.rows[0]?.settled_at, null);

    const relevantAudit = (await context.repositories.audit.list()).filter((event) =>
      event.action.startsWith('datapack-load-order.') || event.action.startsWith('agent.work.'),
    );
    assert.deepEqual(
      [...new Set(relevantAudit.map((event) => event.action))].sort(),
      [
        'agent.work.claim',
        'agent.work.result',
        'datapack-load-order.observe',
        'datapack-load-order.observe.requested',
      ],
    );
    assert.equal(relevantAudit.every((event) => event.outcome === 'succeeded'), true);
    const serializedAudit = JSON.stringify(relevantAudit);
    for (const forbidden of [context.root, 'level.dat', 'rootPath', 'worldPath']) {
      assert.equal(serializedAudit.includes(forbidden), false);
    }

    const replay = await context.app.inject(request);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().replayed, true);
    assert.equal(replay.json().jobId, jobId);
    assert.equal(context.adapter.inspections, 2);

    const persisted = await context.database.query<{ readonly count: number | string }>(
      'SELECT COUNT(*) AS count FROM workspace_datapack_load_order_observations WHERE job_id = $1',
      [jobId],
    );
    assert.equal(Number(persisted.rows[0]?.count), 1);
  });
});
