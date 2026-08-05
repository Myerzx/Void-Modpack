import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { hashPassword } from '@voidfall/authentication';
import { AuthorizedFileService } from '@voidfall/authorized-files';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type { FastifyInstance } from 'fastify';

import { buildControlApi } from '../src/app.js';

/**
 * Phase 10.2 authorized file routes.
 *
 * Every root here is a temporary directory created by the test. No real
 * deployment root, no workspace and no Minecraft installation is involved.
 */

const resources: Array<{
  readonly app: FastifyInstance;
  readonly database: Database;
  readonly directory: string;
}> = [];
const NOW = new Date('2026-08-05T12:00:00.000Z');
const BASE = '/api/v1/files';

afterEach(async () => {
  while (resources.length > 0) {
    const resource = resources.pop();
    if (resource !== undefined) {
      await resource.app.close();
      await resource.database.close();
      await rm(resource.directory, { recursive: true, force: true });
    }
  }
});

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

const INITIAL = 'motd=VoidFall\nmax-players=20\nrcon.password=hunter-two-secret\n';

async function fixture(
  options: { readonly role?: 'owner' | 'read-only'; readonly withService?: boolean } = {},
) {
  const role = options.role ?? 'owner';
  const directory = await mkdtemp(join(tmpdir(), 'voidfall-file-api-'));
  const contentRoot = join(directory, 'content');
  await mkdir(join(contentRoot, 'config'), { recursive: true });
  await mkdir(join(contentRoot, 'backup'), { recursive: true });
  await writeFile(join(contentRoot, 'config', 'server.properties'), INITIAL, 'utf8');

  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const password = 'authorized-file-api-test-password';
  await repositories.users.create({
    email: `${role}@voidfall.invalid`,
    displayName: `${role} fixture`,
    passwordHash: await hashPassword(password),
    roles: [role],
  });

  const authorizedFiles = new AuthorizedFileService({
    revisionRoot: join(directory, 'history'),
    roots: [
      {
        rootId: 'server-config',
        rootPath: contentRoot,
        readableExtensions: ['.json', '.properties'],
        writableExtensions: ['.properties'],
        maximumFileBytes: 4_096,
      },
    ],
  });

  const app = await buildControlApi({
    database,
    cookieSecure: false,
    clock: () => NOW,
    agentTransportVerifier: () => true,
    ...(options.withService === false ? {} : { authorizedFiles }),
  });
  resources.push({ app, database, directory });

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: `${role}@voidfall.invalid`, password },
  });
  assert.equal(login.statusCode, 200);

  return {
    app,
    repositories,
    directory,
    contentRoot,
    cookie: (login.headers['set-cookie'] as string).split(';')[0] ?? '',
    csrfToken: login.json<{ csrfToken: string }>().csrfToken,
  };
}

type Context = Awaited<ReturnType<typeof fixture>>;

function post(context: Context, url: string, payload: unknown) {
  return context.app.inject({
    method: 'POST',
    url,
    headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
    payload: payload as Record<string, unknown>,
  });
}

describe('authorized file discovery', () => {
  it('lists and reads inside a declared root only', async () => {
    const context = await fixture();

    const entries = await context.app.inject({
      method: 'GET',
      url: `${BASE}/roots/server-config/entries?path=config`,
      headers: { cookie: context.cookie },
    });
    assert.equal(entries.statusCode, 200);
    assert.deepEqual(
      entries.json<{ entries: Array<{ name: string }> }>().entries.map((entry) => entry.name),
      ['server.properties'],
    );

    const content = await context.app.inject({
      method: 'GET',
      url: `${BASE}/roots/server-config/content?path=config/server.properties`,
      headers: { cookie: context.cookie },
    });
    assert.equal(content.statusCode, 200);
    assert.equal(content.json<{ sha256: string }>().sha256, digest(INITIAL));

    // A root nobody declared does not exist as far as the API is concerned.
    const unknown = await context.app.inject({
      method: 'GET',
      url: `${BASE}/roots/other-root/entries`,
      headers: { cookie: context.cookie },
    });
    assert.equal(unknown.statusCode, 404);
  });

  it('refuses every spelling of somewhere else, and says nothing about it', async () => {
    const context = await fixture();
    for (const path of [
      '../../etc/passwd',
      'config/../../escape.properties',
      '/etc/passwd',
      'C:/Windows/system.ini',
      'C:\\Windows\\system.ini',
      'config\\server.properties',
      'config/server.properties:$DATA',
    ]) {
      const response = await context.app.inject({
        method: 'GET',
        url: `${BASE}/roots/server-config/content?path=${encodeURIComponent(path)}`,
        headers: { cookie: context.cookie },
      });
      assert.ok(
        response.statusCode === 400 || response.statusCode === 404,
        `expected ${path} to be refused, got ${response.statusCode}`,
      );
      // The refusal never echoes the path back or names a directory.
      assert.equal(response.body.includes('etc'), false);
      assert.equal(response.body.includes('Windows'), false);
    }
  });

  it('reports itself unavailable when no root was configured', async () => {
    const context = await fixture({ withService: false });
    const response = await context.app.inject({
      method: 'GET',
      url: `${BASE}/roots/server-config/entries`,
      headers: { cookie: context.cookie },
    });
    assert.equal(response.statusCode, 503);
  });
});

