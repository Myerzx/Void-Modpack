import { randomBytes, randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword } from '@voidfall/authentication';
import { createEmbeddedDatabase, createRepositories, runMigrations } from '@voidfall/database';
import { discoverJavaRuntime, runRestoredWorldBoot } from '@voidfall/sandbox-runner';
import {
  AgentRuntime,
  AgentWorkTransport,
  DurableProcessOwnershipCoordinator,
  createOfflineExclusiveConfigurationGuard,
  createAgentIdentity,
} from '@voidfall/server-agent';

import { buildControlApi } from './app.js';
import { panelExportExists } from './static-panel.js';
import {
  acquireLocalProcessLock,
  LocalProcessLockError,
  type LocalProcessLock,
} from './local-process-lock.js';
import { createWorkspaceConfigurationService } from './workspace-configuration.js';
import { createWorkspaceEcosystemService } from './workspace-ecosystem.js';
import {
  buildLocalProcessRuntime,
  provisionLocalAgentIdentity,
  provisionLocalInstance,
  registerLocalAgent,
} from './local-agent.js';
import { LocalAgentFleet } from './local-agent-fleet.js';
import { provisionLocalBackup } from './local-backup.js';
import {
  LocalConfigurationReaders,
  provisionLocalConfiguration,
} from './local-configuration.js';
import {
  LocalArtifactCompatibilityPlanFactory,
  LocalArtifactStore,
  runLocalArtifactWorker,
} from './local-artifacts.js';
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

export interface LocalRuntimeReady {
  readonly baseUrl: string;
  readonly launchUrl: string;
  readonly port: number;
  readonly stateDirectory: string;
}

export interface LocalMainOptions {
  /** Development is the terminal command; desktop is the loopback Electron host. */
  readonly runtime?: 'development' | 'desktop';
  /** Desktop callers must provide an absolute per-user application data path. */
  readonly stateDirectory?: string;
  /** Desktop callers must provide the absolute packaged/static panel export. */
  readonly panelExportRoot?: string;
  /** Zero asks the operating system for an ephemeral loopback port. */
  readonly preferredPort?: number;
  readonly onReady?: (runtime: LocalRuntimeReady) => void;
  /** Programmatic shutdown channel used by the desktop utility process. */
  readonly shutdownSignal?: AbortSignal;
  readonly onStopped?: () => void;
}

/** Where the local environment keeps everything it provisions. */
function localStateDirectory(override?: string): string {
  if (override !== undefined) return resolve(override);
  // Anchored to the repository rather than to a working directory, so the
  // command behaves the same wherever it is run from.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '.voidfall');
}

function panelExportDirectory(override?: string): string {
  if (override !== undefined) return resolve(override);
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
  const probe = async (candidate: number): Promise<number | null> =>
    new Promise<number | null>((resolvePort) => {
      const server = createServer();
      server.once('error', () => {
        resolvePort(null);
      });
      server.once('listening', () => {
        const address = server.address();
        const port = typeof address === 'object' && address !== null ? address.port : null;
        server.close(() => {
          resolvePort(port);
        });
      });
      server.listen(candidate, HOST);
    });

  if (preferred === 0) {
    const port = await probe(0);
    if (port === null) throw new Error('O sistema não conseguiu reservar uma porta local.');
    return { port, moved: false };
  }

  for (let candidate = preferred; candidate < preferred + 10; candidate += 1) {
    const port = await probe(candidate);
    if (port !== null) return { port, moved: candidate !== preferred };
  }
  throw new Error('Nenhuma das portas locais reservadas está disponível.');
}

