import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { hashPassword } from '@voidfall/authentication';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type { FastifyInstance } from 'fastify';

import { buildControlApi } from '../src/app.js';
import { createWorkspaceConfigurationService } from '../src/workspace-configuration.js';
import { createWorkspaceScanner } from '../src/workspace-scanner.js';

/**
 * Editing a mod's configuration from the panel.
 *
 * These run against the real inference and staging engines, not a stub — the
 * point of the slice is that the panel reaches what already works, so a test
 * that faked the engine would prove the wiring and nothing else.
 *
 * The property that matters most: after a stage, the workspace file is
 * byte-for-byte what it was. Applying is the one destructive step and it still
 * has no owner anywhere in this repository.
 */

const resources: Array<{ app: FastifyInstance; database: Database }> = [];
const directories: string[] = [];

const TOML = [
  '#Range: 0 ~ 100',
  '#How much damage the boss deals.',
  'bossDamage = 40',
  '',
  '#Allowed Values: EASY, NORMAL, HARD',
  'preset = "NORMAL" #mandatory',
  '',
  'enabled = true',
  '',
].join('\n');

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

async function fixture(options: { readonly withConfiguration?: boolean } = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'voidfall-config-'));
  directories.push(parent);
  const root = join(parent, 'workspace');
  await mkdir(join(root, 'config'), { recursive: true });
  await writeFile(join(root, 'config', 'alpha.toml'), TOML, 'utf8');

  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const password = 'workspace-configuration-test-password';
  await repositories.users.create({
    email: 'dono@voidfall.invalid',
    displayName: 'Dono',
    passwordHash: await hashPassword(password),
    roles: ['owner'],
  });

  const app = await buildControlApi({
    database,
    cookieSecure: false,
    workspaceScanner: createWorkspaceScanner(),
    ...(options.withConfiguration === false
      ? {}
      : {
          workspaceConfiguration: createWorkspaceConfigurationService(join(parent, 'staging')),
        }),
  });
  resources.push({ app, database });

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'dono@voidfall.invalid', password },
  });
  const cookie = (String(login.headers['set-cookie']).split(';')[0] ?? '');
  const csrfToken = login.json<{ csrfToken: string }>().csrfToken;

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

  return { app, cookie, csrfToken, workspaceId, root };
}

const CONFIG_PATH = 'config/alpha.toml';

describe('reading a mod configuration as a form', () => {
  it('reports the bounds the mod itself declared', async () => {
    const { app, cookie, workspaceId } = await fixture();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/configuration?path=${encodeURIComponent(CONFIG_PATH)}`,
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200);

    const form = response.json<{
      form: {
        complete: boolean;
        fields: {
          path: string;
          value: unknown;
          constraints: { kind: string }[];
          documentation: string[];
        }[];
      };
    }>().form;

    const damage = form.fields.find((field) => field.path === 'bossDamage');
    assert.equal(damage?.value, 40);
    // Read from the comment ForgeConfigSpec wrote, never guessed from the value.
    assert.equal(damage?.constraints[0]?.kind, 'range');
    // Verbatim: it is the only description of the field that exists, and it
    // was written by whoever wrote the mod.
    assert.equal(damage?.documentation.includes('How much damage the boss deals.'), true);
    // A trailing comment on a value once made the whole field disappear.
    assert.equal(form.fields.find((field) => field.path === 'preset')?.value, 'NORMAL');
    assert.equal(form.complete, true);
  });

  it('refuses a path the scan never found', async () => {
    const { app, cookie, workspaceId } = await fixture();
    for (const path of ['config/../../../etc/passwd', 'config/nao-existe.toml']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/workspaces/${workspaceId}/configuration?path=${encodeURIComponent(path)}`,
        headers: { cookie },
      });
      // The panel chooses from what the engine reported, so traversal never
      // becomes a question about string handling.
      assert.equal(response.statusCode, 404);
    }
  });
});