describe('authorized file mutations over HTTP', () => {
  it('creates, copies, moves, deletes and restores, each on its own permission', async () => {
    const context = await fixture();

    const created = await post(context, BASE, {
      schemaVersion: 1,
      rootId: 'server-config',
      filePath: 'config/extra.properties',
      reasonCode: 'operator-request',
      content: 'level-name=world\n',
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json<{ operation: string }>().operation, 'create');

    // A second create finds the destination occupied.
    const again = await post(context, BASE, {
      schemaVersion: 1,
      rootId: 'server-config',
      filePath: 'config/extra.properties',
      reasonCode: 'operator-request',
      content: 'level-name=other\n',
    });
    assert.equal(again.statusCode, 409);
    assert.equal(
      await readFile(join(context.contentRoot, 'config', 'extra.properties'), 'utf8'),
      'level-name=world\n',
    );

    const copied = await post(context, `${BASE}/copy`, {
      schemaVersion: 1,
      rootId: 'server-config',
      sourcePath: 'config/server.properties',
      destinationPath: 'backup/server.properties',
      reasonCode: 'operator-request',
      expectedSha256: digest(INITIAL),
    });
    assert.equal(copied.statusCode, 200);

    const moved = await post(context, `${BASE}/move`, {
      schemaVersion: 1,
      rootId: 'server-config',
      sourcePath: 'config/extra.properties',
      destinationPath: 'config/renamed.properties',
      revisionId: 'revision-rename-1',
      reasonCode: 'operator-request',
      expectedSha256: digest('level-name=world\n'),
    });
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json<{ destinationPath: string }>().destinationPath, 'config/renamed.properties');

    const deleted = await post(context, `${BASE}/delete`, {
      schemaVersion: 1,
      rootId: 'server-config',
      filePath: 'config/renamed.properties',
      revisionId: 'revision-delete-1',
      reasonCode: 'operator-request',
      expectedSha256: digest('level-name=world\n'),
      acknowledgesDataLoss: true,
    });
    assert.equal(deleted.statusCode, 200);

    const restored = await post(context, `${BASE}/restore`, {
      schemaVersion: 1,
      rootId: 'server-config',
      revisionId: 'revision-delete-1',
      reasonCode: 'operator-request',
    });
    assert.equal(restored.statusCode, 200);
    assert.equal(
      await readFile(join(context.contentRoot, 'config', 'renamed.properties'), 'utf8'),
      'level-name=world\n',
    );
  });

  it('will not let a deletion be reached by omitting the acknowledgement', async () => {
    const context = await fixture();
    const response = await post(context, `${BASE}/delete`, {
      schemaVersion: 1,
      rootId: 'server-config',
      filePath: 'config/server.properties',
      revisionId: 'revision-delete-2',
      reasonCode: 'operator-request',
      expectedSha256: digest(INITIAL),
    });
    assert.equal(response.statusCode, 400);
    // The file is still there.
    assert.equal(await readFile(join(context.contentRoot, 'config', 'server.properties'), 'utf8'), INITIAL);
  });

  it('refuses a mutation from a role that may only look', async () => {
    const context = await fixture({ role: 'read-only' });
    for (const [url, payload] of [
      [BASE, { schemaVersion: 1, rootId: 'server-config', filePath: 'config/x.properties', reasonCode: 'operator-request', content: 'a=1\n' }],
      [
        `${BASE}/delete`,
        {
          schemaVersion: 1,
          rootId: 'server-config',
          filePath: 'config/server.properties',
          revisionId: 'revision-x',
          reasonCode: 'operator-request',
          expectedSha256: digest(INITIAL),
          acknowledgesDataLoss: true,
        },
      ],
    ] as const) {
      const response = await post(context, url, payload);
      assert.equal(response.statusCode, 403);
    }
    // Looking is still allowed.
    const entries = await context.app.inject({
      method: 'GET',
      url: `${BASE}/roots/server-config/entries`,
      headers: { cookie: context.cookie },
    });
    assert.equal(entries.statusCode, 200);
  });

  it('refuses a mutation without the CSRF token', async () => {
    const context = await fixture();
    const response = await context.app.inject({
      method: 'POST',
      url: BASE,
      headers: { cookie: context.cookie },
      payload: {
        schemaVersion: 1,
        rootId: 'server-config',
        filePath: 'config/x.properties',
        reasonCode: 'operator-request',
        content: 'a=1\n',
      },
    });
    assert.equal(response.statusCode, 403);
  });

  it('records every attempt, including the refused one', async () => {
    const context = await fixture();
    await post(context, BASE, {
      schemaVersion: 1,
      rootId: 'server-config',
      filePath: 'config/audited.properties',
      reasonCode: 'operator-request',
      content: 'a=1\n',
    });
    await post(context, `${BASE}/delete`, {
      schemaVersion: 1,
      rootId: 'server-config',
      filePath: 'config/audited.properties',
      revisionId: 'revision-audited',
      reasonCode: 'operator-request',
      // Stale on purpose: the refusal must be recorded too.
      expectedSha256: digest('something else'),
      acknowledgesDataLoss: true,
    });

    const events = await context.repositories.audit.list();
    const fileEvents = events.filter((event) => event.action.startsWith('file.'));
    // Sorted here rather than asserted in arrival order: the fixture pins the
    // clock, so both events share a timestamp and their order is not
    // determined by anything the test controls.
    assert.deepEqual(
      fileEvents.map((event) => `${event.action}:${event.outcome}`).sort(),
      ['file.created:succeeded', 'file.deleted:failed'],
    );
    // Each entry says which file, which is the whole point of recording it.
    for (const event of fileEvents) {
      assert.ok(event.reason?.includes('config/audited.properties'), event.action);
    }
  });
});

