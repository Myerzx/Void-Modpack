import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { AgentWorkLease, DatapackLoadOrderObservationCommand, Job } from '@voidfall/contracts';
import { createRepositories, runMigrations, type Database, type Repositories } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import {
  ECOSYSTEM_ANALYSIS_SCHEMA_VERSION,
  ECOSYSTEM_ANALYZER_VERSION,
  WORLD_METADATA_NBT_LIMITS,
  type EcosystemAnalysis,
} from '@voidfall/ecosystem-analysis';
import type {
  MinecraftProcessAdapter,
  ProcessLaunchPlan,
  ProcessObservation,
} from '@voidfall/minecraft-process';

import { worldMetadataNbt } from '../../../packages/ecosystem-analysis/test/fixtures/world-metadata-nbt-v1/corpus.js';
import {
  AGENT_DATAPACK_LOAD_ORDER_CAPABILITY,
  DatapackLoadOrderObservationCapability,
  createDatapackLoadOrderObservationHandler,
} from '../src/datapack-load-order-operation.js';
import {
  REGISTERED_WORLD_METADATA_RELATIVE_PATH,
  RegisteredWorldMetadataFileReader,
  RegisteredWorldMetadataReadError,
} from '../src/world-metadata-reader.js';

const NOW = new Date('2026-08-10T18:00:00.000Z');
const INVENTORY_SHA256 = 'a'.repeat(64);
const ANALYSIS_ID = 'b'.repeat(64);

const cleanup: Array<{ readonly database?: Database; readonly directory: string }> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const resource = cleanup.pop();
    if (resource === undefined) continue;
    await resource.database?.close();
    await rm(resource.directory, { recursive: true, force: true });
  }
});

function analysis(): EcosystemAnalysis {
  return {
    schemaVersion: ECOSYSTEM_ANALYSIS_SCHEMA_VERSION,
    analyzerVersion: ECOSYSTEM_ANALYZER_VERSION,
    analysisId: ANALYSIS_ID,
    inventorySha256: INVENTORY_SHA256,
    generatedAt: NOW.toISOString(),
    mods: [], systems: [], configurations: [], relationships: [], evidence: [], issues: [],
    datapacks: [
      {
        datapackId: 'datapack:mns', name: 'cte_mns', loader: 'openloader',
        rootPath: 'config/openloader/data/cte_mns', sha256: 'c'.repeat(64), description: null,
        resourceIds: [], namespaces: [], ownerModId: null, relatedModIds: [], issueIds: [],
        conflictIds: [], evidenceIds: [],
      },
      {
        datapackId: 'datapack:overlay', name: 'cte_overlay', loader: 'openloader',
        rootPath: 'config/openloader/data/cte_overlay', sha256: 'd'.repeat(64), description: null,
        resourceIds: [], namespaces: [], ownerModId: null, relatedModIds: [], issueIds: [],
        conflictIds: [], evidenceIds: [],
      },
    ],
    datapackResources: [], datapackConflicts: [],
    graph: { entities: [], relationshipIds: [] },
    summary: {
      mods: 0, systems: 0, configurations: 0, datapacks: 2, datapackResources: 0,
      datapackConflicts: 0, relationships: 0, issues: 0,
    },
  };
}

class OfflineAdapter implements MinecraftProcessAdapter {
  public inspections = 0;
  public state: ProcessObservation['state'] = 'offline';

