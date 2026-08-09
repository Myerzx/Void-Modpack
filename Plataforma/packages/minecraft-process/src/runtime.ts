import type { ProcessLaunchPlan } from './launch-plan.js';
import type { MinecraftConsoleCommand } from './console.js';

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly exitedAt: string;
}

export interface ProcessOutputSnapshot {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export type ProcessOutputStream = 'stdout' | 'stderr';

/**
 * One complete line observed directly from the child pipes.
 *
 * The sequence belongs to one spawned process and is never reused during that
 * process lifetime. It is deliberately separate from the durable console
 * sequence assigned by PostgreSQL: the former prevents duplicate capture on
 * the host, while the latter is the public cursor across agent restarts.
 */
export interface ProcessOutputLine {
  readonly sequence: number;
  readonly stream: ProcessOutputStream;
  readonly text: string;
  readonly occurredAt: string;
  readonly truncated: boolean;
}

export interface ProcessOutputLinePage {
  readonly lines: readonly ProcessOutputLine[];
  /** Inclusive cursor for the next read. */
  readonly nextCursor: number;
  /** Null until this process has emitted a complete line. */
  readonly oldestRetainedSequence: number | null;
}

export interface SpawnedProcess {
  readonly pid: number;
  getExit(): ProcessExit | undefined;
  readOutput(): ProcessOutputSnapshot;
  /**
   * Reads complete output lines forward from a per-process sequence.
   *
   * Optional for scripted adapters. The Node runtime implements it and is the
   * only runtime allowed to advertise continuous console capture.
   */
  readOutputLines?(fromSequence?: number): ProcessOutputLinePage;
  requestConsoleCommand(command: MinecraftConsoleCommand): Promise<void>;
  requestGracefulStop(): Promise<void>;
  /**
   * Ends the process without asking it.
   *
   * A last resort for a caller that owns the process and cannot leave it
   * running -- a disposable sandbox, whose directory is about to be deleted
   * underneath it. This is **not** the `process.force-kill` capability, which
   * is deliberately unimplemented: that one kills an operator's live server and
   * can lose everything since the last save. This one ends a JVM we spawned
   * ourselves, in a temporary directory, with an empty world in it.
   */
  forceTerminate(): Promise<void>;
  waitForExit(timeoutMs: number): Promise<ProcessExit | undefined>;
}

export interface ProcessRuntime {
  spawn(plan: ProcessLaunchPlan): Promise<SpawnedProcess>;
}
