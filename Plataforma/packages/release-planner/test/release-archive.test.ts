import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  DEFAULT_ARTIFACT_INSPECTION_LIMITS,
  readZipDirectory,
  readZipEntry,
} from '@voidfall/artifact-inspection';

import {
  ArchiveError,
  buildPackage,
  classifySides,
  planRollback,
  presenceFromProfiles,
  RollbackError,
  selectPackageContents,
  splitBySide,
  writeZipArchive,
  type PackageManifest,
  type WorkspaceInventory,
} from '../src/index.js';

/**
 * Packaging, end to end on a real temporary directory.
 *
 * The archive is read back with `@voidfall/artifact-inspection`, which was
 * written months before this writer and knows nothing about it. A writer
 * checked by its own reader proves only that the two agree; a writer checked by
 * an independent reader that already refuses malformed archives proves the
 * bytes are right.
 */

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'voidfall-release-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function workspaceWith(
  files: readonly { readonly path: string; readonly content: string }[],
): Promise<string> {
  const directory = await mkdtemp(join(root, 'ws-'));
  for (const file of files) {
    const segments = file.path.split('/');
    const name = segments.pop() as string;
    if (segments.length > 0) {
      await mkdir(join(directory, ...segments), { recursive: true });
    }
    await writeFile(join(directory, ...segments, name), file.content, 'utf8');
  }
  return directory;
}

