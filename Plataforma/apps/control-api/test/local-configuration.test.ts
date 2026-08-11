import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { hashPassword } from '@voidfall/authentication';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type { MinecraftProcessAdapter } from '@voidfall/minecraft-process';
import { createOfflineExclusiveConfigurationGuard } from '@voidfall/server-agent';

import {
  LocalConfigurationReaders,
  provisionLocalConfiguration,
} from '../src/local-configuration.js';

const databases: Database[] = [];
const directories: string[] = [];

afterEach(async () => {
  while (databases.length > 0) await databases.pop()!.close();
  while (directories.length > 0) {
    await rm(directories.pop()!, { recursive: true, force: true });
  }
});

function document(dataPacks = true, resourcePacks = true): string {
  return `${JSON.stringify(
    {
      resourcePacks: { enabled: resourcePacks, additionalFolders: [] },
      dataPacks: { enabled: dataPacks, additionalFolders: [] },
    },
    null,
    2,
  )}\n`;
}

function serverProperties(): string {
  return [
    '# Sanitized server properties',
    'online-mode=false',
    'white-list=false',
    'enforce-whitelist=false',
    'enforce-secure-profile=true',
    'enable-rcon=true',
    'broadcast-rcon-to-ops=true',
    'rcon.password=fixture-redacted',
    '',
  ].join('\n');
}

function guardFor(context: Awaited<ReturnType<typeof fixture>>) {
  const adapter = {
    inspect: async () => ({
      state: 'offline',
      observedAt: new Date().toISOString(),
      source: 'process-adapter',
    }),
  } as unknown as MinecraftProcessAdapter;
  return createOfflineExclusiveConfigurationGuard({
    repositories: context.repositories,
    adapter,
    serverInstanceId: context.instance.id,
    ownsLock: (lease) => lease.operation.startsWith('configuration.'),
  });
}

async function fixture(withConfiguration: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'voidfall-local-configuration-'));
  directories.push(root);
  const serverRoot = join(root, 'server');
  await mkdir(join(serverRoot, 'config', 'openloader'), { recursive: true });
  if (withConfiguration) {
    await writeFile(join(serverRoot, 'server.properties'), serverProperties(), 'utf8');
    await writeFile(
      join(serverRoot, 'config', 'openloader', 'advanced_options.json'),
      document(),
      'utf8',
    );
  }

  const database = await createPGliteTestDatabase();
  databases.push(database);
  await runMigrations(database);
  const repositories = createRepositories(database);
  const actor = await repositories.users.create({
    email: 'owner@voidfall.invalid',
    displayName: 'Local owner',
    passwordHash: await hashPassword('local-configuration-test-password'),
    roles: ['owner'],
  });
  const created = await repositories.servers.create({
    id: randomUUID(),
    slug: 'local-configuration',
    displayName: 'Local configuration',
    environment: 'local',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '47.4.4',
    maxPlayers: 20,
  });
  await repositories.servers.setRuntime({
    id: created.id,
    runDirectory: serverRoot,
    runtime: {
      family: 'forge',
      shape: 'args-file',
      entry: 'win_args.txt',
      evidence: 'win_args.txt',
    },
    detectedAt: new Date(),
  });
  const instance = await repositories.servers.findById(created.id);
  assert.ok(instance !== undefined);
  return { root, repositories, actor, instance };
}

describe('local reviewed configuration bootstrap', () => {
  it('registers a strict resource once and exposes it through the instance reader', async () => {
    const context = await fixture(true);
    const runtime = await provisionLocalConfiguration({
      instance: context.instance,
      repositories: context.repositories,
      stateDirectory: join(context.root, 'state'),
      actorId: context.actor.id,
      guard: guardFor(context),
    });
    assert.ok(runtime !== null);
    assert.deepEqual(runtime.resourceIds, [
      'minecraft-server-properties',
      'openloader-advanced-options',
    ]);
    assert.equal(runtime.authorizedFiles.rootPath, context.instance.runDirectory);
    assert.ok(!runtime.authorizedFiles.revisionRoot.startsWith(context.instance.runDirectory!));

    const readers = new LocalConfigurationReaders();
    readers.register(context.instance.id, runtime.reader);
    const observed = await readers.readConfiguration(
      context.instance.id,
      'openloader-advanced-options',
    );
    assert.deepEqual(observed.values, {
      'dataPacks.enabled': true,
      'resourcePacks.enabled': true,
    });
    assert.match(observed.currentSha256, /^[a-f0-9]{64}$/u);

    const security = await readers.readConfiguration(
      context.instance.id,
      'minecraft-server-properties',
    );
    assert.deepEqual(security.values, {
      'broadcast-rcon-to-ops': true,
      'enable-rcon': true,
      'enforce-secure-profile': true,
      'enforce-whitelist': false,
      'online-mode': false,
      'white-list': false,
    });
    assert.equal(JSON.stringify(security).includes('fixture-redacted'), false);

    const replay = await provisionLocalConfiguration({
      instance: context.instance,
      repositories: context.repositories,
      stateDirectory: join(context.root, 'state'),
      actorId: context.actor.id,
      guard: guardFor(context),
    });
    assert.deepEqual(replay?.resourceIds, [
      'minecraft-server-properties',
      'openloader-advanced-options',
    ]);
  });

  it('keeps a missing reviewed file unregistered', async () => {
    const context = await fixture(false);
    const runtime = await provisionLocalConfiguration({
      instance: context.instance,
      repositories: context.repositories,
      stateDirectory: join(context.root, 'state'),
      actorId: context.actor.id,
      guard: guardFor(context),
    });
    assert.equal(runtime, null);
    assert.equal(
      await context.repositories.configuration.resource(
        context.instance.id,
        'openloader-advanced-options',
      ),
      undefined,
    );
  });
});