describe('authorized file diff over HTTP', () => {
  it('shows that a secret changed without showing the secret', async () => {
    const context = await fixture();
    const response = await post(context, `${BASE}/diff`, {
      schemaVersion: 1,
      rootId: 'server-config',
      filePath: 'config/server.properties',
      against: {
        type: 'proposed',
        content: 'motd=VoidFall\nmax-players=20\nrcon.password=a-brand-new-secret\n',
      },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json<{
      lines: Array<{ type: string; text: string; redacted: boolean }>;
      containsRedactedChange: boolean;
      addedCount: number;
      removedCount: number;
    }>();

    assert.equal(body.addedCount, 1);
    assert.equal(body.removedCount, 1);
    assert.equal(body.containsRedactedChange, true);
    // Neither the old nor the proposed secret appears anywhere in the response.
    assert.equal(response.body.includes('hunter-two-secret'), false);
    assert.equal(response.body.includes('a-brand-new-secret'), false);
    // The key does, so the operator knows which setting moved.
    assert.ok(response.body.includes('rcon.password'));

    // Asking for a diff wrote nothing.
    assert.equal(await readFile(join(context.contentRoot, 'config', 'server.properties'), 'utf8'), INITIAL);
  });

  it('refuses a diff source that is neither a revision nor proposed text', async () => {
    const context = await fixture();
    const response = await post(context, `${BASE}/diff`, {
      schemaVersion: 1,
      rootId: 'server-config',
      filePath: 'config/server.properties',
      against: { type: 'path', path: '/etc/shadow' },
    });
    assert.equal(response.statusCode, 400);
  });
});

describe('authorized file uploads carry nothing executable', () => {
  it('refuses an extension the root does not allow to be written', async () => {
    const context = await fixture();
    for (const filePath of [
      'config/payload.sh',
      'config/payload.bat',
      'config/payload.jar',
      // Readable but not writable: reading a JSON is fine, creating one is not.
      'config/payload.json',
    ]) {
      const response = await post(context, BASE, {
        schemaVersion: 1,
        rootId: 'server-config',
        filePath,
        reasonCode: 'operator-request',
        content: 'echo hi\n',
      });
      assert.equal(response.statusCode, 403, `expected ${filePath} to be refused`);
    }
  });

  it('refuses content carrying control characters or exceeding the root bound', async () => {
    const context = await fixture();
    const escaped = await post(context, BASE, {
      schemaVersion: 1,
      rootId: 'server-config',
      filePath: 'config/control.properties',
      reasonCode: 'operator-request',
      content: 'motd=\u001b[31mred\u001b[0m\n',
    });
    assert.equal(escaped.statusCode, 400);

    const oversized = await post(context, BASE, {
      schemaVersion: 1,
      rootId: 'server-config',
      filePath: 'config/big.properties',
      reasonCode: 'operator-request',
      content: `${'a'.repeat(5_000)}\n`,
    });
    assert.equal(oversized.statusCode, 413);
  });
});
