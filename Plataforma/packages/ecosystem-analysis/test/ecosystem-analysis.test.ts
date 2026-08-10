import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { WorkspaceInventoryService } from '@voidfall/workspace-inventory';

import { forgeConfigFixtureClass } from '../../artifact-inspection/test/class-fixture.js';
import {
  EcosystemAnalysisService,
  parseDatapackLoadOrderObservation,
  projectObservedDatapackLoadOrder,
  traverseEcosystemGraph,
  VOIDFALL_TRUSTED_DATAPACK_SCHEMA_REGISTRY,
  type EcosystemGraphEntity,
  type EcosystemRelationship,
} from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe('bounded ecosystem graph traversal', () => {
  const entities: readonly EcosystemGraphEntity[] = [
    { id: 'alpha', type: 'Mod', label: 'Alpha', modId: 'alpha', evidenceIds: ['evidence-alpha'] },
    { id: 'beta', type: 'Mod', label: 'Beta', modId: 'beta', evidenceIds: [] },
    { id: 'system-alpha', type: 'System', label: 'Alpha combat', modId: 'alpha', evidenceIds: [] },
    { id: 'evidence-alpha', type: 'Evidence', label: 'Declared metadata', modId: null, evidenceIds: ['evidence-alpha'] },
  ];
  const relationships: readonly EcosystemRelationship[] = [
    {
      relationshipId: '01-alpha-requires-beta', from: { type: 'Mod', id: 'alpha' },
      to: { type: 'Mod', id: 'beta' }, type: 'REQUIRES', systemId: null,
      reason: 'Declared dependency.', status: 'detected', confidence: 'high', evidenceIds: ['evidence-alpha'],
    },
    {
      relationshipId: '02-alpha-owns-system', from: { type: 'Mod', id: 'alpha' },
      to: { type: 'System', id: 'system-alpha' }, type: 'OWNS', systemId: 'system-alpha',
      reason: 'Normalized ownership.', status: 'interpreted', confidence: 'high', evidenceIds: ['evidence-alpha'],
    },
    {
      relationshipId: '03-system-proven-by-evidence', from: { type: 'System', id: 'system-alpha' },
      to: { type: 'Evidence', id: 'evidence-alpha' }, type: 'PROVEN_BY', systemId: 'system-alpha',
      reason: 'Evidence provenance.', status: 'detected', confidence: 'high', evidenceIds: ['evidence-alpha'],
    },
    {
      relationshipId: '04-beta-requires-missing', from: { type: 'Mod', id: 'beta' },
      to: { type: 'Mod', id: 'missing' }, type: 'REQUIRES', systemId: null,
      reason: 'Dependency is declared but absent.', status: 'detected', confidence: 'high', evidenceIds: [],
    },
  ];
  const analysis = {
    graph: { entities, relationshipIds: relationships.map((relationship) => relationship.relationshipId) },
    relationships,
  };

  it('excludes structural edges by default and reports absent endpoints without placeholders', () => {
    const traversal = traverseEcosystemGraph(analysis, {
      root: { type: 'Mod', id: 'alpha' },
      direction: 'outgoing',
      maxDepth: 2,
    });
    assert.notEqual(traversal, null);
    assert.deepEqual(traversal?.entities.map((entity) => [entity.id, entity.depth]), [
      ['alpha', 0],
      ['beta', 1],
    ]);
    assert.deepEqual(traversal?.relationships.map((relationship) => relationship.relationshipId), [
      '01-alpha-requires-beta',
      '04-beta-requires-missing',
    ]);
    assert.deepEqual(traversal?.unresolvedReferences, [{
      type: 'Mod', id: 'missing', relationshipIds: ['04-beta-requires-missing'],
    }]);
  });

  it('lets an explicit type select a structural path and enforces entity bounds', () => {
    const structural = traverseEcosystemGraph(analysis, {
      root: { type: 'Mod', id: 'alpha' },
      direction: 'outgoing',
      maxDepth: 3,
      relationshipType: 'OWNS',
    });
    assert.deepEqual(structural?.entities.map((entity) => entity.id), ['alpha', 'system-alpha']);
    assert.deepEqual(structural?.relationships.map((relationship) => relationship.type), ['OWNS']);

    const bounded = traverseEcosystemGraph(analysis, {
      root: { type: 'Mod', id: 'alpha' },
      direction: 'outgoing',
      maxEntities: 1,
    });
    assert.deepEqual(bounded?.entities.map((entity) => entity.id), ['alpha']);
    assert.deepEqual(bounded?.relationships, []);
    assert.equal(bounded?.truncated.entities, true);
  });

  it('respects direction and returns null for a root absent from the persisted graph', () => {
    assert.deepEqual(
      traverseEcosystemGraph(analysis, {
        root: { type: 'Mod', id: 'alpha' }, direction: 'incoming', maxDepth: 2,
      })?.relationships,
      [],
    );
    assert.equal(
      traverseEcosystemGraph(analysis, { root: { type: 'Mod', id: 'unknown' } }),
      null,
    );
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'voidfall-ecosystem-'));
  roots.push(root);
  return root;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb8_8320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function zip(entries: ReadonlyMap<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x0201_4b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function write(root: string, path: string, value: string | Buffer): Promise<void> {
  const absolute = join(root, ...path.split('/'));
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, value);
}

function mineAndSlashJar(): Buffer {
  return zip(
    new Map<string, string | Buffer>([
      [
        'META-INF/mods.toml',
        `modLoader="javafml"
loaderVersion="[47,)"
license="ARR"
[[mods]]
modId="mmorpg"
version="6.3.14"
displayName="Mine and Slash"
[[dependencies.mmorpg]]
modId="library_of_exile"
mandatory=true
versionRange="[2.1.5,)"
ordering="NONE"
side="BOTH"
`,
      ],
      ['example/config/Config.class', forgeConfigFixtureClass()],
      ['data/mmorpg/mmorpg_spells/fireball.json', '{"damage":10}'],
      ['data/mmorpg/mmorpg_stat/health.json', '{"base":100}'],
      ['data/mmorpg/mmorpg_gear_rarity/common.json', gearRarity('common', 5000)],
      ['data/mmorpg/mmorpg_gear_rarity/uncommon.json', gearRarity('uncommon', 2000)],
    ]),
  );
}

function gearRarity(guid: string, weight: number): string {
  return JSON.stringify({
    type: 'NORMAL',
    affix_rarity_weight: 1000,
    announce_in_chat: false,
    base_stat_percents: { max: 100, min: 0 },
    can_have_runewords: false,
    drops_uber_frags: false,
    favor_loot_multi: 1,
    favor_needed: 0,
    favor_per_hour: 250,
    guid,
    higher_rar: guid === 'common' ? 'uncommon' : 'rare',
    is_unique_item: false,
    item_model_data_num: guid === 'common' ? 1 : 2,
    item_tier: guid === 'common' ? 0 : 1,
    item_tier_power: 1,
    item_value_multi: 1,
    lootable_gear_tier: 'LOW',
    map_lives: 3,
    map_resist_req: -50,
    map_tiers: { max: 10, min: 0 },
    map_xp_multi: 1,
    max_gems: 10,
    max_runes: 2,
    min_affixes: 1,
    min_lvl: 0,
    min_map_rarity_to_drop: 'common',
    omens: {
      affixes: { max: 1, min: 1 },
      normal: { max: 1, min: 1 },
      runed: { max: 1, min: 1 },
      specific_slots: { max: 0, min: 0 },
      stat_multi: 0.5,
      unique: { max: 1, min: 1 },
    },
    pot: { total: 75 },
    sockets: { max: 2, min: 0 },
    stat_percents: { max: 17, min: 0 },
    text_format: 'GRAY',
    weight,
  }, null, 2);
}

function compatibilityJar(): Buffer {
  return zip(new Map<string, string | Buffer>([
    [
      'META-INF/mods.toml',
      `modLoader="javafml"
loaderVersion="[47,)"
license="ARR"
[[mods]]
modId="mns_compat"
version="1.0.0"
displayName="MNS Compatibility"
`,
    ],
    ['external/Target.class', Buffer.from('class ownership marker')],
    ['data/mmorpg/mmorpg_spells/compat_spell.json', '{"damage":4}'],
    ['data/mmorpg/mmorpg_spells/fireball.json', '{"damage":11}'],
  ]));
}

describe('evidence-backed ecosystem analysis', () => {
  it('connects real configuration shape, systems, dependencies and datapack overrides', async () => {
    const root = await workspace();
    await write(root, 'mods/mine-and-slash.jar', mineAndSlashJar());
    await write(root, 'mods/mns-compat.jar', compatibilityJar());
    await write(
      root,
      'world/serverconfig/mine_and_slash-server.toml',
      `[general]
#Chance for a map to drop.
#Range: 0.0 ~ 100.0
MAP_DROPRATE = 1.5
#Allowed Values: ORIGINAL_MODE, COMPATIBLE_MODE
COMPATIBILITY_PRESET = "ORIGINAL_MODE"
mana_regen = 2.0
mob_death_messages = false
enabled = true
`,
    );
    await write(
      root,
      'config/openloader/data/cte_mns/pack.mcmeta',
      '{"pack":{"pack_format":15,"description":"CtE MMO"}}',
    );
    await write(
      root,
      'config/openloader/data/cte_mns/data/mmorpg/mmorpg_spells/fireball.json',
      '{"damage":12}',
    );
    await write(
      root,
      'config/openloader/data/cte_mns/data/mmorpg/mmorpg_spells/frost_nova.json',
      '{"damage":8}',
    );

    const inventory = await new WorkspaceInventoryService().build({ root });
    const analysis = await new EcosystemAnalysisService().analyze({
      root,
      inventory,
      generatedAt: new Date('2026-08-09T12:00:00.000Z'),
    });

    assert.equal(analysis.mods[0]?.modId, 'mmorpg');
    assert.equal(analysis.summary.configurations, 5);
    assert.equal(analysis.summary.datapacks, 1);
    assert.equal(analysis.summary.datapackResources, 2);

    const dropRate = analysis.configurations.find((field) => field.name === 'MAP_DROPRATE');
    assert.equal(dropRate?.category, 'Loot and drops');
    assert.equal(dropRate?.currentValue, 1.5);
    assert.equal(dropRate?.defaultValue, null);
    assert.deepEqual(dropRate?.constraints, [
      { kind: 'range', minimum: 0, maximum: 100, source: 'declared' },
    ]);
    assert.equal(dropRate?.source.file, 'world/serverconfig/mine_and_slash-server.toml');
    assert.equal(dropRate?.source.path, 'general.MAP_DROPRATE');
    assert.equal(dropRate?.side, 'server');
    assert.equal(dropRate?.confidence, 'medium');

    const preset = analysis.configurations.find((field) => field.name === 'COMPATIBILITY_PRESET');
    assert.equal(preset?.type, 'enum');
    assert.deepEqual(preset?.allowedValues, ['ORIGINAL_MODE', 'COMPATIBLE_MODE']);

    const enabled = analysis.configurations.find((field) => field.name === 'enabled');
    assert.equal(enabled?.defaultValue, true);
    assert.equal(enabled?.description, 'Enables the tested system.');
    assert.ok(enabled?.evidenceIds.some((id) =>
      analysis.evidence.find((item) => item.evidenceId === id)?.source === 'class-bytecode',
    ));

    assert.ok(
      analysis.relationships.some(
        (edge) =>
          edge.from.id === 'mmorpg' && edge.to.id === 'library_of_exile' && edge.type === 'REQUIRES',
      ),
    );
    assert.ok(
      analysis.relationships.some(
        (edge) =>
          edge.from.id === 'mmorpg' &&
          edge.to.id === 'mns_compat' &&
          edge.type === 'INTEGRATES_WITH' &&
          edge.confidence === 'high',
      ),
    );
    assert.ok(
      analysis.relationships.some(
        (edge) =>
          edge.from.id === 'mmorpg' &&
          edge.to.id === 'mns_compat' &&
          edge.type === 'READS_REGISTRY_FROM',
      ),
    );
    assert.ok(
      analysis.relationships.some(
        (edge) =>
          edge.from.id === 'mmorpg' &&
          edge.to.id === 'mns_compat' &&
          edge.type === 'MODIFIES_GAMEPLAY_OF',
      ),
    );
    assert.ok(
      analysis.relationships.some(
        (edge) =>
          edge.from.id === 'mns_compat' &&
          edge.to.id === 'mmorpg' &&
          edge.type === 'DATAPACK_EXTENDS' &&
          edge.systemId !== null,
      ),
    );
    assert.ok(
      analysis.relationships.some(
        (edge) =>
          edge.from.id === 'mns_compat' && edge.to.id === 'mmorpg' && edge.type === 'OVERRIDES',
      ),
    );
    assert.ok(
      analysis.relationships.some(
        (edge) => edge.from.type === 'Datapack' && edge.to.id === 'mmorpg' && edge.type === 'OVERRIDES',
      ),
    );
    assert.ok(
      analysis.relationships.some(
        (edge) =>
          edge.from.type === 'Datapack' &&
          edge.to.id === 'mmorpg' &&
          edge.type === 'DATAPACK_EXTENDS',
      ),
    );
    assert.deepEqual(
      analysis.datapackResources.map((resource) => resource.effect).sort(),
      ['extends', 'overrides'],
    );
    assert.ok(analysis.evidence.every((item) => !item.sourcePath.includes(root)));
    assert.ok(analysis.graph.entities.some((entity) => entity.type === 'Evidence'));
    assert.ok(analysis.graph.entities.some((entity) => entity.type === 'Registry'));
  });

  it('keys an analysis to inventory content and analyzer version, not the clock', async () => {
    const root = await workspace();
    await write(root, 'mods/mine-and-slash.jar', mineAndSlashJar());
    await write(root, 'world/serverconfig/mine_and_slash-server.toml', 'enabled = true\n');
    const inventory = await new WorkspaceInventoryService().build({ root });
    const service = new EcosystemAnalysisService();

    const first = await service.analyze({
      root,
      inventory,
      generatedAt: new Date('2026-08-09T12:00:00.000Z'),
    });
    const second = await service.analyze({
      root,
      inventory,
      generatedAt: new Date('2026-08-09T13:00:00.000Z'),
    });
    assert.equal(first.analysisId, second.analysisId);
    assert.notEqual(first.generatedAt, second.generatedAt);
  });

  it('normalizes reviewed datapack fields, embedded defaults and cross-pack conflicts', async () => {
    const root = await workspace();
    await write(root, 'mods/mine-and-slash.jar', mineAndSlashJar());
    await write(root, 'config/openloader/data/cte_mns/pack.mcmeta', '{"pack":{"pack_format":15}}');
    await write(
      root,
      'config/openloader/data/cte_mns/data/mmorpg/mmorpg_gear_rarity/common.json',
      gearRarity('common', 729),
    );
    await write(
      root,
      'config/openloader/data/cte_mns/data/mmorpg/mmorpg_gear_rarity/uncommon.json',
      gearRarity('uncommon', 900),
    );
    await write(root, 'config/openloader/data/cte_overlay/pack.mcmeta', '{"pack":{"pack_format":15}}');
    await write(
      root,
      'config/openloader/data/cte_overlay/data/mmorpg/mmorpg_gear_rarity/common.json',
      gearRarity('common', 800),
    );

    const inventory = await new WorkspaceInventoryService().build({ root });
    const analysis = await new EcosystemAnalysisService().analyze({ root, inventory });

    assert.equal(analysis.summary.datapackConflicts, 1);
    assert.equal(analysis.datapackConflicts[0]?.kind, 'divergent-content');
    assert.equal(analysis.datapackConflicts[0]?.resolution, 'unknown-load-order');
    assert.equal(analysis.datapackConflicts[0]?.resourceIds.length, 2);
    assert.ok(analysis.relationships.some((edge) => edge.type === 'PARTICIPATES_IN'));

    const uncommon = analysis.datapackResources.find((resource) =>
      resource.sourceFile.endsWith('/uncommon.json'));
    assert.equal(uncommon?.reviewedSchema?.schemaId, 'mmorpg-gear-rarity');
    assert.equal(uncommon?.semanticFields.length, 46);
    assert.deepEqual(uncommon?.conflictIds, []);
    const weight = analysis.configurations.find((configuration) =>
      configuration.source.file.endsWith('/uncommon.json') && configuration.source.path === 'weight');
    assert.equal(weight?.currentValue, 900);
    assert.equal(weight?.defaultValue, 2000);
    assert.equal(weight?.editable, true);
    assert.equal(weight?.source.kind, 'datapack-resource');

    const conflictedWeight = analysis.configurations.find((configuration) =>
      configuration.source.file.includes('/cte_mns/') &&
      configuration.source.file.endsWith('/common.json') &&
      configuration.source.path === 'weight');
    assert.equal(conflictedWeight?.editable, false);
    assert.ok(analysis.issues.some((issue) => issue.code === 'datapack-resource-conflict'));

    const mnsPack = analysis.datapacks.find((datapack) => datapack.rootPath.endsWith('/cte_mns'));
    const overlayPack = analysis.datapacks.find((datapack) => datapack.rootPath.endsWith('/cte_overlay'));
    assert.notEqual(mnsPack, undefined);
    assert.notEqual(overlayPack, undefined);
    if (mnsPack === undefined || overlayPack === undefined) return;
    const observation = parseDatapackLoadOrderObservation({
      schemaVersion: 1,
      source: 'minecraft-world-metadata-v1',
      inventorySha256: analysis.inventorySha256,
      observedAt: '2026-08-10T12:00:00.000Z',
      evidenceSha256: 'e'.repeat(64),
      order: 'lowest-priority-first',
      datapacks: [
        { rootPath: mnsPack.rootPath, sha256: mnsPack.sha256 },
        { rootPath: overlayPack.rootPath, sha256: overlayPack.sha256 },
      ],
    });
    const projection = projectObservedDatapackLoadOrder({ analysis, observation });
    assert.equal(projection.authorizesSemanticEditing, false);
    assert.equal(projection.resolutions[0]?.status, 'resolved');
    assert.equal(projection.resolutions[0]?.reason, 'observed-winner');
    assert.equal(projection.resolutions[0]?.winningDatapackId, overlayPack.datapackId);
    assert.equal(
      projection.resolutions[0]?.winningResourceId,
      analysis.datapackResources.find((resource) =>
        resource.datapackId === overlayPack.datapackId && resource.sourceFile.endsWith('/common.json'))
        ?.resourceId,
    );
    assert.equal(analysis.datapackConflicts[0]?.resolution, 'unknown-load-order');
    assert.equal(conflictedWeight?.editable, false);

    const reversedObservation = parseDatapackLoadOrderObservation({
      schemaVersion: 1,
      source: 'minecraft-world-metadata-v1',
      inventorySha256: analysis.inventorySha256,
      observedAt: '2026-08-10T12:01:00.000Z',
      evidenceSha256: 'd'.repeat(64),
      order: 'lowest-priority-first',
      datapacks: [...observation.datapacks].reverse(),
    });
    assert.equal(
      projectObservedDatapackLoadOrder({ analysis, observation: reversedObservation })
        .resolutions[0]?.winningDatapackId,
      mnsPack.datapackId,
    );

    const incompleteObservation = parseDatapackLoadOrderObservation({
      schemaVersion: 1,
      source: 'minecraft-world-metadata-v1',
      inventorySha256: analysis.inventorySha256,
      observedAt: '2026-08-10T12:02:00.000Z',
      evidenceSha256: 'c'.repeat(64),
      order: 'lowest-priority-first',
      datapacks: [observation.datapacks[0]],
    });
    assert.equal(
      projectObservedDatapackLoadOrder({ analysis, observation: incompleteObservation })
        .resolutions[0]?.reason,
      'participant-not-observed',
    );

    const changedPackObservation = parseDatapackLoadOrderObservation({
      schemaVersion: 1,
      source: 'minecraft-world-metadata-v1',
      inventorySha256: analysis.inventorySha256,
      observedAt: '2026-08-10T12:03:00.000Z',
      evidenceSha256: 'b'.repeat(64),
      order: 'lowest-priority-first',
      datapacks: observation.datapacks.map((datapack) => datapack.rootPath === overlayPack.rootPath
        ? { ...datapack, sha256: 'a'.repeat(64) }
        : datapack),
    });
    assert.equal(
      projectObservedDatapackLoadOrder({ analysis, observation: changedPackObservation })
        .resolutions[0]?.reason,
      'participant-hash-mismatch',
    );

    const staleObservation = parseDatapackLoadOrderObservation({
      schemaVersion: 1,
      source: 'minecraft-world-metadata-v1',
      inventorySha256: 'f'.repeat(64),
      observedAt: '2026-08-10T12:00:00.000Z',
      evidenceSha256: 'e'.repeat(64),
      order: 'lowest-priority-first',
      datapacks: observation.datapacks,
    });
    assert.equal(
      projectObservedDatapackLoadOrder({ analysis, observation: staleObservation }).resolutions[0]?.reason,
      'inventory-mismatch',
    );
  });

  it('rejects unsafe, ambiguous or extensible datapack load-order observations', () => {
    const valid = {
      schemaVersion: 1,
      source: 'minecraft-runtime-report-v1',
      inventorySha256: 'a'.repeat(64),
      observedAt: '2026-08-10T12:00:00.000Z',
      evidenceSha256: 'b'.repeat(64),
      order: 'lowest-priority-first',
      datapacks: [{ rootPath: 'config/openloader/data/cte_mns', sha256: 'c'.repeat(64) }],
    } as const;
    const observation = parseDatapackLoadOrderObservation(valid);
    assert.equal(observation.observationId.length, 64);
    assert.equal(Object.isFrozen(observation), true);
    assert.equal(Object.isFrozen(observation.datapacks), true);

    assert.throws(
      () => parseDatapackLoadOrderObservation({ ...valid, extra: true }),
      /ecosystem-analysis:invalid-datapack-load-order-observation/u,
    );
    assert.throws(
      () => parseDatapackLoadOrderObservation({
        ...valid,
        datapacks: [{ rootPath: 'C:/private/world/datapacks/cte_mns', sha256: 'c'.repeat(64) }],
      }),
      /ecosystem-analysis:invalid-datapack-load-order-observation/u,
    );
    assert.throws(
      () => parseDatapackLoadOrderObservation({
        ...valid,
        datapacks: [
          ...valid.datapacks,
          { rootPath: 'CONFIG/OPENLOADER/DATA/CTE_MNS', sha256: 'd'.repeat(64) },
        ],
      }),
      /ecosystem-analysis:invalid-datapack-load-order-observation/u,
    );
  });

  it('validates only mutable fields and preserves reviewed range ordering', () => {
    const content = gearRarity('common', 5000);
    const inspection = VOIDFALL_TRUSTED_DATAPACK_SCHEMA_REGISTRY.inspect({
      schemaId: 'mmorpg-gear-rarity',
      resourcePath: 'common.json',
      content,
    });
    assert.equal(inspection.success, true);
    if (!inspection.success) return;
    assert.equal(Object.keys(inspection.values).length, 46);

    assert.deepEqual(
      VOIDFALL_TRUSTED_DATAPACK_SCHEMA_REGISTRY.validateChanges({
        schemaId: 'mmorpg-gear-rarity',
        resourcePath: 'common.json',
        content,
        changes: [
          { path: 'weight', value: 729 },
          { path: 'guid', value: 'renamed' },
          { path: 'sockets.min', value: 3 },
        ],
      }),
      [
        { path: 'weight', accepted: true },
        { path: 'guid', accepted: false, code: 'field-readonly' },
        { path: 'sockets.min', accepted: false, code: 'range-order' },
      ],
    );

    assert.deepEqual(
      VOIDFALL_TRUSTED_DATAPACK_SCHEMA_REGISTRY.validateChanges({
        schemaId: 'mmorpg-gear-rarity',
        resourcePath: 'common.json',
        content,
        changes: [
          { path: 'weight', value: 729 },
          { path: 'weight', value: 800 },
        ],
      }),
      [
        { path: 'weight', accepted: true },
        { path: 'weight', accepted: false, code: 'duplicate-field' },
      ],
    );

    const withUnknownEmptyObject = JSON.parse(content) as Record<string, unknown>;
    withUnknownEmptyObject['unreviewed_extension'] = {};
    const extendedInspection = VOIDFALL_TRUSTED_DATAPACK_SCHEMA_REGISTRY.inspect({
      schemaId: 'mmorpg-gear-rarity',
      resourcePath: 'common.json',
      content: JSON.stringify(withUnknownEmptyObject),
    });
    assert.equal(extendedInspection.success, false);
    if (!extendedInspection.success) assert.equal(extendedInspection.code, 'schema-mismatch');

    const withInvalidRange = JSON.parse(content) as { sockets: { min: number; max: number } };
    withInvalidRange.sockets.min = 4;
    withInvalidRange.sockets.max = 2;
    const invalidRangeInspection = VOIDFALL_TRUSTED_DATAPACK_SCHEMA_REGISTRY.inspect({
      schemaId: 'mmorpg-gear-rarity',
      resourcePath: 'common.json',
      content: JSON.stringify(withInvalidRange),
    });
    assert.equal(invalidRangeInspection.success, false);
    if (!invalidRangeInspection.success) assert.equal(invalidRangeInspection.code, 'schema-mismatch');
  });
});
