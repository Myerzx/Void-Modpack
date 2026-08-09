import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ECOSYSTEM_ANALYSIS_SCHEMA_VERSION,
  ECOSYSTEM_ANALYZER_VERSION,
  type EcosystemAnalysis,
} from '@voidfall/ecosystem-analysis';

import { createRepositories, runMigrations } from '../src/index.js';
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
});
