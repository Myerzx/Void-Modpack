import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  ArtifactInspectionError,
  ArtifactInspectionService,
  DEFAULT_ARTIFACT_INSPECTION_LIMITS,
  parseJarManifest,
  parseModsToml,
  readZipDirectory,
} from '../src/index.js';

const NOW = new Date('2026-08-04T12:00:00.000Z');

/**
 * Deterministic ZIP builder.
 *
 * Fixtures are built in code rather than committed as binaries so every field
 * a test wants to corrupt — a declared size, a compression method, an entry
 * name — stays explicit and reviewable in the diff.
 */
interface FixtureEntry {
  readonly name: string;
  readonly content: Buffer | string;
  readonly deflate?: boolean;
  /** Overrides used to forge a malformed archive. */
  readonly declaredUncompressedSize?: number;
  readonly compressionMethod?: number;
  readonly flags?: number;
}

function buildZip(entries: readonly FixtureEntry[], options: { readonly comment?: string } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
    const deflate = entry.deflate ?? false;
    const stored = deflate ? deflateRawSync(raw) : raw;
    const method = entry.compressionMethod ?? (deflate ? 8 : 0);
    const declaredSize = entry.declaredUncompressedSize ?? raw.length;
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const flags = entry.flags ?? 0;
    const crc = 0;

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    locals.push(local, stored);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + stored.length;
  }

  const directory = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment ?? '', 'utf8');
  const eocd = Buffer.alloc(22 + comment.length);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  comment.copy(eocd, 22);

  return Buffer.concat([...locals, directory, eocd]);
}

const FORGE_MODS_TOML = [
  'modLoader = "javafml"',
  'loaderVersion = "[47,)"',
  'license = "MIT"',
  '',
  '[[mods]]',
  'modId = "voidfall_probe"',
  'version = "${file.jarVersion}"',
  'displayName = "VoidFall Probe"',
  '',
  '[[dependencies.voidfall_probe]]',
  'modId = "forge"',
  'mandatory = true',
  'versionRange = "[47,)"',
  'side = "BOTH"',
  '',
  '[[dependencies.voidfall_probe]]',
  'modId = "optional_helper"',
  'mandatory = false',
  'versionRange = "[1.0,)"',
  'side = "CLIENT"',
  '',
].join('\n');

const MANIFEST = ['Manifest-Version: 1.0', 'Implementation-Version: 3.2.1', ''].join('\r\n');

function service(limits?: Partial<typeof DEFAULT_ARTIFACT_INSPECTION_LIMITS>) {
  return new ArtifactInspectionService({ clock: () => NOW, ...(limits === undefined ? {} : { limits }) });
}

function expectCode(operation: () => unknown, code: ArtifactInspectionError['code']): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof ArtifactInspectionError, `expected an inspection error for ${code}`);
    assert.equal(error.code, code);
    return true;
  });
}

