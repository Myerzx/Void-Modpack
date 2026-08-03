import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createMinecraftProcessPlan,
  LinuxMinecraftProcessAdapter,
  NodeProcessRuntime,
  transitionObservedProcessState,
  WindowsMinecraftProcessAdapter,
  type ProcessLaunchPlan,
  type ProcessOutputSnapshot,
  type ProcessRuntime,
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
const fixtureSource = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'FakeMinecraftFixture.java',
);

function javaFixturePlan(cwd: string, extraArguments: readonly string[] = []): ProcessLaunchPlan {
  assert.ok(hostPlatform);
  assert.ok(javaExecutable);
  return {
    platform: hostPlatform,
    executable: javaExecutable,
    args: [fixtureSource, ...extraArguments],
    cwd,
    shell: false,
    windowsHide: hostPlatform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  };
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

describe('managed platform adapters', () => {
  it(
    'starts and gracefully stops a disposable Java fixture without touching the server workspace',
    { skip: hostPlatform === undefined || javaExecutable === undefined },
    async () => {
      assert.ok(hostPlatform);
      const temporaryDirectory = await mkdtemp(join(tmpdir(), 'voidfall-process-fixture-'));
      try {
        assert.equal(temporaryDirectory.includes('Servidor'), false);
        const runtime = new NodeProcessRuntime();
        const options = { runtime, stopTimeoutMs: 5_000 };
        const adapter =
          hostPlatform === 'win32'
            ? new WindowsMinecraftProcessAdapter(options)
            : new LinuxMinecraftProcessAdapter(options);
        const started = await adapter.start(javaFixturePlan(temporaryDirectory));
        assert.equal(started.state, 'starting');
        assert.equal(typeof started.pid, 'number');

        await waitForState(adapter, 'online');
        assert.match(adapter.readOutput().stdout, /Done \(0\.100s\)!/u);
        const stopped = await adapter.requestGracefulStop();
        assert.equal(stopped.state, 'offline');
        assert.equal(stopped.lastExit?.code, 0);
        assert.match(adapter.readOutput().stdout, /Stopping server/u);
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    },
  );

  it(
    'bounds captured output from the disposable Java fixture',
    { skip: hostPlatform === undefined || javaExecutable === undefined },
    async () => {
      const temporaryDirectory = await mkdtemp(join(tmpdir(), 'voidfall-output-fixture-'));
      try {
        const runtime = new NodeProcessRuntime({ maximumOutputBytesPerStream: 1_024 });
        const handle = await runtime.spawn(javaFixturePlan(temporaryDirectory, ['flood']));
        const exit = await handle.waitForExit(15_000);
        assert.equal(exit?.code, 0);
        const output = handle.readOutput();
        assert.equal(output.stdoutTruncated, true);
        assert.equal(Buffer.byteLength(output.stdout, 'utf8') <= 1_024, true);
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
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

      async requestGracefulStop(): Promise<void> {
        this.gracefulStopRequests += 1;
      }

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
