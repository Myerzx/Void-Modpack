import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createMinecraftConsoleSnapshot,
  createMinecraftMetricsSnapshot,
  createMinecraftProcessPlan,
  LinuxMinecraftProcessAdapter,
  MINECRAFT_CONSOLE_COMMANDS,
  minecraftConsoleCommandLiteral,
  MinecraftProcessController,
  NodeHostMetricsSampler,
  NodeProcessRuntime,
  ProcessControlRequestError,
  ProcessOwnershipConflictError,
  transitionObservedProcessState,
  WindowsMinecraftProcessAdapter,
  type MinecraftProcessAdapter,
  type MinecraftConsoleCommand,
  type MinecraftProcessControllerOptions,
  type ProcessLaunchPlan,
  type ProcessObservation,
  type ProcessOutputSnapshot,
  type ProcessRuntime,
  type ProcessOwnershipCoordinator,
  type SpawnedProcess,
  type SupportedHostPlatform,
} from '../src/index.js';

function findJavaExecutable(): string | undefined {
  const executableName = process.platform === 'win32' ? 'java.exe' : 'java';
  const javaHome = process.env['JAVA_HOME'];
  if (javaHome !== undefined) {
    const candidate = resolve(javaHome, 'bin', executableName);
    if (existsSync(candidate)) return candidate;
  }
  for (const entry of (process.env['PATH'] ?? '').split(delimiter)) {
    const candidate = resolve(entry.replace(/^"|"$/gu, ''), executableName);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const hostPlatform: SupportedHostPlatform | undefined =
  process.platform === 'win32' || process.platform === 'linux' ? process.platform : undefined;
const javaExecutable = findJavaExecutable();
const javacExecutable =
  javaExecutable === undefined
    ? undefined
    : resolve(dirname(javaExecutable), process.platform === 'win32' ? 'javac.exe' : 'javac');
const fixtureSource = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'FakeMinecraftFixture.java',
);
const execFileAsync = promisify(execFile);

async function compileJavaFixture(cwd: string): Promise<void> {
  assert.ok(hostPlatform);
  assert.ok(javacExecutable);
  await execFileAsync(
    javacExecutable,
    ['-encoding', 'UTF-8', '-d', cwd, fixtureSource],
    { cwd, timeout: 60_000, windowsHide: hostPlatform === 'win32' },
  );
}

function javaFixturePlan(cwd: string, extraArguments: readonly string[] = []): ProcessLaunchPlan {
  assert.ok(hostPlatform);
  assert.ok(javaExecutable);
  return {
    platform: hostPlatform,
    executable: javaExecutable,
    args: ['-cp', cwd, 'FakeMinecraftFixture', ...extraArguments],
    cwd,
    shell: false,
    windowsHide: hostPlatform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  };
}

class TrackingRuntime implements ProcessRuntime {
  handle: SpawnedProcess | undefined;
  spawnCount = 0;

  constructor(private readonly delegate: ProcessRuntime) {}

  async spawn(plan: ProcessLaunchPlan): Promise<SpawnedProcess> {
    const handle = await this.delegate.spawn(plan);
    this.spawnCount += 1;
    this.handle = handle;
    return handle;
  }

  async requestFixtureCleanup(): Promise<void> {
    if (this.handle === undefined || this.handle.getExit() !== undefined) return;
    await this.handle.requestGracefulStop();
    await this.handle.waitForExit(15_000);
  }
}

const fakeControllerPlan = createMinecraftProcessPlan({
  platform: 'win32',
  javaExecutable: 'C:\\Java\\bin\\java.exe',
  serverDirectory: 'D:\\VoidFallFixture\\server',
  serverJar: 'forge-server.jar',
  initialMemoryMiB: 512,
  maximumMemoryMiB: 1_024,
});

function livingTestHandle(pid: number, ready: boolean): SpawnedProcess {
  return {
    pid,
    getExit: () => undefined,
    readOutput: () => ({
      stdout: ready ? 'Done (0.100s)! For help, type "help"' : 'Loading mods...',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
    requestConsoleCommand: async () => {},
    requestGracefulStop: async () => {},
    forceTerminate: async () => {},
    waitForExit: async () => undefined,
  };
}

class FakeMinecraftProcessAdapter implements MinecraftProcessAdapter {
  state: ProcessObservation['state'];
  startCalls = 0;
  stopCalls = 0;
  inspectCalls = 0;
  autoCompleteStart = true;
  autoCompleteStop = true;
  throwOnStart: Error | undefined;
  readonly lifecycle: string[] = [];
  readonly #pendingStates: ProcessObservation['state'][] = [];

  constructor(initialState: ProcessObservation['state']) {
    this.state = initialState;
  }

  async inspect(): Promise<ProcessObservation> {
    this.inspectCalls += 1;
    const pending = this.#pendingStates.shift();
    if (pending !== undefined) this.state = pending;
    this.lifecycle.push(`inspect:${this.state}`);
    return this.#observation();
  }

  async start(_plan: ProcessLaunchPlan): Promise<ProcessObservation> {
    this.startCalls += 1;
    this.lifecycle.push('start');
    if (this.throwOnStart !== undefined) throw this.throwOnStart;
    this.state = 'starting';
    if (this.autoCompleteStart) this.#pendingStates.push('online');
    return this.#observation();
  }

  async requestGracefulStop(): Promise<ProcessObservation> {
    this.stopCalls += 1;
    this.lifecycle.push('stop');
    this.state = 'stopping';
    if (this.autoCompleteStop) this.#pendingStates.push('offline');
    return this.#observation();
  }

  readOutput(): ProcessOutputSnapshot {
    return { stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false };
  }

  #observation(): ProcessObservation {
    return {
      state: this.state,
      observedAt: '2026-08-03T12:00:00.000Z',
      source: 'process-adapter',
    };
  }
}

function createFakeController(
  adapter: FakeMinecraftProcessAdapter,
  overrides: Partial<MinecraftProcessControllerOptions> = {},
): MinecraftProcessController {
  return new MinecraftProcessController({
    adapter,
    launchPlan: fakeControllerPlan,
    operationTimeoutMs: 100,
    pollIntervalMs: 10,
    maximumRememberedOperations: 8,
    clock: () => new Date('2026-08-03T12:00:00.000Z'),
    sleep: async () => {},
    ...overrides,
  });
}

async function waitForState(
  adapter: WindowsMinecraftProcessAdapter | LinuxMinecraftProcessAdapter,
  expected: 'online' | 'offline',
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await adapter.inspect()).state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for fixture state ${expected}.`);
}

async function waitForConsoleLine(
  adapter: WindowsMinecraftProcessAdapter | LinuxMinecraftProcessAdapter,
  expected: RegExp,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const lines = adapter.readConsole().stdout.lines.map((line) => line.text);
    if (lines.some((line) => expected.test(line))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for fixture console output ${expected.source}.`);
}

