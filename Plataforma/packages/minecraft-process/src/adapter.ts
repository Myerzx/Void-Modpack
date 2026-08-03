import {
  validateProcessLaunchPlan,
  type ProcessLaunchPlan,
  type SupportedHostPlatform,
} from './launch-plan.js';
import {
  createMinecraftConsoleSnapshot,
  validateMinecraftConsoleCommand,
  type MinecraftConsoleCommand,
  type MinecraftConsoleCommandReceipt,
  type MinecraftConsoleSnapshot,
  type MinecraftConsoleSnapshotOptions,
} from './console.js';
import type {
  ProcessExit,
  ProcessOutputSnapshot,
  ProcessRuntime,
  SpawnedProcess,
} from './runtime.js';
import {
  createMinecraftMetricsSnapshot,
  NodeHostMetricsSampler,
  type HostMetricsSampler,
  type MinecraftMetricsSnapshot,
} from './metrics.js';
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

export interface MinecraftConsoleAdapter {
  inspect(): Promise<ProcessObservation>;
  readConsole(): MinecraftConsoleSnapshot;
  requestConsoleCommand(command: MinecraftConsoleCommand): Promise<MinecraftConsoleCommandReceipt>;
}

export interface MinecraftMetricsAdapter {
  readMetrics(): Promise<MinecraftMetricsSnapshot>;
}

export interface MinecraftProcessAdapterOptions {
  readonly runtime: ProcessRuntime;
  readonly stopTimeoutMs?: number;
  readonly maximumConsoleLinesPerStream?: number;
  readonly maximumConsoleCharactersPerLine?: number;
  readonly hostMetricsSampler?: HostMetricsSampler;
  readonly clock?: () => Date;
}

