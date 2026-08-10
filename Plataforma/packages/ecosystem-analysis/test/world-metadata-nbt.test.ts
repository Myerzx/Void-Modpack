import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';

import {
  BoundedNbtWorldMetadataDatapackLoadOrderReader,
  ECOSYSTEM_ANALYSIS_SCHEMA_VERSION,
  ECOSYSTEM_ANALYZER_VERSION,
  WORLD_METADATA_NBT_LIMITS,
  WorldMetadataNbtReadError,
  readWorldMetadataDatapackSelection,
  type EcosystemAnalysis,
} from '../src/index.js';
import {
  compound,
  declaredStringListLength,
  namedTag,
  nestedCompounds,
  stringList,
  stringPayload,
  worldMetadataNbt,
} from './fixtures/world-metadata-nbt-v1/corpus.js';

function analysis(): EcosystemAnalysis {
  return {
    schemaVersion: ECOSYSTEM_ANALYSIS_SCHEMA_VERSION,
    analyzerVersion: ECOSYSTEM_ANALYZER_VERSION,
    analysisId: 'd'.repeat(64),
    inventorySha256: 'c'.repeat(64),
    generatedAt: '2026-08-10T13:00:00.000Z',
    mods: [], systems: [], configurations: [], relationships: [], evidence: [], issues: [],
    datapacks: [
      {
        datapackId: 'datapack:mns', name: 'cte_mns', loader: 'openloader',
        rootPath: 'config/openloader/data/cte_mns', sha256: 'a'.repeat(64), description: null,
        resourceIds: [], namespaces: [], ownerModId: null, relatedModIds: [], issueIds: [],
        conflictIds: [], evidenceIds: [],
      },
      {
        datapackId: 'datapack:overlay', name: 'cte_overlay', loader: 'openloader',
        rootPath: 'config/openloader/data/cte_overlay', sha256: 'b'.repeat(64), description: null,
        resourceIds: [], namespaces: [], ownerModId: null, relatedModIds: [], issueIds: [],
        conflictIds: [], evidenceIds: [],
      },
      {
        datapackId: 'datapack:world', name: 'world_pack', loader: 'minecraft',
        rootPath: 'world/datapacks/world_pack', sha256: 'e'.repeat(64), description: null,
        resourceIds: [], namespaces: [], ownerModId: null, relatedModIds: [], issueIds: [],
        conflictIds: [], evidenceIds: [],
      },
    ],
    datapackResources: [], datapackConflicts: [],
    graph: { entities: [], relationshipIds: [] },
    summary: {
      mods: 0, systems: 0, configurations: 0, datapacks: 3, datapackResources: 0,
      datapackConflicts: 0, relationships: 0, issues: 0,
    },
  };
}

function rejectsWith(code: WorldMetadataNbtReadError['code']): (error: unknown) => boolean {
  return (error) => error instanceof WorldMetadataNbtReadError && error.code === code;
}

