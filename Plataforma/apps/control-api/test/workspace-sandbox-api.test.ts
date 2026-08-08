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
import { createWorkspaceConfigurationService } from '../src/workspace-configuration.js';
import { createWorkspaceScanner } from '../src/workspace-scanner.js';
import type { SandboxLauncher } from '../src/workspace-routes.js';
import { withoutHostPaths } from '../src/workspace-sandbox.js';

/**
 * Running a disposable sandbox from the panel.
 *
 * The launcher is controlled here rather than real: a genuine boot spawns a
 * JVM for minutes, and a test that did would be testing Forge. What is under
 * test is the shape around it — that a run is answered immediately and read
 * back by id, that a boot in flight blocks a second one, that a refusal keeps
 * its named cause, and that the staged change is what gets handed over.
 */

const resources: Array<{ app: FastifyInstance; database: Database }> = [];
const directories: string[] = [];

const TOML = ['#Range: 0 ~ 100', 'bossDamage = 40', ''].join('\n');

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

/** A launcher whose completion this test decides, so no JVM is involved. */
function controllable() {
  const seen: {
    changeSets: readonly { path: string; changes: readonly { path: string }[] }[];
    finish?: (result: { outcome: string; durationMs: number; evidence: unknown }) => Promise<void>;
    refuse?: (refusal: string) => Promise<void>;
    progress?: (message: string) => Promise<void>;
  } = { changeSets: [] };

  const launcher: SandboxLauncher = {
    launch(input) {
      seen.changeSets = input.changeSets as never;
      seen.finish = input.onFinished;
      seen.refuse = input.onRefused;
      seen.progress = input.onProgress;
    },
  };
  return { launcher, seen };
}

async function fixture(options: { readonly launcher?: SandboxLauncher } = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'voidfall-sandbox-'));
  directories.push(parent);
  const root = join(parent, 'workspace');
  await mkdir(join(root, 'config'), { recursive: true });
  await writeFile(join(root, 'config', 'alpha.toml'), TOML, 'utf8');

  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const password = 'workspace-sandbox-test-password';
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
    workspaceConfiguration: createWorkspaceConfigurationService(join(parent, 'staging')),
    ...(options.launcher === undefined ? {} : { sandboxLauncher: options.launcher }),
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

describe('progress lines that reach a browser', () => {
  it('keeps the meaning and drops the host path', () => {
    // Caught by watching the panel, not by a test: the runner writes for a
    // terminal and names the sandbox parent by absolute path, which went
    // straight onto the screen. A host path in a browser is a host path in a
    // screenshot.
    // Built from a character code: a backslash written through a tool call has
    // turned into a control byte in this repository more than once.
    const back = String.fromCharCode(92);
    assert.equal(
      withoutHostPaths(
        `Sandbox parent: C:${back}Users${back}alguem${back}AppData${back}Local${back}Temp`,
      ),
      'Sandbox parent: <caminho local>',
    );
    assert.equal(
      withoutHostPaths('Sandbox parent: /home/alguem/.cache/voidfall'),
      'Sandbox parent: <caminho local>',
    );
    // A relative path inside the server is not a host path and stays readable.
    assert.equal(
      withoutHostPaths('Forge argument file: libraries/net/minecraftforge/win_args.txt'),
      'Forge argument file: libraries/net/minecraftforge/win_args.txt',
    );
    assert.equal(withoutHostPaths('5530 files to copy (1017 MiB).'), '5530 files to copy (1017 MiB).');
  });
});

