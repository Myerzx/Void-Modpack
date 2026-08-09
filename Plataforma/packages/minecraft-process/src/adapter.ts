import {
  validateProcessLaunchPlan,
  type ProcessLaunchPlan,
  type SupportedHostPlatform,
} from './launch-plan.js';
import {
  createMinecraftConsoleSnapshot,
  sanitizeMinecraftConsoleLine,
  validateMinecraftConsoleCommand,
  type MinecraftConsoleCommand,
  type MinecraftConsoleCommandReceipt,
  type MinecraftConsoleDelta,
  type MinecraftConsoleDeltaLine,
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

/**
 * What a Minecraft server prints when it has finished loading.
 *
 * Exported so a sandbox boot can wait for the same line the adapter waits for,
 * rather than keeping a second copy that could drift from this one.
 */
export const BOOT_COMPLETED_PATTERN = /Done \([^)]+\)! For help, type "help"/u;

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
  /** Available only when the runtime can expose complete lines incrementally. */
  readConsoleDelta?(): MinecraftConsoleDelta;
  /** Removes a successfully persisted prefix returned by `readConsoleDelta`. */
  acknowledgeConsoleDelta?(count: number): void;
  requestConsoleCommand(command: MinecraftConsoleCommand): Promise<MinecraftConsoleCommandReceipt>;
}

export interface MinecraftMetricsAdapter {
  readMetrics(): Promise<MinecraftMetricsSnapshot>;
}

export interface ProcessOwnershipLease {
  /** Binds the spawned PID to this exact pre-spawn ownership generation. */
  attachPid(pid: number): Promise<void>;
  /** Releases only this generation; an old lease must not delete a newer one. */
  release(): Promise<void>;
}

export interface ProcessOwnershipCoordinator {
  /** Reserves ownership before any process side effect happens. */
  acquire(): Promise<ProcessOwnershipLease>;
}

export class ProcessOwnershipConflictError extends Error {
  override readonly name = 'ProcessOwnershipConflictError';

  public constructor() {
    super('Minecraft process ownership is held by a live or uncertain generation.');
  }
}

export interface MinecraftProcessAdapterOptions {
  readonly runtime: ProcessRuntime;
  readonly ownership?: ProcessOwnershipCoordinator;
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
  readonly #maximumConsoleCharactersPerLine: number;
  readonly #hostMetricsSampler: HostMetricsSampler;
  readonly #ownership: ProcessOwnershipCoordinator | undefined;
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
  #ownershipLease: ProcessOwnershipLease | undefined;
  #launchInFlight = false;
  #pidPublished = false;
  #consoleCursor = 1;
  #pendingConsoleLines: MinecraftConsoleDeltaLine[] = [];
  #consoleSourceTruncated = false;