describe('bounded Minecraft world-metadata NBT reader', () => {
  it('extracts the reviewed lists, skips every standard unrelated tag and fixes native priority direction', () => {
    const bytes = worldMetadataNbt({
      enabled: ['vanilla', 'data/cte_mns', 'data/cte_overlay'],
      disabled: [],
      includeRepresentativeUnrelatedTags: true,
    });
    const selection = readWorldMetadataDatapackSelection(bytes);
    assert.deepEqual(selection.enabledPackIds, ['vanilla', 'data/cte_mns', 'data/cte_overlay']);
    assert.deepEqual(selection.disabledPackIds, []);
    assert.equal(selection.order, 'lowest-priority-first');
    assert.equal(selection.evidenceSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(Object.isFrozen(selection), true);
    assert.equal(Object.isFrozen(selection.enabledPackIds), true);
  });

  it('maps only active OpenLoader IDs to the exact analyzed roots and hashes', async () => {
    const bytes = worldMetadataNbt({
      enabled: ['vanilla', 'mod:forge', 'data/cte_mns', 'data/cte_overlay'],
      disabled: ['data/disabled_pack'],
    });
    const reader = new BoundedNbtWorldMetadataDatapackLoadOrderReader({
      async readCompressedWorldMetadata() { return bytes; },
    });
    assert.deepEqual(await reader.readNormalizedEvidence(analysis()), {
      schemaVersion: 1,
      evidenceSha256: createHash('sha256').update(bytes).digest('hex'),
      order: 'lowest-priority-first',
      datapacks: [
        { rootPath: 'config/openloader/data/cte_mns', sha256: 'a'.repeat(64) },
        { rootPath: 'config/openloader/data/cte_overlay', sha256: 'b'.repeat(64) },
      ],
    });
  });

  it('rejects unknown types, wrong target types, excessive nesting and oversized lists', () => {
    assert.throws(
      () => readWorldMetadataDatapackSelection(Buffer.from('not-gzip', 'utf8')),
      rejectsWith('invalid-gzip'),
    );
    const canonical = worldMetadataNbt();
    assert.throws(
      () => readWorldMetadataDatapackSelection(gzipSync(Buffer.concat([
        gunzipSync(canonical),
        Buffer.from([0]),
      ]))),
      rejectsWith('invalid-nbt'),
    );
    assert.throws(
      () => readWorldMetadataDatapackSelection(worldMetadataNbt({
        rootEntries: [namedTag(13, 'Unknown', Buffer.alloc(0))],
      })),
      rejectsWith('invalid-nbt'),
    );
    assert.throws(
      () => readWorldMetadataDatapackSelection(worldMetadataNbt({
        dataPackEntries: [
          namedTag(8, 'Enabled', stringPayload('vanilla')),
          namedTag(9, 'Disabled', stringList([])),
        ],
      })),
      rejectsWith('world-metadata-schema-mismatch'),
    );
    assert.throws(
      () => readWorldMetadataDatapackSelection(worldMetadataNbt({
        rootEntries: [namedTag(10, 'TooDeep', nestedCompounds(WORLD_METADATA_NBT_LIMITS.maximumDepth))],
      })),
      rejectsWith('nbt-limit-exceeded'),
    );
    assert.throws(
      () => readWorldMetadataDatapackSelection(worldMetadataNbt({
        dataPackEntries: [
          namedTag(9, 'Enabled', declaredStringListLength(WORLD_METADATA_NBT_LIMITS.maximumListEntries + 1)),
          namedTag(9, 'Disabled', stringList([])),
        ],
      })),
      rejectsWith('nbt-limit-exceeded'),
    );
  });

  it('rejects duplicate IDs, active OpenLoader IDs outside the analysis and both byte budgets', async () => {
    assert.throws(
      () => readWorldMetadataDatapackSelection(worldMetadataNbt({
        enabled: ['vanilla', 'vanilla'],
      })),
      rejectsWith('duplicate-pack-id'),
    );
    const unmapped = new BoundedNbtWorldMetadataDatapackLoadOrderReader({
      async readCompressedWorldMetadata() {
        return worldMetadataNbt({ enabled: ['vanilla', 'data/not_in_inventory'] });
      },
    });
    await assert.rejects(
      unmapped.readNormalizedEvidence(analysis()),
      rejectsWith('unmapped-active-openloader-pack'),
    );
    assert.throws(
      () => readWorldMetadataDatapackSelection(
        Buffer.alloc(WORLD_METADATA_NBT_LIMITS.maximumCompressedBytes + 1),
      ),
      rejectsWith('compressed-bytes-limit-exceeded'),
    );
    assert.throws(
      () => readWorldMetadataDatapackSelection(gzipSync(
        Buffer.alloc(WORLD_METADATA_NBT_LIMITS.maximumDecompressedBytes + 1),
      )),
      rejectsWith('decompressed-bytes-limit-exceeded'),
    );
  });

  it('rejects duplicate target keys even when both values are otherwise valid', () => {
    const dataPacks = compound([
      namedTag(9, 'Enabled', stringList(['vanilla'])),
      namedTag(9, 'Disabled', stringList([])),
    ]);
    assert.throws(
      () => readWorldMetadataDatapackSelection(worldMetadataNbt({
        dataEntries: [
          namedTag(10, 'DataPacks', dataPacks),
          namedTag(10, 'DataPacks', dataPacks),
        ],
      })),
      rejectsWith('invalid-nbt'),
    );
  });
});
