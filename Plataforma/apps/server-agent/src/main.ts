import { randomUUID } from 'node:crypto';

import { PostgresDatabase, createRepositories } from '@voidfall/database';

import { createAgentIdentity, type AgentFetch } from './agent-client.js';
import { AgentRuntime } from './runtime.js';
import { AgentConfigurationError, loadAgentConfiguration } from './runtime-config.js';
import { AgentWorkTransport } from './work-transport.js';

/**
 * The agent entry point.
 *
 * It does as little as an entry point can: read the environment, validate it,
 * build the runtime, and hand it a signal. Every decision worth testing lives
 * in `AgentRuntime`, which takes its dependencies as arguments — so the tests
 * exercise the same assembly this file performs rather than a parallel one.
 *
 * Nothing here connects to a Minecraft process. The process controller, the
 * console adapter and both offline guards are deliberately not constructed:
 * this slice brings the agent up against a database, temporary directories and
 * injected keys, and readiness reports the capabilities that need a runtime as
 * unavailable, with reasons. Connecting the real runtime is a separate,
 * explicitly authorized step.
 *
 * What this file *does* connect is the work loop. The transport and the signing
 * identity are built here and handed to the runtime, which claims work only for
 * capabilities it announced. With no guard and no controller that set is empty,
 * so the agent comes up, reconciles, collects metrics and reports that it is
 * claiming nothing — rather than claiming jobs it would have to refuse.
 */

/**
 * The platform `fetch`, narrowed to what the transport uses.
 *
 * Narrowed rather than passed whole: an outbound-only client needs to POST a
 * signed envelope and read a JSON answer, and a transport that could reach for
 * anything else on the response would be a transport that could grow a second
 * protocol without anyone deciding to add one.
 */
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

  const controller = new AbortController();
  const runtime = new AgentRuntime({
    configuration,
    repositories: createRepositories(database),
    bootId: randomUUID(),
    identity,
    workTransport,
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
