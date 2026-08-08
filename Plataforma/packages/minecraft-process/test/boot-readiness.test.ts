import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BOOT_COMPLETED_PATTERN,
  MinecraftProcessController,
  WindowsMinecraftProcessAdapter,
  createMinecraftProcessPlan,
  type ProcessExit,
  type ProcessLaunchPlan,
  type ProcessOutputSnapshot,
  type ProcessRuntime,
  type SpawnedProcess,
} from '../src/index.js';

/**
 * Reaching `online` from what the server actually prints.
 *
 * The evidence that a Minecraft server finished booting is one line it writes
 * when it is ready to accept players. Everything cheaper — the process exists,
 * a port answers, some seconds passed, the JVM is alive — means *starting*, and
 * a control plane that treated any of them as `online` would report a server
 * ready while it was still loading a hundred and eighty mods.
 *
 * There is one definition of that line in this repository,
 * `BOOT_COMPLETED_PATTERN`, and both the sandbox runner and the process
 * adapter read it. These tests hold the adapter and the controller to it.
 */

const PLAN: ProcessLaunchPlan = createMinecraftProcessPlan({
  platform: 'win32',
  javaExecutable: 'C:/java/bin/java.exe',
  serverDirectory: 'C:/servidor',
  serverJar: 'server.jar',
  initialMemoryMiB: 1_024,
  maximumMemoryMiB: 2_048,
});

/** A process whose output and exit this test writes, chunk by chunk. */
class ScriptedProcess implements SpawnedProcess {
  public readonly pid = 4_242;
  #stdout = '';
  #stderr = '';
  #exit: ProcessExit | undefined;
  public stopRequested = false;
  public forceTerminated = false;

  public emit(chunk: string): void {
    this.#stdout += chunk;
  }

  public emitStderr(chunk: string): void {
    this.#stderr += chunk;
  }

  public end(exit: ProcessExit): void {
    this.#exit = exit;
  }

  public getExit(): ProcessExit | undefined {
    return this.#exit;
  }

