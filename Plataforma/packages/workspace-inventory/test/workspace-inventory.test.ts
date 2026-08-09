import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  WorkspaceInventoryError,
  WorkspaceInventoryService,
  classifyEditLevel,
  configurationAliasesFor,
  configurationCandidatesFor,
  roleForPath,
  scanWorkspace,
} from '../src/index.js';

/**
 * The importer, against a real temporary directory.
 *
 * Nothing here points at a real installation, and nothing writes to the tree it
 * scans. The JARs are built in the test so the inventory can be checked against
 * a known declaration rather than against whatever happens to be on the runner.
 */

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'voidfall-workspace-'));
  roots.push(root);
  return root;
}

/** Minimal stored-and-deflated ZIP, enough for the inspector's central directory. */
function zip(entries: ReadonlyMap<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.from(text, 'utf8');
    const deflated = deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, deflated);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x0201_4b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    // Offset 8 is the flags field; the compression method lives at 10. Writing
    // it at 8 leaves the directory claiming "stored" over deflated bytes, and
    // the inspector rejects the size mismatch — correctly.
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(deflated.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);

    offset += local.length + nameBytes.length + deflated.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
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

function forgeJar(modId: string, version: string, displayName = modId): Buffer {
  return zip(
    new Map([
      [
        'META-INF/mods.toml',
        `modLoader="javafml"\nloaderVersion="[47,)"\nlicense="ARR"\n[[mods]]\nmodId="${modId}"\nversion="${version}"\ndisplayName="${displayName}"\n`,
      ],
    ]),
  );
}

async function write(root: string, relativePath: string, content: string | Buffer): Promise<void> {
  const absolute = join(root, ...relativePath.split('/'));
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, content);
}

describe('workspace scanning', () => {
  it('records private state as excluded instead of quietly skipping it', async () => {
    const root = await workspace();
    await write(root, 'mods/example.jar', forgeJar('example', '1.0.0'));
    await write(root, 'server.properties', 'motd=VoidFall\n');
    await write(root, 'ops.json', '[]');
    await write(root, 'whitelist.json', '[]');
    await write(root, 'logs/latest.log', 'a log line');
    await write(root, 'world/level.dat', 'not really nbt');

    const scan = await scanWorkspace({ root });

    // None of it was hashed, and all of it is named. An inventory that omitted
    // them silently would be indistinguishable from one that failed to look.
    const excluded = scan.exclusions.map((entry) => entry.path).sort();
    // Directories are refused at the directory, so the walk never descends into
    // a world or a log folder to reject each file one at a time.
    assert.deepEqual(excluded, [
      'logs',
      'ops.json',
      'server.properties',
      'whitelist.json',
      'world',
    ]);
    assert.ok(scan.exclusions.every((entry) => entry.reason === 'private-state'));
    assert.deepEqual(
      scan.files.map((file) => file.path),
      ['mods/example.jar'],
    );
  });

  it('refuses to follow a symlink out of the workspace', async () => {
    const root = await workspace();
    const outside = await workspace();
    await write(outside, 'secret.txt', 'not yours');
    await mkdir(join(root, 'config'), { recursive: true });
    try {
      await symlink(join(outside, 'secret.txt'), join(root, 'config', 'linked.toml'));
    } catch {
      // Unprivileged Windows cannot create symlinks; the rule is still tested
      // by the exclusion path above and by the scanner's own branch.
      return;
    }

    const scan = await scanWorkspace({ root });
    // A link inside an imported pack can point anywhere on the host, and a
    // scanner that followed one could be made to hash files outside the tree.
    assert.deepEqual(
      scan.exclusions.map((entry) => [entry.path, entry.reason]),
      [['config/linked.toml', 'symlink']],
    );
    assert.deepEqual(scan.files, []);
  });

  it('produces the same inventory twice, in the same order', async () => {
    const root = await workspace();
    await write(root, 'mods/zeta.jar', forgeJar('zeta', '2.0.0'));
    await write(root, 'mods/alpha.jar', forgeJar('alpha', '1.0.0'));
    await write(root, 'config/alpha.toml', 'enabled = true\n');

    const service = new WorkspaceInventoryService();
    const first = await service.build({ root });
    const second = await service.build({ root });

    // Nothing derived from the filesystem's timestamps enters the digest, so
    // two scans of one tree compare equal — which is what makes a diff between
    // two versions mean anything at all.
    assert.equal(first.inventorySha256, second.inventorySha256);
    assert.deepEqual(
      first.mods.map((mod) => mod.modId),
      ['alpha', 'zeta'],
    );
  });

  it('records an archive that declares nothing rather than dropping it', async () => {
    const root = await workspace();
    await write(root, 'mods/empty.jar', zip(new Map([['README.txt', 'nothing here']])));

    const inventory = await new WorkspaceInventoryService().build({ root });
    assert.deepEqual(inventory.mods, []);
    // The folder has a JAR in it. An inventory that said otherwise would
    // disagree with the folder.
    assert.deepEqual(
      inventory.undeclaredArchives.map((archive) => archive.reason),
      ['no-declared-mod'],
    );
  });

  it('refuses a root that is not an absolute directory', async () => {
    await assert.rejects(
      scanWorkspace({ root: 'relative/path' }),
      (error: unknown) =>
        error instanceof WorkspaceInventoryError && error.code === 'root-not-absolute',
    );
    await assert.rejects(
      scanWorkspace({ root: join(tmpdir(), 'voidfall-does-not-exist-9e1f') }),
      (error: unknown) =>
        error instanceof WorkspaceInventoryError && error.code === 'root-not-a-directory',
    );
  });
});