describe('declared metadata inspection', () => {
  it('reports the declared Forge mod, dependencies and resolved jar version', () => {
    const archive = buildZip([
      { name: 'META-INF/MANIFEST.MF', content: MANIFEST },
      { name: 'META-INF/mods.toml', content: FORGE_MODS_TOML, deflate: true },
      { name: 'com/example/Probe.class', content: 'not really a class' },
      { name: 'data/voidfall/tags/x.json', content: '{}' },
      { name: 'assets/voidfall/lang/en_us.json', content: '{}' },
    ]);

    const report = service().inspect({ content: archive });

    assert.equal(report.container, 'zip');
    assert.equal(report.sha256, createHash('sha256').update(archive).digest('hex'));
    assert.equal(report.sizeBytes, archive.length);
    assert.deepEqual(report.loaders, ['forge']);
    assert.equal(report.mods.length, 1);
    const mod = report.mods[0];
    assert.ok(mod);
    assert.equal(mod.modId, 'voidfall_probe');
    assert.equal(mod.displayName, 'VoidFall Probe');
    // The manifest resolves the documented placeholder; nothing is invented.
    assert.equal(mod.version, '3.2.1');
    assert.deepEqual(
      mod.dependencies.map((dependency) => [dependency.target, dependency.mandatory, dependency.side]),
      [
        ['forge', true, 'BOTH'],
        ['optional_helper', false, 'CLIENT'],
      ],
    );
    assert.deepEqual(report.evidence, ['META-INF/MANIFEST.MF', 'META-INF/mods.toml']);
    assert.deepEqual(report.metadataIssues, []);
    assert.equal(report.features.containsClasses, true);
    assert.equal(report.features.containsData, true);
    assert.equal(report.features.containsAssets, true);
    assert.equal(report.features.containsNestedJars, false);
  });

  it('keeps an unresolved version placeholder verbatim instead of guessing', () => {
    const archive = buildZip([{ name: 'META-INF/mods.toml', content: FORGE_MODS_TOML }]);
    const report = service().inspect({ content: archive });
    assert.equal(report.mods[0]?.version, '${file.jarVersion}');
  });

  it('attributes NeoForge separately from Forge', () => {
    const archive = buildZip([
      {
        name: 'META-INF/neoforge.mods.toml',
        content: FORGE_MODS_TOML.replace('voidfall_probe', 'voidfall_neo'),
      },
    ]);
    const report = service().inspect({ content: archive });
    assert.deepEqual(report.loaders, ['neoforge']);
    assert.equal(report.mods[0]?.loader, 'neoforge');
  });

  it('reads a Fabric descriptor only when no Forge descriptor claims the artifact', () => {
    const fabric = JSON.stringify({
      id: 'voidfall_fabric',
      name: 'VoidFall Fabric',
      version: '1.4.0',
      depends: { fabricloader: '>=0.15.0', minecraft: '1.20.1' },
    });

    const alone = service().inspect({ content: buildZip([{ name: 'fabric.mod.json', content: fabric }]) });
    assert.deepEqual(alone.loaders, ['fabric']);
    assert.equal(alone.mods[0]?.modId, 'voidfall_fabric');
    assert.equal(alone.mods[0]?.dependencies.length, 2);

    const both = service().inspect({
      content: buildZip([
        { name: 'META-INF/mods.toml', content: FORGE_MODS_TOML },
        { name: 'fabric.mod.json', content: fabric },
      ]),
    });
    assert.deepEqual(both.loaders, ['forge']);
    assert.equal(both.mods.length, 1);
    assert.equal(
      both.metadataIssues.some((issue) => issue.startsWith('fabric.mod.json: ignored')),
      true,
    );
  });

  it('reports embedded JarJar libraries as declarations without opening them', () => {
    const jarJar = JSON.stringify({
      jars: [
        {
          identifier: { group: 'com.example', artifact: 'probe-lib' },
          version: { artifactVersion: '2.0.0' },
        },
      ],
    });
    const archive = buildZip([
      { name: 'META-INF/mods.toml', content: FORGE_MODS_TOML },
      { name: 'META-INF/jarjar/metadata.json', content: jarJar },
      { name: 'META-INF/jarjar/probe-lib-2.0.0.jar', content: 'PK-not-opened' },
    ]);

    const report = service().inspect({ content: archive });
    assert.deepEqual(report.embeddedLibraries, [
      { identifier: 'com.example:probe-lib', version: '2.0.0', evidence: 'META-INF/jarjar/metadata.json' },
    ]);
    assert.equal(report.features.containsNestedJars, true);
    // The nested jar itself was never expanded: only the three descriptors were.
    assert.equal(report.expandedBytes < 1024, true);
  });

  it('records an unreadable descriptor as an issue instead of dropping it', () => {
    const archive = buildZip([
      { name: 'META-INF/mods.toml', content: FORGE_MODS_TOML },
      { name: 'META-INF/jarjar/metadata.json', content: '{ this is not json' },
    ]);
    const report = service().inspect({ content: archive });
    assert.equal(report.mods.length, 1);
    assert.equal(
      report.metadataIssues.some((issue) => issue.startsWith('META-INF/jarjar/metadata.json')),
      true,
    );
    assert.deepEqual(report.embeddedLibraries, []);
  });

  it('marks an artifact with no reviewed descriptor as unknown', () => {
    const report = service().inspect({ content: buildZip([{ name: 'readme.txt', content: 'hello' }]) });
    assert.deepEqual(report.loaders, ['unknown']);
    assert.deepEqual(report.mods, []);
    assert.deepEqual(report.evidence, []);
  });

  it('flags a legacy descriptor as unparsed rather than pretending to read it', () => {
    const report = service().inspect({ content: buildZip([{ name: 'mcmod.info', content: '[]' }]) });
    assert.deepEqual(report.loaders, ['legacy-mcmod']);
    assert.equal(report.metadataIssues.some((issue) => issue.includes('no reviewed parser')), true);
  });
});