describe('validating a proposed value', () => {
  it('keeps well-typed apart from checked against a declared bound', async () => {
    const { app, cookie, csrfToken, workspaceId } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/configuration/validate`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: {
        path: CONFIG_PATH,
        changes: [
          { path: 'bossDamage', value: 55 },
          { path: 'enabled', value: false },
        ],
      },
    });

    const body = response.json<{
      acceptable: boolean;
      decisions: { path: string; checkedAgainstDeclaredBounds?: boolean }[];
    }>();
    assert.equal(body.acceptable, true);
    // The number had a declared range; the boolean had nothing to check
    // against. Presenting both as "validated" would be a lie by omission.
    assert.equal(
      body.decisions.find((decision) => decision.path === 'bossDamage')
        ?.checkedAgainstDeclaredBounds,
      true,
    );
    assert.equal(
      body.decisions.find((decision) => decision.path === 'enabled')
        ?.checkedAgainstDeclaredBounds,
      false,
    );
  });

  it('rejects a value outside the declared range, and names why', async () => {
    const { app, cookie, csrfToken, workspaceId } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/configuration/validate`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { path: CONFIG_PATH, changes: [{ path: 'bossDamage', value: 4_000 }] },
    });
    const body = response.json<{ acceptable: boolean; decisions: { code?: string }[] }>();
    assert.equal(body.acceptable, false);
    assert.equal(body.decisions[0]?.code, 'out-of-declared-range');
  });

  it('rejects a value outside the allowed set', async () => {
    const { app, cookie, csrfToken, workspaceId } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/configuration/validate`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { path: CONFIG_PATH, changes: [{ path: 'preset', value: 'IMPOSSIVEL' }] },
    });
    assert.equal(response.json<{ decisions: { code?: string }[] }>().decisions[0]?.code, 'not-an-allowed-value');
  });
});

describe('staging a change', () => {
  it('writes the change somewhere else and leaves the workspace untouched', async () => {
    const { app, cookie, csrfToken, workspaceId, root } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/configuration/staging`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { path: CONFIG_PATH, changes: [{ path: 'bossDamage', value: 55 }] },
    });
    assert.equal(response.statusCode, 201);

    const staged = response.json<{
      appliedToWorkspace: boolean;
      baseSha256: string;
      stagedSha256: string;
      diff: { kind: string; text: string }[];
    }>();
    assert.equal(staged.appliedToWorkspace, false);
    assert.notEqual(staged.baseSha256, staged.stagedSha256);
    assert.equal(
      staged.diff.some((line) => line.kind === 'added' && line.text.includes('55')),
      true,
    );

    // Byte for byte what it was. Applying is the one destructive step and it
    // still has no owner anywhere in this repository.
    assert.equal(await readFile(join(root, 'config', 'alpha.toml'), 'utf8'), TOML);
  });

  it('refuses a change the validator would have rejected', async () => {
    const { app, cookie, csrfToken, workspaceId, root } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/configuration/staging`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { path: CONFIG_PATH, changes: [{ path: 'bossDamage', value: 4_000 }] },
    });
    assert.equal(response.statusCode, 422);
    assert.equal(await readFile(join(root, 'config', 'alpha.toml'), 'utf8'), TOML);
  });

  it('reports the staged diff and lets it be discarded', async () => {
    const { app, cookie, csrfToken, workspaceId } = await fixture();
    await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/configuration/staging`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { path: CONFIG_PATH, changes: [{ path: 'bossDamage', value: 55 }] },
    });

    const url = `/api/v1/workspaces/${workspaceId}/configuration/staging?path=${encodeURIComponent(CONFIG_PATH)}`;
    const before = await app.inject({ method: 'GET', url, headers: { cookie } });
    assert.equal(before.json<{ dataQuality: string }>().dataQuality, 'stored');

    const discarded = await app.inject({
      method: 'DELETE',
      url,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    assert.equal(discarded.statusCode, 204);

    // Discarding before apply deletes a file this service wrote. Nothing in
    // the workspace was touched, because nothing in it ever was.
    const after = await app.inject({ method: 'GET', url, headers: { cookie } });
    assert.equal(after.json<{ dataQuality: string }>().dataQuality, 'not-staged');
  });

  it('reports itself unavailable rather than staging nowhere', async () => {
    const { app, cookie, workspaceId } = await fixture({ withConfiguration: false });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/configuration?path=${encodeURIComponent(CONFIG_PATH)}`,
      headers: { cookie },
    });
    assert.equal(response.statusCode, 503);
  });
});
