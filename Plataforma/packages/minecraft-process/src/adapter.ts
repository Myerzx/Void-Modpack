import {
  validateProcessLaunchPlan,
  type ProcessLaunchPlan,
  type SupportedHostPlatform,
} from './launch-plan.js';
import type {
  ProcessExit,
  ProcessOutputSnapshot,
  ProcessRuntime,
  SpawnedProcess,
} from './runtime.js';
import {
  transitionObservedProcessState,
  type ObservedProcessState,
} from './state-machine.js';

const BOOT_COMPLETED_PATTERN = /Done \([^)]+\)! For help, type "help"/u;

export interface ProcessObservation {
  readonly state: ObservedProcessState;
  readonly observedAt: string;
  readonly source: 'process-adapter';
  readonly pid?: number;
  readonly lastExit?: ProcessExit;
}

export interface MinecraftProcessAdapter {
  inspect(): Promise<ProcessObservation>;
  start(plan: ProcessLaunchPlan): Promise<ProcessObservation>;
  requestGracefulStop(): Promise<ProcessObservation>;
  readOutput(): ProcessOutputSnapshot;
}

export interface MinecraftProcessAdapterOptions {
  readonly runtime: ProcessRuntime;
  readonly stopTimeoutMs?: number;
  readonly clock?: () => Date;
}

abstract class ManagedMinecraftProcessAdapter implements MinecraftProcessAdapter {
  readonly #runtime: ProcessRuntime;
  readonly #stopTimeoutMs: number;
  readonly #clock: () => Date;
  #state: ObservedProcessState = 'offline';
  #handle: SpawnedProcess | undefined;
  #lastExit: ProcessExit | undefined;
  #lastOutput: ProcessOutputSnapshot = {
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
  };

  protected constructor(
    private readonly platform: SupportedHostPlatform,
    options: MinecraftProcessAdapterOptions,
  ) {
    const stopTimeoutMs = options.stopTimeoutMs ?? 30_000;
    if (!Number.isInteger(stopTimeoutMs) || stopTimeoutMs < 10 || stopTimeoutMs > 300_000) {
      throw new Error('stopTimeoutMs is outside the safe range.');
    }
    this.#runtime = options.runtime;
    this.#stopTimeoutMs = stopTimeoutMs;
    this.#clock = options.clock ?? (() => new Date());
  }

  async inspect(): Promise<ProcessObservation> {
    const exit = this.#handle?.getExit();
    if (exit !== undefined) {
      this.#lastOutput = this.#handle?.readOutput() ?? this.#lastOutput;
      this.#lastExit = exit;
      this.#state = transitionObservedProcessState(this.#state, 'process-exited');
      this.#handle = undefined;
    } else if (
      this.#state === 'starting' &&
      BOOT_COMPLETED_PATTERN.test(this.#handle?.readOutput().stdout ?? '')
    ) {
      this.#state = transitionObservedProcessState(this.#state, 'boot-confirmed');
    }
    return this.#observation();
  }

  async start(plan: ProcessLaunchPlan): Promise<ProcessObservation> {
    await this.inspect();
    if (this.#state !== 'offline') {
      throw new Error(`Cannot start Minecraft while observed state is ${this.#state}.`);
    }
    if (plan.platform !== this.platform) {
      throw new Error(`The ${this.platform} adapter rejected a ${plan.platform} launch plan.`);
    }
    validateProcessLaunchPlan(plan);
    this.#state = transitionObservedProcessState(this.#state, 'launch-requested');
    this.#lastExit = undefined;
    this.#lastOutput = {
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    };
    try {
      this.#handle = await this.#runtime.spawn(plan);
      this.#state = transitionObservedProcessState(this.#state, 'process-spawned');
      return this.#observation();
    } catch (error) {
      this.#state = transitionObservedProcessState(this.#state, 'fault-detected');
      throw error;
    }
  }

  async requestGracefulStop(): Promise<ProcessObservation> {
    await this.inspect();
    if (this.#state !== 'online' || this.#handle === undefined) {
      throw new Error(`Cannot request a graceful stop while observed state is ${this.#state}.`);
    }
    this.#state = transitionObservedProcessState(this.#state, 'stop-requested');
    try {
      await this.#handle.requestGracefulStop();
      const exit = await this.#handle.waitForExit(this.#stopTimeoutMs);
      if (exit !== undefined) {
        this.#lastOutput = this.#handle.readOutput();
        this.#lastExit = exit;
        this.#state = transitionObservedProcessState(this.#state, 'process-exited');
        this.#handle = undefined;
      }
      return this.#observation();
    } catch (error) {
      this.#state = transitionObservedProcessState(this.#state, 'fault-detected');
      throw error;
    }
  }

  readOutput(): ProcessOutputSnapshot {
    return this.#handle?.readOutput() ?? this.#lastOutput;
  }

  #observation(): ProcessObservation {
    return {
      state: this.#state,
      observedAt: this.#clock().toISOString(),
      source: 'process-adapter',
      ...(this.#handle === undefined ? {} : { pid: this.#handle.pid }),
      ...(this.#lastExit === undefined ? {} : { lastExit: this.#lastExit }),
    };
  }
}

export class WindowsMinecraftProcessAdapter extends ManagedMinecraftProcessAdapter {
  constructor(options: MinecraftProcessAdapterOptions) {
    super('win32', options);
  }
}

export class LinuxMinecraftProcessAdapter extends ManagedMinecraftProcessAdapter {
  constructor(options: MinecraftProcessAdapterOptions) {
    super('linux', options);
  }
}