describe('inspection bounds and refusals', () => {
  it('refuses content that is not a ZIP container', () => {
    expectCode(() => service().inspect({ content: Buffer.from('definitely not a zip') }), 'not-a-zip-container');
    expectCode(() => service().inspect({ content: Buffer.alloc(0) }), 'not-a-zip-container');
  });

  it('refuses a truncated archive', () => {
    const archive = buildZip([{ name: 'META-INF/mods.toml', content: FORGE_MODS_TOML }]);
    expectCode(() => service().inspect({ content: archive.subarray(0, archive.length - 8) }), 'not-a-zip-container');

    // A valid EOCD pointing past the end of the file is a truncated directory.
    const forged = Buffer.from(archive);
    forged.writeUInt32LE(archive.length + 1024, forged.length - 6);
    expectCode(() => service().inspect({ content: forged }), 'truncated-archive');
  });

  it('refuses path traversal, absolute and drive-qualified entry names', () => {
    for (const name of ['../escape.toml', 'nested/../../escape.toml', '/etc/passwd', 'C:/windows/x.txt']) {
      expectCode(() => service().inspect({ content: buildZip([{ name, content: 'x' }]) }), 'unsafe-entry-name');
    }
  });

  it('refuses a backslash or control character in an entry name', () => {
    expectCode(
      () => service().inspect({ content: buildZip([{ name: 'nested\\escape.toml', content: 'x' }]) }),
      'unsafe-entry-name',
    );
    expectCode(
      () => service().inspect({ content: buildZip([{ name: `probe${String.fromCharCode(0)}.toml`, content: 'x' }]) }),
      'unsafe-entry-name',
    );
  });

  it('refuses an entry name that is too long or too deep', () => {
    expectCode(
      () => service().inspect({ content: buildZip([{ name: `${'a'.repeat(600)}.txt`, content: 'x' }]) }),
      'entry-name-too-long',
    );
    expectCode(
      () =>
        service().inspect({
          content: buildZip([{ name: `${Array.from({ length: 40 }, () => 'd').join('/')}/x.txt`, content: 'x' }]),
        }),
      'entry-depth-exceeded',
    );
  });

  it('refuses more entries than the limit allows', () => {
    const entries = Array.from({ length: 6 }, (_, index) => ({ name: `file-${index}.txt`, content: 'x' }));
    expectCode(
      () => service({ maximumEntries: 5 }).inspect({ content: buildZip(entries) }),
      'too-many-entries',
    );
  });

  it('refuses an archive larger than its limit before reading it', () => {
    const archive = buildZip([{ name: 'a.txt', content: 'x'.repeat(4096) }]);
    expectCode(
      () => service({ maximumArchiveBytes: 512 }).inspect({ content: archive }),
      'content-too-large',
    );
  });

  it('refuses a ZIP bomb by its declared ratio before allocating', () => {
    // 2 MiB of zeroes deflates to a few hundred bytes: a ratio far past the cap.
    const bomb = Buffer.alloc(2 * 1024 * 1024, 0);
    const archive = buildZip([{ name: 'META-INF/mods.toml', content: bomb, deflate: true }]);
    expectCode(() => service().inspect({ content: archive }), 'metadata-too-large');

    // Raising the per-file cap still leaves the ratio guard in place.
    expectCode(
      () => service({ maximumMetadataBytes: 4 * 1024 * 1024, maximumExpandedBytes: 8 * 1024 * 1024 }).inspect({ content: archive }),
      'compression-ratio-exceeded',
    );
  });

  it('refuses a descriptor whose real size contradicts the directory', () => {
    const archive = buildZip([
      { name: 'META-INF/mods.toml', content: FORGE_MODS_TOML, declaredUncompressedSize: 4 },
    ]);
    expectCode(() => service().inspect({ content: archive }), 'entry-size-mismatch');
  });

  it('refuses an encrypted entry and an unsupported compression method', () => {
    expectCode(
      () => service().inspect({ content: buildZip([{ name: 'META-INF/mods.toml', content: 'x', flags: 0x1 }]) }),
      'encrypted-entry',
    );
    expectCode(
      () =>
        service().inspect({
          content: buildZip([{ name: 'META-INF/mods.toml', content: 'x', compressionMethod: 12 }]),
        }),
      'unsupported-zip-feature',
    );
  });

  it('refuses to expand more than the total budget across descriptors', () => {
    const filler = 'k = "v"\n'.repeat(400);
    const archive = buildZip([
      { name: 'META-INF/MANIFEST.MF', content: MANIFEST },
      { name: 'META-INF/mods.toml', content: filler },
    ]);
    expectCode(
      () => service({ maximumExpandedBytes: 64, maximumMetadataBytes: 64 }).inspect({ content: archive }),
      'metadata-too-large',
    );
  });

  it('refuses a hash that does not match the content', () => {
    const archive = buildZip([{ name: 'a.txt', content: 'x' }]);
    expectCode(
      () => service().inspect({ content: archive, expectedSha256: 'f'.repeat(64) }),
      'hash-mismatch',
    );
    const actual = createHash('sha256').update(archive).digest('hex');
    assert.equal(service().inspect({ content: archive, expectedSha256: actual }).sha256, actual);
  });

  it('refuses an invalid plan or limit set', () => {
    expectCode(() => service().inspect({ content: 'not bytes' as never }), 'invalid-plan');
    expectCode(
      () => service().inspect({ content: buildZip([{ name: 'a.txt', content: 'x' }]), expectedSha256: 'nope' }),
      'invalid-plan',
    );
    expectCode(() => service({ maximumEntries: 0 }), 'invalid-options');
    expectCode(() => service({ maximumExpandedBytes: 1, maximumMetadataBytes: 4096 }), 'invalid-options');
  });

  it('never reveals a host path or an entry name in a public error message', () => {
    try {
      service().inspect({ content: buildZip([{ name: '../secret/escape.toml', content: 'x' }]) });
      assert.fail('expected a refusal');
    } catch (error) {
      assert.ok(error instanceof ArtifactInspectionError);
      assert.equal(error.message.includes('secret'), false);
      assert.equal(error.message.includes('escape.toml'), false);
      assert.equal(/[A-Z]:\\|\/home\//u.test(error.message), false);
    }
  });
});

describe('strict subset readers', () => {
  it('reads only the manifest main section and folded continuations', () => {
    const manifest = parseJarManifest(
      Buffer.from(
        ['Manifest-Version: 1.0', 'Implementation-Title: Void', ' Fall', '', 'Name: other/', 'Sealed: true', ''].join(
          '\r\n',
        ),
        'utf8',
      ),
    );
    assert.equal(manifest['Implementation-Title'], 'VoidFall');
    // Per-entry sections after the blank line are not main attributes.
    assert.equal(manifest['Sealed'], undefined);
  });

  it('reads the reviewed TOML subset and ignores what it cannot vouch for', () => {
    const parsed = parseModsToml(
      Buffer.from(
        [
          'modLoader = "javafml"',
          'issueTrackerURL = "https://example.invalid"',
          'unsupportedArray = [1, 2, 3]',
          'description = """',
          'multi line',
          '"""',
          '[[mods]]',
          'modId = "probe"',
          'flag = true',
        ].join('\n'),
        'utf8',
      ),
    ) as Record<string, unknown>;

    assert.equal(parsed['modLoader'], 'javafml');
    assert.equal(parsed['unsupportedArray'], undefined);
    assert.equal(Array.isArray(parsed['mods']), true);
    const mods = parsed['mods'] as Record<string, unknown>[];
    assert.equal(mods[0]?.['modId'], 'probe');
    assert.equal(mods[0]?.['flag'], true);
  });

  it('reads the descriptor Forge’s own template actually produces', () => {
    // Every line here is copied from the MDK skeleton, trailing comments and
    // all. Requiring a header to end at `]]` and a value at a closing quote
    // made this file declare nothing: no mods block, no keys. In a real
    // 181-archive pack that hid 76 mods, each of which declared plenty.
    const parsed = parseModsToml(
      Buffer.from(
        [
          'modLoader="javafml" #mandatory',
          'loaderVersion="[46,)" #mandatory This is typically bumped every version.',
          '[[mods]] #mandatory',
          'modId="alexsmobs" #mandatory',
          'version="1.22.9" #mandatory',
          `displayName="Alex's Mobs" #mandatory`,
          'description=\'\'\'New, original mobs.\'\'\'',
          '[[dependencies.alexsmobs]] #optional',
          '    # the modid of the dependency',
          '    modId="citadel" #mandatory',
          '    mandatory=true #mandatory',
        ].join('\r\n'),
        'utf8',
      ),
    ) as Record<string, unknown>;

    assert.equal(parsed['modLoader'], 'javafml');
    const mods = parsed['mods'] as Record<string, unknown>[];
    assert.equal(mods[0]?.['modId'], 'alexsmobs');
    assert.equal(mods[0]?.['version'], '1.22.9');
    assert.equal(mods[0]?.['displayName'], "Alex's Mobs");
    const dependencies = (parsed['dependencies'] as Record<string, unknown>)['alexsmobs'];
    assert.equal((dependencies as Record<string, unknown>[])[0]?.['modId'], 'citadel');
  });

  it('keeps a hash that is inside a quoted value', () => {
    const parsed = parseModsToml(
      Buffer.from(['[[mods]]', 'modId="probe"', 'displayName="Sharp # Mod" #note'].join('\n'), 'utf8'),
    ) as Record<string, unknown>;
    // A comment stripper that did not track quotes would truncate the name.
    assert.equal((parsed['mods'] as Record<string, unknown>[])[0]?.['displayName'], 'Sharp # Mod');
  });

  it('exposes the central directory without expanding any entry', () => {
    const archive = buildZip([
      { name: 'a.txt', content: 'aaaa', deflate: true },
      { name: 'b/', content: '' },
    ]);
    const directory = readZipDirectory(archive, DEFAULT_ARTIFACT_INSPECTION_LIMITS);
    assert.deepEqual(
      directory.entries.map((entry) => [entry.name, entry.isDirectory]),
      [
        ['a.txt', false],
        ['b/', true],
      ],
    );
  });
});
