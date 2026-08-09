import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { WorkspaceInventoryService } from '@voidfall/workspace-inventory';

import { EcosystemAnalysisService } from '../src/index.js';

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

function zip(entries: ReadonlyMap<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.from(text, 'utf8');
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
    new Map([
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
      ['data/mmorpg/mmorpg_spells/fireball.json', '{"damage":10}'],
      ['data/mmorpg/mmorpg_stat/health.json', '{"base":100}'],
    ]),
  );
}

function compatibilityJar(): Buffer {
  return zip(new Map([
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
    assert.equal(analysis.summary.configurations, 4);
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

    assert.ok(
      analysis.relationships.some(
        (edge) =>
          edge.from.id === 'mmorpg' && edge.to.id === 'library_of_exile' && edge.type === 'REQUIRES',
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
});
