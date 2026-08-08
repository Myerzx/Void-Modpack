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

/**
 * The panel served from the API's own origin.
 *
 * Two properties. The panel must never shadow the API — a page called
 * `api.html` cannot answer for `/api/v1/...`. And no request may read a file
 * outside the export, whichever spelling of `..` it arrives in, because the
 * export root sits inside a repository full of things nobody published.
 */

const resources: Array<{ app: FastifyInstance; database: Database }> = [];
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

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'voidfall-panel-'));
  directories.push(parent);
  const root = join(parent, 'out');
  await mkdir(join(root, 'entrar'), { recursive: true });
  // Next writes a route as a sibling .html *and* a directory holding the RSC
  // payload, with no index.html in it. The fixture mirrors that exactly,
  // because assuming index.html is what broke every nested page.
  await mkdir(join(root, 'workspaces', 'detalhe'), { recursive: true });
  await mkdir(join(root, '_next', 'static'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html><title>painel</title>', 'utf8');
  await writeFile(join(root, 'entrar', 'index.html'), '<!doctype html><title>entrar</title>', 'utf8');
  await writeFile(join(root, '404.html'), '<!doctype html><title>404</title>', 'utf8');
  await writeFile(join(root, '_next', 'static', 'app.js'), 'console.log(1);', 'utf8');
  await writeFile(join(root, 'workspaces.html'), '<!doctype html><title>lista</title>', 'utf8');
  await writeFile(join(root, 'workspaces', 'detalhe.html'), '<!doctype html><title>detalhe</title>', 'utf8');
  await writeFile(join(root, 'workspaces', 'detalhe', 'payload.txt'), 'rsc', 'utf8');
  // A file that exists beside the export and must stay unreachable.
  await writeFile(join(parent, 'segredo.txt'), 'nada disso deveria sair', 'utf8');

  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  await repositories.users.create({
    email: 'dono@voidfall.invalid',
    displayName: 'Dono',
    passwordHash: await hashPassword('static-panel-test-password'),
    roles: ['owner'],
  });

  const app = await buildControlApi({ database, cookieSecure: false, panelExportRoot: root });
  resources.push({ app, database });
  return { app, root, parent };
}

describe('serving the panel from the API', () => {
  it('serves a page and its assets from the same origin', async () => {
    const { app } = await fixture();

    const page = await app.inject({ method: 'GET', url: '/entrar' });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-type'] as string, /text\/html/u);
    assert.match(page.body, /entrar/u);

    const asset = await app.inject({ method: 'GET', url: '/_next/static/app.js' });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.headers['content-type'] as string, /text\/javascript/u);
    // Hashed assets are safe to cache hard; a document is not.
    assert.match(asset.headers['cache-control'] as string, /immutable/u);
  });

  it('sends the root to the sign-in page', async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers['location'], '/entrar');
  });

  it('never lets the panel answer for the API', async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    // A JSON error about the API, not an HTML page — a screen that got the
    // panel's 404 here would render a login form inside a fetch.
    assert.equal(response.statusCode, 404);
    assert.equal(response.json<{ error: { code: string } }>().error.code, 'NOT_FOUND');
  });

  it('refuses to read outside the export, in every spelling', async () => {
    const { app } = await fixture();
    for (const url of [
      '/../segredo.txt',
      '/%2e%2e/segredo.txt',
      '/entrar/../../segredo.txt',
      '/%2e%2e%2f%2e%2e%2fsegredo.txt',
      '/..%5csegredo.txt',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(
        response.body.includes('nada disso deveria sair'),
        false,
        `traversal leaked through ${url}`,
      );
    }
  });

  it('serves a nested route that Next exported beside a payload directory', async () => {
    const { app } = await fixture();

    // `/workspaces` exists as workspaces.html *and* as a workspaces/ directory
    // with no index.html. Stopping at the directory answered 404 for every
    // page below it — the list worked and nothing under it did.
    const list = await app.inject({ method: 'GET', url: '/workspaces' });
    assert.equal(list.statusCode, 200);
    assert.match(list.body, /lista/u);

    const nested = await app.inject({ method: 'GET', url: '/workspaces/detalhe' });
    assert.equal(nested.statusCode, 200);
    assert.match(nested.body, /detalhe/u);

    // With a query string, which is how the panel actually links to it. The
    // other half of the same bug appended `.html` to a path still carrying it.
    const withQuery = await app.inject({ method: 'GET', url: '/workspaces/detalhe?id=abc-123' });
    assert.equal(withQuery.statusCode, 200);
    assert.match(withQuery.body, /detalhe/u);
  });

  it('answers an unknown page with the exported 404, not with the API', async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: 'GET', url: '/pagina-que-nao-existe' });
    assert.equal(response.statusCode, 404);
    assert.match(response.body, /404/u);
  });

  it('keeps the session working on the same origin', async () => {
    const { app } = await fixture();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'dono@voidfall.invalid', password: 'static-panel-test-password' },
    });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers['set-cookie']);
    // `SameSite=strict` survives only because there is no second origin. That
    // is the whole reason the panel is served from here.
    assert.match(cookie, /SameSite=Strict/iu);

    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: cookie.split(';')[0] ?? '' },
    });
    assert.equal(session.json<{ csrfToken: string }>().csrfToken, login.json<{ csrfToken: string }>().csrfToken);
  });
});