describe('file roles', () => {
  it('assigns a role from the path alone', async () => {
    assert.equal(roleForPath('mods/jei.jar'), 'mod-archive');
    assert.equal(roleForPath('config/jei.toml'), 'configuration');
    assert.equal(roleForPath('kubejs/server_scripts/recipes.js'), 'script');
    assert.equal(roleForPath('datapacks/pack/data/x.json'), 'datapack');
    assert.equal(roleForPath('config/openloader/data/pack/data/x/recipes/a.json'), 'datapack');
    assert.equal(roleForPath('config/openloader/resources/pack/assets/x/model.json'), 'resource');
    assert.equal(roleForPath('config/openloader/advanced_options.json'), 'configuration');
    assert.equal(roleForPath('resourcepacks/pack.zip'), 'resource');
    // A .js outside a script root is not a script; guessing from extension
    // alone would classify a mod's bundled asset as something to interpret.
    assert.equal(roleForPath('assets/example/vendor.js'), 'other');
  });
});

describe('edit-level classification', () => {
  const files = [
    { path: 'config/alpha.toml', role: 'configuration' as const, sizeBytes: 1, sha256: 'a' },
    { path: 'config/alpha-common.toml', role: 'configuration' as const, sizeBytes: 1, sha256: 'b' },
    { path: 'config/alphatweaks.toml', role: 'configuration' as const, sizeBytes: 1, sha256: 'c' },
    { path: 'config/beta/rules.cfg', role: 'configuration' as const, sizeBytes: 1, sha256: 'd' },
    { path: 'config/gamma/data.snbt', role: 'configuration' as const, sizeBytes: 1, sha256: 'e' },
  ];

  it('matches a mod id exactly, never by prefix', () => {
    const candidates = configurationCandidatesFor({ modId: 'alpha', files });
    // `alphatweaks` is a different mod by different people. Prefix matching
    // would let one claim the other's configuration.
    assert.deepEqual(
      candidates.map((candidate) => candidate.path),
      ['config/alpha-common.toml', 'config/alpha.toml'],
    );
    assert.ok(candidates.every((candidate) => candidate.rule === 'config-file-by-mod-id'));
  });

  it('associates per-world server config through an exact metadata alias', () => {
    const serverFiles = [
      ...files,
      {
        path: 'world/serverconfig/mine_and_slash-server.toml',
        role: 'configuration' as const,
        sizeBytes: 1,
        sha256: 'f',
      },
      {
        path: 'world/serverconfig/mine_and_slash_extra-server.toml',
        role: 'configuration' as const,
        sizeBytes: 1,
        sha256: 'g',
      },
    ];
    const aliases = configurationAliasesFor({ modId: 'mmorpg', displayName: 'Mine and Slash' });
    const candidates = configurationCandidatesFor({ modId: 'mmorpg', aliases, files: serverFiles });
    assert.deepEqual(candidates, [
      {
        path: 'world/serverconfig/mine_and_slash-server.toml',
        rule: 'serverconfig-file-by-mod-alias',
      },
    ]);
  });

  it('reports nothing found as runtime-only, not as unsupported', () => {
    const decision = classifyEditLevel(configurationCandidatesFor({ modId: 'delta', files }));
    // Most Forge mods write their configuration on first boot. Declaring the
    // mod unsupported would be a conclusion; naming what would resolve it is a
    // fact, and it is what the sandbox exists to do.
    assert.equal(decision.level, 'RUNTIME_ONLY');
    assert.match(decision.reason, /after the mod has run/u);
  });

  it('earns FULLY_MANAGED only from a reviewed schema', () => {
    const structured = classifyEditLevel(configurationCandidatesFor({ modId: 'alpha', files }));
    // Parseable is not understood. A TOML file is structure; nothing here says
    // what its fields mean or which values are safe.
    assert.equal(structured.level, 'STRUCTURED');

    const reviewed = classifyEditLevel(
      configurationCandidatesFor({
        modId: 'alpha',
        files,
        reviewedResourcePaths: ['config/alpha.toml'],
      }),
    );
    assert.equal(reviewed.level, 'FULLY_MANAGED');
  });

  it('drops to raw editing for formats with no safe round-trip', () => {
    assert.equal(
      classifyEditLevel(configurationCandidatesFor({ modId: 'beta', files })).level,
      'RAW_EDITABLE',
    );
    // .snbt is a serialisation nobody should round-trip without a reviewed
    // codec, so it is text with a warning rather than a form.
    assert.equal(
      classifyEditLevel(configurationCandidatesFor({ modId: 'gamma', files })).level,
      'RAW_EDITABLE',
    );
  });

  it('classifies a real workspace end to end', async () => {
    const root = await workspace();
    await write(root, 'mods/alpha.jar', forgeJar('alpha', '1.0.0'));
    await write(root, 'mods/delta.jar', forgeJar('delta', '3.0.0'));
    await write(root, 'config/alpha.toml', 'enabled = true\n');

    const inventory = await new WorkspaceInventoryService({
      reviewedResourcePaths: ['config/alpha.toml'],
    }).build({ root });

    const byId = new Map(inventory.mods.map((mod) => [mod.modId, mod]));
    assert.equal(byId.get('alpha')?.editLevel, 'FULLY_MANAGED');
    assert.equal(byId.get('alpha')?.version, '1.0.0');
    // Every unavailable level carries its cause, the same way readiness does.
    assert.equal(byId.get('delta')?.editLevel, 'RUNTIME_ONLY');
    assert.ok((byId.get('delta')?.editLevelReason.length ?? 0) > 0);
    assert.equal(inventory.totals.mods, 2);
  });

  it('links a generated server config when the mod id differs from its display name', async () => {
    const root = await workspace();
    await write(root, 'mods/mmorpg.jar', forgeJar('mmorpg', '6.3.14', 'Mine and Slash'));
    await write(root, 'world/serverconfig/mine_and_slash-server.toml', 'enabled = true\n');

    const inventory = await new WorkspaceInventoryService().build({ root });
    assert.deepEqual(inventory.mods[0]?.configurationCandidates, [
      {
        path: 'world/serverconfig/mine_and_slash-server.toml',
        rule: 'serverconfig-file-by-mod-alias',
      },
    ]);
    assert.equal(inventory.mods[0]?.editLevel, 'STRUCTURED');
  });
});