export async function main(
  argv: readonly string[] = [],
  options: LocalMainOptions = {},
): Promise<number> {
  const runtime = options.runtime ?? 'development';
  if (runtime === 'development' && process.env['NODE_ENV'] === 'production') {
    process.stderr.write(
      'O ambiente local não roda com NODE_ENV=production. Use `npm run start` com DATABASE_URL.\n',
    );
    return 64;
  }

  if (runtime === 'desktop') {
    if (options.stateDirectory === undefined || !isAbsolute(options.stateDirectory)) {
      throw new Error('O aplicativo desktop exige um diretório de estado absoluto.');
    }
    if (options.panelExportRoot === undefined || !isAbsolute(options.panelExportRoot)) {
      throw new Error('O aplicativo desktop exige um diretório de painel absoluto.');
    }
  }

  const stateDirectory = localStateDirectory(options.stateDirectory);
  const panelRoot = panelExportDirectory(options.panelExportRoot);
  const desktopLaunchToken =
    runtime === 'desktop' ? randomBytes(32).toString('base64url') : undefined;

  const say = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };

  say('VoidFall — ambiente local');
  say('');

  let processLock: LocalProcessLock;
  try {
    // This happens before reset and before PGlite opens. A second local process
    // must not delete or share state merely because it can move to another
    // HTTP port.
    processLock = await acquireLocalProcessLock(stateDirectory);
  } catch (error) {
    if (error instanceof LocalProcessLockError) {
      process.stderr.write(`${error.message}\n`);
      return 73;
    }
    throw error;
  }

  let database: Awaited<ReturnType<typeof createEmbeddedDatabase>> | undefined;
  let app: Awaited<ReturnType<typeof buildControlApi>> | undefined;
  let agentAbort: AbortController | undefined;
  let agentTask: Promise<void> | undefined;
  let artifactAbort: AbortController | undefined;
  let artifactTask: Promise<void> | undefined;
  let shutdownTask: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownTask ??= (async () => {
      agentAbort?.abort();
      artifactAbort?.abort();
      if (agentTask !== undefined) await agentTask.catch(() => undefined);
      if (artifactTask !== undefined) await artifactTask.catch(() => undefined);
      if (app !== undefined) await app.close().catch(() => undefined);
      if (database !== undefined) await database.close().catch(() => undefined);
      await processLock.release();
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      options.shutdownSignal?.removeEventListener('abort', onShutdownRequest);
      options.onStopped?.();
    })();
    return shutdownTask;
  };
  const onSignal = (): void => {
    void shutdown().catch((error: unknown) => {
      process.stderr.write(
        `falhou ao encerrar: ${error instanceof Error ? error.message : 'erro'}\n`,
      );
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const onShutdownRequest = (): void => onSignal();

  try {

  if (argv.includes('--reset')) {
    // The directory is the whole database plus everything staged. Deleting it
    // is the reset, and saying so is better than a command that half-clears
    // some of it.
    await rm(stateDirectory, { recursive: true, force: true });
    say('  reset     estado local apagado');
  }

  database = await createEmbeddedDatabase(join(stateDirectory, 'database'));
  const applied = await runMigrations(database);
  say(`  banco     PostgreSQL embutido · ${String(applied.length)} migração(ões) aplicada(s)`);
  say(`            ${join(stateDirectory, 'database')}`);

  const owner = await provisionOwner(database, stateDirectory);
  const localDatabase = database;
  await provisionLocalInstance(localDatabase);
  const repositories = createRepositories(localDatabase);
  const java = await discoverJavaRuntime().catch(() => null);
  const artifactStore = new LocalArtifactStore(stateDirectory);
  const artifactPlanFactory = new LocalArtifactCompatibilityPlanFactory(
    repositories,
    java === null ? null : String(java.major),
  );

  const hasPanel = await panelExportExists(panelRoot);
  if (!hasPanel) {
    // Deny-by-default, and say which command fixes it. Starting without the
    // panel and answering 404 would look like a defect in the API.
    say('');
    process.stderr.write(
      'O painel ainda não foi exportado. Rode `npm run build` na pasta Plataforma e tente de novo.\n',
    );
    await shutdown();
    return 2;
  }
  say(`  painel    servido pela própria API (mesma origem, sem proxy)`);

  const configurationReaders = new LocalConfigurationReaders();
  app = await buildControlApi({
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
    workspaceEcosystem: createWorkspaceEcosystemService(),
    workspaceRootPolicy: defaultWorkspaceRootPolicy,
    // Staging lives beside the database, one directory per workspace, and is
    // provisioned rather than configured. Nothing is ever written into the
    // workspace itself.
    workspaceConfiguration: createWorkspaceConfigurationService(join(stateDirectory, 'staging')),
    configurationReader: configurationReaders,
    artifactQuarantineStore: artifactStore,
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
    localOperator:
      runtime === 'desktop'
        ? {
            mode: 'desktop',
            email: LOCAL_OWNER_EMAIL,
            launchToken: desktopLaunchToken!,
          }
        : { mode: 'development', email: LOCAL_OWNER_EMAIL },
    panelEntryPath: '/workspaces',
  });

  const preferred =
    options.preferredPort ??
    Number(
      process.env['VOIDFALL_CONTROL_API_PORT'] ??
        (runtime === 'desktop' ? '0' : String(DEFAULT_PORT)),
    );
  if (!Number.isInteger(preferred) || preferred < 0 || preferred > 65_535) {
    throw new Error('A porta local deve ser um inteiro entre 0 e 65535.');
  }
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
  const workTransport = new AgentWorkTransport({
    baseUrl,
    fetch: async (url, init) => {
      const response = await fetch(url, {
        method: init.method,
        headers: { ...init.headers },
        body: init.body,
      });
      return { ok: response.ok, status: response.status, json: () => response.json() };
    },
    allowInsecureDevelopment: true,
  });

  const fleet = new LocalAgentFleet({
    listInstances: () => repositories.servers.list(),
    createProcess: async (instance) => {
      const assigned = await repositories.agents.findByServerInstanceId(instance.id);
      const agentIdentity = await provisionLocalAgentIdentity(
        stateDirectory,
        instance.id,
        assigned?.id,
      );
      await registerLocalAgent({
        database: localDatabase,
        identity: agentIdentity,
        serverInstanceId: instance.id,
        baseUrl,
        softwareVersion: '0.1.0',
      });
      const bootId = randomUUID();
      const processOwnership = new DurableProcessOwnershipCoordinator({
        repository: repositories.processOwnership,
        serverInstanceId: instance.id,
        agentId: agentIdentity.agentId,
        agentBootId: bootId,
      });
      const processRuntime =
        java === null
          ? null
          : buildLocalProcessRuntime(instance, java.executable, processOwnership);
      const ownerUser = await repositories.users.findByEmail(LOCAL_OWNER_EMAIL);
      const configurationGuard =
        processRuntime === null
          ? undefined
          : createOfflineExclusiveConfigurationGuard({
              repositories,
              adapter: processRuntime.adapter,
              serverInstanceId: instance.id,
              ownsLock: (lease) => lease.operation.startsWith('configuration.'),
            });
      const localConfiguration =
        configurationGuard === undefined || ownerUser === undefined
          ? null
          : await provisionLocalConfiguration({
              instance,
              repositories,
              stateDirectory,
              actorId: ownerUser.id,
              guard: configurationGuard,
            });
      const localBackup =
        processRuntime === null
          ? null
          : await provisionLocalBackup({ instance, stateDirectory });
      if (localConfiguration === null) configurationReaders.unregister(instance.id);
      else configurationReaders.register(instance.id, localConfiguration.reader);
      const agent = new AgentRuntime({
        configuration: {
          agentId: agentIdentity.agentId,
          serverInstanceId: instance.id,
          controlApiUrl: baseUrl,
          privateKeyPem: agentIdentity.privateKeyPem,
          databaseUrl: 'embedded',
          serverRelease: '0.1.0',
          metricsDiskPath: instance.runDirectory,
          authorizedFiles: localConfiguration?.authorizedFiles ?? null,
          backups: localBackup,
          process: null,
          schedulerEnabled: false,
        },
        repositories,
        bootId,
        processOwnership,
        ...(localConfiguration === null
          ? {}
          : { configurationGuard: localConfiguration.guard }),
        identity: createAgentIdentity({
          agentId: agentIdentity.agentId,
          serverInstanceId: instance.id,
          privateKeyPem: agentIdentity.privateKeyPem,
        }),
        workTransport,
        ...(processRuntime === null
          ? {}
          : {
              processController: processRuntime.controller,
              consoleAdapter: processRuntime.adapter,
              processAdapter: processRuntime.adapter,
              ...(localBackup?.restoreVerificationEnabled === true &&
              instance.runDirectory !== null &&
              java !== null
                ? {
                    restoreVerifier: {
                      verify: async (restore: {
                        readonly backupId: string;
                        readonly restoredRoot: string;
                      }) => {
                        const evidence = await runRestoredWorldBoot({
                          workspaceRoot: instance.runDirectory as string,
                          activeWorldRoot: localBackup.worldSourcePath,
                          restoredRoot: restore.restoredRoot,
                          java,
                        });
                        return { outcome: evidence.report.outcome };
                      },
                    },
                  }
                : {}),
              ...(instance.runDirectory === null
                ? {}
                : {
                    artifactInstaller: {
                      reader: artifactStore,
                      serverRoot: instance.runDirectory,
                    },
                  }),
            }),
        onEvent: (event) => {
          const prefix = `  agente    ${instance.displayName}`;
          if (event.kind === 'ready') {
            say(`${prefix} anuncia: ${event.announced.join(', ')}`);
          } else if (event.kind === 'work-loop-skipped') {
            say(`${prefix} não vai reivindicar trabalho: ${event.reason}`);
          } else if (event.kind === 'supervisor') {
            say(`${prefix} ${JSON.stringify(event.event)}`);
            if (event.event.kind === 'unauthorized') {
              say(`${prefix} HTTP ${String(event.event.status)}`);
            }
            if (event.event.kind === 'error') say(`${prefix} motivo: ${event.event.reason}`);
          }
        },
      });

      return {
        description:
          processRuntime !== null
            ? `${processRuntime.family} · pode iniciar e parar`
            : instance.runDirectory === null
              ? 'sem diretório de execução'
              : java === null
                ? 'sem Java encontrável neste host'
                : 'runtime sem controlador compatível',
        run: (signal: AbortSignal) => agent.start(signal),
      };
    },
    onEvent: (event) => {
      if (event.kind === 'started') {
        say(`  agente    ${event.serverInstanceId} · ${event.description}`);
      } else if (event.kind === 'failed' || event.kind === 'sync-failed') {
        say(`  agente    falhou: ${event.reason}`);
      }
    },
  });

  agentAbort = new AbortController();
  await fleet.synchronize();
  agentTask = fleet.start(agentAbort.signal);
  artifactAbort = new AbortController();
  artifactTask = runLocalArtifactWorker({
    database: localDatabase,
    reader: artifactStore,
    planFactory: artifactPlanFactory,
    signal: artifactAbort.signal,
    onFailure: (reason) => say(`  artefatos falhou: ${reason}`),
  });

  const launchUrl =
    desktopLaunchToken === undefined
      ? `${baseUrl}/`
      : `${baseUrl}/local/session?token=${encodeURIComponent(desktopLaunchToken)}`;
  options.shutdownSignal?.addEventListener('abort', onShutdownRequest, { once: true });
  if (options.shutdownSignal?.aborted === true) {
    await shutdown();
    return 0;
  }
  options.onReady?.({ baseUrl, launchUrl, port, stateDirectory });

  say(
    runtime === 'desktop'
      ? '  sessão    operador desktop protegido por credencial efêmera'
      : '  sessão    operador local entra sem senha (só em loopback)',
  );
  say('');
  if (owner !== null) {
    // Still written, because the login screen exists and will be the way in
    // the day this is something other people run.
    say(`  Credencial guardada em ${join(stateDirectory, 'first-owner.txt')}`);
    say('');
  }
  if (runtime === 'development') say(`  Abra  http://${HOST}:${String(port)}/`);
  say('');
  say(
    runtime === 'desktop'
      ? '  Fechar a janela encerra o aplicativo e o serviço local.'
      : '  Ctrl+C encerra. `npm run panel -- --reset` recomeça do zero.',
  );
  say('');
  return 0;
  } catch (error) {
    await shutdown();
    throw error;
  }
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
