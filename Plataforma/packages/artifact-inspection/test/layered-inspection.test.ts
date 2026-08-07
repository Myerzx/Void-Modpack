import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  ArtifactInspectionError,
  ArtifactInspectionService,
  DEFAULT_ARTIFACT_INSPECTION_LIMITS,
  readSelectedEntries,
  scanZipDirectoryFor,
  type ArtifactInspectionReport,
  type InspectionLayerName,
} from '../src/index.js';

/**
 * The layered path.
 *
 * The property under test throughout: identification does not depend on the
 * artifact being small enough to enumerate. A mod that declares itself is
 * identified whether it is four kilobytes or a hundred and twenty megabytes,
 * and the deep protections stay exactly where they were — refusing, and saying
 * so, rather than being raised so a specific mod can pass.
 */

const NOW = new Date('2026-08-07T12:00:00.000Z');

interface FixtureEntry {
  readonly name: string;
  readonly content: Buffer | string;
  readonly deflate?: boolean;
  readonly declaredUncompressedSize?: number;
}

function buildZip(entries: readonly FixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
    const deflate = entry.deflate ?? false;
    const stored = deflate ? deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const declaredSize = entry.declaredUncompressedSize ?? raw.length;
    const nameBytes = Buffer.from(entry.name, 'utf8');

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, stored);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + stored.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length & 0xffff, 8);
  eocd.writeUInt16LE(entries.length & 0xffff, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, eocd]);
}

const MODS_TOML = [
  'modLoader="javafml" #mandatory',
  'loaderVersion="[47,)"',
  '[[mods]] #mandatory',
  'modId="bigmod"',
  'version="1.2.3"',
  'displayName="Big Mod"',
].join('\r\n');

function service(limits?: Partial<typeof DEFAULT_ARTIFACT_INSPECTION_LIMITS>) {
  return new ArtifactInspectionService({
    clock: () => NOW,
    ...(limits === undefined ? {} : { limits }),
  });
}

function layer(report: ArtifactInspectionReport, name: InspectionLayerName) {
  const found = report.layers.find((entry) => entry.layer === name);
  assert.ok(found, `expected a ${name} layer`);
  return found;
}

/** Filler that is genuinely incompressible, so a fixture's size is its size. */
function noise(bytes: number): Buffer {
  const buffer = Buffer.allocUnsafe(bytes);
  let seed = 0x2545_f491;
  for (let index = 0; index < bytes; index += 1) {
    seed = (seed * 1_103_515_245 + 12_345) >>> 0;
    buffer[index] = (seed >>> 16) & 0xff;
  }
  return buffer;
}

describe('a large artifact with valid metadata', () => {
  // Deliberately over the archive limit used for the deep layers.
  const archive = buildZip([
    { name: 'META-INF/mods.toml', content: MODS_TOML },
    { name: 'assets/bigmod/textures/atlas.png', content: noise(3 * 1024 * 1024) },
    { name: 'com/example/Big.class', content: 'not really a class' },
  ]);

  it('identifies the mod even though the archive is past the deep limit', () => {
    const report = service({ maximumArchiveBytes: 1024 * 1024 }).inspect({ content: archive });

    // This is the whole point: too large to enumerate is not "declares nothing".
    assert.equal(report.mods[0]?.modId, 'bigmod');
    assert.equal(report.mods[0]?.version, '1.2.3');
    assert.deepEqual(report.loaders, ['forge']);
    assert.equal(layer(report, 'metadata').outcome, 'completed');
  });

  it('refuses the structural layer, names the limit and lists what is unknown', () => {
    const report = service({ maximumArchiveBytes: 1024 * 1024 }).inspect({ content: archive });
    const structural = layer(report, 'structural');

    assert.equal(structural.outcome, 'refused');
    assert.equal(structural.limit, 'maximumArchiveBytes');
    assert.equal(structural.unknown.includes('features.containsMixins'), true);
    // Nullable rather than all-false: nobody looked, which is not the same as
    // "there are no mixins".
    assert.equal(report.features, null);
    assert.equal(report.entryCount, null);
  });

  it('still enumerates when the artifact fits, and the protection is unchanged', () => {
    const report = service().inspect({ content: archive });
    assert.equal(layer(report, 'structural').outcome, 'completed');
    assert.equal(report.entryCount, 3);
    assert.equal(report.features?.containsClasses, true);
  });

  it('never attempts the deep layer without an adapter', () => {
    const deep = layer(service().inspect({ content: archive }), 'deep');
    assert.equal(deep.outcome, 'not-attempted');
    assert.equal(deep.limit, 'no-adapter');
    assert.equal(deep.unknown.length > 0, true);
  });
});

describe('an artifact with more entries than the deep limit allows', () => {
  const many: FixtureEntry[] = [{ name: 'META-INF/mods.toml', content: MODS_TOML }];
  for (let index = 0; index < 400; index += 1) {
    many.push({ name: `assets/bigmod/f${String(index)}.json`, content: '{}' });
  }
  const archive = buildZip(many);

  it('reads the descriptor without walking the entries', () => {
    const report = service({ maximumEntries: 50 }).inspect({ content: archive });

    assert.equal(report.mods[0]?.modId, 'bigmod');
    assert.equal(layer(report, 'metadata').outcome, 'completed');
    assert.equal(layer(report, 'structural').outcome, 'refused');
    assert.equal(layer(report, 'structural').limit, 'too-many-entries');
  });

  it('bounds the selective scan by the index, not by the entry count', () => {
    // The directory is what the selective path reads, so that is what bounds
    // it — and it is refused when it is genuinely too big to walk.
    assert.throws(
      () =>
        scanZipDirectoryFor(archive, new Set(['meta-inf/mods.toml']), {
          ...DEFAULT_ARTIFACT_INSPECTION_LIMITS,
          maximumDirectoryBytes: 64,
        }),
      (error: unknown) =>
        error instanceof ArtifactInspectionError && error.code === 'directory-too-large',
    );
  });

  it('reports the metadata layer as refused rather than throwing', () => {
    const report = service({ maximumDirectoryBytes: 64 }).inspect({ content: archive });
    const metadata = layer(report, 'metadata');
    assert.equal(metadata.outcome, 'refused');
    assert.equal(metadata.limit, 'maximumDirectoryBytes');
    assert.deepEqual(report.mods, []);
    // A limit we chose is reported; it is not an invalid artifact.
    assert.deepEqual(report.loaders, ['unknown']);
  });
});