describe('reviewed resources belong to their own mod', () => {
  it('does not let one mod inherit another mod reviewed schema', () => {
    const files = [
      { path: 'config/alpha.toml', role: 'configuration' as const, sizeBytes: 1, sha256: 'a' },
    ];
    // `beta` owns nothing here. If reviewed-ness alone were a match, beta would
    // come back FULLY_MANAGED on alpha's file — a claim that somebody
    // understood fields they had never seen.
    const candidates = configurationCandidatesFor({
      modId: 'beta',
      files,
      reviewedResourcePaths: ['config/alpha.toml'],
    });
    assert.deepEqual(candidates, []);
    assert.equal(classifyEditLevel(candidates).level, 'RUNTIME_ONLY');
  });
});

describe('the server runtime is infrastructure, not private state', () => {
  it('leaves libraries out by default, and says which kind of exclusion it is', async () => {
    const root = await workspace();
    await write(root, 'mods/alpha.jar', forgeJar('alpha', '1.0.0'));
    await write(root, 'libraries/net/minecraftforge/forge/1.20.1-47.4.4/unix_args.txt', '-cp x');
    await write(root, 'server.properties', 'motd=VoidFall\n');

    const scan = await scanWorkspace({ root });
    const reasons = new Map(scan.exclusions.map((entry) => [entry.path, entry.reason]));
    // Excluded at the directory, so the walk never descends into 159 MB of
    // jars to record each one. Not private either — nobody manages a Forge
    // library through a configuration panel.
    assert.equal(reasons.get('libraries'), 'runtime-infrastructure');
    assert.ok(![...reasons.keys()].some((path) => path.startsWith('libraries/')));
    // Still private, and for a different reason.
    assert.equal(reasons.get('server.properties'), 'private-state');
  });

  it('includes the runtime when a sandbox asks for it', async () => {
    const root = await workspace();
    await write(root, 'mods/alpha.jar', forgeJar('alpha', '1.0.0'));
    await write(root, 'libraries/net/minecraftforge/forge/1.20.1-47.4.4/unix_args.txt', '-cp x');
    await write(root, 'server.properties', 'motd=VoidFall\n');

    const scan = await scanWorkspace({ root, includeRuntime: true });
    const runtime = scan.files.filter((file) => file.role === 'runtime');
    // Without it there is nothing to boot.
    assert.deepEqual(
      runtime.map((file) => file.path),
      ['libraries/net/minecraftforge/forge/1.20.1-47.4.4/unix_args.txt'],
    );
    // Asking for the runtime does not also hand over private state.
    assert.ok(scan.exclusions.some((entry) => entry.reason === 'private-state'));
  });
});

