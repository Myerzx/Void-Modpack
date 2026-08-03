import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createMinecraftProcessPlan,
  transitionObservedProcessState,
} from '../src/index.js';

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