describe('a large artifact with no known metadata', () => {
  const archive = buildZip([
    { name: 'com/example/Thing.class', content: noise(2 * 1024 * 1024) },
    { name: 'README.txt', content: 'nothing declared here' },
  ]);

  it('says the metadata layer ran and found nothing, which is not a refusal', () => {
    const report = service({ maximumArchiveBytes: 1024 * 1024 }).inspect({ content: archive });

    assert.equal(layer(report, 'metadata').outcome, 'completed');
    assert.deepEqual(report.mods, []);
    assert.deepEqual(report.evidence, []);
    assert.deepEqual(report.loaders, ['unknown']);
    // "We looked and there is nothing" and "we were not allowed to look" are
    // different facts, and only the first one is true here.
    assert.equal(layer(report, 'metadata').limit, null);
  });
});

describe('protection against excessive reading', () => {
  it('refuses an abnormally large descriptor instead of expanding it', () => {
    const archive = buildZip([
      // A descriptor of 600 KiB, past `maximumMetadataBytes`. That is not a
      // large mod being identified cheaply — it is an archive asking to be
      // expanded, and the selective layer refuses it exactly as the deep one
      // would. Being cheap to *find* is not permission to read anything.
      { name: 'META-INF/mods.toml', content: noise(600 * 1024) },
      { name: 'assets/bigmod/x.png', content: noise(1024) },
    ]);
    assert.throws(
      () => service().inspect({ content: archive }),
      (error: unknown) =>
        error instanceof ArtifactInspectionError && error.code === 'metadata-too-large',
    );
  });

  it('refuses a descriptor whose declared expansion is implausible', () => {
    // A tiny deflated payload declaring a huge expansion is the shape of a zip
    // bomb. The ratio is checked against the declared sizes, before anything
    // is allocated — being on the selective path changes nothing about that.
    const archive = buildZip([
      {
        name: 'META-INF/mods.toml',
        content: Buffer.alloc(400 * 1024, 0x61),
        deflate: true,
        declaredUncompressedSize: 400 * 1024,
      },
    ]);
    assert.throws(
      () => service().inspect({ content: archive }),
      (error: unknown) => error instanceof ArtifactInspectionError,
    );
  });

  it('keeps an unsafe entry name a refusal of the whole artifact', () => {
    // Not downgraded to "the structural layer did not run". A traversal name
    // says something about the archive, unlike its size or its entry count.
    const archive = buildZip([
      { name: 'META-INF/mods.toml', content: MODS_TOML },
      { name: '../escape.txt', content: 'x' },
    ]);
    assert.throws(
      () => service().inspect({ content: archive }),
      (error: unknown) =>
        error instanceof ArtifactInspectionError && error.code === 'unsafe-entry-name',
    );
  });

  it('holds an adapter to the budget it declared', () => {
    const archive = buildZip([
      { name: 'META-INF/mods.toml', content: MODS_TOML },
      { name: 'config/defaults.json', content: '{"a":1}' },
    ]);

    const read = readSelectedEntries({
      content: archive,
      names: ['config/defaults.json'],
      budgetBytes: 4096,
    });
    assert.equal(read.get('config/defaults.json')?.toString('utf8'), '{"a":1}');
    // Only what was named: an adapter cannot enumerate through this door.
    assert.equal(read.size, 1);

    assert.throws(
      () =>
        readSelectedEntries({
          content: archive,
          names: ['config/defaults.json'],
          budgetBytes: 1,
        }),
      (error: unknown) =>
        error instanceof ArtifactInspectionError && error.code === 'expansion-limit-exceeded',
    );
  });
});

describe('a malformed container', () => {
  it('is refused rather than half-read', () => {
    const archive = buildZip([{ name: 'META-INF/mods.toml', content: MODS_TOML }]);

    // Truncated past the end of central directory.
    assert.throws(
      () => service().inspect({ content: archive.subarray(0, archive.length - 10) }),
      (error: unknown) =>
        error instanceof ArtifactInspectionError && error.code === 'not-a-zip-container',
    );

    // A directory that points outside the file.
    const corrupt = Buffer.from(archive);
    corrupt.writeUInt32LE(0xff_ff_00, corrupt.length - 6);
    assert.throws(
      () => service().inspect({ content: corrupt }),
      (error: unknown) => error instanceof ArtifactInspectionError,
    );

    // Not a container at all.
    assert.throws(
      () => service().inspect({ content: Buffer.from('this is not a zip file', 'utf8') }),
      (error: unknown) =>
        error instanceof ArtifactInspectionError && error.code === 'not-a-zip-container',
    );
  });

  it('does not let a malformed archive reach the layered path as a refusal', () => {
    // An invalid artifact is not a limit. Reporting it as "metadata refused"
    // would tell an operator to raise a bound that would never help.
    assert.throws(
      () => service().inspect({ content: Buffer.alloc(64) }),
      (error: unknown) =>
        error instanceof ArtifactInspectionError && error.code === 'not-a-zip-container',
    );
  });
});