describe('Minecraft process launch plans', () => {
  it('creates fixed argv plans without a shell for Windows and Linux', () => {
    const windows = createMinecraftProcessPlan({
      platform: 'win32',
      javaExecutable: 'C:\\Java\\bin\\java.exe',
      serverDirectory: 'D:\\VoidFall\\server',
      serverJar: 'forge-server.jar',
      initialMemoryMiB: 4_096,
      maximumMemoryMiB: 16_384,
    });
    const linux = createMinecraftProcessPlan({
      platform: 'linux',
      javaExecutable: '/opt/java/bin/java',
      serverDirectory: '/srv/voidfall/server',
      serverJar: 'forge-server.jar',
      initialMemoryMiB: 4_096,
      maximumMemoryMiB: 16_384,
    });

    assert.equal(windows.shell, false);
    assert.equal(windows.windowsHide, true);
    assert.equal(linux.shell, false);
    assert.equal(linux.windowsHide, false);
    assert.deepEqual(windows.args, linux.args);
    assert.deepEqual(windows.args, [
      '-Xms4096M',
      '-Xmx16384M',
      '-Dfile.encoding=UTF-8',
      '-jar',
      'forge-server.jar',
      'nogui',
    ]);
  });

  it('rejects relative paths, path-bearing JAR names and invalid memory limits', () => {
    const valid = {
      platform: 'linux' as const,
      javaExecutable: '/opt/java/bin/java',
      serverDirectory: '/srv/voidfall/server',
      serverJar: 'forge-server.jar',
      initialMemoryMiB: 4_096,
      maximumMemoryMiB: 16_384,
    };
    assert.throws(() => createMinecraftProcessPlan({ ...valid, javaExecutable: 'java' }), /absolute/u);
    assert.throws(() => createMinecraftProcessPlan({ ...valid, serverJar: '../server.jar' }), /filename/u);
    assert.throws(
      () => createMinecraftProcessPlan({ ...valid, initialMemoryMiB: 32_768 }),
      /memory/u,
    );
  });
});

describe('observed process state machine', () => {
  it('models a graceful lifecycle and rejects impossible transitions', () => {
    let state = transitionObservedProcessState('offline', 'launch-requested');
    state = transitionObservedProcessState(state, 'process-spawned');
    state = transitionObservedProcessState(state, 'boot-confirmed');
    state = transitionObservedProcessState(state, 'stop-requested');
    state = transitionObservedProcessState(state, 'process-exited');
    assert.equal(state, 'offline');
    assert.throws(() => transitionObservedProcessState('offline', 'boot-confirmed'), /Invalid/u);
  });
});