describe('tooling directories are not server content', () => {
  it('refuses a dot-directory whatever it happens to be called', async () => {
    const root = await workspace();
    await write(root, 'mods/alpha.jar', forgeJar('alpha', '1.0.0'));
    await write(root, 'config/alpha.toml', 'enabled = true\n');
    await write(root, '.vscode/settings.json', '{"editor.tabSize":2}');
    await write(root, '.codex/notes.json', '{}');

    const scan = await scanWorkspace({ root });
    // No allowlist of mod directories could have predicted these names, and a
    // .json inside one still looks exactly like configuration — which is how a
    // first attempt at a real server carried 20 800 files into a sandbox.
    assert.deepEqual(
      scan.files.map((file) => file.path),
      ['config/alpha.toml', 'mods/alpha.jar'],
    );
    assert.ok(
      ['.codex', '.vscode'].every((name) =>
        scan.exclusions.some((entry) => entry.path === name && entry.reason === 'private-state'),
      ),
    );
  });
});

describe('per-world server configuration is configuration, not world', () => {
  it('sees it without letting the rest of the world through', async () => {
    const root = await workspace();
    await write(root, 'mods/alpha.jar', forgeJar('alpha', '1.0.0'));
    await write(root, 'world/level.dat', 'precious');
    await write(root, 'world/region/r.0.0.mca', 'chunks');
    await write(root, 'world/serverconfig/mine_and_slash-server.toml', 'GET_STARTER_ITEMS = true\n');
    await write(root, 'world/serverconfig/curios-server.toml', 'enabled = true\n');

    const scan = await scanWorkspace({ root });
    // Forge keeps per-world server settings inside the level directory. Losing
    // them with the world means a sandbox boots on defaults instead of on what
    // the operator actually runs.
    assert.deepEqual(
      scan.files.filter((file) => file.role === 'configuration').map((file) => file.path),
      ['world/serverconfig/curios-server.toml', 'world/serverconfig/mine_and_slash-server.toml'],
    );
    // And nothing else from the world came with it.
    assert.ok(!scan.files.some((file) => file.path.startsWith('world/region')));
    assert.ok(!scan.files.some((file) => file.path === 'world/level.dat'));
  });

  it('still refuses a world that has no server config in it', async () => {
    const root = await workspace();
    await write(root, 'mods/alpha.jar', forgeJar('alpha', '1.0.0'));
    await write(root, 'world/level.dat', 'precious');

    const scan = await scanWorkspace({ root });
    assert.ok(
      scan.exclusions.some((entry) => entry.path === 'world' && entry.reason === 'private-state'),
    );
  });
});
