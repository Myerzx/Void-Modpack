import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  ECOSYSTEM_ANALYSIS_SCHEMA_VERSION,
  ECOSYSTEM_ANALYZER_VERSION,
  DatapackLoadOrderCaptureError,
  GuardedDatapackLoadOrderObserver,
  validateDatapackLoadOrderObservation,
  validateDatapackLoadOrderProjection,
  type EcosystemAnalysis,
  type OfflineExclusiveDatapackLoadOrderGuard,
  type TrustedWorldMetadataDatapackLoadOrderReader,
} from '../src/index.js';

const INVENTORY_SHA256 = 'c'.repeat(64);
const ANALYSIS_ID = 'd'.repeat(64);
const ACQUIRED_AT = '2026-08-10T14:00:00.000Z';
const OBSERVED_AT = new Date('2026-08-10T14:01:00.000Z');

function analysis(): EcosystemAnalysis {
  return {
    schemaVersion: ECOSYSTEM_ANALYSIS_SCHEMA_VERSION,
    analyzerVersion: ECOSYSTEM_ANALYZER_VERSION,
    analysisId: ANALYSIS_ID,
    inventorySha256: INVENTORY_SHA256,
    generatedAt: '2026-08-10T13:00:00.000Z',
    mods: [], systems: [], configurations: [], relationships: [], evidence: [], issues: [],
    datapacks: [
      {
        datapackId: 'datapack:mns', name: 'cte_mns', loader: 'openloader',
        rootPath: 'config/openloader/data/cte_mns', sha256: 'a'.repeat(64), description: null,
        resourceIds: ['resource:mns'], namespaces: ['mmorpg'], ownerModId: null,
        relatedModIds: [], issueIds: [], conflictIds: ['conflict:common'], evidenceIds: [],
      },
      {
        datapackId: 'datapack:overlay', name: 'cte_overlay', loader: 'openloader',
        rootPath: 'config/openloader/data/cte_overlay', sha256: 'b'.repeat(64), description: null,
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
    graph: { entities: [], relationshipIds: [] },
    summary: {
      mods: 0, systems: 0, configurations: 0, datapacks: 2, datapackResources: 2,
      datapackConflicts: 1, relationships: 0, issues: 0,
    },
  };
}

async function fixtureEvidence(): Promise<unknown> {
  return JSON.parse(await readFile(
    new URL('./fixtures/world-metadata-datapack-order-v1.json', import.meta.url),
    'utf8',
  )) as unknown;
}

function guard(run: (operation: Parameters<OfflineExclusiveDatapackLoadOrderGuard['runWithExclusiveOfflineAccess']>[0]) => Promise<unknown>): OfflineExclusiveDatapackLoadOrderGuard {
  return { runWithExclusiveOfflineAccess: run } as OfflineExclusiveDatapackLoadOrderGuard;
}

describe('guarded datapack load-order observation', () => {
  it('captures sanitized world metadata only inside the offline-exclusive window', async () => {
    let insideGuard = false;
    let reads = 0;
    const reader: TrustedWorldMetadataDatapackLoadOrderReader = {
      async readNormalizedEvidence(): Promise<unknown> {
        assert.equal(insideGuard, true);
        reads += 1;
        return fixtureEvidence();
      },
    };
    const observer = new GuardedDatapackLoadOrderObserver({
      guard: guard(async (operation) => {
        insideGuard = true;
        try {
          return await operation({ method: 'offline-exclusive-v1', acquiredAt: ACQUIRED_AT });
        } finally {
          insideGuard = false;
        }
      }),
      reader,
      clock: () => OBSERVED_AT,
    });

    const captured = await observer.capture(analysis());
    assert.equal(reads, 1);
    assert.equal(captured.observation.source, 'minecraft-world-metadata-v1');
    assert.equal(captured.observation.observedAt, OBSERVED_AT.toISOString());
    assert.equal(captured.projection.authorizesSemanticEditing, false);
    assert.equal(captured.projection.resolutions[0]?.winningDatapackId, 'datapack:overlay');
    assert.deepEqual(validateDatapackLoadOrderObservation(captured.observation), captured.observation);
    assert.deepEqual(validateDatapackLoadOrderProjection(captured.projection), captured.projection);
    assert.equal(Object.isFrozen(captured), true);
    assert.throws(
      () => validateDatapackLoadOrderObservation({
        ...captured.observation,
        observationId: 'f'.repeat(64),
      }),
      /ecosystem-analysis:invalid-datapack-load-order-observation/u,
    );
    assert.throws(
      () => validateDatapackLoadOrderProjection({
        ...captured.projection,
        authorizesSemanticEditing: true,
      }),
      /ecosystem-analysis:invalid-datapack-load-order-observation/u,
    );
  });

  it('does not consult the reader when the operational guard refuses', async () => {
    let reads = 0;
    const observer = new GuardedDatapackLoadOrderObserver({
      guard: guard(async () => { throw new Error('offline window refused'); }),
      reader: { async readNormalizedEvidence() { reads += 1; return fixtureEvidence(); } },
      clock: () => OBSERVED_AT,
    });
    await assert.rejects(observer.capture(analysis()), /offline window refused/u);
    assert.equal(reads, 0);
  });

  it('rejects extensible evidence and clocks older than the exclusive lease', async () => {
    const valid = await fixtureEvidence() as Record<string, unknown>;
    const captureWith = (evidence: unknown, clock = OBSERVED_AT) => new GuardedDatapackLoadOrderObserver({
      guard: guard((operation) => operation({ method: 'offline-exclusive-v1', acquiredAt: ACQUIRED_AT })),
      reader: { async readNormalizedEvidence() { return evidence; } },
      clock: () => clock,
    }).capture(analysis());

    await assert.rejects(
      captureWith({ ...valid, sourcePath: 'world/level.dat' }),
      (error: unknown) => error instanceof DatapackLoadOrderCaptureError &&
        error.code === 'invalid-world-metadata-evidence',
    );
    await assert.rejects(
      captureWith(valid, new Date('2026-08-10T13:59:59.999Z')),
      (error: unknown) => error instanceof DatapackLoadOrderCaptureError &&
        error.code === 'clock-before-exclusive-lease',
    );
  });
});