  public readOutput(): ProcessOutputSnapshot {
    return {
      stdout: this.#stdout,
      stderr: this.#stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }

  public async requestConsoleCommand(): Promise<void> {
    // Nothing: the console catalogue is not what these tests are about.
  }

  public async requestGracefulStop(): Promise<void> {
    this.stopRequested = true;
  }

  public async forceTerminate(): Promise<void> {
    this.forceTerminated = true;
  }

  public async waitForExit(timeoutMs: number): Promise<ProcessExit | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (this.#exit === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.#exit;
  }
}

function runtimeFor(process: ScriptedProcess): ProcessRuntime {
  return { spawn: async () => process };
}

describe('the one definition of "the server finished booting"', () => {
  it('matches the line the server writes and nothing weaker', () => {
    assert.equal(
      BOOT_COMPLETED_PATTERN.test('[12:00:00] [Server thread/INFO]: Done (91.482s)! For help, type "help"'),
      true,
    );
    // Everything cheaper means starting. A server that has opened a port or
    // merely stayed alive has not told anybody it is ready.
    for (const weaker of [
      '[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.20.1',
      '[12:00:00] [Server thread/INFO]: Preparing level "world"',
      '[12:00:00] [Server thread/INFO]: Starting Minecraft server on *:25565',
      '[12:00:00] [Server thread/INFO]: Loaded 181 mods',
    ]) {
      assert.equal(BOOT_COMPLETED_PATTERN.test(weaker), false, weaker);
    }
  });

  it('finds the line when the output arrives split across chunks', async () => {
    const child = new ScriptedProcess();
    const adapter = new WindowsMinecraftProcessAdapter({ runtime: runtimeFor(child) });

    await adapter.start(PLAN);
    assert.equal((await adapter.inspect()).state, 'starting');

    // A pipe hands over whatever it has. The line can be cut anywhere, and a
    // detector that tested each chunk on its own would never see it.
    child.emit('[12:00:00] [Server thread/INFO]: Preparing spawn area\r\n[12:00:0');
    assert.equal((await adapter.inspect()).state, 'starting');
    child.emit('1] [Server thread/INFO]: Done (9');
    assert.equal((await adapter.inspect()).state, 'starting');
    child.emit('1.482s)! For help, type "help"\r\n');

    assert.equal((await adapter.inspect()).state, 'online');
  });

  it('reads the same whether the server writes CRLF or LF', async () => {
    for (const newline of ['\r\n', '\n']) {
      const child = new ScriptedProcess();
      const adapter = new WindowsMinecraftProcessAdapter({ runtime: runtimeFor(child) });
      await adapter.start(PLAN);
      child.emit(`[12:00:01] [Server thread/INFO]: Done (2.0s)! For help, type "help"${newline}`);
      assert.equal((await adapter.inspect()).state, 'online', JSON.stringify(newline));
    }
  });

  it('reports online once and stays there while the process lives', async () => {
    const child = new ScriptedProcess();
    const adapter = new WindowsMinecraftProcessAdapter({ runtime: runtimeFor(child) });
    await adapter.start(PLAN);
    child.emit('Done (1.0s)! For help, type "help"\n');

    assert.equal((await adapter.inspect()).state, 'online');
    // The transition table has no `boot-confirmed` out of `online`, so a
    // second confirmation would throw rather than be ignored. It is only
    // tested while starting, and this is what keeps that true.
    assert.equal((await adapter.inspect()).state, 'online');
    assert.equal((await adapter.inspect()).state, 'online');
  });

  it('never reports online for a process that has already exited', async () => {
    const child = new ScriptedProcess();
    const adapter = new WindowsMinecraftProcessAdapter({ runtime: runtimeFor(child) });
    await adapter.start(PLAN);

    // The line is in the buffer *and* the process is gone: a crash right after
    // reporting ready is still a crash, and the exit is the later fact.
    child.emit('Done (1.0s)! For help, type "help"\n');
    child.end({ code: 1, signal: null, exitedAt: new Date().toISOString() });

    assert.equal((await adapter.inspect()).state, 'error');
  });
});

describe('starting through the controller', () => {
  /** Drives the wait loop without real time passing. */
  function controllerFor(child: ScriptedProcess, operationTimeoutMs = 5_000) {
    const adapter = new WindowsMinecraftProcessAdapter({ runtime: runtimeFor(child) });
    const controller = new MinecraftProcessController({
      adapter,
      launchPlan: PLAN,
      operationTimeoutMs,
      pollIntervalMs: 10,
    });
    return { adapter, controller };
  }

  it('returns succeeded once the server says it is ready', async () => {
    const child = new ScriptedProcess();
    const { controller } = controllerFor(child);

    // Written after the wait starts, the way a real server does.
    setTimeout(() => {
      child.emit('[12:00:01] [Server thread/INFO]: Done (0.4s)! For help, type "help"\n');
    }, 40);

    const result = await controller.execute({ idempotencyKey: 'start-0001', action: 'start' });
    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.observation?.state, 'online');
  });

  it('reports a boot that died rather than waiting out the timeout', async () => {
    const child = new ScriptedProcess();
    const { controller } = controllerFor(child, 30_000);

    setTimeout(() => {
      child.emitStderr('Exception in server tick loop\n');
      child.end({ code: 1, signal: null, exitedAt: new Date().toISOString() });
    }, 40);

    // A crash during boot is a distinct answer from "still starting", and it
    // must not be masked as success or left hanging until a timeout.
    const result = await controller.execute({ idempotencyKey: 'start-0002', action: 'start' });
    assert.notEqual(result.outcome, 'succeeded');
    assert.equal(result.observation?.state, 'error');
  });

  it('times out instead of hanging when the line never comes', async () => {
    const child = new ScriptedProcess();
    const { controller } = controllerFor(child, 200);

    child.emit('[12:00:00] [Server thread/INFO]: Loading 181 mods\n');
    const result = await controller.execute({ idempotencyKey: 'start-0003', action: 'start' });
    assert.equal(result.outcome, 'timed-out');
    assert.equal(result.failureCode, 'operation-timeout');
  });

  it('stops after a start that reached online', async () => {
    const child = new ScriptedProcess();
    const { controller } = controllerFor(child);
    setTimeout(() => child.emit('Done (0.4s)! For help, type "help"\n'), 40);
    assert.equal(
      (await controller.execute({ idempotencyKey: 'start-0004', action: 'start' })).outcome,
      'succeeded',
    );

    // Stop: the server ends, and the observation follows the exit.
    setTimeout(() => child.end({ code: 0, signal: null, exitedAt: new Date().toISOString() }), 40);
    const stopped = await controller.execute({ idempotencyKey: 'stop-0004', action: 'stop' });
    assert.equal(stopped.outcome, 'succeeded');
    assert.equal(stopped.observation?.state, 'offline');
    assert.equal(child.stopRequested, true);
  });

  it('restarts by stopping and starting, ending online again', async () => {
    const first = new ScriptedProcess();
    const second = new ScriptedProcess();
    let launches = 0;
    const adapter = new WindowsMinecraftProcessAdapter({
      runtime: {
        // Each launch is a new process, the way a real restart works: the
        // second one has to announce its own readiness rather than inherit
        // the output the first one left in the buffer.
        spawn: async () => {
          launches += 1;
          const child = launches === 1 ? first : second;
          setTimeout(() => child.emit('Done (0.4s)! For help, type "help"\n'), 30);
          return child;
        },
      },
    });
    const controller = new MinecraftProcessController({
      adapter,
      launchPlan: PLAN,
      operationTimeoutMs: 5_000,
      pollIntervalMs: 10,
    });

    assert.equal(
      (await controller.execute({ idempotencyKey: 'start-0007', action: 'start' })).outcome,
      'succeeded',
    );

    // The running process must be asked to stop before the new one comes up.
    setTimeout(() => first.end({ code: 0, signal: null, exitedAt: new Date().toISOString() }), 30);
    const restarted = await controller.execute({
      idempotencyKey: 'restart-0007',
      action: 'restart',
    });

    assert.equal(restarted.outcome, 'succeeded');
    assert.equal(restarted.observation?.state, 'online');
    assert.equal(first.stopRequested, true);
  });

  /**
   * The reference server reports `Done (555.962s)!` — a real Forge boot runs
   * far past the 60s default. If the configured default is treated as a
   * ceiling, the caller's deadline is silently discarded and a server that
   * booted perfectly is reported as a timeout.
   */
  it('honours a deadline longer than the configured default', async () => {
    const child = new ScriptedProcess();
    const { controller } = controllerFor(child, 200);

    setTimeout(() => child.emit('Done (555.962s)! For help, type "help"\n'), 400);
    const result = await controller.execute({
      idempotencyKey: 'start-0005',
      action: 'start',
      timeoutMs: 30_000,
    });

    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.observation?.state, 'online');
  });

  it('still refuses a deadline beyond what the host allows', async () => {
    const child = new ScriptedProcess();
    const adapter = new WindowsMinecraftProcessAdapter({ runtime: runtimeFor(child) });
    const controller = new MinecraftProcessController({
      adapter,
      launchPlan: PLAN,
      operationTimeoutMs: 200,
      maximumOperationTimeoutMs: 300,
      pollIntervalMs: 10,
    });

    // Asks for 30s from a host that allows 300ms: the ceiling wins, and the
    // wait ends as a timeout rather than running for the requested half minute.
    const result = await controller.execute({
      idempotencyKey: 'start-0006',
      action: 'start',
      timeoutMs: 30_000,
    });
    assert.equal(result.outcome, 'timed-out');
    assert.equal(result.failureCode, 'operation-timeout');
  });
});