  public async inspect(): Promise<ProcessObservation> {
    this.inspections += 1;
    return { state: this.state, observedAt: NOW.toISOString(), source: 'process-adapter' };
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

async function fixture(): Promise<{
  readonly directory: string;
  readonly database: Database;
  readonly repositories: Repositories;
  readonly serverInstanceId: string;
  readonly agentId: string;
  readonly workspaceId: string;
  readonly adapter: OfflineAdapter;
  readonly capability: DatapackLoadOrderObservationCapability;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'voidfall-datapack-order-'));
  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  cleanup.push({ database, directory });
  const repositories = createRepositories(database);
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'datapack-order-agent-test',
    displayName: 'Datapack order agent test',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '1.20.1-47.4.4',
    maxPlayers: 20,
  });
  const workspace = await repositories.workspaces.register({
    slug: 'datapack-order-agent-workspace',
    displayName: 'Datapack order agent workspace',
    rootPath: directory,
    kind: 'server',
    createdBy: { type: 'system', id: 'test' },
  });
  await repositories.servers.setRuntime({
    id: server.id,
    runDirectory: directory,
    runtime: { family: 'forge', shape: 'args-file', entry: 'args.txt', evidence: 'test' },
    detectedAt: NOW,
    workspaceId: workspace.workspaceId,
  });
  const inventory = await repositories.workspaces.recordScan({
    workspaceId: workspace.workspaceId,
    inventorySha256: INVENTORY_SHA256,
    totalFiles: 2,
    totalBytes: 2,
    totalMods: 0,
    document: {},
    scannedBy: { type: 'system', id: 'test' },
    scannedAt: NOW,
  });
  await repositories.ecosystemAnalysis.save({
    workspaceId: workspace.workspaceId,
    inventoryId: inventory.inventoryId,
    document: analysis(),
  });
  await mkdir(join(directory, 'world'), { recursive: true });
  await writeFile(join(directory, 'world', 'level.dat'), worldMetadataNbt({
    enabled: ['vanilla', 'data/cte_mns', 'data/cte_overlay'],
  }));

  const adapter = new OfflineAdapter();
  const agentId = randomUUID();
  const capability = new DatapackLoadOrderObservationCapability({
    repositories,
    processAdapter: adapter,
    serverInstanceId: server.id,
    agentId,
    runtime: { workspaceId: workspace.workspaceId, workspaceRoot: directory },
    clock: () => NOW,
  });
  return {
    directory,
    database,
    repositories,
    serverInstanceId: server.id,
    agentId,
    workspaceId: workspace.workspaceId,
    adapter,
    capability,
  };
}

function command(context: Awaited<ReturnType<typeof fixture>>): DatapackLoadOrderObservationCommand {
  return {
    schemaVersion: 1,
    serverInstanceId: context.serverInstanceId,
    workspaceId: context.workspaceId,
    analysisId: ANALYSIS_ID,
    inventorySha256: INVENTORY_SHA256,
  };
}

async function jobAndLease(
  context: Awaited<ReturnType<typeof fixture>>,
  commandValue: unknown = command(context),
): Promise<{ readonly job: Job; readonly lease: AgentWorkLease }> {
  const correlationId = randomUUID();
  const job = await context.repositories.jobs.enqueue({
    schemaVersion: 1,
    id: randomUUID(),
    type: AGENT_DATAPACK_LOAD_ORDER_CAPABILITY,
    resource: { type: 'server-instance', id: context.serverInstanceId },
    status: 'queued',
    stage: 'awaiting-agent',
    priority: 50,
    payload: { schemaVersion: 1, parameters: { command: commandValue as never } },
    idempotencyKey: `datapack-order:${randomUUID()}`,
    requestedBy: { type: 'system', id: 'test' },
    correlationId,
    availableAt: NOW.toISOString(),
    attempt: 0,
    maxAttempts: 3,
  });
  return {
    job,
    lease: {
      schemaVersion: 1,
      leaseId: randomUUID(),
      jobId: job.id,
      capability: AGENT_DATAPACK_LOAD_ORDER_CAPABILITY,
      jobType: AGENT_DATAPACK_LOAD_ORDER_CAPABILITY,
      correlationId,
      parameters: {
        resourceType: 'server-instance',
        resourceId: context.serverInstanceId,
        expectedVersion: 1,
      },
      leasedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      attempt: 1,
    },
  };
}