abstract class ManagedMinecraftProcessAdapter
  implements MinecraftProcessAdapter, MinecraftConsoleAdapter, MinecraftMetricsAdapter
{
  readonly #runtime: ProcessRuntime;
  readonly #stopTimeoutMs: number;
  readonly #clock: () => Date;
  readonly #consoleSnapshotOptions: MinecraftConsoleSnapshotOptions;
  readonly #hostMetricsSampler: HostMetricsSampler;
  #state: ObservedProcessState = 'offline';
  #handle: SpawnedProcess | undefined;
  #lastExit: ProcessExit | undefined;
  #lastOutput: ProcessOutputSnapshot = {
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
  };
  #activeEffect: 'start' | 'stop' | 'console-command' | undefined;
  #processStartedAt: string | undefined;

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
    this.#hostMetricsSampler = options.hostMetricsSampler ?? new NodeHostMetricsSampler();
    this.#consoleSnapshotOptions = Object.freeze({
      ...(options.maximumConsoleLinesPerStream === undefined
        ? {}
        : { maximumLinesPerStream: options.maximumConsoleLinesPerStream }),
      ...(options.maximumConsoleCharactersPerLine === undefined
        ? {}
        : { maximumCharactersPerLine: options.maximumConsoleCharactersPerLine }),
      clock: this.#clock,
    });
    createMinecraftConsoleSnapshot(this.#lastOutput, {
      ...this.#consoleSnapshotOptions,
      clock: () => new Date(0),
    });
  }

  async inspect(): Promise<ProcessObservation> {
    const exit = this.#handle?.getExit();
    if (exit !== undefined) {
      this.#lastOutput = this.#handle?.readOutput() ?? this.#lastOutput;
      this.#lastExit = exit;
      this.#state = transitionObservedProcessState(this.#state, 'process-exited');
      this.#handle = undefined;
      this.#processStartedAt = undefined;
    } else if (
      this.#state === 'starting' &&
      BOOT_COMPLETED_PATTERN.test(this.#handle?.readOutput().stdout ?? '')
    ) {
      this.#state = transitionObservedProcessState(this.#state, 'boot-confirmed');
    }
    return this.#observation();
  }

  start(plan: ProcessLaunchPlan): Promise<ProcessObservation> {
    return this.#runExclusiveEffect('start', async () => {
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
      this.#processStartedAt = undefined;
      this.#lastOutput = {
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
      };
      try {
        this.#handle = await this.#runtime.spawn(plan);
        this.#processStartedAt = this.#timestamp();
        this.#state = transitionObservedProcessState(this.#state, 'process-spawned');
        return this.#observation();
      } catch (error) {
        this.#state = transitionObservedProcessState(this.#state, 'fault-detected');
        throw error;
      }
    });
  }

  requestGracefulStop(): Promise<ProcessObservation> {
    return this.#runExclusiveEffect('stop', async () => {
      await this.inspect();
      const handle = this.#handle;
      if (this.#state !== 'online' || handle === undefined) {
        throw new Error(`Cannot request a graceful stop while observed state is ${this.#state}.`);
      }
      this.#state = transitionObservedProcessState(this.#state, 'stop-requested');
      try {
        await handle.requestGracefulStop();
        const exit = await handle.waitForExit(this.#stopTimeoutMs);
        if (exit !== undefined && this.#handle === handle) {
          this.#lastOutput = handle.readOutput();
          this.#lastExit = exit;
          this.#state = transitionObservedProcessState(this.#state, 'process-exited');
          this.#handle = undefined;
          this.#processStartedAt = undefined;
        }
        return this.#observation();
      } catch (error) {
        this.#state = transitionObservedProcessState(this.#state, 'fault-detected');
        throw error;
      }
    });
  }

  readOutput(): ProcessOutputSnapshot {
    return this.#handle?.readOutput() ?? this.#lastOutput;
  }

  readConsole(): MinecraftConsoleSnapshot {
    return createMinecraftConsoleSnapshot(this.readOutput(), this.#consoleSnapshotOptions);
  }

  async readMetrics(): Promise<MinecraftMetricsSnapshot> {
    const observation = await this.inspect();
    return createMinecraftMetricsSnapshot({
      host: this.#hostMetricsSampler.sample(),
      process: {
        state: observation.state,
        observedAt: observation.observedAt,
        ...(observation.pid === undefined ? {} : { pid: observation.pid }),
        ...(this.#processStartedAt === undefined
          ? {}
          : { startedAt: this.#processStartedAt }),
      },
      clock: this.#clock,
    });
  }

  requestConsoleCommand(
    command: MinecraftConsoleCommand,
  ): Promise<MinecraftConsoleCommandReceipt> {
    const acceptedCommand = validateMinecraftConsoleCommand(command);
    return this.#runExclusiveEffect('console-command', async () => {
      await this.inspect();
      if (this.#state !== 'online' || this.#handle === undefined) {
        throw new Error(`Cannot request a console command while observed state is ${this.#state}.`);
      }
      await this.#handle.requestConsoleCommand(acceptedCommand);
      return Object.freeze({
        command: acceptedCommand,
        dispatchedAt: this.#timestamp(),
        source: 'process-adapter',
        state: 'online',
      });
    });
  }

  #runExclusiveEffect<T>(
    effect: 'start' | 'stop' | 'console-command',
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.#activeEffect !== undefined) {
      return Promise.reject(
        new Error(`Process adapter is busy with ${this.#activeEffect}.`),
      );
    }
    this.#activeEffect = effect;
    let running: Promise<T>;
    try {
      running = operation();
    } catch (error) {
      this.#activeEffect = undefined;
      throw error;
    }
    return running.finally(() => {
      if (this.#activeEffect === effect) this.#activeEffect = undefined;
    });
  }

  #observation(): ProcessObservation {
    return {
      state: this.#state,
      observedAt: this.#timestamp(),
      source: 'process-adapter',
      ...(this.#handle === undefined ? {} : { pid: this.#handle.pid }),
      ...(this.#lastExit === undefined ? {} : { lastExit: this.#lastExit }),
    };
  }

  #timestamp(): string {
    const value = this.#clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error('Process adapter clock returned an invalid date.');
    }
    return value.toISOString();
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
