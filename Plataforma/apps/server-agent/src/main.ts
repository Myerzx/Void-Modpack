import { randomUUID } from 'node:crypto';

import { PostgresDatabase, createRepositories } from '@voidfall/database';
import {
  LinuxMinecraftProcessAdapter,
  MinecraftProcessController,
  NodeProcessRuntime,
  WindowsMinecraftProcessAdapter,
  createMinecraftProcessPlan,
  type SupportedHostPlatform,
} from '@voidfall/minecraft-process';

import { createAgentIdentity, type AgentFetch } from './agent-client.js';
import { AgentRuntime } from './runtime.js';
import {
  AgentConfigurationError,
  loadAgentConfiguration,
  type ProcessConfiguration,
} from './runtime-config.js';
import { AgentWorkTransport } from './work-transport.js';

/**
 * The agent entry point.
 *
 * It does as little as an entry point can: read the environment, validate it,
 * build the runtime, and hand it a signal. Every decision worth testing lives
 * in `AgentRuntime`, which takes its dependencies as arguments — so the tests
 * exercise the same assembly this file performs rather than a parallel one.
 *
 * This file connects three things the runtime cannot build for itself: the
 * database handle, the outbound work transport with its signing identity, and
 * the Minecraft process runtime.
 *
 * The process runtime is built only when the deployment configured one. A host
 * that holds backups and configuration for a server it does not launch is a
 * valid deployment, not a broken one — and readiness reports which of the two
 * this is, with a reason per capability, rather than announcing everything and
 * failing later.
 *
 * What is still deliberately absent: `process.force-kill` has no handler, by a
 * decision recorded in the phase notes. Killing a server can lose everything
 * since the last save.
 */

/**
 * The platform `fetch`, narrowed to what the transport uses.
 *
 * Narrowed rather than passed whole: an outbound-only client needs to POST a
 * signed envelope and read a JSON answer, and a transport that could reach for
 * anything else on the response would be a transport that could grow a second
 * protocol without anyone deciding to add one.
 */
/**
 * Builds the adapter and controller that hold this host's server process.
 *
 * Returns nothing when the deployment did not configure one, which is an
 * ordinary state: a host that runs backups and configuration for a server it
 * does not launch is a valid deployment, and readiness reports the difference.
 *
 * A launch plan that will not build refuses the startup rather than disabling
 * the capability quietly. The configuration loader has already checked the
 * shape of every value; anything the plan still rejects is a combination an
 * operator has to see, not one to come up without.
 */
function buildProcessRuntime(configuration: ProcessConfiguration | null): {
  readonly adapter: WindowsMinecraftProcessAdapter | LinuxMinecraftProcessAdapter;
  readonly controller: MinecraftProcessController;
} | null {
  if (configuration === null) return null;
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    // The supported set is closed on purpose. Spawning a JVM through an
    // untested platform's process semantics is not something to improvise on
    // the host that holds the world.
    throw new Error(`voidfall-agent: unsupported host platform ${process.platform}`);
  }
  const platform: SupportedHostPlatform = process.platform;
  const launchPlan = createMinecraftProcessPlan({ platform, ...configuration });
  const runtime = new NodeProcessRuntime();
  // One adapter serves as process, console and metrics adapter. It is the
  // thing that owns the child handle, and two of them would each believe they
  // did.
  const adapter =
    platform === 'win32'
      ? new WindowsMinecraftProcessAdapter({ runtime })
      : new LinuxMinecraftProcessAdapter({ runtime });
  return { adapter, controller: new MinecraftProcessController({ adapter, launchPlan }) };
}

const agentFetch: AgentFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: { ...init.headers },
    body: init.body,
  });
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
  };
};

function reportConfigurationError(error: AgentConfigurationError): void {
  // Keys and codes only. A startup log is the last place a private key or a
  // repository path should appear, and an operator does not need either to fix
  // the fault — they need to know which variable is wrong and how.
  process.stderr.write('voidfall-agent: configuration refused\n');
  for (const issue of error.issues) {
    process.stderr.write(`  ${issue.key}: ${issue.code}\n`);
  }
}

export async function main(): Promise<number> {
  let configuration;
  try {
    configuration = loadAgentConfiguration(process.env);
  } catch (error) {
    if (!(error instanceof AgentConfigurationError)) throw error;
    reportConfigurationError(error);
    // Refusing to start is the point. An agent that came up with a capability
    // silently missing would fail on the day it was needed instead of now.
    return 78;
  }

  // The database handle and the transport are the dependencies this file
  // constructs, because they are the ones the runtime cannot be given without
  // an entry point somewhere.
  const database = new PostgresDatabase(configuration.databaseUrl);
  const identity = createAgentIdentity({
    agentId: configuration.agentId,
    serverInstanceId: configuration.serverInstanceId,
    privateKeyPem: configuration.privateKeyPem,
  });
  const workTransport = new AgentWorkTransport({
    baseUrl: configuration.controlApiUrl,
    fetch: agentFetch,
    // The configuration loader already refused anything that is neither HTTPS
    // nor loopback, so a loopback development URL reaches here having been
    // decided on once rather than waved through twice.
    allowInsecureDevelopment: true,
  });

  const minecraft = buildProcessRuntime(configuration.process);

  const controller = new AbortController();
  const runtime = new AgentRuntime({
    configuration,
    repositories: createRepositories(database),
    bootId: randomUUID(),
    identity,
    workTransport,
    ...(minecraft === null
      ? {}
      : {
          processController: minecraft.controller,
          consoleAdapter: minecraft.adapter,
          processAdapter: minecraft.adapter,
        }),
    onEvent: (event) => {
      process.stdout.write(`voidfall-agent: ${JSON.stringify(event)}\n`);
    },
  });

  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  process.stdout.write(
    `voidfall-agent: readiness ${JSON.stringify(runtime.readiness.capabilities)}\n`,
  );

  try {
    await runtime.start(controller.signal);
  } finally {
    // Closing the database last: the runtime's shutdown settles held runs, and
    // it needs the connection to do it.
    await database.close();
  }
  return 0;
}

// Only when run directly, so importing this module in a test does not start an
// agent as a side effect.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/gu, '/'))) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`voidfall-agent: fatal ${error instanceof Error ? error.name : 'error'}\n`);
      process.exitCode = 1;
    });
}
