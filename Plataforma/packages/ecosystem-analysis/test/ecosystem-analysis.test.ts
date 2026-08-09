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
  VOIDFALL_TRUSTED_DATAPACK_SCHEMA_REGISTRY,
} from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
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