describe('bounded Minecraft console contract', () => {
  it('maps only closed command identifiers to exact private literals', () => {
    assert.deepEqual(MINECRAFT_CONSOLE_COMMANDS, ['list-players', 'save-all']);
    assert.equal(minecraftConsoleCommandLiteral('list-players'), 'list\n');
    assert.equal(minecraftConsoleCommandLiteral('save-all'), 'save-all flush\n');
    for (const rejected of ['stop', 'list\nstop', 'say hello', '', undefined]) {
      assert.throws(() => minecraftConsoleCommandLiteral(rejected), /not allowed/u);
    }
  });

  it('sanitizes controls and applies independent line and character bounds', () => {
    const longUnicodeLine = '🙂'.repeat(40);
    const snapshot = createMinecraftConsoleSnapshot(
      {
        stdout: `discarded\n\u001b[31m${longUnicodeLine}\u001b[0m\ntail\u0000\n`,
        stderr: 'warning\u0007\u001b]0;hidden title\u0007\r\n',
        stdoutTruncated: true,
        stderrTruncated: false,
      },
      {
        maximumLinesPerStream: 2,
        maximumCharactersPerLine: 32,
        clock: () => new Date('2026-08-03T12:00:00.000Z'),
      },
    );

    assert.equal(snapshot.readAt, '2026-08-03T12:00:00.000Z');
    assert.equal(snapshot.stdout.sourceTruncated, true);
    assert.equal(snapshot.stdout.viewTruncated, true);
    assert.equal(snapshot.stdout.lines.length, 2);
    assert.equal(snapshot.stdout.lines[0]?.text, '🙂'.repeat(32));
    assert.equal(snapshot.stdout.lines[0]?.truncated, true);
    assert.equal(snapshot.stdout.lines[1]?.text, 'tail');
    assert.equal(snapshot.stderr.lines[0]?.text, 'warning');
    assert.equal(Object.isFrozen(snapshot.stdout.lines), true);
    assert.equal(Object.isFrozen(snapshot.stdout.lines[0]), true);
  });

  it('rejects unsafe snapshot limits and invalid clocks', () => {
    const output: ProcessOutputSnapshot = {
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    };
    assert.throws(
      () => createMinecraftConsoleSnapshot(output, { maximumLinesPerStream: 0 }),
      /safe range/u,
    );
    assert.throws(
      () =>
        createMinecraftConsoleSnapshot(output, {
          clock: () => new Date(Number.NaN),
        }),
      /invalid date/u,
    );
  });
});

