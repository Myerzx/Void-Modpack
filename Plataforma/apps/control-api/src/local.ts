import { randomBytes, randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword } from '@voidfall/authentication';
import { createEmbeddedDatabase, createRepositories, runMigrations } from '@voidfall/database';
import { discoverJavaRuntime } from '@voidfall/sandbox-runner';
import { AgentRuntime, AgentWorkTransport, createAgentIdentity } from '@voidfall/server-agent';

import { buildControlApi } from './app.js';
import { panelExportExists } from './static-panel.js';
import { createWorkspaceConfigurationService } from './workspace-configuration.js';
import {
  buildLocalProcessRuntime,
  provisionLocalAgentIdentity,
  provisionLocalInstance,
  registerLocalAgent,
} from './local-agent.js';
import { detectServerRuntimeAt } from './server-runtime.js';
import { createReleaseBuilder } from './workspace-release.js';
import { createSandboxLauncher } from './workspace-sandbox.js';
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
const LOCAL_OWNER_EMAIL = 'owner@voidfall.local';
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

  const email = LOCAL_OWNER_EMAIL;
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

/**
 * Finds a port that is actually free, starting from the preferred one.
 *
 * A busy port used to end the command in an npm error dump about `EADDRINUSE`,
 * which is a stack trace answering a question nobody asked. The common cause
 * is the previous run still holding it, and the useful behaviour is to say so
 * and move over rather than to make the operator hunt a process id.
 */
async function freePortFrom(preferred: number): Promise<{ port: number; moved: boolean }> {
  for (let candidate = preferred; candidate < preferred + 10; candidate += 1) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', () => {
        resolve(false);
      });
      probe.once('listening', () => {
        probe.close(() => {
          resolve(true);
        });
      });
      probe.listen(candidate, HOST);
    });
    if (free) return { port: candidate, moved: candidate !== preferred };
  }
  return { port: preferred, moved: false };
}

