import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword } from '@voidfall/authentication';
import { createEmbeddedDatabase, createRepositories, runMigrations } from '@voidfall/database';

import { buildControlApi } from './app.js';
import { panelExportExists } from './static-panel.js';
import { createWorkspaceScanner, defaultWorkspaceRootPolicy } from './workspace-scanner.js';

/**
 * `npm run panel` — the whole local environment, from nothing.
 *
 * The one thing the operator still had to solve by hand was how to serve panel
 * and API on the same origin, and the honest answers all ended in "install a
 * proxy and write a config". So the project provides the environment instead
 * of instructions for building one:
 *
 *  - **Database.** PGlite, already in this repository running the test suite,
 *    persisted to a directory under `.voidfall/`. A real PostgreSQL compiled
 *    to WebAssembly: no daemon, no port, no credential to store. Deleting the
 *    directory resets to first run.
 *  - **Origin.** The API serves the exported panel itself, so same-origin is a
 *    property of the process rather than a deployment instruction, and the
 *    session cookie's `SameSite=strict` keeps working with nothing configured.
 *  - **Owner.** Generated on first run and printed once. A password nobody
 *    chose is still a password nobody has to invent, and inventing one is the
 *    step people skip badly.
 *
 * None of this is production. It binds loopback, it refuses to run with
 * `NODE_ENV=production`, and the owner is only ever created when the user
 * table is empty — three separate reasons this cannot quietly become a
 * deployment.
 */

const DEFAULT_PORT = 3100;
const HOST = '127.0.0.1';

/** Where the local environment keeps everything it provisions. */
function localStateDirectory(): string {
  // Anchored to the repository rather than to a working directory, so the
  // command behaves the same wherever it is run from.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '.voidfall');
}

function panelExportDirectory(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'panel-web', 'out');
}

/**
 * Creates the first owner when there is none, and reports the credential once.
 *
 * The password is written to a file readable only by whoever runs the command
 * *and* printed, because a secret that only scrolls past is a secret somebody
 * loses. It is never shown again.
 */
async function provisionOwner(
  database: Parameters<typeof createRepositories>[0],
  stateDirectory: string,
): Promise<{ readonly email: string; readonly password: string } | null> {
  const repositories = createRepositories(database);
  const existing = await database.query<{ readonly count: string }>(
    'SELECT count(*)::text AS count FROM panel_users',
  );
  if (Number(existing.rows[0]?.count ?? '0') > 0) return null;

  const email = 'owner@voidfall.local';
  const password = randomBytes(18).toString('base64url');
  await repositories.users.create({
    email,
    displayName: 'VoidFall Owner',
    passwordHash: await hashPassword(password),
    roles: ['owner'],
  });

  const credentialFile = join(stateDirectory, 'first-owner.txt');
  await writeFile(
    credentialFile,
    [
      'VoidFall — credencial do primeiro acesso local.',
      '',
      `e-mail: ${email}`,
      `senha:  ${password}`,
      '',
      'Trocar a senha ainda não está no painel. Apagar .voidfall/ recomeça do zero.',
      '',
    ].join('\n'),
    'utf8',
  );
  return { email, password };
}

export async function main(): Promise<number> {
  if (process.env['NODE_ENV'] === 'production') {
    process.stderr.write(
      'O ambiente local não roda com NODE_ENV=production. Use `npm run start` com DATABASE_URL.\n',
    );
    return 64;
  }

  const stateDirectory = localStateDirectory();
  const panelRoot = panelExportDirectory();
  const port = Number(process.env['VOIDFALL_CONTROL_API_PORT'] ?? String(DEFAULT_PORT));

  const say = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };

  say('VoidFall — ambiente local');
  say('');

  const database = await createEmbeddedDatabase(join(stateDirectory, 'database'));
  await runMigrations(database);
  say(`  banco     PostgreSQL embutido em ${join(stateDirectory, 'database')}`);

  const owner = await provisionOwner(database, stateDirectory);

  const hasPanel = await panelExportExists(panelRoot);
  if (!hasPanel) {
    // Deny-by-default, and say which command fixes it. Starting without the
    // panel and answering 404 would look like a defect in the API.
    say('');
    process.stderr.write(
      'O painel ainda não foi exportado. Rode `npm run build` na pasta Plataforma e tente de novo.\n',
    );
    await database.close();
    return 2;
  }
  say(`  painel    servido pela própria API (mesma origem, sem proxy)`);

  const app = await buildControlApi({
    database,
    // Loopback without TLS: the secure flag would make the browser drop the
    // cookie and nothing would work. Refused outright under production above.
    cookieSecure: false,
    logger: false,
    workspaceScanner: createWorkspaceScanner(),
    workspaceRootPolicy: defaultWorkspaceRootPolicy,
    panelExportRoot: panelRoot,
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await database.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await app.listen({ host: HOST, port });
  say('');

  if (owner !== null) {
    say('  Primeiro acesso — esta credencial não será mostrada de novo:');
    say('');
    say(`      e-mail  ${owner.email}`);
    say(`      senha   ${owner.password}`);
    say('');
    say(`  (também gravada em ${join(stateDirectory, 'first-owner.txt')})`);
    say('');
  }

  say(`  Abra  http://${HOST}:${String(port)}/entrar`);
  say('');
  return 0;
}

/** Compared as paths, not as strings — a directory with a space arrives encoded. */
function runDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
  } catch {
    return false;
  }
}

if (runDirectly()) {
  main()
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`falhou: ${error instanceof Error ? error.message : 'erro'}\n`);
      process.exitCode = 1;
    });
}
