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

export interface SpawnedProcess {
  readonly pid: number;
  getExit(): ProcessExit | undefined;
  readOutput(): ProcessOutputSnapshot;
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