describe('starting a sandbox run', () => {
  it('answers immediately and is read back by id', async () => {
    const { launcher, seen } = controllable();
    const { app, cookie, csrfToken, workspaceId } = await fixture({ launcher });

    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/sandbox-runs`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    // 202, not 201: a boot takes minutes, so the answer is "accepted", not
    // "done". Blocking a request on a JVM would be the other design.
    assert.equal(started.statusCode, 202);
    const runId = started.json<{ runId: string }>().runId;

    const running = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/sandbox-runs/${runId}`,
      headers: { cookie },
    });
    const run = running.json<{ run: { status: string; outcome: string | null } }>().run;
    assert.equal(run.status, 'running');
    // Not knowing yet is its own state, never conflated with a failure.
    assert.equal(run.outcome, null);

    await seen.progress?.('Java 21 via JAVA_HOME.');
    await seen.finish?.({
      outcome: 'booted',
      durationMs: 91_000,
      evidence: { generatedFiles: ['config/novo.toml'], tail: ['Done (91.0s)!'], disposed: true },
    });

    const finished = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/sandbox-runs/${runId}`,
      headers: { cookie },
    });
    const done = finished.json<{
      run: {
        status: string;
        outcome: string;
        durationMs: number;
        progress: string[];
        evidence: { generatedFiles: string[] };
      };
    }>().run;
    assert.equal(done.status, 'finished');
    assert.equal(done.outcome, 'booted');
    assert.equal(done.durationMs, 91_000);
    // A page that reloads mid-boot sees where it got to, not a bare spinner.
    assert.deepEqual(done.progress, ['Java 21 via JAVA_HOME.']);
    // The payoff of booting: a file that only exists after the mod has run.
    assert.deepEqual(done.evidence.generatedFiles, ['config/novo.toml']);
  });

  it('hands the staged change to the boot, not a rewritten file', async () => {
    const { launcher, seen } = controllable();
    const { app, cookie, csrfToken, workspaceId } = await fixture({ launcher });

    await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/configuration/staging`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { path: 'config/alpha.toml', changes: [{ path: 'bossDamage', value: 55 }] },
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/sandbox-runs`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    // The fields, not the rewritten bytes. Booting a change needs the change.
    assert.equal(seen.changeSets[0]?.path, 'config/alpha.toml');
    assert.deepEqual(seen.changeSets[0]?.changes, [{ path: 'bossDamage', value: 55 }]);
  });

  it('surfaces what is staged so a run can be judged before it starts', async () => {
    const { launcher } = controllable();
    const { app, cookie, csrfToken, workspaceId } = await fixture({ launcher });
    await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/configuration/staging`,
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { path: 'config/alpha.toml', changes: [{ path: 'bossDamage', value: 55 }] },
    });

    const staged = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/staged`,
      headers: { cookie },
    });
    const list = staged.json<{ staged: { path: string; baseSha256: string }[] }>().staged;
    assert.equal(list.length, 1);
    assert.equal(list[0]?.path, 'config/alpha.toml');
    // Recorded so an apply that ever exists can refuse when the file moved on.
    assert.match(list[0]?.baseSha256 ?? '', /^[0-9a-f]{64}$/u);
  });

  it('refuses a second boot while one is in flight', async () => {
    const { launcher } = controllable();
    const { app, cookie, csrfToken, workspaceId } = await fixture({ launcher });

    await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/sandbox-runs`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/sandbox-runs`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    // Two sandboxes from one server contend for the same files and port, and
    // the second fails in a way that reads like the change under test.
    assert.equal(second.statusCode, 409);
  });

  it('keeps the named cause when the runner would not start', async () => {
    const { launcher, seen } = controllable();
    const { app, cookie, csrfToken, workspaceId } = await fixture({ launcher });

    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/sandbox-runs`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    await seen.refuse?.('eula-not-accepted-in-workspace');

    const run = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/sandbox-runs/${started.json<{ runId: string }>().runId}`,
      headers: { cookie },
    });
    const body = run.json<{ run: { status: string; refusal: string; outcome: string | null } }>().run;
    assert.equal(body.status, 'refused');
    // An operator is told what to change, not that something went wrong.
    assert.equal(body.refusal, 'eula-not-accepted-in-workspace');
    // Refused and "it did not boot" are different facts.
    assert.equal(body.outcome, null);
  });

  it('reports itself unavailable rather than accepting a run nothing will execute', async () => {
    const { app, cookie, csrfToken, workspaceId } = await fixture();
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/sandbox-runs`,
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    assert.equal(started.statusCode, 503);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/workspaces/${workspaceId}/sandbox-runs`,
          headers: { cookie },
        })
      ).json<{ available: boolean }>().available,
      false,
    );
  });
});