describe('registered world metadata filesystem reader', () => {
  it('reads only the literal world metadata file under the registered root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'voidfall-world-reader-'));
    cleanup.push({ directory });
    const expected = worldMetadataNbt({ enabled: ['vanilla', 'data/cte_mns'] });
    await mkdir(join(directory, 'world'));
    await writeFile(join(directory, 'world', 'level.dat'), expected);
    await writeFile(join(directory, 'level.dat'), Buffer.from('decoy'));

    const reader = new RegisteredWorldMetadataFileReader(directory);
    assert.equal(REGISTERED_WORLD_METADATA_RELATIVE_PATH, 'world/level.dat');
    assert.deepEqual(Buffer.from(await reader.readCompressedWorldMetadata()), expected);
  });

  it('rejects oversized evidence before parsing it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'voidfall-world-reader-'));
    cleanup.push({ directory });
    await mkdir(join(directory, 'world'));
    await writeFile(
      join(directory, 'world', 'level.dat'),
      Buffer.alloc(WORLD_METADATA_NBT_LIMITS.maximumCompressedBytes + 1),
    );
    await assert.rejects(
      new RegisteredWorldMetadataFileReader(directory).readCompressedWorldMetadata(),
      (error: unknown) => error instanceof RegisteredWorldMetadataReadError &&
        error.code === 'compressed-bytes-limit-exceeded',
    );
  });

  it('refuses a linked world suffix instead of following it', async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'voidfall-world-reader-'));
    const outside = await mkdtemp(join(tmpdir(), 'voidfall-world-reader-outside-'));
    cleanup.push({ directory }, { directory: outside });
    await writeFile(join(outside, 'level.dat'), worldMetadataNbt());
    try {
      await symlink(outside, join(directory, 'world'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        context.skip('symlink creation is unavailable in this environment');
        return;
      }
      throw error;
    }
    await assert.rejects(
      new RegisteredWorldMetadataFileReader(directory).readCompressedWorldMetadata(),
      (error: unknown) => error instanceof RegisteredWorldMetadataReadError &&
        error.code === 'unsafe-filesystem-entry',
    );
  });
});

describe('typed datapack load-order capability and lease handler', () => {
  it('observes once, persists and audits atomically, then replays without rereading', async () => {
    const context = await fixture();
    const work = await jobAndLease(context);
    const handler = createDatapackLoadOrderObservationHandler({
      repositories: context.repositories,
      capability: context.capability,
      serverInstanceId: context.serverInstanceId,
      clock: () => NOW,
    });

    assert.deepEqual(await handler(work.lease), { outcome: 'succeeded' });
    const stored = await context.repositories.datapackLoadOrder.findByJobId(work.job.id);
    assert.equal(stored?.jobId, work.job.id);
    assert.equal(stored?.observation.datapacks.length, 2);
    assert.equal(stored?.projection.authorizesSemanticEditing, false);
    assert.equal(context.adapter.inspections, 2);

    assert.deepEqual(await handler(work.lease), { outcome: 'succeeded' });
    assert.equal(context.adapter.inspections, 2);
    const audit = await context.repositories.audit.listChain('datapack-load-order', 1, 100);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.event.action, AGENT_DATAPACK_LOAD_ORDER_CAPABILITY);
    assert.equal(audit[0]?.event.outcome, 'succeeded');
    const serialized = JSON.stringify(audit[0]?.event);
    assert.equal(serialized.includes(context.directory), false);
    assert.equal(serialized.includes('level.dat'), false);
    assert.equal(serialized.includes('rootPath'), false);
  });

  it('refuses an extensible command before filesystem access or audit', async () => {
    const context = await fixture();
    const work = await jobAndLease(context, { ...command(context), worldPath: 'elsewhere/level.dat' });
    const handler = createDatapackLoadOrderObservationHandler({
      repositories: context.repositories,
      capability: context.capability,
      serverInstanceId: context.serverInstanceId,
      clock: () => NOW,
    });
    assert.deepEqual(await handler(work.lease), {
      outcome: 'failed',
      failureCode: 'unsupported-parameters',
    });
    assert.equal(context.adapter.inspections, 0);
    assert.equal(await context.repositories.datapackLoadOrder.findByJobId(work.job.id), undefined);
    assert.deepEqual(await context.repositories.audit.list(), []);
  });

  it('fails closed while the server is online and audits only sanitized identifiers', async () => {
    const context = await fixture();
    context.adapter.state = 'online';
    const work = await jobAndLease(context);
    const handler = createDatapackLoadOrderObservationHandler({
      repositories: context.repositories,
      capability: context.capability,
      serverInstanceId: context.serverInstanceId,
      clock: () => NOW,
    });
    assert.deepEqual(await handler(work.lease), {
      outcome: 'failed',
      failureCode: 'precondition-not-met',
    });
    assert.equal(await context.repositories.datapackLoadOrder.findByJobId(work.job.id), undefined);
    const audit = await context.repositories.audit.listChain('datapack-load-order', 1, 100);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.event.outcome, 'failed');
    assert.equal(audit[0]?.event.reason, 'server-not-offline');
    const serialized = JSON.stringify(audit[0]?.event);
    assert.equal(serialized.includes(context.directory), false);
    assert.equal(serialized.includes('level.dat'), false);
  });
});