  protected constructor(
    private readonly platform: SupportedHostPlatform,
    options: MinecraftProcessAdapterOptions,
  ) {
    const stopTimeoutMs = options.stopTimeoutMs ?? 30_000;
    if (!Number.isInteger(stopTimeoutMs) || stopTimeoutMs < 10 || stopTimeoutMs > 300_000) {
      throw new Error('stopTimeoutMs is outside the safe range.');
    }
    this.#runtime = options.runtime;
    this.#ownership = options.ownership;
    this.#stopTimeoutMs = stopTimeoutMs;
    this.#clock = options.clock ?? (() => new Date());
    this.#hostMetricsSampler = options.hostMetricsSampler ?? new NodeHostMetricsSampler();
    this.#maximumConsoleCharactersPerLine =
      options.maximumConsoleCharactersPerLine ?? 1_024;
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
    // Spawning plus attaching the durable PID is one logical publication. An
    // unrelated metrics/readiness observation may read the intermediate state
    // but must not release the pre-spawn reservation or advance readiness while
    // the ownership row is still being bound.
    if (this.#launchInFlight) return this.#observation();
    if (this.#handle === undefined && this.#ownershipLease !== undefined) {
      await this.#releaseOwnership();
    }
    const exit = this.#handle?.getExit();
    if (exit !== undefined) {
      if (this.#handle !== undefined) this.#captureConsoleLines(this.#handle);
      this.#lastOutput = this.#handle?.readOutput() ?? this.#lastOutput;
      this.#lastExit = exit;
      this.#state = transitionObservedProcessState(this.#state, 'process-exited');
      this.#handle = undefined;
      this.#processStartedAt = undefined;
      this.#pidPublished = false;
      await this.#releaseOwnership();
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
      this.#launchInFlight = true;
      try {
        const ownershipLease = await this.#ownership?.acquire();
        this.#ownershipLease = ownershipLease;
        this.#lastExit = undefined;
        this.#processStartedAt = undefined;
        this.#pidPublished = false;
        this.#lastOutput = {
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        };
        this.#consoleCursor = 1;
        try {
          this.#handle = await this.#runtime.spawn(plan);
          const processStartedAt = this.#timestamp();
          await ownershipLease?.attachPid(this.#handle.pid);
          this.#processStartedAt = processStartedAt;
          this.#pidPublished = true;
          this.#state = transitionObservedProcessState(this.#state, 'launch-requested');
          this.#state = transitionObservedProcessState(this.#state, 'process-spawned');
          return this.#observation();
        } catch (error) {
          // A failed spawn has no JVM to fence. If the child exists but attaching
          // its PID failed, the reservation deliberately remains: releasing it
          // could let another agent launch a second JVM while this one lives.
          if (this.#handle === undefined) await this.#releaseOwnership();
          this.#state = transitionObservedProcessState(this.#state, 'fault-detected');
          throw error;
        }
      } finally {
        this.#launchInFlight = false;
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
          this.#captureConsoleLines(handle);
          this.#lastOutput = handle.readOutput();
          this.#lastExit = exit;
          this.#state = transitionObservedProcessState(this.#state, 'process-exited');
          this.#handle = undefined;
          this.#processStartedAt = undefined;
          this.#pidPublished = false;
          await this.#releaseOwnership();
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

  readConsoleDelta(): MinecraftConsoleDelta {
    if (this.#handle !== undefined) this.#captureConsoleLines(this.#handle);
    const lines = Object.freeze(this.#pendingConsoleLines.slice(0, 500));
    return Object.freeze({
      readAt: this.#timestamp(),
      source: 'process-adapter',
      lines,
      acknowledgementCount: lines.length,
      sourceTruncated: this.#consoleSourceTruncated,
    });
  }

  acknowledgeConsoleDelta(count: number): void {
    if (!Number.isInteger(count) || count < 0 || count > this.#pendingConsoleLines.length) {
      throw new Error('Minecraft console acknowledgement is invalid.');
    }
    if (count > 0) this.#pendingConsoleLines.splice(0, count);
    // A zero-length acknowledgement can still settle a reported source gap.
    this.#consoleSourceTruncated = false;
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
      ...(this.#handle === undefined || !this.#pidPublished ? {} : { pid: this.#handle.pid }),
      ...(this.#lastExit === undefined ? {} : { lastExit: this.#lastExit }),
    };
  }

  #captureConsoleLines(handle: SpawnedProcess): void {
    if (handle.readOutputLines === undefined) return;
    const page = handle.readOutputLines(this.#consoleCursor);
    if (
      page.oldestRetainedSequence !== null &&
      this.#consoleCursor < page.oldestRetainedSequence
    ) {
      this.#consoleSourceTruncated = true;
    }
    this.#consoleCursor = page.nextCursor;
    for (const line of page.lines) {
      const sanitized = sanitizeMinecraftConsoleLine(
        line.text,
        this.#maximumConsoleCharactersPerLine,
      );
      this.#pendingConsoleLines.push(
        Object.freeze({
          stream: line.stream,
          text: sanitized.text,
          occurredAt: line.occurredAt,
          truncated: line.truncated || sanitized.truncated,
        }),
      );
    }
    if (this.#pendingConsoleLines.length > 5_000) {
      this.#pendingConsoleLines.splice(0, this.#pendingConsoleLines.length - 5_000);
      this.#consoleSourceTruncated = true;
    }
  }

  async #releaseOwnership(): Promise<void> {
    const lease = this.#ownershipLease;
    if (lease === undefined) return;
    try {
      await lease.release();
      if (this.#ownershipLease === lease) this.#ownershipLease = undefined;
    } catch {
      // Retained for the next observation. A failed cleanup may over-refuse a
      // later start; discarding the generation here could under-refuse one.
    }
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
