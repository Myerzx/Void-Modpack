import { randomUUID } from 'node:crypto';

import { PostgresDatabase, createRepositories } from '@voidfall/database';

import { AgentRuntime } from './runtime.js';
import { AgentConfigurationError, loadAgentConfiguration } from './runtime-config.js';

/**
 * The agent entry point.
 *
 * It does as little as an entry point can: read the environment, validate it,
 * build the runtime, and hand it a signal. Every decision worth testing lives
 * in `AgentRuntime`, which takes its dependencies as arguments — so the tests
 * exercise the same assembly this file performs rather than a parallel one.
 *
 * Nothing here connects to a Minecraft process. The process controller and the
 * console adapter are deliberately not constructed: this slice brings the agent
 * up against a database, temporary directories and injected keys, and readiness
 * reports the capabilities that need a runtime as unavailable, with reasons.
 * Connecting the real runtime is a separate, explicitly authorized step.
 */

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

  // The database handle is the one dependency this file constructs, because it
  // is the one the runtime cannot be given without an entry point somewhere.
  const database = new PostgresDatabase(configuration.databaseUrl);

  const controller = new AbortController();
  const runtime = new AgentRuntime({
    configuration,
    repositories: createRepositories(database),
    bootId: randomUUID(),
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
