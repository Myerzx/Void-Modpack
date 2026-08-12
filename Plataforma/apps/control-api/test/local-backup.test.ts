import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { ServerInstance } from '@voidfall/database';

import { provisionLocalBackup, resolveLocalWorldDirectory } from '../src/local-backup.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; server: string; state: string }> {
  const root = await mkdtemp(join(tmpdir(), 'voidfall-local-backup-'));
  roots.push(root);
  const server = join(root, 'server');
  const state = join(root, 'state');
  await mkdir(join(server, 'world'), { recursive: true });
  await writeFile(join(server, 'server.properties'), '# fixture\nlevel-name=world\n', 'utf8');
  return { root, server, state };
}

function instance(runDirectory: string | null): ServerInstance {
  return {
    id: '018f6b8c-76a3-7d10-9f2e-1d9e52a63701',
    slug: 'local',
    displayName: 'Local',
    environment: 'local',
    desiredState: 'stopped',
    observedState: 'offline',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '47.4.4',
    maxPlayers: 20,
    version: 1,
    runDirectory,
    runtime: null,
    runtimeDetectedAt: null,
  };
}

describe('local backup provisioning', () => {
  it('binds an encrypted repository to the contained active world and reuses its keys', async () => {
    const context = await fixture();
    const first = await provisionLocalBackup({
      instance: instance(context.server),
      stateDirectory: context.state,
    });
    assert.notEqual(first, null);
    assert.equal(first?.worldSourcePath, join(context.server, 'world'));
    assert.equal(first?.restoreEnabled, false);
    assert.equal(first?.sealKey.secret.byteLength, 32);
    assert.equal(first?.encryptionKey?.secret.byteLength, 32);

    const second = await provisionLocalBackup({
      instance: instance(context.server),
      stateDirectory: context.state,
    });
    assert.deepEqual(second?.sealKey.secret, first?.sealKey.secret);
    assert.deepEqual(second?.encryptionKey?.secret, first?.encryptionKey?.secret);

    const keyDocument = JSON.parse(
      await readFile(join(context.state, 'backups', instance(null).id, 'keys.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(keyDocument['schemaVersion'], 1);
  });

  it('supports a contained custom level name', async () => {
    const context = await fixture();
    await mkdir(join(context.server, 'saves', 'voidfall'), { recursive: true });
    await writeFile(
      join(context.server, 'server.properties'),
      'level-name=saves/voidfall\n',
      'utf8',
    );
    assert.equal(
      await resolveLocalWorldDirectory(context.server),
      join(context.server, 'saves', 'voidfall'),
    );
  });

  it('refuses a level name that escapes the linked server', async () => {
    const context = await fixture();
    await writeFile(join(context.server, 'server.properties'), 'level-name=../private\n', 'utf8');
    await assert.rejects(resolveLocalWorldDirectory(context.server), /local-backup-world-unsafe/u);
  });

  it('does not announce backup without a linked world', async () => {
    const context = await fixture();
    assert.equal(
      await provisionLocalBackup({ instance: instance(null), stateDirectory: context.state }),
      null,
    );
    await rm(join(context.server, 'world'), { recursive: true, force: true });
    assert.equal(
      await provisionLocalBackup({
        instance: instance(context.server),
        stateDirectory: context.state,
      }),
      null,
    );
  });
});
