import type { ProcessLaunchPlan } from './launch-plan.js';

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
  requestGracefulStop(): Promise<void>;
  waitForExit(timeoutMs: number): Promise<ProcessExit | undefined>;
}

export interface ProcessRuntime {
  spawn(plan: ProcessLaunchPlan): Promise<SpawnedProcess>;
}
