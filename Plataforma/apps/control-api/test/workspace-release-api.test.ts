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
import { createReleaseBuilder } from '../src/workspace-release.js';
import { createWorkspaceScanner } from '../src/workspace-scanner.js';

/**
 * Producing a release from the panel.
 *
 * These run against the real builder, not a stub: the whole point of the slice
 * is that the panel reaches what already works. What is under test around it —
 * that a build is answered immediately and read back by id, that a version
 * cannot be reused, that the licence gate refuses a distribution build before
 * anything is written, and that a download never lets the caller name a file.
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

async function fixture(options: { readonly withRelease?: boolean } = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'voidfall-release-'));
  directories.push(parent);
  const root = join(parent, 'workspace');
  await mkdir(join(root, 'config'), { recursive: true });
  await mkdir(join(root, 'mods'), { recursive: true });
  await writeFile(join(root, 'config', 'alpha.toml'), 'a = 1\n', 'utf8');
  await writeFile(join(root, 'mods', 'alpha.jar'), 'not really a jar', 'utf8');

  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const password = 'workspace-release-test-password';
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
    ...(options.withRelease === false
      ? {}
      : { releaseBuilder: createReleaseBuilder(join(parent, 'releases')) }),
  });
  resources.push({ app, database });

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'dono@voidfall.invalid', password },
  });
  const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
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

  return { app, cookie, csrfToken, workspaceId };
}

/** Waits for the build to leave `building`, which happens off the request. */
async function settled(app: FastifyInstance, cookie: string, workspaceId: string, releaseId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/releases/${releaseId}`,
      headers: { cookie },
    });
    const release = response.json<{
      release: { status: string; refusal: string | null; packages: unknown };
    }>().release;
    if (release.status !== 'building') return release;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('release never settled');
}

describe('previewing a release', () => {
  it('reports the diff, the changelog and why distribution is refused', async () => {
    const { app, cookie, workspaceId } = await fixture();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/release/preview`,
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200);

    const body = response.json<{
      previousInventoryId: string | null;
      changelogMarkdown: string;
      distribution: {
        distributable: boolean;
        localUseOnly: boolean;
        blocksByReason: [string, number][];
        curseForge: { allowed: boolean; refusal: string | null };
      };
    }>();

    // A first release has no previous inventory. That is a state, not a gap:
    // everything is added, and saying otherwise would invent a history.
    assert.equal(body.previousInventoryId, null);
    // The fixture jar declares no mod, so the changelog has no mod section —
    // and says what it does have rather than an empty document.
    assert.match(body.changelogMarkdown, /## Configuration\n\n- added: config\/alpha\.toml/u);

    // Nothing is reviewed, so nothing may be redistributed — and the reason is
    // counted, because "1 need provider metadata" tells an operator what to do
    // and "1 blocked" does not.
    assert.equal(body.distribution.distributable, false);
    assert.equal(body.distribution.localUseOnly, true);
    assert.deepEqual(body.distribution.blocksByReason, [['not-reviewed', 1]]);
    assert.equal(body.distribution.curseForge.allowed, false);
  });

  it('refuses before a scan, instead of releasing nothing', async () => {
    const { app, cookie, csrfToken } = await fixture();
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: {
        slug: 'sem-scan',
        displayName: 'Sem scan',
        rootPath: directories[directories.length - 1] ?? '',
        kind: 'server',
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${second.json<{ workspaceId: string }>().workspaceId}/release/preview`,
      headers: { cookie },
    });
    assert.equal(response.statusCode, 409);
  });
});

describe('building a release', () => {
  it('answers immediately and produces both packages', async () => {
    const { app, cookie, csrfToken, workspaceId } = await fixture();

    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/releases`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { version: '1.0.0' },
    });
    // 202: a gigabyte of archives is not a request.
    assert.equal(started.statusCode, 202);

    const release = await settled(
      app,
      cookie,
      workspaceId,
      started.json<{ releaseId: string }>().releaseId,
    );
    assert.equal(release.status, 'ready');

    const packages = release.packages as {
      server: { fileName: string; entries: number; sha256: string };
      client: { derivedFromServerWorkspace: boolean };
    };
    assert.equal(packages.server.fileName, 'voidfall-server-1.0.0.zip');
    assert.match(packages.server.sha256, /^[0-9a-f]{64}$/u);
    // A client package cut from a server installation is partial, and the
    // manifest says so rather than letting it read as complete.
    assert.equal(packages.client.derivedFromServerWorkspace, true);
  });

  it('refuses a distribution build before writing anything', async () => {
    const { app, cookie, csrfToken, workspaceId } = await fixture();
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/releases`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { version: '1.0.0', intent: 'distribution' },
    });
    const release = await settled(
      app,
      cookie,
      workspaceId,
      started.json<{ releaseId: string }>().releaseId,
    );
    // A licence refusal is not a smaller export; it is a violation with a
    // progress bar. The refusal carries the gate's own counts.
    assert.equal(release.status, 'refused');
    assert.match(release.refusal ?? '', /never reviewed|provider metadata/u);
  });

  it('refuses to reuse a version', async () => {
    const { app, cookie, csrfToken, workspaceId } = await fixture();
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/releases`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { version: '1.0.0' },
    });
    await settled(app, cookie, workspaceId, first.json<{ releaseId: string }>().releaseId);

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/releases`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { version: '1.0.0' },
    });
    // Rebuilding a version over different evidence is how a version number
    // stops meaning anything.
    assert.equal(again.statusCode, 409);
  });

  it('downloads the archive without the caller naming a file', async () => {
    const { app, cookie, csrfToken, workspaceId } = await fixture();
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/releases`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { version: '1.0.0' },
    });
    const releaseId = started.json<{ releaseId: string }>().releaseId;
    await settled(app, cookie, workspaceId, releaseId);

    const download = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/releases/${releaseId}/archive?side=server`,
      headers: { cookie },
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers['content-type'], 'application/zip');
    assert.match(String(download.headers['content-disposition']), /voidfall-server-1\.0\.0\.zip/u);
    // A real ZIP: the local file header signature, PK\x03\x04.
    assert.equal(download.rawPayload.readUInt32LE(0), 0x0403_4b50);

    // The archive is addressed by release id and side, never by a name the
    // caller composed, so a download cannot reach a file nobody produced.
    const unknown = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/releases/${releaseId}/archive?side=../../etc/passwd`,
      headers: { cookie },
    });
    assert.equal(unknown.statusCode, 200);
    assert.match(String(unknown.headers['content-disposition']), /voidfall-server/u);
  });

  it('reports itself unavailable rather than promising an artefact', async () => {
    const { app, cookie, csrfToken, workspaceId } = await fixture({ withRelease: false });
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/releases`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { version: '1.0.0' },
    });
    assert.equal(started.statusCode, 503);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/workspaces/${workspaceId}/releases`,
          headers: { cookie },
        })
      ).json<{ available: boolean }>().available,
      false,
    );
  });
});