describe('sourced host and process metrics', () => {
  const hostSample = {
    totalMemoryBytes: 16 * 1_024 ** 3,
    freeMemoryBytes: 6 * 1_024 ** 3,
    uptimeSeconds: 3_600,
    availableCpuCount: 8,
  };

  it('labels real, calculated and unavailable values without inventing zeroes', () => {
    const collectedAt = '2026-08-03T12:00:10.000Z';
    const snapshot = createMinecraftMetricsSnapshot({
      host: hostSample,
      process: {
        state: 'offline',
        observedAt: '2026-08-03T12:00:09.000Z',
      },
      clock: () => new Date(collectedAt),
    });

    assert.deepEqual(snapshot.host.usedMemory, {
      status: 'available',
      value: 10 * 1_024 ** 3,
      unit: 'bytes',
      quality: 'calculated',
      source: 'node:os:derived',
      collectedAt,
    });
    assert.deepEqual(snapshot.process.pid, {
      status: 'unavailable',
      unit: 'process-id',
      quality: 'unavailable',
      source: 'process-adapter',
      collectedAt,
      reason: 'not-running',
    });
    assert.equal(snapshot.host.totalMemory.source, 'node:os');
    assert.equal(snapshot.host.freeMemory.quality, 'real');
    assert.equal(snapshot.host.uptime.unit, 'seconds');
    assert.equal(snapshot.host.availableCpuCount.value, 8);
    assert.equal('value' in snapshot.process.cpuPercent, false);
    assert.equal('value' in snapshot.process.residentMemory, false);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.host.usedMemory), true);
  });

  it('reports managed PID and uptime while keeping unsupported runtime data explicit', () => {
    const collectedAt = '2026-08-03T12:00:10.000Z';
    const snapshot = createMinecraftMetricsSnapshot({
      host: hostSample,
      process: {
        state: 'online',
        observedAt: '2026-08-03T12:00:09.000Z',
        pid: 4_242,
        startedAt: '2026-08-03T12:00:00.000Z',
      },
      clock: () => new Date(collectedAt),
    });

    assert.deepEqual(snapshot.process.pid, {
      status: 'available',
      value: 4_242,
      unit: 'process-id',
      quality: 'real',
      source: 'process-adapter',
      collectedAt,
    });
    assert.deepEqual(snapshot.process.uptime, {
      status: 'available',
      value: 10,
      unit: 'seconds',
      quality: 'calculated',
      source: 'process-adapter:derived',
      collectedAt,
    });
    assert.equal(snapshot.process.cpuPercent.status, 'unavailable');
    assert.equal(snapshot.process.residentMemory.status, 'unavailable');
    if (
      snapshot.process.cpuPercent.status !== 'unavailable' ||
      snapshot.process.residentMemory.status !== 'unavailable'
    ) {
      assert.fail('Portable process metrics must remain explicitly unavailable.');
    }
    assert.equal(snapshot.process.cpuPercent.reason, 'unsupported-portable-runtime');
    assert.equal(snapshot.process.residentMemory.reason, 'unsupported-portable-runtime');
    assert.equal(snapshot.process.state.observedAt, '2026-08-03T12:00:09.000Z');
    assert.equal(JSON.stringify(snapshot).includes('server.jar'), false);
    assert.equal(JSON.stringify(snapshot).includes('stdout'), false);
  });

  it('rejects inconsistent samples, active identities and timestamps', () => {
    const fixedClock = () => new Date('2026-08-03T12:00:10.000Z');
    for (const invalidHost of [
      { ...hostSample, totalMemoryBytes: Number.NaN },
      { ...hostSample, freeMemoryBytes: -1 },
      { ...hostSample, uptimeSeconds: Number.POSITIVE_INFINITY },
      { ...hostSample, availableCpuCount: 2.5 },
    ]) {
      assert.throws(
        () =>
          createMinecraftMetricsSnapshot({
            host: invalidHost,
            process: { state: 'offline', observedAt: '2026-08-03T12:00:09.000Z' },
            clock: fixedClock,
          }),
        /invalid/u,
      );
    }
    assert.throws(
      () =>
        createMinecraftMetricsSnapshot({
          host: { ...hostSample, freeMemoryBytes: hostSample.totalMemoryBytes + 1 },
          process: { state: 'offline', observedAt: '2026-08-03T12:00:09.000Z' },
          clock: fixedClock,
        }),
      /cannot exceed/u,
    );
    assert.throws(
      () =>
        createMinecraftMetricsSnapshot({
          host: hostSample,
          process: { state: 'online', observedAt: '2026-08-03T12:00:09.000Z' },
          clock: fixedClock,
        }),
      /PID/u,
    );
    assert.throws(
      () =>
        createMinecraftMetricsSnapshot({
          host: hostSample,
          process: {
            state: 'online',
            observedAt: '2026-08-03T12:00:09.000Z',
            pid: 4_242,
            startedAt: '2026-08-03T12:00:11.000Z',
          },
          clock: fixedClock,
        }),
      /precedes/u,
    );
    assert.throws(
      () =>
        createMinecraftMetricsSnapshot({
          host: hostSample,
          process: { state: 'offline', observedAt: 'not-a-date' },
          clock: fixedClock,
        }),
      /observedAt/u,
    );
  });

  it('samples finite host values through the portable Node source', () => {
    const sample = new NodeHostMetricsSampler().sample();

    assert.equal(Number.isSafeInteger(sample.totalMemoryBytes), true);
    assert.equal(Number.isSafeInteger(sample.freeMemoryBytes), true);
    assert.equal(sample.totalMemoryBytes > 0, true);
    assert.equal(sample.freeMemoryBytes <= sample.totalMemoryBytes, true);
    assert.equal(Number.isFinite(sample.uptimeSeconds), true);
    assert.equal(sample.uptimeSeconds >= 0, true);
    assert.equal(Number.isSafeInteger(sample.availableCpuCount), true);
    assert.equal(sample.availableCpuCount >= 1, true);
  });

  it('tracks adapter state and managed uptime across a complete lifecycle', async () => {
    let exitObserved = false;
    let now = new Date('2026-08-03T12:00:00.000Z');
    const handle: SpawnedProcess = {
      pid: 4_242,
      getExit: () =>
        exitObserved
          ? {
              code: 0,
              signal: null,
              exitedAt: '2026-08-03T12:00:12.000Z',
            }
          : undefined,
      readOutput: () => ({
        stdout: '[Server thread/INFO]: Done (0.100s)! For help, type "help"',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
      requestConsoleCommand: async () => {},
      requestGracefulStop: async () => {},
      forceTerminate: async () => {},
      waitForExit: async () => {
        exitObserved = true;
        return handle.getExit();
      },
    };
    const adapter = new WindowsMinecraftProcessAdapter({
      runtime: { spawn: async () => handle },
      stopTimeoutMs: 10,
      hostMetricsSampler: { sample: () => hostSample },
      clock: () => now,
    });

    const offline = await adapter.readMetrics();
    assert.equal(offline.process.pid.status, 'unavailable');
    await adapter.start(fakeControllerPlan);
    assert.equal((await adapter.inspect()).state, 'online');
    now = new Date('2026-08-03T12:00:10.000Z');
    const online = await adapter.readMetrics();
    assert.equal(online.process.pid.status, 'available');
    assert.equal(online.process.pid.status === 'available' && online.process.pid.value, 4_242);
    assert.equal(
      online.process.uptime.status === 'available' && online.process.uptime.value,
      10,
    );
    assert.equal((await adapter.requestGracefulStop()).state, 'offline');
    const stopped = await adapter.readMetrics();
    assert.equal(stopped.process.pid.status, 'unavailable');
    assert.equal(stopped.process.uptime.status, 'unavailable');
  });
});

