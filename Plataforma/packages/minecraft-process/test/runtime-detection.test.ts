import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { detectServerRuntime, RuntimeDetectionError } from '../src/index.js';

/**
 * Working out how a server has to be started, by looking at it.
 *
 * The property that matters: an unrecognised layout is refused by name. The
 * agent assembled `java -jar` for every installation, and Forge 1.20.1 has no
 * fat jar — so the one server it could not start was the operator's own, and
 * it failed in a way that reads like a broken mod rather than like a wrong
 * launch plan.
 */

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

async function serverDirectory(
  files: readonly string[],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'voidfall-runtime-'));
  directories.push(root);
  for (const file of files) {
    const segments = file.split('/');
    const name = segments.pop() as string;
    if (segments.length > 0) await mkdir(join(root, ...segments), { recursive: true });
    await writeFile(join(root, ...segments, name), 'x', 'utf8');
  }
  return root;
}

describe('detecting how a server starts', () => {
  it('recognises Forge by its argument file', async () => {
    const root = await serverDirectory([
      'libraries/net/minecraftforge/forge/1.20.1-47.4.4/win_args.txt',
      'libraries/net/minecraftforge/forge/1.20.1-47.4.4/unix_args.txt',
      'user_jvm_args.txt',
      // A Forge install carries jars in `libraries`; matching one of those
      // would start something that is not the server.
      'libraries/net/minecraftforge/forge/1.20.1-47.4.4/forge-1.20.1-47.4.4-universal.jar',
    ]);

    const detected = await detectServerRuntime({ serverDirectory: root, platform: 'win32' });
    assert.equal(detected.family, 'forge');
    assert.equal(detected.shape, 'args-file');
    assert.equal(
      detected.entry,
      'libraries/net/minecraftforge/forge/1.20.1-47.4.4/win_args.txt',
    );
  });

  it('picks the argument file for the host it will run on', async () => {
    const root = await serverDirectory([
      'libraries/net/minecraftforge/forge/1.20.1-47.4.4/win_args.txt',
      'libraries/net/minecraftforge/forge/1.20.1-47.4.4/unix_args.txt',
    ]);
    assert.match(
      (await detectServerRuntime({ serverDirectory: root, platform: 'linux' })).entry,
      /unix_args\.txt$/u,
    );
  });

  it('recognises NeoForge separately from Forge', async () => {
    const root = await serverDirectory([
      'libraries/net/neoforged/neoforge/21.1.65/unix_args.txt',
    ]);
    const detected = await detectServerRuntime({ serverDirectory: root, platform: 'linux' });
    assert.equal(detected.family, 'neoforge');
    assert.equal(detected.shape, 'args-file');
  });

  it('recognises Fabric, Paper and Spigot by their jars', async () => {
    for (const [file, family] of [
      ['fabric-server-launch.jar', 'fabric'],
      ['paper-1.20.1-196.jar', 'paper'],
      ['spigot-1.20.1.jar', 'spigot'],
      ['minecraft_server.1.20.1.jar', 'vanilla'],
    ] as const) {
      const root = await serverDirectory([file]);
      const detected = await detectServerRuntime({ serverDirectory: root, platform: 'linux' });
      assert.equal(detected.family, family, `${file} should be ${family}`);
      assert.equal(detected.shape, 'jar');
      assert.equal(detected.entry, file);
    }
  });

  it('ignores an installer sitting beside the server', async () => {
    const root = await serverDirectory([
      'paper-1.20.1-196.jar',
      'forge-1.20.1-47.4.4-installer.jar',
    ]);
    // An installer is a jar and is never the server. Starting one would run a
    // wizard where a server was expected.
    assert.equal(
      (await detectServerRuntime({ serverDirectory: root, platform: 'linux' })).entry,
      'paper-1.20.1-196.jar',
    );
  });

  it('refuses when two servers share a directory', async () => {
    const root = await serverDirectory(['paper-1.20.1-196.jar', 'spigot-1.20.1.jar']);
    // Picking one would be right half the time and silent the other half.
    await assert.rejects(
      detectServerRuntime({ serverDirectory: root, platform: 'linux' }),
      (error: unknown) =>
        error instanceof RuntimeDetectionError && error.code === 'multiple-candidate-jars',
    );
  });

  it('refuses a layout it does not recognise', async () => {
    const root = await serverDirectory(['leiame.txt', 'config/alpha.toml']);
    // Guessing `-jar` here produces a process that exits in a way that reads
    // like a broken mod. Saying "I do not know this layout" is worth more.
    await assert.rejects(
      detectServerRuntime({ serverDirectory: root, platform: 'linux' }),
      (error: unknown) =>
        error instanceof RuntimeDetectionError && error.code === 'no-recognised-runtime',
    );
  });

  it('refuses a directory it cannot read', async () => {
    await assert.rejects(
      detectServerRuntime({ serverDirectory: join(tmpdir(), 'voidfall-nao-existe'), platform: 'linux' }),
      (error: unknown) =>
        error instanceof RuntimeDetectionError && error.code === 'directory-unreadable',
    );
  });

  it('never returns a host path in the descriptor', async () => {
    const root = await serverDirectory([
      'libraries/net/minecraftforge/forge/1.20.1-47.4.4/unix_args.txt',
    ]);
    const detected = await detectServerRuntime({ serverDirectory: root, platform: 'linux' });
    // The descriptor ends up in a database and eventually on a screen, so the
    // entry is relative to the server directory and nothing else.
    assert.equal(detected.entry.includes(root), false);
    assert.equal(detected.evidence.includes(root), false);
  });
});