describe('writing a zip archive', () => {
  it('produces an archive an independent reader accepts', async () => {
    const workspace = await workspaceWith([
      { path: 'config/alpha.toml', content: `preset = "NORMAL"\n`.repeat(40) },
      { path: 'mods/alpha.jar', content: 'not really a jar, but named like one' },
      { path: 'nested/deep/file.txt', content: 'x' },
    ]);
    const target = join(root, 'basic.zip');

    const receipt = await writeZipArchive({
      targetPath: target,
      entries: [
        { name: 'config/alpha.toml', source: join(workspace, 'config', 'alpha.toml') },
        { name: 'mods/alpha.jar', source: join(workspace, 'mods', 'alpha.jar') },
        { name: 'nested/deep/file.txt', source: join(workspace, 'nested', 'deep', 'file.txt') },
      ],
    });
    assert.equal(receipt.entries, 3);

    const content = await readFile(target);
    const directory = readZipDirectory(content, DEFAULT_ARTIFACT_INSPECTION_LIMITS);
    assert.deepEqual(
      directory.entries.map((entry) => entry.name),
      ['config/alpha.toml', 'mods/alpha.jar', 'nested/deep/file.txt'],
    );

    // Reading an entry back verifies the whole chain at once: the directory's
    // declared method and sizes, the local header offset, and the payload.
    const budget = { remaining: DEFAULT_ARTIFACT_INSPECTION_LIMITS.maximumExpandedBytes };
    const toml = readZipEntry(
      content,
      directory.entries[0] as never,
      DEFAULT_ARTIFACT_INSPECTION_LIMITS,
      budget,
    );
    assert.equal(toml.toString('utf8'), `preset = "NORMAL"\n`.repeat(40));
  });

  it('carries the compression method at offset 10 of the directory header', async () => {
    // The one mistake already made once in this repository: writing the method
    // at offset 8 in the central header, where the flags live. The archive then
    // claims "stored" over deflated bytes and a reader rejects the size
    // mismatch — correctly, and a long way from the cause.
    const workspace = await workspaceWith([
      { path: 'config/big.toml', content: 'a = 1\n'.repeat(500) },
    ]);
    const target = join(root, 'offsets.zip');
    await writeZipArchive({
      targetPath: target,
      entries: [{ name: 'config/big.toml', source: join(workspace, 'config', 'big.toml') }],
    });

    const content = await readFile(target);
    const directory = readZipDirectory(content, DEFAULT_ARTIFACT_INSPECTION_LIMITS);
    const entry = directory.entries[0] as { compressionMethod: number; localHeaderOffset: number };
    assert.equal(entry.compressionMethod, 8, 'repetitive text should have deflated');
    // The same value has to appear at offset 8 of the local header.
    assert.equal(content.readUInt16LE(entry.localHeaderOffset + 8), 8);
  });

  it('stores an already-compressed entry instead of deflating it again', async () => {
    const workspace = await workspaceWith([{ path: 'mods/x.jar', content: 'aaaaaaaaaaaaaaaaaaaa' }]);
    const target = join(root, 'stored.zip');
    await writeZipArchive({
      targetPath: target,
      entries: [{ name: 'mods/x.jar', source: join(workspace, 'mods', 'x.jar') }],
    });

    const content = await readFile(target);
    const directory = readZipDirectory(content, DEFAULT_ARTIFACT_INSPECTION_LIMITS);
    // Twenty identical bytes would deflate beautifully; a jar is already a zip,
    // so spending the CPU on a gigabyte of them buys nothing.
    assert.equal((directory.entries[0] as { compressionMethod: number }).compressionMethod, 0);
  });

  it('keeps the crc of a stored entry, which is written after its header', async () => {
    // A stored entry streams through, so its header is written before the CRC
    // is known and patched afterwards. If the patch were dropped the archive
    // would still open and every entry would fail to verify.
    const workspace = await workspaceWith([{ path: 'mods/y.jar', content: 'payload bytes here' }]);
    const target = join(root, 'crc.zip');
    await writeZipArchive({
      targetPath: target,
      entries: [{ name: 'mods/y.jar', source: join(workspace, 'mods', 'y.jar') }],
    });

    const content = await readFile(target);
    const directory = readZipDirectory(content, DEFAULT_ARTIFACT_INSPECTION_LIMITS);
    const entry = directory.entries[0] as { localHeaderOffset: number };
    const local = content.readUInt32LE(entry.localHeaderOffset + 14);
    assert.notEqual(local, 0);
    // Local and central headers must agree, or a reader picking either is right
    // only half the time.
    const eocd = content.length - 22;
    const directoryOffset = content.readUInt32LE(eocd + 16);
    assert.equal(content.readUInt32LE(directoryOffset + 16), local);
  });

  it('refuses a name that would escape the folder somebody extracts into', async () => {
    const workspace = await workspaceWith([{ path: 'a.txt', content: 'a' }]);
    await assert.rejects(
      writeZipArchive({
        targetPath: join(root, 'unsafe.zip'),
        entries: [{ name: '../escape.txt', source: join(workspace, 'a.txt') }],
      }),
      (error: unknown) => error instanceof ArchiveError && error.code === 'unsafe-entry-name',
    );
  });

  it('refuses two entries with the same name', async () => {
    const workspace = await workspaceWith([{ path: 'a.txt', content: 'a' }]);
    await assert.rejects(
      writeZipArchive({
        targetPath: join(root, 'duplicate.zip'),
        entries: [
          { name: 'a.txt', source: join(workspace, 'a.txt') },
          { name: 'A.TXT', source: join(workspace, 'a.txt') },
        ],
      }),
      (error: unknown) => error instanceof ArchiveError && error.code === 'duplicate-entry-name',
    );
  });

  it('writes an empty file without inventing a payload', async () => {
    const workspace = await workspaceWith([{ path: 'empty.txt', content: '' }]);
    const target = join(root, 'empty.zip');
    await writeZipArchive({
      targetPath: target,
      entries: [{ name: 'empty.txt', source: join(workspace, 'empty.txt') }],
    });

    const content = await readFile(target);
    const directory = readZipDirectory(content, DEFAULT_ARTIFACT_INSPECTION_LIMITS);
    const entry = directory.entries[0] as { compressedSize: number; uncompressedSize: number };
    assert.equal(entry.uncompressedSize, 0);
    assert.equal(entry.compressedSize, 0);
  });
});