describe('serialized process controller', () => {
  it('starts, stops and restarts only after observing the required states', async () => {
    const adapter = new FakeMinecraftProcessAdapter('offline');
    const controller = createFakeController(adapter);

    const started = await controller.execute({ action: 'start', idempotencyKey: 'start-0001' });
    assert.equal(started.outcome, 'succeeded');
    assert.equal(started.observation?.state, 'online');
    assert.deepEqual(
      started.events.map((event) => event.sequence),
      [1, 2, 3, 4, 5],
    );

    const restarted = await controller.execute({
      action: 'restart',
      idempotencyKey: 'restart-0001',
    });
    assert.equal(restarted.outcome, 'succeeded');
    assert.equal(restarted.observation?.state, 'online');
    assert.equal(adapter.stopCalls, 1);
    assert.equal(adapter.startCalls, 2);
    assert.equal(adapter.lifecycle.indexOf('stop') < adapter.lifecycle.lastIndexOf('start'), true);
    assert.deepEqual(
      restarted.events.map((event) => event.phase),
      [
        'accepted',
        'state-observed',
        'stop-requested',
        'state-observed',
        'start-requested',
        'state-observed',
        'succeeded',
      ],
    );

    const stopped = await controller.execute({ action: 'stop', idempotencyKey: 'stop-0001' });
    assert.equal(stopped.outcome, 'succeeded');
    assert.equal(stopped.observation?.state, 'offline');
  });

  it('shares an in-flight duplicate and rejects a different concurrent operation', async () => {
    const adapter = new FakeMinecraftProcessAdapter('offline');
    let releaseSleep: () => void = () => {};
    const sleepGate = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    const controller = createFakeController(adapter, { sleep: async () => sleepGate });
    const first = controller.execute({ action: 'start', idempotencyKey: 'shared-0001' });
    const duplicate = controller.execute({ action: 'start', idempotencyKey: 'shared-0001' });

    assert.strictEqual(duplicate, first);
    assert.throws(
      () => controller.execute({ action: 'stop', idempotencyKey: 'other-0001' }),
      (error: unknown) =>
        error instanceof ProcessControlRequestError && error.code === 'controller-busy',
    );
    releaseSleep();
    assert.equal((await first).outcome, 'succeeded');
    assert.equal(adapter.startCalls, 1);
  });

  it('replays a completed result and rejects reuse of its key for another action', async () => {
    const adapter = new FakeMinecraftProcessAdapter('offline');
    const controller = createFakeController(adapter);
    const first = await controller.execute({ action: 'start', idempotencyKey: 'replay-0001' });
    const replay = await controller.execute({ action: 'start', idempotencyKey: 'replay-0001' });

    assert.strictEqual(replay, first);
    assert.equal(adapter.startCalls, 1);
    assert.throws(
      () => controller.execute({ action: 'stop', idempotencyKey: 'replay-0001' }),
      (error: unknown) =>
        error instanceof ProcessControlRequestError && error.code === 'idempotency-conflict',
    );
  });

  it('remembers a state rejection without producing a process effect', async () => {
    const adapter = new FakeMinecraftProcessAdapter('offline');
    const controller = createFakeController(adapter);
    const rejected = await controller.execute({ action: 'stop', idempotencyKey: 'reject-0001' });
    adapter.state = 'online';
    const replay = await controller.execute({ action: 'stop', idempotencyKey: 'reject-0001' });

    assert.equal(rejected.outcome, 'rejected');
    assert.equal(rejected.failureCode, 'state-conflict');
    assert.strictEqual(replay, rejected);
    assert.equal(adapter.stopCalls, 0);
  });

  it('times out without exposing or invoking a force-kill operation', async () => {
    const adapter = new FakeMinecraftProcessAdapter('offline');
    adapter.autoCompleteStart = false;
    const controller = createFakeController(adapter);
    const result = await controller.execute({ action: 'start', idempotencyKey: 'timeout-0001' });

    assert.equal(result.outcome, 'timed-out');
    assert.equal(result.failureCode, 'operation-timeout');
    assert.equal(result.observation?.state, 'starting');
    assert.equal(adapter.inspectCalls, 11);
    assert.equal('kill' in adapter, false);
    assert.equal('forceKill' in controller, false);
  });

  it('sanitizes adapter failures and validates idempotency keys', async () => {
    const adapter = new FakeMinecraftProcessAdapter('offline');
    adapter.throwOnStart = new Error('secret-runtime-path C:\\private\\server.jar');
    const controller = createFakeController(adapter);
    const failed = await controller.execute({ action: 'start', idempotencyKey: 'failure-0001' });

    assert.equal(failed.outcome, 'failed');
    assert.equal(failed.failureCode, 'adapter-error');
    assert.equal(JSON.stringify(failed).includes('secret-runtime-path'), false);
    assert.throws(
      () => controller.execute({ action: 'start', idempotencyKey: 'short' }),
      (error: unknown) =>
        error instanceof ProcessControlRequestError &&
        error.code === 'invalid-idempotency-key',
    );
  });

  it('bounds completed idempotency history and allows an evicted key to execute again', async () => {
    const adapter = new FakeMinecraftProcessAdapter('offline');
    const controller = createFakeController(adapter, { maximumRememberedOperations: 1 });
    await controller.execute({ action: 'start', idempotencyKey: 'evicted-0001' });
    await controller.execute({ action: 'stop', idempotencyKey: 'retained-0001' });
    await controller.execute({ action: 'start', idempotencyKey: 'evicted-0001' });

    assert.equal(adapter.startCalls, 2);
    assert.equal(adapter.stopCalls, 1);
  });
});

