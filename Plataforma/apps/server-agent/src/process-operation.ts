import { randomUUID } from 'node:crypto';

import type { AgentWorkLease } from '@voidfall/contracts';
import { ConfigurationPersistenceError, type Repositories } from '@voidfall/database';
import type {
  MinecraftConsoleAdapter,
  MinecraftProcessController,
  ProcessControlAction,
  ProcessControlResult,
} from '@voidfall/minecraft-process';

import type { LeaseHandlerResult } from './supervisor.js';

/**
 * The `process.control` capability.
 *
 * It runs a reviewed lifecycle action against the existing process controller
 * while holding the durable `minecraft-exclusive` lock — the same lock the
 * configuration operations take, so a start can never race a configuration
 * apply or a backup on one server.
 *
 * Nothing here resolves a launch plan, an executable or a working directory
 * from the lease: those come from trusted local configuration, and the lease
 * carries only which server and which action.
 *
 * Force kill is deliberately not handled here. It is a separate capability
 * with its own grant, so holding ordinary control never implies the authority
 * to kill a running server.
 */

const LOCK_NAME = 'minecraft-exclusive';

const ACTION_BY_JOB_TYPE: Readonly<Record<string, ProcessControlAction>> = Object.freeze({
  'server.start': 'start',
  'server.stop': 'stop',
  'server.restart': 'restart',
});

export interface ProcessControlCapabilityOptions {
  readonly repositories: Repositories;
  readonly controller: MinecraftProcessController;
  /**
   * Reads whatever the process wrote. Optional: losing console output must
   * never turn a successful start into a reported failure.
   */
  readonly consoleAdapter?: MinecraftConsoleAdapter;
  /** The server this agent is responsible for; a lease for another is refused. */
  readonly serverInstanceId: string;
  readonly agentId: string;
  readonly bootId: string;
  readonly leaseSeconds?: number;
  readonly clock?: () => Date;
  /** Retention bound for console lines captured during the operation. */
  readonly consoleRetainLines?: number;
}

const DEFAULT_LOCK_SECONDS = 600;
const DEFAULT_CONSOLE_RETAIN = 5_000;

function lifecycleFor(
  result: ProcessControlResult,
): NonNullable<LeaseHandlerResult['observedLifecycle']> {
  if (result.failureCode === 'ownership-conflict') return 'unknown';
  return result.observation?.state ?? 'unknown';
}

function failureCodeFor(
  result: ProcessControlResult,
): NonNullable<LeaseHandlerResult['failureCode']> {
  if (result.outcome === 'rejected') return 'state-conflict';
  if (result.outcome === 'timed-out') return 'precondition-not-met';
  if (result.failureCode === 'ownership-conflict') return 'precondition-not-met';
  return 'operation-failed';
}

/**
 * Builds the lease handler for `process.control`.
 *
 * A lease naming another server, or a job type this capability does not serve,
 * is refused rather than interpreted — the capability never improvises what it
 * was asked to do.
 */
export function createProcessControlHandler(
  options: ProcessControlCapabilityOptions,
): (lease: AgentWorkLease) => Promise<LeaseHandlerResult> {
  const clock = options.clock ?? (() => new Date());

  return async (lease: AgentWorkLease): Promise<LeaseHandlerResult> => {
    const action = ACTION_BY_JOB_TYPE[lease.jobType];
    if (action === undefined) {
      return { outcome: 'failed', failureCode: 'unsupported-parameters' };
    }
    if (
      lease.parameters.resourceType !== 'server-instance' ||
      lease.parameters.resourceId !== options.serverInstanceId
    ) {
      // A lease for a server this agent does not own is refused outright.
      return { outcome: 'failed', failureCode: 'unsupported-parameters' };
    }

    const now = clock();
    const leaseSeconds = options.leaseSeconds ?? DEFAULT_LOCK_SECONDS;

    // The durable lock is shared with configuration and backup, so an
    // operation on one server excludes the others rather than only excluding
    // another process action.
    try {
      await options.repositories.operationalLocks.acquire({
        serverInstanceId: options.serverInstanceId,
        lockName: LOCK_NAME,
        ownerId: options.agentId,
        operation: lease.jobType,
        acquiredAt: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1_000).toISOString(),
      });
    } catch (error) {
      if (error instanceof ConfigurationPersistenceError) {
        return { outcome: 'failed', failureCode: 'precondition-not-met' };
      }
      throw error;
    }

    try {
      const result = await options.controller.execute({
        idempotencyKey: `${lease.jobId}:${action}`,
        action,
        // The deadline the requester stated, carried on the lease. Without it
        // the controller falls back to its own default, which is shorter than
        // a modded boot — and a start that timed out while the server was
        // still loading reported failure for a server that came up fine.
        ...(lease.parameters.timeoutSeconds === undefined
          ? {}
          : { timeoutMs: lease.parameters.timeoutSeconds * 1_000 }),
      });

      await captureConsole(options, now);

      if (result.outcome === 'succeeded') {
        const observation = result.observation;
        return {
          outcome: 'succeeded',
          observedLifecycle: lifecycleFor(result),
          // A pid is only meaningful for a running process, and only together
          // with the boot that produced it.
          ...(observation?.pid === undefined || observation.state !== 'online'
            ? {}
            : { observedPid: observation.pid }),
        };
      }

      return {
        outcome: 'failed',
        // Three different answers, and flattening them loses what the operator
        // needs. `rejected` means nothing was attempted: the server was not in
        // a state this action is defined for, and a restart of an already
        // offline server is the case that surfaced it. Reporting that as
        // `operation-failed` made it look like a restart that ran and broke.
        failureCode: failureCodeFor(result),
        observedLifecycle: lifecycleFor(result),
      };
    } catch {
      // The controller refused or the adapter faulted; the public failure
      // stays a closed code and never carries a host detail.
      return { outcome: 'failed', failureCode: 'operation-failed' };
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
 * Persists whatever the console produced during the operation.
 *
 * Failing to store console output must never fail the operation itself: the
 * server state is the outcome that matters, and losing a few lines is not a
 * reason to report a successful start as failed.
 */
async function captureConsole(
  options: ProcessControlCapabilityOptions,
  now: Date,
): Promise<void> {
  try {
    if (options.consoleAdapter === undefined) return;
    if (
      options.consoleAdapter.readConsoleDelta !== undefined &&
      options.consoleAdapter.acknowledgeConsoleDelta !== undefined
    ) {
      // The runtime pump owns incremental adapters. Re-reading their bounded
      // snapshot after every operation would append the same boot lines again.
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

export function newBootId(): string {
  return randomUUID();
}