export async function main(argv: readonly string[] = []): Promise<number> {
  if (process.env['NODE_ENV'] === 'production') {
    process.stderr.write(
      'O ambiente local não roda com NODE_ENV=production. Use `npm run start` com DATABASE_URL.\n',
    );
    return 64;
  }

  const stateDirectory = localStateDirectory();
  const panelRoot = panelExportDirectory();

  const say = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };

  say('VoidFall — ambiente local');
  say('');

  if (argv.includes('--reset')) {
    // The directory is the whole database plus everything staged. Deleting it
    // is the reset, and saying so is better than a command that half-clears
    // some of it.
    await rm(stateDirectory, { recursive: true, force: true });
    say('  reset     estado local apagado');
  }

  const database = await createEmbeddedDatabase(join(stateDirectory, 'database'));
  const applied = await runMigrations(database);
  say(`  banco     PostgreSQL embutido · ${String(applied.length)} migração(ões) aplicada(s)`);
  say(`            ${join(stateDirectory, 'database')}`);

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
    logger: process.env['VOIDFALL_LOCAL_VERBOSE'] === 'true',
    /**
     * The agent runs in this process and dials loopback without TLS, so there
     * is no peer certificate to fingerprint. Accepting loopback is the local
     * concession, made once and in the open — the default verifier requires an
     * authorized TLS socket and is what production keeps.
     *
     * This is the only reason it is safe: the listener is bound to 127.0.0.1
     * and the environment refuses to run under `NODE_ENV=production`.
     */
    agentTransportVerifier: (request) =>
      request.ip === '127.0.0.1' || request.ip === '::1' || request.ip === '::ffff:127.0.0.1',
    workspaceScanner: createWorkspaceScanner(),
    workspaceRootPolicy: defaultWorkspaceRootPolicy,
    // Staging lives beside the database, one directory per workspace, and is
    // provisioned rather than configured. Nothing is ever written into the
    // workspace itself.
    workspaceConfiguration: createWorkspaceConfigurationService(join(stateDirectory, 'staging')),
    // A boot composes a disposable copy from the minimum files and deletes it
    // afterwards. The original world is never copied and never touched, which
    // is the only reason pointing this at a real server is acceptable.
    sandboxLauncher: createSandboxLauncher(),
    // Archives land beside the database and the staging area, one directory
    // per workspace. The panel downloads by id; the path never leaves here.
    releaseBuilder: createReleaseBuilder(join(stateDirectory, 'releases')),
    // How a server starts is read from the server, never typed.
    serverRuntimeDetector: detectServerRuntimeAt,
    panelExportRoot: panelRoot,
    // Authentication is deferred, not removed: the session, the cookie, the
    // CSRF token and every permission check are the ones the real login
    // produces. What is missing is the step where somebody proves they are the
    // person sitting at their own machine, on loopback, alone.
    localOperatorEmail: LOCAL_OWNER_EMAIL,
    panelEntryPath: '/workspaces',
  });

  const shutdown = async (): Promise<void> => {
    agentAbort.abort();
    await app.close();
    await database.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  const preferred = Number(process.env['VOIDFALL_CONTROL_API_PORT'] ?? String(DEFAULT_PORT));
  const { port, moved } = await freePortFrom(preferred);
  if (moved) {
    say(`  porta     ${String(preferred)} ocupada — usando ${String(port)}`);
  }

  await app.listen({ host: HOST, port });

  // --- The agent, in this same process ---------------------------------
  //
  // Measured before it was decided: two separate processes opened and wrote
  // the same PGlite directory with no refusal of any kind, and the absence of
  // a refusal is the danger rather than the permission. Sharing the process is
  // not a shortcut — the authority over the Minecraft process stays in the
  // agent, reached by a durable operation it claims over loopback HTTP.
  const baseUrl = `http://${HOST}:${String(port)}`;
  const agentIdentity = await provisionLocalAgentIdentity(stateDirectory);
  const instance = await provisionLocalInstance(database);
  await registerLocalAgent({
    database,
    identity: agentIdentity,
    serverInstanceId: instance.id,
    baseUrl,
    softwareVersion: '0.1.0',
  });

  const java = await discoverJavaRuntime().catch(() => null);
  const processRuntime =
    java === null ? null : buildLocalProcessRuntime(instance, java.executable);

  const agentAbort = new AbortController();
  const agent = new AgentRuntime({
    configuration: {
      agentId: agentIdentity.agentId,
      serverInstanceId: instance.id,
      controlApiUrl: baseUrl,
      privateKeyPem: agentIdentity.privateKeyPem,
      databaseUrl: 'embedded',
      serverRelease: '0.1.0',
      // Disk metrics need a path somebody chose to watch. Absent means the
      // agent reports none rather than guessing a volume.
      metricsDiskPath: null,
      authorizedFiles: null,
      backups: null,
      process: null,
      schedulerEnabled: false,
    },
    repositories: createRepositories(database),
    bootId: randomUUID(),
    identity: createAgentIdentity({
      agentId: agentIdentity.agentId,
      serverInstanceId: instance.id,
      privateKeyPem: agentIdentity.privateKeyPem,
    }),
    workTransport: new AgentWorkTransport({
      baseUrl,
      fetch: async (url, init) => {
        const response = await fetch(url, {
          method: init.method,
          headers: { ...init.headers },
          body: init.body,
        });
        return { ok: response.ok, status: response.status, json: () => response.json() };
      },
      // Loopback without TLS, decided once here rather than waved through.
      allowInsecureDevelopment: true,
    }),
    ...(processRuntime === null
      ? {}
      : {
          processController: processRuntime.controller,
          consoleAdapter: processRuntime.adapter,
          processAdapter: processRuntime.adapter,
        }),
    // Surfaced rather than swallowed. An agent that quietly never claims work
    // looks exactly like one whose control plane went away, and only one of
    // those is something an operator can fix.
    onEvent: (event) => {
      if (event.kind === 'ready') {
        say(`  agente    anuncia: ${event.announced.join(', ')}`);
      } else if (event.kind === 'work-loop-skipped') {
        say(`  agente    não vai reivindicar trabalho: ${event.reason}`);
      } else if (event.kind === 'supervisor') {
        say(`  agente    ${JSON.stringify(event.event)}`);
        if (event.event.kind === 'unauthorized') say(`  agente    HTTP ${String(event.event.status)}`);
      }
    },
  });
  void agent.start(agentAbort.signal);

  if (processRuntime === null) {
    // An ordinary state, and the one readiness already models. Announcing a
    // capability nothing can serve would be the other option.
    say(
      instance.runDirectory === null
        ? '  agente    no ar · nenhuma instância aponta para um diretório ainda'
        : '  agente    no ar · sem Java encontrável neste host',
    );
  } else {
    say(`  agente    no ar · ${processRuntime.family} · pode iniciar e parar o servidor`);
  }

  say('  sessão    operador local entra sem senha (só em loopback)');
  say('');
  if (owner !== null) {
    // Still written, because the login screen exists and will be the way in
    // the day this is something other people run.
    say(`  Credencial guardada em ${join(stateDirectory, 'first-owner.txt')}`);
    say('');
  }
  say(`  Abra  http://${HOST}:${String(port)}/`);
  say('');
  say('  Ctrl+C encerra. `npm run panel -- --reset` recomeça do zero.');
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
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`falhou: ${error instanceof Error ? error.message : 'erro'}\n`);
      process.exitCode = 1;
    });
}