describe('managed platform adapters', () => {
  it('reserves before spawn, binds the pid and releases only after exit', async () => {
    const events: string[] = [];
    let exited = false;
    let generation = 0;
    const ownership: ProcessOwnershipCoordinator = {
      acquire: async () => {
        generation += 1;
        const current = generation;
        events.push(`reserve:${String(current)}`);
        return {
          attachPid: async (pid) => {
            events.push(`attach:${String(current)}:${String(pid)}`);
          },
          release: async () => {
            events.push(`release:${String(current)}`);
          },
        };
      },
    };
    const handle: SpawnedProcess = {
      pid: 4_242,
      getExit: () =>
        exited
          ? { code: 0, signal: null, exitedAt: '2026-08-03T12:00:01.000Z' }
          : undefined,
      readOutput: () => ({
        stdout: '[Server thread/INFO]: Done (0.100s)! For help, type "help"',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
      requestConsoleCommand: async () => {},
      requestGracefulStop: async () => {},
      forceTerminate: async () => {},
      waitForExit: async () => {
        exited = true;
        return handle.getExit();
      },
    };
    const runtime: ProcessRuntime = {
      spawn: async () => {
        events.push('spawn');
        return handle;
      },
    };
    const adapter = new WindowsMinecraftProcessAdapter({
      runtime,
      ownership,
      stopTimeoutMs: 10,
    });

    await adapter.start(fakeControllerPlan);
    assert.deepEqual(events, ['reserve:1', 'spawn', 'attach:1:4242']);
    assert.equal((await adapter.inspect()).state, 'online');
    await adapter.requestGracefulStop();
    assert.deepEqual(events, ['reserve:1', 'spawn', 'attach:1:4242', 'release:1']);
  });

  it('does not publish or release a pid while its durable binding is in flight', async () => {
    let enterAttach: () => void = () => {};
    const attachEntered = new Promise<void>((resolve) => {
      enterAttach = resolve;
    });
    let finishAttach: () => void = () => {};
    const attachGate = new Promise<void>((resolve) => {
      finishAttach = resolve;
    });
    let releases = 0;
    const ownership: ProcessOwnershipCoordinator = {
      acquire: async () => ({
        attachPid: async () => {
          enterAttach();
          await attachGate;
        },
        release: async () => {
          releases += 1;
        },
      }),
    };
    const handle = livingTestHandle(4_242, true);
    const adapter = new WindowsMinecraftProcessAdapter({
      runtime: { spawn: async () => handle },
      ownership,
      hostMetricsSampler: {
        sample: () => ({
          totalMemoryBytes: 16 * 1_024 ** 3,
          freeMemoryBytes: 6 * 1_024 ** 3,
          uptimeSeconds: 3_600,
          availableCpuCount: 8,
        }),
      },
    });

    const starting = adapter.start(fakeControllerPlan);
    await attachEntered;
    const intermediate = await adapter.inspect();
    assert.equal(intermediate.state, 'offline');
    assert.equal(intermediate.pid, undefined);
    assert.equal((await adapter.readMetrics()).process.pid.status, 'unavailable');
    assert.equal(releases, 0);

    finishAttach();
    const published = await starting;
    assert.equal(published.pid, 4_242);
    assert.equal(releases, 0);
  });

  it('blocks spawn on ownership conflict and reports it as a closed controller failure', async () => {
    let spawnCount = 0;
    const ownership: ProcessOwnershipCoordinator = {
      acquire: async () => {
        throw new ProcessOwnershipConflictError();
      },
    };
    const adapter = new WindowsMinecraftProcessAdapter({
      runtime: {
        spawn: async () => {
          spawnCount += 1;
          throw new Error('must not spawn');
        },
      },
      ownership,
    });
    const controller = new MinecraftProcessController({
      adapter,
      launchPlan: fakeControllerPlan,
      operationTimeoutMs: 100,
      pollIntervalMs: 10,
      sleep: async () => {},
    });

    const result = await controller.execute({
      action: 'start',
      idempotencyKey: 'ownership-conflict-0001',
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.failureCode, 'ownership-conflict');
    assert.equal(result.observation?.state, 'offline');
    assert.equal(spawnCount, 0);
    assert.equal(JSON.stringify(result).includes('ownership'), true);
    assert.equal(JSON.stringify(result).includes('PID'), false);
  });

  it('requires online state and rejects concurrent console effects without a queue', async () => {
    let releaseCommand: () => void = () => {};
    const commandGate = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    class CommandTrackingHandle implements SpawnedProcess {
      readonly pid = 4_242;
      readonly commands: MinecraftConsoleCommand[] = [];

      getExit() {
        return undefined;
      }

      readOutput(): ProcessOutputSnapshot {
        return {
          stdout: '[Server thread/INFO]: Done (0.100s)! For help, type "help"',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }

      async requestConsoleCommand(command: MinecraftConsoleCommand): Promise<void> {
        this.commands.push(command);
        await commandGate;
      }

      async requestGracefulStop(): Promise<void> {}

      async forceTerminate(): Promise<void> {}

      async waitForExit(): Promise<undefined> {
        return undefined;
      }
    }

    const handle = new CommandTrackingHandle();
    const runtime: ProcessRuntime = { spawn: async () => handle };
    const adapter = new WindowsMinecraftProcessAdapter({ runtime, stopTimeoutMs: 10 });

    await assert.rejects(adapter.requestConsoleCommand('list-players'), /offline/u);
    await adapter.start(fakeControllerPlan);
    assert.equal((await adapter.inspect()).state, 'online');
    const first = adapter.requestConsoleCommand('list-players');
    await assert.rejects(adapter.requestConsoleCommand('save-all'), /busy/u);
    releaseCommand();
    const receipt = await first;

    assert.deepEqual(handle.commands, ['list-players']);
    assert.equal(receipt.command, 'list-players');
    assert.equal(receipt.state, 'online');
    assert.equal(Object.isFrozen(receipt), true);
    assert.throws(
      () => adapter.requestConsoleCommand('stop' as MinecraftConsoleCommand),
      /not allowed/u,
    );
    assert.equal('write' in adapter, false);
    assert.equal('stdin' in adapter, false);
  });

  it(
    'starts and gracefully stops a disposable Java fixture without touching the server workspace',
    {
      skip:
        hostPlatform === undefined ||
        javaExecutable === undefined ||
        javacExecutable === undefined ||
        !existsSync(javacExecutable),
    },
    async () => {
      assert.ok(hostPlatform);
      const temporaryDirectory = await mkdtemp(join(tmpdir(), 'voidfall-process-fixture-'));
      const runtime = new TrackingRuntime(new NodeProcessRuntime());
      try {
        assert.equal(temporaryDirectory.includes('Servidor'), false);
        await compileJavaFixture(temporaryDirectory);
        const options = { runtime, stopTimeoutMs: 5_000 };
        const adapter =
          hostPlatform === 'win32'
            ? new WindowsMinecraftProcessAdapter(options)
            : new LinuxMinecraftProcessAdapter(options);
        assert.equal((await adapter.readMetrics()).process.pid.status, 'unavailable');
        const started = await adapter.start(javaFixturePlan(temporaryDirectory));
        assert.equal(started.state, 'starting');
        assert.equal(typeof started.pid, 'number');

        await waitForState(adapter, 'online');
        const onlineMetrics = await adapter.readMetrics();
        assert.equal(onlineMetrics.process.pid.status, 'available');
        assert.equal(onlineMetrics.process.uptime.status, 'available');
        assert.match(adapter.readOutput().stdout, /Done \(0\.100s\)!/u);
        const stopped = await adapter.requestGracefulStop();
        assert.equal(stopped.state, 'offline');
        assert.equal(stopped.lastExit?.code, 0);
        assert.equal((await adapter.readMetrics()).process.pid.status, 'unavailable');
        assert.match(adapter.readOutput().stdout, /Stopping server/u);
      } finally {
        await runtime.requestFixtureCleanup();
        await rm(temporaryDirectory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    },
  );

  it(
    'dispatches the closed command catalog against the disposable Java fixture',
    {
      skip:
        hostPlatform === undefined ||
        javaExecutable === undefined ||
        javacExecutable === undefined ||
        !existsSync(javacExecutable),
    },
    async () => {
      assert.ok(hostPlatform);
      const temporaryDirectory = await mkdtemp(join(tmpdir(), 'voidfall-console-fixture-'));
      const runtime = new TrackingRuntime(new NodeProcessRuntime());
      try {
        await compileJavaFixture(temporaryDirectory);
        const adapter =
          hostPlatform === 'win32'
            ? new WindowsMinecraftProcessAdapter({
                runtime,
                stopTimeoutMs: 5_000,
                maximumConsoleLinesPerStream: 10,
              })
            : new LinuxMinecraftProcessAdapter({
                runtime,
                stopTimeoutMs: 5_000,
                maximumConsoleLinesPerStream: 10,
              });
        await adapter.start(javaFixturePlan(temporaryDirectory));
        await waitForState(adapter, 'online');

        const listed = await adapter.requestConsoleCommand('list-players');
        await waitForConsoleLine(adapter, /There are 0 of a max of 20 players online/u);
        const saved = await adapter.requestConsoleCommand('save-all');
        await waitForConsoleLine(adapter, /Saved the game/u);

        assert.equal(listed.command, 'list-players');
        assert.equal(saved.command, 'save-all');
        assert.equal(adapter.readConsole().stderr.lines.length, 0);
        const firstDelta = adapter.readConsoleDelta();
        assert.ok(
          firstDelta.lines.some((line) =>
            /There are 0 of a max of 20 players online/u.test(line.text),
          ),
        );
        assert.ok(firstDelta.lines.some((line) => /Saved the game/u.test(line.text)));
        // A read is retryable until durable persistence acknowledges it.
        assert.deepEqual(adapter.readConsoleDelta().lines, firstDelta.lines);
        adapter.acknowledgeConsoleDelta(firstDelta.acknowledgementCount);
        assert.deepEqual(adapter.readConsoleDelta().lines, []);
        assert.ok(runtime.handle);
        assert.throws(
          () => runtime.handle?.requestConsoleCommand('stop' as MinecraftConsoleCommand),
          /not allowed/u,
        );
        assert.equal('write' in runtime.handle, false);
        assert.equal('forceKill' in adapter, false);
        assert.equal((await adapter.requestGracefulStop()).state, 'offline');
      } finally {
        await runtime.requestFixtureCleanup();
        await rm(temporaryDirectory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    },
  );

  it(
    'performs a full controller restart against the disposable Java fixture',
    {
      skip:
        hostPlatform === undefined ||
        javaExecutable === undefined ||
        javacExecutable === undefined ||
        !existsSync(javacExecutable),
    },
    async () => {
      assert.ok(hostPlatform);
      const temporaryDirectory = await mkdtemp(join(tmpdir(), 'voidfall-controller-fixture-'));
      const runtime = new TrackingRuntime(new NodeProcessRuntime());
      try {
        assert.equal(temporaryDirectory.includes('Servidor'), false);
        await compileJavaFixture(temporaryDirectory);
        const adapter =
          hostPlatform === 'win32'
            ? new WindowsMinecraftProcessAdapter({ runtime, stopTimeoutMs: 5_000 })
            : new LinuxMinecraftProcessAdapter({ runtime, stopTimeoutMs: 5_000 });
        const controller = new MinecraftProcessController({
          adapter,
          launchPlan: javaFixturePlan(temporaryDirectory),
          operationTimeoutMs: 15_000,
          pollIntervalMs: 25,
        });

        const started = await controller.execute({
          action: 'start',
          idempotencyKey: 'fixture-start-0001',
        });
        const restarted = await controller.execute({
          action: 'restart',
          idempotencyKey: 'fixture-restart-0001',
        });
        const stopped = await controller.execute({
          action: 'stop',
          idempotencyKey: 'fixture-stop-0001',
        });

        assert.equal(started.outcome, 'succeeded');
        assert.equal(restarted.outcome, 'succeeded');
        assert.equal(stopped.outcome, 'succeeded');
        assert.equal(stopped.observation?.state, 'offline');
        assert.equal(runtime.spawnCount, 2);
        const restartPhases = restarted.events.map((event) => event.phase);
        assert.equal(
          restartPhases.indexOf('stop-requested') < restartPhases.indexOf('start-requested'),
          true,
        );
      } finally {
        await runtime.requestFixtureCleanup();
        await rm(temporaryDirectory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    },
  );

  it(
    'bounds captured output from the disposable Java fixture',
    {
      skip:
        hostPlatform === undefined ||
        javaExecutable === undefined ||
        javacExecutable === undefined ||
        !existsSync(javacExecutable),
    },
    async () => {
      const temporaryDirectory = await mkdtemp(join(tmpdir(), 'voidfall-output-fixture-'));
      try {
        await compileJavaFixture(temporaryDirectory);
        const runtime = new NodeProcessRuntime({ maximumOutputBytesPerStream: 1_024 });
        const handle = await runtime.spawn(javaFixturePlan(temporaryDirectory, ['flood']));
        const exit = await handle.waitForExit(15_000);
        assert.equal(exit?.code, 0);
        const output = handle.readOutput();
        assert.equal(output.stdoutTruncated, true);
        assert.equal(Buffer.byteLength(output.stdout, 'utf8') <= 1_024, true);
      } finally {
        await rm(temporaryDirectory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    },
  );

  it(
    'rejects a missing executable without producing a process handle',
    { skip: hostPlatform === undefined },
    async () => {
      assert.ok(hostPlatform);
      const missingExecutable =
        hostPlatform === 'win32'
          ? 'Z:\\voidfall-missing\\java.exe'
          : '/voidfall-missing/java';
      const plan: ProcessLaunchPlan = {
        platform: hostPlatform,
        executable: missingExecutable,
        args: ['fixture.java'],
        cwd: hostPlatform === 'win32' ? 'C:\\' : '/',
        shell: false,
        windowsHide: hostPlatform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      };
      await assert.rejects(new NodeProcessRuntime().spawn(plan));
    },
  );

  it('returns a stopping state on timeout and exposes no force-kill operation', async () => {
    class NeverExitingHandle implements SpawnedProcess {
      readonly pid = 4_242;
      gracefulStopRequests = 0;

      getExit() {
        return undefined;
      }

      readOutput(): ProcessOutputSnapshot {
        return {
          stdout: '[Server thread/INFO]: Done (0.100s)! For help, type "help"',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }

      async requestConsoleCommand(): Promise<void> {}

      async requestGracefulStop(): Promise<void> {
        this.gracefulStopRequests += 1;
      }

      /** Present so the double satisfies the interface. The adapter never calls it. */
      async forceTerminate(): Promise<void> {}

      async waitForExit(): Promise<undefined> {
        return undefined;
      }
    }

    const handle = new NeverExitingHandle();
    const runtime: ProcessRuntime = { spawn: async () => handle };
    const adapter = new WindowsMinecraftProcessAdapter({ runtime, stopTimeoutMs: 10 });
    const plan = createMinecraftProcessPlan({
      platform: 'win32',
      javaExecutable: 'C:\\Java\\bin\\java.exe',
      serverDirectory: 'D:\\VoidFallFixture\\server',
      serverJar: 'forge-server.jar',
      initialMemoryMiB: 512,
      maximumMemoryMiB: 1_024,
    });
    await adapter.start(plan);
    assert.equal((await adapter.inspect()).state, 'online');
    assert.equal((await adapter.requestGracefulStop()).state, 'stopping');
    assert.equal(handle.gracefulStopRequests, 1);
    assert.equal('kill' in handle, false);
    assert.equal('forceKill' in adapter, false);
  });
});