describe('deciding which side a file belongs on', () => {
  const presence = [
    { fileName: 'both.jar', inServer: true, inClient: true },
    { fileName: 'client.jar', inServer: false, inClient: true },
    { fileName: 'server.jar', inServer: true, inClient: false },
    { fileName: 'orphan.jar', inServer: false, inClient: false },
  ];

  it('reads the side off observed presence, not off a declaration', () => {
    assert.deepEqual(
      classifySides(presence).map((entry) => [entry.fileName, entry.side]),
      [
        ['both.jar', 'both'],
        ['client.jar', 'client-only'],
        ['orphan.jar', 'neither'],
        ['server.jar', 'server-only'],
      ],
    );
  });

  it('builds presence by comparing two real installations, matched by name', () => {
    // A server and a client routinely carry different builds of the same mod.
    // Matching by digest would report one jar as server-only and the other as
    // client-only — two wrong answers from one correct observation.
    assert.deepEqual(
      presenceFromProfiles({
        serverFiles: ['mods/Shared-1.0.jar', 'mods/OnlyServer.jar'],
        clientFiles: ['shared-1.0.jar', 'OnlyClient.jar'],
      }),
      [
        { fileName: 'onlyclient.jar', inServer: false, inClient: true },
        { fileName: 'onlyserver.jar', inServer: true, inClient: false },
        { fileName: 'shared-1.0.jar', inServer: true, inClient: true },
      ],
    );
  });

  it('leaves an unrecorded file unassigned rather than guessing server', () => {
    const split = splitBySide({
      paths: ['mods/both.jar', 'mods/client.jar', 'mods/server.jar', 'mods/unknown.jar'],
      assignments: classifySides(presence),
    });
    // Most mods are server mods, so inferring would be right often enough to be
    // trusted and wrong often enough to crash a server at boot.
    assert.deepEqual(split.unassigned, ['mods/unknown.jar']);
    assert.deepEqual(split.server, ['mods/both.jar', 'mods/server.jar']);
    assert.deepEqual(split.client, ['mods/both.jar', 'mods/client.jar']);
  });
});

function inventoryOf(
  files: readonly { readonly path: string; readonly role: string; readonly content: string }[],
): WorkspaceInventory {
  return {
    schemaVersion: 1,
    inventorySha256: 'ab'.padEnd(64, '0'),
    files: files.map((file) => ({
      path: file.path,
      role: file.role as WorkspaceInventory['files'][number]['role'],
      sizeBytes: Buffer.byteLength(file.content, 'utf8'),
      sha256: file.path.length.toString(16).padEnd(64, '0'),
    })),
    exclusions: [],
    mods: [],
    undeclaredArchives: [],
    totals: { files: files.length, bytes: 0, mods: 0 },
  };
}

