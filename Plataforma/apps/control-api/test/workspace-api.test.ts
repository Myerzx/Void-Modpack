import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { hashPassword } from '@voidfall/authentication';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type { FastifyInstance } from 'fastify';

import { buildControlApi } from '../src/app.js';
import { detectServerRuntimeAt } from '../src/server-runtime.js';
import type { WorkspaceScanner } from '../src/workspace-routes.js';

/**
 * The first slice of the panel integration track, end to end.
 *
 * What these tests hold to: the panel can reach the engine, and no route
 * anywhere gives a browser a host path. The second one matters more than it
 * looks — the path is typed once at registration and is the one piece of this
 * flow that could leak somewhere it does not belong.
 */

const resources: Array<{ app: FastifyInstance; database: Database }> = [];
const NOW = new Date('2026-08-07T12:00:00.000Z');
const directories: string[] = [];

afterEach(async () => {
  while (resources.length > 0) {
    const resource = resources.pop();
    if (resource !== undefined) {
      await resource.app.close();
      await resource.database.close();
    }
  }
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

/** Stands in for the real inventory engine, recording what root it was given. */
function scanner(options: { readonly fail?: boolean } = {}): WorkspaceScanner & {
  readonly seen: { roots: string[] };
} {
  const seen = { roots: [] as string[] };
  return {
    seen,
    async build(input: { readonly root: string }) {
      seen.roots.push(input.root);
      if (options.fail === true) throw new Error('root unreadable');
      return {
        inventorySha256: 'ab'.padEnd(64, '0'),
        totals: { files: 12, bytes: 4_096, mods: 3 },
        files: [
          { path: 'mods/alpha.jar', role: 'mod-archive', sizeBytes: 100 },
          { path: 'config/alpha.toml', role: 'configuration', sizeBytes: 20 },
        ],
        mods: [
          {
            modId: 'alpha',
            displayName: 'Alpha',
            version: '1.0.0',
            loader: 'forge',
            archivePath: 'mods/alpha.jar',
            editLevel: 'STRUCTURED',
            editLevelReason: 'a parseable file was found',
            configurationCandidates: [{ path: 'config/alpha.toml', rule: 'config-file-by-mod-id' }],
          },
        ],
        undeclaredArchives: [{ path: 'mods/library.jar', reason: 'no-declared-mod' }],
        exclusions: [{ path: 'world', reason: 'private-state' }],
      } as never;
    },
  };
}

async function fixture(
  options: { readonly role?: 'owner' | 'read-only'; readonly scanner?: WorkspaceScanner } = {},
) {
  const role = options.role ?? 'owner';
  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const password = 'workspace-api-test-password';
  await repositories.users.create({
    email: `${role}@voidfall.invalid`,
    displayName: `${role} fixture`,
    passwordHash: await hashPassword(password),
    roles: [role],
  });

  const app = await buildControlApi({
    database,
    cookieSecure: false,
    clock: () => NOW,
    ...(options.scanner === undefined ? {} : { workspaceScanner: options.scanner }),
    serverRuntimeDetector: detectServerRuntimeAt,
  });
  resources.push({ app, database });

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: `${role}@voidfall.invalid`, password },
  });
  assert.equal(login.statusCode, 200);
  const setCookie = login.headers['set-cookie'] as string;

  return {
    app,
    repositories,
    cookie: setCookie.split(';')[0] ?? '',
    csrfToken: login.json<{ csrfToken: string }>().csrfToken,
  };
}

async function workspaceRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'voidfall-ws-'));
  directories.push(directory);
  return directory;
}

describe('a session a reloaded page can actually use', () => {
  it('returns the csrf token, so a write after a refresh is possible', async () => {
    const { app, cookie, csrfToken } = await fixture();

    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    assert.equal(session.statusCode, 200);
    // It used to return only the user and the permissions. A page that
    // reloaded held a valid cookie and could not write, because the token
    // existed exactly once, in the login response.
    assert.equal(session.json<{ csrfToken: string }>().csrfToken, csrfToken);
  });
});

