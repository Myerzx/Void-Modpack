import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'node:test';

import { hashPassword } from '@voidfall/authentication';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type { FastifyInstance } from 'fastify';

import { buildControlApi } from '../src/app.js';

/**
 * Signing in without a password, locally.
 *
 * Authentication is deferred, and these tests are what keeps "deferred" from
 * turning into "removed". The session it mints is the same one the real login
 * mints — same cookie flags, same CSRF token, same permission set — and the
 * route refuses anything that did not arrive on loopback.
 */

const resources: Array<{ app: FastifyInstance; database: Database }> = [];

afterEach(async () => {
  while (resources.length > 0) {
    const resource = resources.pop();
    if (resource !== undefined) {
      await resource.app.close();
      await resource.database.close();
    }
  }
});

async function fixture(options: { readonly local?: boolean } = {}) {
  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  await repositories.users.create({
    email: 'owner@voidfall.local',
    displayName: 'VoidFall Owner',
    passwordHash: await hashPassword('local-session-test-password'),
    roles: ['owner'],
  });

  const app = await buildControlApi({
    database,
    cookieSecure: false,
    ...(options.local === false
      ? {}
      : {
          localOperator: {
            mode: 'development' as const,
            email: 'owner@voidfall.local',
          },
        }),
  });
  resources.push({ app, database });
  return { app };
}

describe('the local operator session', () => {
  it('mints the same session the real login would', async () => {
    const { app } = await fixture();

    const granted = await app.inject({
      method: 'GET',
      url: '/local/session',
      remoteAddress: '127.0.0.1',
    });
    assert.equal(granted.statusCode, 302);
    assert.equal(granted.headers['location'], '/workspaces');

    const cookie = String(granted.headers['set-cookie']);
    // Nothing was loosened: the cookie is HttpOnly and SameSite=strict, which
    // only works because the panel is served from this same origin.
    assert.match(cookie, /HttpOnly/iu);
    assert.match(cookie, /SameSite=Strict/iu);

    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: cookie.split(';')[0] ?? '' },
    });
    const body = session.json<{
      user: { displayName: string };
      permissions: string[];
      csrfToken: string;
    }>();
    assert.equal(body.user.displayName, 'VoidFall Owner');
    // A real CSRF token, and the full owner permission set. The step that is
    // missing is proving who is sitting at the machine, not the machinery.
    assert.match(body.csrfToken, /^[A-Za-z0-9_-]{20,}$/u);
    assert.equal(body.permissions.includes('workspace.manage'), true);
  });

  it('refuses anything that did not arrive on loopback', async () => {
    const { app } = await fixture();
    const refused = await app.inject({
      method: 'GET',
      url: '/local/session',
      remoteAddress: '10.0.0.7',
    });
    // A bound interface or a proxy somebody puts in front must not reach this.
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.json<{ error: { code: string } }>().error.code, 'LOCAL_ONLY');
    assert.equal(refused.headers['set-cookie'], undefined);
  });

  it('does not exist unless the local environment asked for it', async () => {
    const { app } = await fixture({ local: false });
    const response = await app.inject({
      method: 'GET',
      url: '/local/session',
      remoteAddress: '127.0.0.1',
    });
    assert.equal(response.statusCode, 404);
  });

  it('leaves the password login working, for the day it is needed', async () => {
    const { app } = await fixture();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'owner@voidfall.local', password: 'local-session-test-password' },
    });
    // The login screen already exists; deferring authentication removed the
    // friction, not the route.
    assert.equal(login.statusCode, 200);
  });

  it('requires the ephemeral launch credential in desktop mode', async () => {
    const database = await createPGliteTestDatabase();
    await runMigrations(database);
    const repositories = createRepositories(database);
    await repositories.users.create({
      email: 'owner@voidfall.local',
      displayName: 'VoidFall Owner',
      passwordHash: await hashPassword('desktop-session-test-password'),
      roles: ['owner'],
    });
    const app = await buildControlApi({
      database,
      cookieSecure: false,
      panelExportRoot: tmpdir(),
      localOperator: {
        mode: 'desktop',
        email: 'owner@voidfall.local',
        launchToken: 'desktop-launch-token-with-enough-entropy-for-the-test',
      },
    });
    resources.push({ app, database });

    const root = await app.inject({
      method: 'GET',
      url: '/',
      remoteAddress: '127.0.0.1',
    });
    assert.equal(root.statusCode, 302);
    assert.equal(root.headers['location'], '/entrar');
    assert.equal(String(root.headers['location']).includes('token='), false);

    for (const url of ['/local/session', '/local/session?token=wrong']) {
      const refused = await app.inject({
        method: 'GET',
        url,
        remoteAddress: '127.0.0.1',
      });
      assert.equal(refused.statusCode, 403);
      assert.equal(
        refused.json<{ error: { code: string } }>().error.code,
        'LOCAL_LAUNCH_TOKEN_INVALID',
      );
      assert.equal(refused.headers['set-cookie'], undefined);
    }

    const granted = await app.inject({
      method: 'GET',
      url: '/local/session?token=desktop-launch-token-with-enough-entropy-for-the-test',
      remoteAddress: '127.0.0.1',
    });
    assert.equal(granted.statusCode, 302);
    assert.match(String(granted.headers['set-cookie']), /HttpOnly/iu);
  });
});
