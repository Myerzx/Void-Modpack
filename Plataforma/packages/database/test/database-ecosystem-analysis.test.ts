import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ECOSYSTEM_ANALYSIS_SCHEMA_VERSION,
  ECOSYSTEM_ANALYZER_VERSION,
  parseDatapackLoadOrderObservation,
  type EcosystemAnalysis,
} from '@voidfall/ecosystem-analysis';

import {
  DatapackLoadOrderPersistenceError,
  createRepositories,
  runMigrations,
} from '../src/index.js';
import { createPGliteTestDatabase } from '../src/testing.js';

function document(inventorySha256: string): EcosystemAnalysis {
  return {
    schemaVersion: ECOSYSTEM_ANALYSIS_SCHEMA_VERSION,
    analyzerVersion: ECOSYSTEM_ANALYZER_VERSION,
    analysisId: 'b'.repeat(64),
    inventorySha256,
    generatedAt: '2026-08-09T12:00:00.000Z',
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

function conflictedDocument(inventorySha256: string): EcosystemAnalysis {
  return {
    ...document(inventorySha256),
    datapacks: [
      {
        datapackId: 'datapack:mns', name: 'cte_mns', loader: 'openloader',
        rootPath: 'config/openloader/data/cte_mns', sha256: 'c'.repeat(64), description: null,
        resourceIds: ['resource:mns'], namespaces: ['mmorpg'], ownerModId: null,
        relatedModIds: [], issueIds: [], conflictIds: ['conflict:common'], evidenceIds: [],
      },
      {
        datapackId: 'datapack:overlay', name: 'cte_overlay', loader: 'openloader',
        rootPath: 'config/openloader/data/cte_overlay', sha256: 'd'.repeat(64), description: null,
        resourceIds: ['resource:overlay'], namespaces: ['mmorpg'], ownerModId: null,
        relatedModIds: [], issueIds: [], conflictIds: ['conflict:common'], evidenceIds: [],
      },
    ],
    datapackResources: [
      {
        resourceId: 'resource:mns', datapackId: 'datapack:mns', namespace: 'mmorpg',
        resourceType: 'mmorpg_gear_rarity', resourcePath: 'common.json', sourceFile: 'mns/common.json',
        sha256: '1'.repeat(64), ownerModId: null, systemId: null, effect: 'unknown',
        reviewedSchema: null, semanticFields: [], conflictIds: ['conflict:common'], parseIssue: null,
        status: 'detected', confidence: 'high', evidenceIds: [],
      },
      {
        resourceId: 'resource:overlay', datapackId: 'datapack:overlay', namespace: 'mmorpg',
        resourceType: 'mmorpg_gear_rarity', resourcePath: 'common.json', sourceFile: 'overlay/common.json',
        sha256: '2'.repeat(64), ownerModId: null, systemId: null, effect: 'unknown',
        reviewedSchema: null, semanticFields: [], conflictIds: ['conflict:common'], parseIssue: null,
        status: 'detected', confidence: 'high', evidenceIds: [],
      },
    ],
    datapackConflicts: [{
      conflictId: 'conflict:common', coordinate: 'mmorpg:mmorpg_gear_rarity/common.json',
      kind: 'divergent-content', resourceIds: ['resource:mns', 'resource:overlay'],
      datapackIds: ['datapack:mns', 'datapack:overlay'], resolution: 'unknown-load-order',
      status: 'detected', confidence: 'high', evidenceIds: [],
    }],
    summary: {
      mods: 0, systems: 0, configurations: 0, datapacks: 2, datapackResources: 2,
      datapackConflicts: 1, relationships: 0, issues: 0,
    },
  };
}

describe('ecosystem analysis persistence', () => {
  it('caches one immutable analysis per workspace, inventory digest and analyzer version', async () => {
    const database = await createPGliteTestDatabase();
    try {
      await runMigrations(database);
      const repositories = createRepositories(database);
      const workspace = await repositories.workspaces.register({
        slug: 'server-fixture',
        displayName: 'Server fixture',
        rootPath: 'C:\\fixture',
        kind: 'server',
        createdBy: { type: 'panel-user', id: 'owner' },
      });
      const inventorySha256 = 'a'.repeat(64);
      const inventory = await repositories.workspaces.recordScan({
        workspaceId: workspace.workspaceId,
        inventorySha256,
        totalFiles: 0,
        totalBytes: 0,
        totalMods: 0,
        document: {},
        scannedBy: { type: 'panel-user', id: 'owner' },
        scannedAt: new Date('2026-08-09T11:00:00.000Z'),
      });

      const first = await repositories.ecosystemAnalysis.save({
        workspaceId: workspace.workspaceId,
        inventoryId: inventory.inventoryId,
        document: document(inventorySha256),
      });
      const replay = await repositories.ecosystemAnalysis.save({
        workspaceId: workspace.workspaceId,
        inventoryId: inventory.inventoryId,
        document: document(inventorySha256),
      });

      assert.equal(replay.recordId, first.recordId);
      assert.equal(replay.analysisId, first.analysisId);
      assert.deepEqual(
        await repositories.ecosystemAnalysis.findForInventory({
          workspaceId: workspace.workspaceId,
          inventorySha256,
          analyzerVersion: ECOSYSTEM_ANALYZER_VERSION,
        }),
        first,
      );
      assert.deepEqual(await repositories.ecosystemAnalysis.latest(workspace.workspaceId), first);
    } finally {
      await database.close();
    }
  });

  it('persists observed precedence separately and recomputes the immutable projection', async () => {
    const database = await createPGliteTestDatabase();
    try {
      await runMigrations(database);
      const repositories = createRepositories(database);
      const workspace = await repositories.workspaces.register({
        slug: 'datapack-order-fixture',
        displayName: 'Datapack order fixture',
        rootPath: 'C:\\fixture',
        kind: 'server',
        createdBy: { type: 'panel-user', id: 'owner' },
      });
      const inventorySha256 = 'a'.repeat(64);
      const inventory = await repositories.workspaces.recordScan({
        workspaceId: workspace.workspaceId,
        inventorySha256,
        totalFiles: 4,
        totalBytes: 4,
        totalMods: 0,
        document: {},
        scannedBy: { type: 'panel-user', id: 'owner' },
        scannedAt: new Date('2026-08-10T13:00:00.000Z'),
      });
      const analysis = conflictedDocument(inventorySha256);
      await repositories.ecosystemAnalysis.save({
        workspaceId: workspace.workspaceId,
        inventoryId: inventory.inventoryId,
        document: analysis,
      });
      const observation = parseDatapackLoadOrderObservation({
        schemaVersion: 1,
        source: 'minecraft-world-metadata-v1',
        inventorySha256,
        observedAt: '2026-08-10T14:00:00.000Z',
        evidenceSha256: 'e'.repeat(64),
        order: 'lowest-priority-first',
        datapacks: [
          { rootPath: 'config/openloader/data/cte_mns', sha256: 'c'.repeat(64) },
          { rootPath: 'config/openloader/data/cte_overlay', sha256: 'd'.repeat(64) },
        ],
      });

      const first = await repositories.datapackLoadOrder.save({
        workspaceId: workspace.workspaceId,
        analysisId: analysis.analysisId,
        observation,
      });
      const replay = await repositories.datapackLoadOrder.save({
        workspaceId: workspace.workspaceId,
        analysisId: analysis.analysisId,
        observation,
      });

      assert.equal(replay.recordId, first.recordId);
      assert.equal(first.projection.authorizesSemanticEditing, false);
      assert.equal(first.projection.resolutions[0]?.winningDatapackId, 'datapack:overlay');
      assert.equal(first.observationId, observation.observationId);
      assert.deepEqual(await repositories.datapackLoadOrder.find({
        workspaceId: workspace.workspaceId,
        analysisId: analysis.analysisId,
        observationId: observation.observationId,
      }), first);
      assert.deepEqual(await repositories.datapackLoadOrder.latestForAnalysis({
        workspaceId: workspace.workspaceId,
        analysisId: analysis.analysisId,
      }), first);

      const stale = parseDatapackLoadOrderObservation({
        schemaVersion: 1,
        source: 'minecraft-world-metadata-v1',
        inventorySha256: 'f'.repeat(64),
        observedAt: '2026-08-10T14:01:00.000Z',
        evidenceSha256: 'e'.repeat(64),
        order: 'lowest-priority-first',
        datapacks: observation.datapacks,
      });
      await assert.rejects(
        repositories.datapackLoadOrder.save({
          workspaceId: workspace.workspaceId,
          analysisId: analysis.analysisId,
          observation: stale,
        }),
        (error: unknown) => error instanceof DatapackLoadOrderPersistenceError &&
          error.code === 'inventory-mismatch',
      );
      await assert.rejects(
        repositories.datapackLoadOrder.save({
          workspaceId: workspace.workspaceId,
          analysisId: 'f'.repeat(64),
          observation,
        }),
        (error: unknown) => error instanceof DatapackLoadOrderPersistenceError &&
          error.code === 'analysis-not-found',
      );
    } finally {
      await database.close();
    }
  });
});
