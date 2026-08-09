import type { AgentWorkLease } from '@voidfall/contracts';
import { ConfigurationPersistenceError, type Repositories } from '@voidfall/database';
import type { MinecraftConsoleAdapter } from '@voidfall/minecraft-process';

import type { LeaseHandlerResult } from './supervisor.js';

/**
 * The `console.command` capability.
 *
 * A console command is a reviewed literal with no arguments. The lease carries
 * only which server, so the command itself is read from the durable operation
 * the job belongs to — where the database constrains it to the catalogue. The
 * agent therefore never receives command text over the wire and never composes
 * any: it looks up a reviewed literal and dispatches it.
 *
 * The capability is separate from `process.control`, so console access is
 * granted on its own and never rides along with the authority to start or stop
 * a server.
 */

const LOCK_NAME = 'minecraft-exclusive';

export interface ConsoleCommandCapabilityOptions {
  readonly repositories: Repositories;
  readonly consoleAdapter: MinecraftConsoleAdapter;
  /** The server this agent is responsible for; a lease for another is refused. */
  readonly serverInstanceId: string;
  readonly agentId: string;
  readonly bootId: string;
  readonly lockSeconds?: number;
  readonly consoleRetainLines?: number;
  readonly clock?: () => Date;
}

const DEFAULT_LOCK_SECONDS = 120;
const DEFAULT_CONSOLE_RETAIN = 5_000;

export function createConsoleCommandHandler(
  options: ConsoleCommandCapabilityOptions,
): (lease: AgentWorkLease) => Promise<LeaseHandlerResult> {
  const clock = options.clock ?? (() => new Date());

  return async (lease: AgentWorkLease): Promise<LeaseHandlerResult> => {
    if (lease.jobType !== 'server.command') {
      return { outcome: 'failed', failureCode: 'unsupported-parameters' };
    }
    if (
      lease.parameters.resourceType !== 'server-instance' ||
      lease.parameters.resourceId !== options.serverInstanceId
    ) {
      return { outcome: 'failed', failureCode: 'unsupported-parameters' };
    }

    // The reviewed command comes from the operation, not from the wire.
    const operation = await options.repositories.operations.findByJobId(lease.jobId);
    if (operation === undefined || operation.consoleCommand === null) {
      return { outcome: 'failed', failureCode: 'unsupported-parameters' };
    }
    const command = operation.consoleCommand;

    const now = clock();
    // A command shares the same exclusive lock as start, stop and configuration,
    // so it cannot run against a server that is mid-restart.
    try {
      await options.repositories.operationalLocks.acquire({
        serverInstanceId: options.serverInstanceId,
        lockName: LOCK_NAME,
        ownerId: options.agentId,
        operation: 'server.command',
        acquiredAt: now.toISOString(),
        leaseExpiresAt: new Date(
          now.getTime() + (options.lockSeconds ?? DEFAULT_LOCK_SECONDS) * 1_000,
        ).toISOString(),
      });
    } catch (error) {
      if (error instanceof ConfigurationPersistenceError) {
        return { outcome: 'failed', failureCode: 'precondition-not-met' };
      }
      throw error;
    }

    try {
      // The adapter revalidates the literal against its own closed catalogue
      // and refuses anything the server is not online to receive.
      await options.consoleAdapter.requestConsoleCommand(command);
      const observation = await options.consoleAdapter.inspect();

      await captureConsole(options, now);

      return {
        outcome: 'succeeded',
        observedLifecycle: observation.state,
        ...(observation.pid === undefined || observation.state !== 'online'
          ? {}
          : { observedPid: observation.pid }),
      };
    } catch {
      // A refused command is a closed failure; the receipt never carries the
      // adapter's message or anything about the host.
      return { outcome: 'failed', failureCode: 'precondition-not-met' };
    } finally {
      await options.repositories.operationalLocks
        .release({
          serverInstanceId: options.serverInstanceId,
          lockName: LOCK_NAME,
          ownerId: options.agentId,
        })
        .catch(() => undefined);
    }
  };
}

/**
 * Stores whatever the command produced. Losing console output must never turn
 * a dispatched command into a reported failure.
 */
async function captureConsole(
  options: ConsoleCommandCapabilityOptions,
  now: Date,
): Promise<void> {
  try {
    if (
      options.consoleAdapter.readConsoleDelta !== undefined &&
      options.consoleAdapter.acknowledgeConsoleDelta !== undefined
    ) {
      // Continuous capture persists this adapter independently of commands.
      // Snapshot capture remains only for older/scripted adapters.
      return;
    }
    const snapshot = options.consoleAdapter.readConsole();
    const lines = [
      ...snapshot.stdout.lines.map((line) => ({
        stream: 'stdout' as const,
        text: line.text,
        occurredAt: now,
      })),
      ...snapshot.stderr.lines.map((line) => ({
        stream: 'stderr' as const,
        text: line.text,
        occurredAt: now,
      })),
    ];
    if (lines.length === 0) return;
    await options.repositories.console.append({
      serverInstanceId: options.serverInstanceId,
      lines,
      bootId: options.bootId,
      retainLines: options.consoleRetainLines ?? DEFAULT_CONSOLE_RETAIN,
      now,
    });
  } catch {
    // Deliberately swallowed: see the comment above.
  }
}