describe('a POST with nothing to say', () => {
  it('is accepted even when the client sets a JSON content type', async () => {
    const { app, cookie, csrfToken } = await fixture({ scanner: scanner() });
    const root = await workspaceRoot();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { slug: 'principal', displayName: 'Principal', rootPath: root, kind: 'server' },
    });

    // Found by running it over HTTP rather than in process: curl and every
    // ordinary client send `content-type: application/json` with an empty
    // body, and the default parser answered with a validation error whose
    // details were empty — correct, and impossible to act on.
    const scanned = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${registered.json<{ workspaceId: string }>().workspaceId}/scans`,
      headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
      payload: '',
    });
    assert.equal(scanned.statusCode, 201);
  });

  it('still refuses a route that needs a body', async () => {
    const { app, cookie, csrfToken } = await fixture({ scanner: scanner() });
    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
      payload: '',
    });
    assert.equal(refused.statusCode, 400);
  });
});

describe('registering a server instance', () => {
  it('can be done through the API instead of by hand in SQL', async () => {
    const { app, cookie, csrfToken } = await fixture();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: {
        slug: 'principal',
        displayName: 'Servidor principal',
        environment: 'local',
        minecraftVersion: '1.20.1',
        loader: 'forge',
        loaderVersion: '1.20.1-47.4.4',
        maxPlayers: 20,
      },
    });
    assert.equal(created.statusCode, 201);

    const listed = await app.inject({ method: 'GET', url: '/api/v1/servers', headers: { cookie } });
    assert.equal(listed.json<{ servers: unknown[] }>().servers.length, 1);
  });

  it('refuses without the csrf token', async () => {
    const { app, cookie } = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: {
        slug: 'principal',
        displayName: 'Servidor principal',
        environment: 'local',
        minecraftVersion: '1.20.1',
        loader: 'forge',
        loaderVersion: '1.20.1-47.4.4',
        maxPlayers: 20,
      },
    });
    assert.equal(created.statusCode, 403);
  });
});

describe('importing a workspace', () => {
  it('registers a root, scans it and reports the inventory', async () => {
    const engine = scanner();
    const { app, cookie, csrfToken } = await fixture({ scanner: engine });
    const root = await workspaceRoot();

    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { slug: 'principal', displayName: 'Principal', rootPath: root, kind: 'server' },
    });
    assert.equal(registered.statusCode, 201);
    const workspaceId = registered.json<{ workspaceId: string }>().workspaceId;

    const scanned = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/scans`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    assert.equal(scanned.statusCode, 201);
    // The engine was handed the registered root, not something a screen sent.
    assert.deepEqual(engine.seen.roots, [root]);

    const inventory = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/inventory`,
      headers: { cookie },
    });
    const body = inventory.json<{
      inventory: {
        totals: { files: number; mods: number; modArchives: number; undeclaredArchives: number };
        exclusionsByReason: [string, number][];
      };
    }>();
    assert.equal(body.inventory.totals.files, 12);
    assert.equal(body.inventory.totals.mods, 3);
    assert.equal(body.inventory.totals.modArchives, 1);
    // Excluded is recorded, not skipped — and it reaches the screen.
    assert.deepEqual(body.inventory.exclusionsByReason, [['private-state', 1]]);
  });

  it('never hands a host path to a browser', async () => {
    const engine = scanner();
    const { app, cookie, csrfToken } = await fixture({ scanner: engine });
    const root = await workspaceRoot();

    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { slug: 'principal', displayName: 'Principal', rootPath: root, kind: 'server' },
    });
    const listed = await app.inject({ method: 'GET', url: '/api/v1/workspaces', headers: { cookie } });

    // The path was typed once and stays on the host. A response that echoed it
    // would put it in every screenshot and every browser cache.
    assert.equal(registered.body.includes(root), false);
    assert.equal(listed.body.includes(root), false);
  });

  it('says a workspace was never scanned instead of pretending it is empty', async () => {
    const { app, cookie, csrfToken } = await fixture({ scanner: scanner() });
    const root = await workspaceRoot();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { slug: 'principal', displayName: 'Principal', rootPath: root, kind: 'server' },
    });
    const workspaceId = registered.json<{ workspaceId: string }>().workspaceId;

    const inventory = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/inventory`,
      headers: { cookie },
    });
    // Zero files and "nobody looked" have to read differently, or a screen
    // shows an empty server with confidence.
    assert.equal(inventory.json<{ dataQuality: string }>().dataQuality, 'never-scanned');
    assert.equal(inventory.json<{ inventory: unknown }>().inventory, null);
  });

  it('reports the mods and the archives that declared nothing', async () => {
    const { app, cookie, csrfToken } = await fixture({ scanner: scanner() });
    const root = await workspaceRoot();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { slug: 'principal', displayName: 'Principal', rootPath: root, kind: 'server' },
    });
    const workspaceId = registered.json<{ workspaceId: string }>().workspaceId;
    await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/scans`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    const mods = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/mods`,
      headers: { cookie },
    });
    const body = mods.json<{
      mods: { modId: string; editLevel: string; configurationCount: number }[];
      undeclared: { path: string }[];
    }>();
    assert.equal(body.mods[0]?.modId, 'alpha');
    assert.equal(body.mods[0]?.editLevel, 'STRUCTURED');
    assert.equal(body.mods[0]?.configurationCount, 1);
    // A jar declaring nothing is a fact about the folder, not an omission.
    assert.deepEqual(body.undeclared, [{ path: 'mods/library.jar', reason: 'no-declared-mod' }]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/mods/alpha`,
      headers: { cookie },
    });
    // The rule travels with the path: these are conventions, not declarations.
    assert.deepEqual(
      detail.json<{ mod: { configurationCandidates: { rule: string }[] } }>().mod
        .configurationCandidates[0]?.rule,
      'config-file-by-mod-id',
    );
  });

  it('reports a root that became unreadable without echoing it', async () => {
    const { app, cookie, csrfToken } = await fixture({ scanner: scanner({ fail: true }) });
    const root = await workspaceRoot();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { slug: 'principal', displayName: 'Principal', rootPath: root, kind: 'server' },
    });

    const scanned = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${registered.json<{ workspaceId: string }>().workspaceId}/scans`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    // A directory that moved is an operator's problem, and the message says
    // which without repeating the path back into a browser.
    assert.equal(scanned.statusCode, 422);
    assert.equal(scanned.body.includes(root), false);
  });

  it('refuses registration when no scanner is configured', async () => {
    const { app, cookie, csrfToken } = await fixture();
    const root = await workspaceRoot();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { slug: 'principal', displayName: 'Principal', rootPath: root, kind: 'server' },
    });
    // Deny-by-default: better to say the capability is missing than to accept a
    // workspace nothing can ever read.
    assert.equal(registered.statusCode, 503);

    const listed = await app.inject({ method: 'GET', url: '/api/v1/workspaces', headers: { cookie } });
    assert.equal(
      listed.json<{ capabilities: { canScan: boolean } }>().capabilities.canScan,
      false,
    );
  });

  it('lets a read-only user look and not touch', async () => {
    const { app, cookie, csrfToken } = await fixture({ role: 'read-only', scanner: scanner() });
    const root = await workspaceRoot();

    assert.equal(
      (
        await app.inject({ method: 'GET', url: '/api/v1/workspaces', headers: { cookie } })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/workspaces',
          headers: { cookie, 'x-csrf-token': csrfToken },
          payload: { slug: 'principal', displayName: 'Principal', rootPath: root, kind: 'server' },
        })
      ).statusCode,
      403,
    );
  });
});