describe('building a side package', () => {
  const files = [
    { path: 'mods/both.jar', role: 'mod-archive', content: 'both' },
    { path: 'mods/client.jar', role: 'mod-archive', content: 'client' },
    { path: 'mods/server.jar', role: 'mod-archive', content: 'server' },
    { path: 'mods/unknown.jar', role: 'mod-archive', content: 'unknown' },
    { path: 'mods/old.jar.disabled', role: 'other', content: 'switched off' },
    { path: 'config/alpha.toml', role: 'configuration', content: 'a = 1\n' },
    { path: 'world/serverconfig/alpha-server.toml', role: 'configuration', content: 'b = 2\n' },
    { path: 'libraries/forge.jar', role: 'runtime', content: 'runtime' },
  ];
  const assignments = classifySides([
    { fileName: 'both.jar', inServer: true, inClient: true },
    { fileName: 'client.jar', inServer: false, inClient: true },
    { fileName: 'server.jar', inServer: true, inClient: false },
  ]);
  const distributable = { distributable: true, blocks: [], localUseOnly: false } as const;
  const blocked = {
    distributable: false,
    blocks: [{ path: 'mods/both.jar', reason: 'provider-metadata-required' }],
    localUseOnly: true,
  } as const;

  it('excludes the other side, the runtime and anything unrecorded', () => {
    const selection = selectPackageContents({
      inventory: inventoryOf(files),
      assignments,
      side: 'server',
    });
    assert.deepEqual(
      selection.include.map((file) => file.path),
      [
        'config/alpha.toml',
        'mods/both.jar',
        'mods/old.jar.disabled',
        'mods/server.jar',
        'world/serverconfig/alpha-server.toml',
      ],
    );
    assert.deepEqual(
      selection.excluded.map((file) => [file.path, file.reason]),
      [
        ['libraries/forge.jar', 'runtime-infrastructure'],
        ['mods/client.jar', 'other-side'],
        ['mods/unknown.jar', 'unassigned'],
      ],
    );
  });

  it('keeps a server’s world configs and switched-off jars out of a client package', () => {
    const selection = selectPackageContents({
      inventory: inventoryOf(files),
      assignments,
      side: 'client',
    });
    // A client has no world and no serverconfig, and a player has no use for
    // somebody else's disabled mods — which would otherwise reach the archive
    // without ever passing the side split.
    assert.deepEqual(
      selection.include.map((file) => file.path),
      ['config/alpha.toml', 'mods/both.jar', 'mods/client.jar'],
    );
    assert.deepEqual(
      selection.excluded.filter((file) => file.reason === 'other-side').map((file) => file.path),
      ['mods/old.jar.disabled', 'mods/server.jar', 'world/serverconfig/alpha-server.toml'],
    );
  });

  it('writes an archive and a manifest that names what was left out', async () => {
    const workspace = await workspaceWith(files);
    const output = await mkdtemp(join(root, 'out-'));
    const built = await buildPackage({
      workspaceRoot: workspace,
      outputDirectory: output,
      inventory: inventoryOf(files),
      assignments,
      distribution: distributable,
      side: 'server',
      version: '1.2.0',
      intent: 'local-use',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    assert.equal(built.manifest.archive.fileName, 'voidfall-server-1.2.0.zip');
    assert.equal(built.manifest.archive.entries, 5);
    assert.match(built.manifest.archive.sha256, /^[0-9a-f]{64}$/u);

    const onDisk = JSON.parse(await readFile(built.manifestPath, 'utf8')) as PackageManifest;
    assert.deepEqual(
      onDisk.excluded.map((file) => file.path),
      ['libraries/forge.jar', 'mods/client.jar', 'mods/unknown.jar'],
    );

    const archive = await readFile(join(output, built.manifest.archive.fileName));
    assert.deepEqual(
      readZipDirectory(archive, DEFAULT_ARTIFACT_INSPECTION_LIMITS).entries.map((e) => e.name),
      [
        'config/alpha.toml',
        'mods/both.jar',
        'mods/old.jar.disabled',
        'mods/server.jar',
        'world/serverconfig/alpha-server.toml',
      ],
    );
  });

  it('builds for the operator’s own machine even when the licence gate refuses', async () => {
    const workspace = await workspaceWith(files);
    const output = await mkdtemp(join(root, 'out-'));
    const built = await buildPackage({
      workspaceRoot: workspace,
      outputDirectory: output,
      inventory: inventoryOf(files),
      assignments,
      distribution: blocked,
      side: 'server',
      version: '1.2.0',
      intent: 'local-use',
    });
    // Restoring your own server onto your own host is a backup. Refusing it
    // would treat a licence question as a backup question.
    assert.equal(built.manifest.intent, 'local-use');
  });

  it('refuses to build the same package for distribution, and says how many', async () => {
    const workspace = await workspaceWith(files);
    const output = await mkdtemp(join(root, 'out-'));
    await assert.rejects(
      buildPackage({
        workspaceRoot: workspace,
        outputDirectory: output,
        inventory: inventoryOf(files),
        assignments,
        distribution: blocked,
        side: 'server',
        version: '1.2.0',
        intent: 'distribution',
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('distribution-refused') &&
        error.message.includes('provider-metadata-required'),
    );
  });

  it('marks a client package as cut from a server installation', async () => {
    const workspace = await workspaceWith(files);
    const output = await mkdtemp(join(root, 'out-'));
    const built = await buildPackage({
      workspaceRoot: workspace,
      outputDirectory: output,
      inventory: inventoryOf(files),
      assignments,
      distribution: distributable,
      side: 'client',
      version: '1.2.0',
      intent: 'local-use',
    });
    // It carries the shared configuration and the client mods, but nothing that
    // only ever exists in a real client installation.
    assert.equal(built.manifest.derivedFromServerWorkspace, true);
    const archive = await readFile(join(output, built.manifest.archive.fileName));
    assert.deepEqual(
      readZipDirectory(archive, DEFAULT_ARTIFACT_INSPECTION_LIMITS).entries.map((e) => e.name),
      ['config/alpha.toml', 'mods/both.jar', 'mods/client.jar'],
    );
    // The client-only jars that live in a client profile and never in the
    // server folder cannot come from here at all — the manifest says so rather
    // than letting this read as a complete client.
    assert.equal(built.manifest.files.length, 3);
  });
});

describe('rolling back to a previous version', () => {
  function manifest(
    version: string,
    entries: readonly (readonly [string, string])[],
    side: 'server' | 'client' = 'server',
  ): PackageManifest {
    return {
      schemaVersion: 1,
      side,
      version,
      createdAt: '2026-01-01T00:00:00.000Z',
      intent: 'local-use',
      sourceInventorySha256: 'aa'.padEnd(64, '0'),
      includesRuntime: false,
      derivedFromServerWorkspace: false,
      files: entries.map(([path, sha]) => ({ path, sha256: sha.padEnd(64, '0'), sizeBytes: 1 })),
      excluded: [],
      archive: { fileName: `x-${version}.zip`, sha256: 'bb'.padEnd(64, '0'), bytes: 1, entries: 1 },
    };
  }

  it('derives every step from a digest', () => {
    const plan = planRollback({
      current: manifest('1.2.0', [
        ['config/a.toml', 'c2'],
        ['mods/kept.jar', 'k1'],
        ['mods/new.jar', 'n1'],
      ]),
      target: manifest('1.1.0', [
        ['config/a.toml', 'c1'],
        ['mods/kept.jar', 'k1'],
        ['mods/gone.jar', 'g1'],
      ]),
    });

    assert.deepEqual(
      plan.steps.map((step) => [step.path, step.kind]),
      [
        ['config/a.toml', 'restore'],
        ['mods/gone.jar', 'restore'],
        ['mods/new.jar', 'remove'],
      ],
    );
    assert.deepEqual(plan.totals, { restored: 2, removed: 1, unchanged: 1 });
  });

  it('states that the world is not covered', () => {
    const plan = planRollback({
      current: manifest('1.2.0', [['mods/a.jar', 'a2']]),
      target: manifest('1.1.0', [['mods/a.jar', 'a1']]),
    });
    // A world saved with a mod present can fail to load once that mod is gone,
    // and no file comparison can see that. It is part of the plan rather than a
    // line in a document somebody may not read.
    assert.equal(plan.worldStateCovered, false);
  });

  it('refuses to roll a server package back onto a client one', () => {
    assert.throws(
      () =>
        planRollback({
          current: manifest('1.2.0', [['mods/a.jar', 'a2']], 'server'),
          target: manifest('1.1.0', [['mods/a.jar', 'a1']], 'client'),
        }),
      // The plan would otherwise remove every server file.
      (error: unknown) => error instanceof RollbackError && error.code === 'sides-differ',
    );
  });
});