describe('pointing an instance at a directory', () => {
  it('reads how the server starts, and never echoes the directory', async () => {
    const { app, cookie, csrfToken } = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: {
        slug: 'principal',
        displayName: 'Principal',
        environment: 'local',
        minecraftVersion: '1.20.1',
        loader: 'forge',
        loaderVersion: '1.20.1-47.4.4',
        maxPlayers: 20,
      },
    });
    const serverId = created.json<{ id: string }>().id;

    const root = await workspaceRoot();
    await mkdir(join(root, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.4.4'), {
      recursive: true,
    });
    for (const name of ['win_args.txt', 'unix_args.txt']) {
      await writeFile(
        join(root, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.4.4', name),
        'x',
        'utf8',
      );
    }

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/runtime`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { rootPath: root },
    });
    assert.equal(response.statusCode, 200);
    const runtime = response.json<{ runtime: { family: string; shape: string; entry: string } }>()
      .runtime;
    assert.equal(runtime.family, 'forge');
    assert.equal(runtime.shape, 'args-file');
    // The descriptor only. The directory was sent once and stays on the host.
    assert.equal(response.body.includes(root), false);

    const listed = await app.inject({ method: 'GET', url: '/api/v1/servers', headers: { cookie } });
    const server = listed.json<{
      servers: { runtime: { family: string }; hasRunDirectory: boolean }[];
    }>().servers[0];
    assert.equal(server?.runtime.family, 'forge');
    // Whether it has been pointed at one, never at which one. Adding the
    // column put the host path straight into this listing on the first run.
    assert.equal(server?.hasRunDirectory, true);
    assert.equal(listed.body.includes(root), false);
  });

  it('refuses a layout it does not recognise, in words an operator can act on', async () => {
    const { app, cookie, csrfToken } = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: {
        slug: 'vazio',
        displayName: 'Vazio',
        environment: 'local',
        minecraftVersion: '1.20.1',
        loader: 'forge',
        loaderVersion: '1.20.1-47.4.4',
        maxPlayers: 20,
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${created.json<{ id: string }>().id}/runtime`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { rootPath: await workspaceRoot() },
    });
    // Guessing `-jar` here would run a JVM in the directory that holds a world.
    assert.equal(response.statusCode, 422);
    assert.match(response.json<{ error: { message: string } }>().error.message, /Nenhum runtime/u);
  });
});
