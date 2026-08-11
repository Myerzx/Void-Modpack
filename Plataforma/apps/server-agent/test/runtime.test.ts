import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { ScheduleStep, ServerSchedule } from '@voidfall/contracts';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import {
  MinecraftProcessController,
  createMinecraftProcessPlan,
  type MinecraftConsoleAdapter,
  type MinecraftConsoleDelta,
  type MinecraftProcessAdapter,
  type ProcessObservation,
} from '@voidfall/minecraft-process';
import type { BackupConsistencyLease, OfflineExclusiveBackupGuard } from '@voidfall/server-backup';
import type {
  ConfigurationConsistencyLease,
  OfflineExclusiveConfigurationGuard,
} from '@voidfall/server-configuration';

import { createAgentIdentity } from '../src/agent-client.js';
import { AgentRuntime, type AgentRuntimeEvent } from '../src/runtime.js';
import { DurableProcessOwnershipCoordinator } from '../src/process-ownership.js';
import { loadAgentConfiguration, type Environment } from '../src/runtime-config.js';
import { SchedulerLoop, type ScheduleStepExecutor } from '../src/scheduler-loop.js';
import { AgentWorkTransport } from '../src/work-transport.js';

/**
 * The agent runtime brought up for real, against temporary directories, a
 * temporary database and injected keys.
 *
 * No Minecraft process is started, no real repository is opened and neither
 * `Launcher/workspace` nor `Servidor/workspace` is touched. The process
 * controller is deliberately absent throughout, which is exactly the condition
 * readiness has to report honestly.
 */

const AGENT_ID = '018f6b8c-76a3-7d10-9f2e-1d9e52a63702';
const NOW = new Date('2026-08-05T12:00:00.000Z');
const KEY = Buffer.alloc(32, 7).toString('base64');
/** A real key, because the loader now parses it rather than taking its word. */
const KEY_PAIR = generateKeyPairSync('ed25519');
const PRIVATE_KEY_PEM = KEY_PAIR.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const cleanup: Array<{ database: Database; directory: string }> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const resource = cleanup.pop();
    if (resource !== undefined) {
      await resource.database.close();
      await rm(resource.directory, { recursive: true, force: true });
    }
  }
});

class ImmediateOfflineGuard implements OfflineExclusiveBackupGuard {
  async runWithExclusiveOfflineAccess<T>(
    operation: (lease: BackupConsistencyLease) => Promise<T>,
  ): Promise<T> {
    return operation({ method: 'offline-exclusive-v1', acquiredAt: NOW.toISOString() });
  }
}

/**
 * Stands in for the proof that the server is offline while a config file is
 * rewritten. A real one needs a process controller; this slice has none, which
 * is exactly why the guard is injected rather than built.
 */
class ImmediateConfigurationGuard implements OfflineExclusiveConfigurationGuard {
  async runWithExclusiveOfflineAccess<T>(
    _resourceId: string,
    operation: (lease: ConfigurationConsistencyLease) => Promise<T>,
  ): Promise<T> {
    return operation({ method: 'offline-exclusive-v1', acquiredAt: NOW });
  }
}

async function fixture(options: { readonly withBackups?: boolean; readonly withFiles?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'voidfall-agent-runtime-'));
  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  cleanup.push({ database, directory });

  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'voidfall-runtime-test',
    displayName: 'VoidFall Runtime Test',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '1.20.1-47.4.4',
    maxPlayers: 20,
  });

  // Registered through the real provisioning flow rather than inserted, so a
  // process state can reference this agent the way a live one would.
  const tokenHash = 'a'.repeat(64);
  await repositories.agents.createProvisioningToken({
    serverInstanceId: server.id,
    tokenHash,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    createdAt: NOW,
  });
  const registered = await repositories.agents.register({
    agentId: AGENT_ID,
    serverInstanceId: server.id,
    tokenHash,
    publicKeyPem: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----',
    certificateFingerprint: 'b'.repeat(64),
    softwareVersion: '0.1.0',
    capabilities: ['heartbeat'],
    now: NOW,
  });
  assert.notEqual(registered, undefined);

  const environment: Record<string, string> = {
    VOIDFALL_AGENT_ID: AGENT_ID,
    VOIDFALL_SERVER_INSTANCE_ID: server.id,
    VOIDFALL_CONTROL_API_URL: 'https://control.voidfall.invalid',
    VOIDFALL_AGENT_PRIVATE_KEY_PEM: PRIVATE_KEY_PEM,
    VOIDFALL_DATABASE_URL: 'postgres://voidfall@localhost/voidfall',
    VOIDFALL_SERVER_RELEASE: '1.20.1-forge-47.4.4',
    VOIDFALL_METRICS_DISK_PATH: directory,
  };

  if (options.withFiles === true) {
    const configRoot = join(directory, 'config');
    await mkdir(configRoot, { recursive: true });
    await writeFile(join(configRoot, 'server.properties'), 'motd=VoidFall\n', 'utf8');
    environment.VOIDFALL_AUTHORIZED_ROOT_CONFIG = configRoot;
    environment.VOIDFALL_AUTHORIZED_REVISION_ROOT = join(directory, 'revisions');
  }
  if (options.withBackups === true) {
    const world = join(directory, 'world');
    await mkdir(world, { recursive: true });
    await writeFile(join(world, 'level.dat'), 'level', 'utf8');
    await mkdir(join(directory, 'repository'), { recursive: true });
    await mkdir(join(directory, 'restore'), { recursive: true });
    environment.VOIDFALL_BACKUP_REPOSITORY_ROOT = join(directory, 'repository');
    environment.VOIDFALL_BACKUP_RESTORE_ROOT = join(directory, 'restore');
    environment.VOIDFALL_BACKUP_WORLD_SOURCE = world;
    environment.VOIDFALL_BACKUP_SEAL_KEY = KEY;
    environment.VOIDFALL_BACKUP_SEAL_KEY_ID = 'test-seal';
  }

  return {
    directory,
    database,
    repositories,
    server,
    environment: environment as Environment,
  };
}

function runtimeFor(
  context: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {},
): { readonly runtime: AgentRuntime; readonly events: AgentRuntimeEvent[] } {
  const events: AgentRuntimeEvent[] = [];
  const runtime = new AgentRuntime({
    configuration: loadAgentConfiguration(context.environment),
    repositories: context.repositories,
    bootId: randomUUID(),
    backupGuard: new ImmediateOfflineGuard(),
    configurationGuard: new ImmediateConfigurationGuard(),
    clock: () => NOW,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { runtime, events };
}

/** A scripted control plane, so the work loop is observable and deterministic. */
function scriptedTransport(
  answer: (call: number) => { readonly ok: boolean; readonly body: unknown },
): { readonly transport: AgentWorkTransport; readonly paths: string[] } {
  const paths: string[] = [];
  let call = 0;
  const transport = new AgentWorkTransport({
    baseUrl: 'http://control.invalid',
    allowInsecureDevelopment: true,
    fetch: async (url) => {
      paths.push(url.pathname);
      call += 1;
      const scripted = answer(call);
      return { ok: scripted.ok, status: scripted.ok ? 200 : 503, json: async () => scripted.body };
    },
  });
  return { transport, paths };
}

function testIdentity(context: Awaited<ReturnType<typeof fixture>>) {
  return createAgentIdentity({
    agentId: AGENT_ID,
    serverInstanceId: context.server.id,
    privateKeyPem: PRIVATE_KEY_PEM,
  });
}

describe('readiness never announces a capability it cannot serve', () => {
  it('reports every capability as unavailable with a reason on a bare runtime', async () => {
    const context = await fixture();
    const { runtime } = runtimeFor(context);

    assert.deepEqual(runtime.readiness.announced, []);
    for (const entry of runtime.readiness.capabilities) {
      assert.equal(entry.available, false, entry.capability);
      // "Not available" with no cause is indistinguishable from a bug.
      assert.notEqual(entry.reason, null, entry.capability);
    }
    // And the handler map is empty, so the supervisor cannot claim anything.
    assert.deepEqual(Object.keys(runtime.handlers), []);
  });

  it('announces configuration only once a root is actually configured', async () => {
    const bare = await fixture();
    assert.equal(
      runtimeFor(bare).runtime.readiness.capabilities.find(
        (entry) => entry.capability === 'configuration.apply',
      )?.reason,
      'no-authorized-root-configured',
    );

    const configured = await fixture({ withFiles: true });
    const ready = runtimeFor(configured).runtime.readiness;
    assert.ok(ready.announced.includes('configuration.apply'));
  });

  it('refuses to announce configuration without a guard, and says which fix is missing', async () => {
    const context = await fixture({ withFiles: true });
    // A root, but nothing that can prove the server is offline while the file is
    // rewritten. Rewriting a config a running server holds open is how a world
    // comes back with half a configuration.
    const runtime = new AgentRuntime({
      configuration: loadAgentConfiguration(context.environment),
      repositories: context.repositories,
      bootId: randomUUID(),
      clock: () => NOW,
    });
    const entry = runtime.readiness.capabilities.find(
      (capability) => capability.capability === 'configuration.apply',
    );
    assert.equal(entry?.available, false);
    // Not the same fault as an unconfigured root, and not the same fix.
    assert.equal(entry?.reason, 'no-configuration-guard-configured');
    assert.equal(runtime.handlers['configuration.apply'], undefined);
    assert.equal(runtime.configurationCapability, null);
  });

  it('refuses to announce backup.restore without a controller to verify the boot', async () => {
    const context = await fixture({ withBackups: true });
    const { runtime } = runtimeFor(context);
    // The repository exists, so create is serviceable.
    assert.ok(runtime.readiness.announced.includes('backup.create'));
    assert.ok(runtime.handlers['backup.create'] !== undefined);
    // Restore boots the server to verify. Without a controller that check
    // cannot run, and an unverified restore is one nobody knows the outcome of.
    assert.equal(
      runtime.readiness.capabilities.find((entry) => entry.capability === 'backup.restore')?.reason,
      'no-process-controller-configured',
    );
    assert.equal(runtime.handlers['backup.restore'], undefined);
  });

  it('announces datapack observation only with both a registered root and offline guard', async () => {
    const context = await fixture();
    const adapter: MinecraftProcessAdapter = {
      async inspect() {
        return { state: 'offline', observedAt: NOW.toISOString(), source: 'process-adapter' };
      },
      async start() { throw new Error('unused'); },
      async requestGracefulStop() { throw new Error('unused'); },
      readOutput() { throw new Error('unused'); },
    };
    const withoutRoot = runtimeFor(context, { processAdapter: adapter }).runtime;
    assert.equal(
      withoutRoot.readiness.capabilities.find(
        (entry) => entry.capability === 'datapack-load-order.observe',
      )?.reason,
      'no-server-workspace-registered',
    );

    const withoutGuard = runtimeFor(context, {
      datapackLoadOrderRuntime: { workspaceId: randomUUID(), workspaceRoot: context.directory },
    }).runtime;
    assert.equal(
      withoutGuard.readiness.capabilities.find(
        (entry) => entry.capability === 'datapack-load-order.observe',
      )?.reason,
      'no-datapack-load-order-guard-configured',
    );

    const ready = runtimeFor(context, {
      processAdapter: adapter,
      datapackLoadOrderRuntime: { workspaceId: randomUUID(), workspaceRoot: context.directory },
    }).runtime;
    assert.ok(ready.readiness.announced.includes('datapack-load-order.observe'));
    assert.ok(ready.handlers['datapack-load-order.observe'] !== undefined);
    assert.ok(ready.datapackLoadOrderCapability !== null);
  });

  it('keeps force kill deliberately disabled rather than merely unconfigured', async () => {
    const context = await fixture({ withBackups: true, withFiles: true });
    const { runtime } = runtimeFor(context);
    const forceKill = runtime.readiness.capabilities.find(
      (entry) => entry.capability === 'process.force-kill',
    );
    // Not "missing a dependency" — a decision. Killing a server can lose
    // everything since the last save.
    assert.equal(forceKill?.available, false);
    assert.equal(forceKill?.reason, 'deliberately-disabled');
  });

  it('keeps announced and registered exactly equal, in both directions', async () => {
    const context = await fixture({ withBackups: true, withFiles: true });
    const { runtime } = runtimeFor(context);
    // The two lists are derived from one another, so they cannot drift. Equality
    // rather than containment is the point: a capability announced without a
    // handler is a job claimed and then refused, and a handler registered
    // without an announcement is work this agent can do and never gets asked
    // for. Until this slice `configuration.apply` was the standing exception.
    assert.deepEqual(
      Object.keys(runtime.handlers).sort(),
      [...runtime.readiness.announced].sort(),
    );
    assert.ok(runtime.readiness.announced.includes('configuration.apply'));
    assert.ok(runtime.handlers['configuration.apply'] !== undefined);
  });
});

describe('startup, reconciliation and shutdown', () => {
  it('refreshes a live process snapshot instead of letting operation state expire', async () => {
    const context = await fixture();
    const bootId = randomUUID();
    const adapter: MinecraftProcessAdapter = {
      async inspect() {
        return {
          state: 'online',
          observedAt: NOW.toISOString(),
          source: 'process-adapter',
          pid: 4_242,
        };
      },
      async start() {
        throw new Error('unused');
      },
      async requestGracefulStop() {
        throw new Error('unused');
      },
      readOutput() {
        throw new Error('unused');
      },
    };
    const { runtime, events } = runtimeFor(context, { bootId, processAdapter: adapter });

    assert.equal(await runtime.observeProcessState(), true);

    const state = await context.repositories.processStates.find(context.server.id);
    assert.equal(state?.lifecycle, 'online');
    assert.equal(state?.observedPid, 4_242);
    assert.equal(state?.bootId, bootId);
    assert.equal(state?.stale, false);
    assert.ok(
      events.some((event) => event.kind === 'process-observed' && event.lifecycle === 'online'),
    );
  });

  it('reconciles an orphaned process state before serving anything', async () => {
    const context = await fixture();
    // A previous run died claiming the server was online.
    await context.repositories.processStates.observe({
      serverInstanceId: context.server.id,
      lifecycle: 'online',
      observedPid: 4242,
      bootId: randomUUID(),
      observedBy: AGENT_ID,
      eventId: randomUUID(),
      correlationId: randomUUID(),
      now: new Date(NOW.getTime() - 3_600_000),
    });

    const { runtime, events } = runtimeFor(context);
    const reconciled = await runtime.reconcileOrphanProcessStates();
    assert.equal(reconciled, 1);
    assert.ok(events.some((event) => event.kind === 'reconciled'));

    const state = await context.repositories.processStates.find(context.server.id);
    // A pid nobody is observing is not evidence a server is running.
    assert.equal(state?.lifecycle, 'unknown');
    assert.equal(state?.observedPid, null);
    assert.equal(state?.stale, true);
  });

  it('invalidates a fresh online snapshot immediately when another boot owns the JVM', async () => {
    const context = await fixture();
    const previousBootId = randomUUID();
    const originalOwnership = new DurableProcessOwnershipCoordinator({
      repository: context.repositories.processOwnership,
      serverInstanceId: context.server.id,
      agentId: AGENT_ID,
      agentBootId: previousBootId,
      liveness: { isAlive: async () => true },
      clock: () => NOW,
    });
    const lease = await originalOwnership.acquire();
    await lease.attachPid(4_242);
    await context.repositories.processStates.observe({
      serverInstanceId: context.server.id,
      lifecycle: 'online',
      observedPid: 4_242,
      bootId: previousBootId,
      observedBy: AGENT_ID,
      eventId: randomUUID(),
      correlationId: randomUUID(),
      now: NOW,
    });

    const currentBootId = randomUUID();
    const processOwnership = new DurableProcessOwnershipCoordinator({
      repository: context.repositories.processOwnership,
      serverInstanceId: context.server.id,
      agentId: AGENT_ID,
      agentBootId: currentBootId,
      liveness: { isAlive: async () => true },
      clock: () => NOW,
    });
    const { runtime, events } = runtimeFor(context, {
      bootId: currentBootId,
      processOwnership,
    });
    assert.equal(await runtime.reconcileOrphanProcessStates(), 1);

    const state = await context.repositories.processStates.find(context.server.id);
    assert.equal(state?.lifecycle, 'unknown');
    assert.equal(state?.observedPid, null);
    assert.equal(state?.bootId, null);
    assert.equal(state?.stale, true);
    assert.ok(
      events.some(
        (event) =>
          event.kind === 'process-ownership-reconciled' && event.outcome === 'orphaned',
      ),
    );
  });

  it('starts, records metrics and shuts down cleanly on the signal', async () => {
    const context = await fixture();
    const { runtime, events } = runtimeFor(context);
    const controller = new AbortController();

    const running = runtime.start(controller.signal);
    // Give startup a turn to reconcile and take its first sample.
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await running;

    assert.ok(events.some((event) => event.kind === 'ready'));
    assert.ok(events.some((event) => event.kind === 'metrics-recorded'));
    assert.ok(events.some((event) => event.kind === 'shutdown'));
  });

  it('stores what it can measure and reports the rest as unavailable', async () => {
    const context = await fixture();
    const { runtime } = runtimeFor(context);
    await runtime.collectAndStoreMetrics();

    const series = await context.repositories.telemetry.readSeries({
      serverInstanceId: context.server.id,
      names: ['host.memory.total.bytes', 'game.tps', 'process.resident.bytes'],
      since: new Date(NOW.getTime() - 3_600_000),
    });
    const names = series.map((bucket) => bucket.name);
    assert.ok(names.includes('host.memory.total.bytes'));
    // Tick timing has no approved provider, so nothing was stored for it — and
    // the database would have refused the row anyway.
    assert.equal(names.includes('game.tps'), false);
    // The server is not running, so its process readings are unavailable
    // rather than stored as zero.
    assert.equal(names.includes('process.resident.bytes'), false);
  });

  it('is safe to shut down twice', async () => {
    const context = await fixture();
    const { runtime } = runtimeFor(context);
    await runtime.shutdown();
    await runtime.shutdown();
  });
});

describe('the work loop', () => {
  it('claims work for exactly the capabilities it announced', async () => {
    const context = await fixture({ withBackups: true, withFiles: true });
    const { transport, paths } = scriptedTransport(() => ({
      ok: true,
      body: { schemaVersion: 1, leases: [], retryAfterSeconds: 3_600 },
    }));
    const { runtime } = runtimeFor(context, {
      identity: testIdentity(context),
      workTransport: transport,
    });

    assert.notEqual(runtime.supervisor, null);
    // What it will ask for is what readiness allowed, with nothing added.
    assert.deepEqual(
      [...(runtime.supervisor?.servedCapabilities ?? [])],
      [...runtime.readiness.announced].sort(),
    );

    await runtime.supervisor?.runOnce();
    assert.deepEqual(paths, ['/agent/v1/work/claim']);
  });

  it('reports one boot id across the process rather than two', async () => {
    const context = await fixture({ withFiles: true });
    const bootId = randomUUID();
    const { runtime } = runtimeFor(context, {
      bootId,
      identity: testIdentity(context),
      workTransport: scriptedTransport(() => ({
        ok: true,
        body: { schemaVersion: 1, leases: [], retryAfterSeconds: 60 },
      })).transport,
    });
    // A receipt whose boot id did not match the process state and the console
    // lines from the same run would correlate with nothing.
    assert.equal(runtime.supervisor?.bootId, bootId);
    assert.equal(runtime.readiness.bootId, bootId);
  });

  it('does not dial at all when it has nothing to serve, and says so', async () => {
    const context = await fixture();
    const { transport, paths } = scriptedTransport(() => ({
      ok: true,
      body: { schemaVersion: 1, leases: [], retryAfterSeconds: 60 },
    }));
    const { runtime, events } = runtimeFor(context, {
      identity: testIdentity(context),
      workTransport: transport,
    });

    assert.deepEqual(runtime.readiness.announced, []);
    assert.equal(runtime.supervisor, null);

    const controller = new AbortController();
    const running = runtime.start(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await running;

    // Nothing was claimed, and the reason is on the record: an agent that
    // quietly never dials looks like one whose control plane went away.
    assert.deepEqual(paths, []);
    assert.ok(
      events.some(
        (event) => event.kind === 'work-loop-skipped' && event.reason === 'no-capability-handler',
      ),
    );
  });

  it('names the missing transport rather than the missing handlers', async () => {
    const context = await fixture({ withFiles: true });
    const { runtime, events } = runtimeFor(context);
    assert.equal(runtime.supervisor, null);

    const controller = new AbortController();
    const running = runtime.start(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await running;

    assert.ok(
      events.some(
        (event) => event.kind === 'work-loop-skipped' && event.reason === 'no-transport-configured',
      ),
    );
  });

  it('stops the work loop on the same signal that stops everything else', async () => {
    const context = await fixture({ withFiles: true });
    const { transport } = scriptedTransport(() => ({
      ok: true,
      body: { schemaVersion: 1, leases: [], retryAfterSeconds: 1 },
    }));
    const { runtime, events } = runtimeFor(context, {
      identity: testIdentity(context),
      workTransport: transport,
    });

    const controller = new AbortController();
    const running = runtime.start(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    // Returns rather than hanging: one signal stops the whole agent, instead of
    // leaving a work loop claiming jobs nothing is left to settle.
    await running;

    assert.ok(
      events.some((event) => event.kind === 'supervisor' && event.event.kind === 'stopped'),
    );
    assert.ok(events.some((event) => event.kind === 'shutdown'));
  });
});

describe('the scheduler loop', () => {
  async function schedule(
    context: Awaited<ReturnType<typeof fixture>>,
    steps: readonly ScheduleStep[] = [{ kind: 'backup', scope: 'world' }],
  ): Promise<ServerSchedule> {
    return context.repositories.schedules.create({
      schedule: {
        scheduleId: randomUUID(),
        serverInstanceId: context.server.id,
        name: 'Nightly',
        enabled: true,
        trigger: { timezone: 'UTC', hour: 4, minute: 0, weekdays: [] },
        steps: [...steps],
        reasonCode: 'scheduled-maintenance',
        // Already due.
        nextRunAt: new Date(NOW.getTime() - 60_000).toISOString(),
      },
      now: NOW,
    });
  }

  function loop(
    context: Awaited<ReturnType<typeof fixture>>,
    executor: ScheduleStepExecutor,
    overrides: Partial<ConstructorParameters<typeof SchedulerLoop>[0]> = {},
  ) {
    return new SchedulerLoop({
      repositories: context.repositories,
      serverInstanceId: context.server.id,
      agentId: AGENT_ID,
      executor,
      clock: () => NOW,
      ...overrides,
    });
  }

  it('runs a due schedule once and advances it', async () => {
    const context = await fixture();
    const created = await schedule(context);
    const executed: string[] = [];
    const scheduler = loop(context, {
      async execute({ step }) {
        executed.push(step.kind);
        return { outcome: 'continue' };
      },
    });

    assert.equal(await scheduler.runOnce(), 1);
    assert.deepEqual(executed, ['backup']);

    const runs = await context.repositories.schedules.listRuns(created.scheduleId);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, 'succeeded');

    const after = await context.repositories.schedules.findById(created.scheduleId);
    assert.notEqual(after?.nextRunAt, created.nextRunAt);
  });

  it('will not run the same occurrence twice', async () => {
    const context = await fixture();
    const created = await schedule(context);
    let executions = 0;
    const executor: ScheduleStepExecutor = {
      async execute() {
        executions += 1;
        return { outcome: 'continue' };
      },
    };

    // Two agents, same occurrence. The unique constraint decides.
    const first = loop(context, executor, { agentId: randomUUID() });
    const second = loop(context, executor, { agentId: randomUUID() });
    await first.runOnce();

    // Re-point the schedule at the occurrence that was already run, as a
    // scheduler that woke twice on stale state would.
    await context.database.query(
      'UPDATE server_schedules SET next_run_at = $2 WHERE schedule_id = $1',
      [created.scheduleId, created.nextRunAt],
    );
    await second.runOnce();

    assert.equal(executions, 1);
    const runs = await context.repositories.schedules.listRuns(created.scheduleId);
    assert.equal(runs.length, 1);
  });

  it('records a missed window as skipped instead of running it late', async () => {
    const context = await fixture();
    const created = await context.repositories.schedules.create({
      schedule: {
        scheduleId: randomUUID(),
        serverInstanceId: context.server.id,
        name: 'Stale nightly',
        enabled: true,
        trigger: { timezone: 'UTC', hour: 4, minute: 0, weekdays: [] },
        steps: [{ kind: 'restart', timeoutSeconds: 60 }],
        reasonCode: 'scheduled-maintenance',
        // Three days ago: the agent was down.
        nextRunAt: new Date(NOW.getTime() - 3 * 86_400_000).toISOString(),
      },
      now: NOW,
    });
    let restarts = 0;
    const scheduler = loop(context, {
      async execute({ step }) {
        if (step.kind === 'restart') restarts += 1;
        return { outcome: 'continue' };
      },
    });
    await scheduler.runOnce();

    const runs = await context.repositories.schedules.listRuns(created.scheduleId);
    const skipped = runs.filter((run) => run.status === 'skipped');
    assert.ok(skipped.length >= 1);
    // Running yesterday's window now would restart a live server at an hour
    // nobody chose. At most the current occurrence may execute.
    assert.ok(restarts <= 1);
  });

  it('takes over a run whose scheduler died, and only after the lease lapsed', async () => {
    const context = await fixture();
    const created = await schedule(context);
    const scheduledFor = new Date(created.nextRunAt as string);

    // A dead process holds the occurrence.
    await context.repositories.schedules.claimOccurrence({
      runId: randomUUID(),
      scheduleId: created.scheduleId,
      serverInstanceId: context.server.id,
      scheduledFor,
      claimedBy: randomUUID(),
      leaseSeconds: 600,
      now: new Date(NOW.getTime() - 60_000),
    });

    // Still held: recovery must not touch it.
    const early = loop(context, { async execute() { return { outcome: 'continue' }; } });
    await early.runOnce();
    let runs = await context.repositories.schedules.listRuns(created.scheduleId);
    assert.equal(runs[0]?.status, 'claimed');

    // The lease lapsed. Recovery settles it as abandoned rather than resuming
    // from a step the dead process never confirmed.
    const later = loop(context, { async execute() { return { outcome: 'continue' }; } }, {
      clock: () => new Date(NOW.getTime() + 3_600_000),
    });
    await later.runOnce();
    runs = await context.repositories.schedules.listRuns(created.scheduleId);
    const abandoned = runs.find((run) => run.failureCode === 'scheduler-abandoned');
    assert.notEqual(abandoned, undefined);
  });

  it('settles what it holds when it is shut down mid-run', async () => {
    const context = await fixture();
    const created = await schedule(context, [
      { kind: 'backup', scope: 'world' },
      { kind: 'restart', timeoutSeconds: 60 },
    ]);
    const scheduler = loop(context, {
      async execute() {
        return { outcome: 'continue' };
      },
    });
    await scheduler.runOnce();
    // Nothing held after a completed run.
    await scheduler.releaseHeldRuns();

    const runs = await context.repositories.schedules.listRuns(created.scheduleId);
    assert.equal(runs.length, 1);
    // A completed run is not rewritten by shutdown.
    assert.equal(runs[0]?.status, 'succeeded');
  });

  it('stops the run when a maintenance check says now is not the time', async () => {
    const context = await fixture();
    const created = await schedule(context, [
      { kind: 'maintenance-check', maximumPlayersOnline: 0 },
      { kind: 'restart', timeoutSeconds: 60 },
    ]);
    let restarted = false;
    const scheduler = loop(context, {
      async execute({ step }) {
        if (step.kind === 'maintenance-check') return { outcome: 'skip' };
        restarted = true;
        return { outcome: 'continue' };
      },
    });
    await scheduler.runOnce();

    assert.equal(restarted, false);
    const runs = await context.repositories.schedules.listRuns(created.scheduleId);
    // Skipped is a fact worth recording, not a failure.
    assert.equal(runs[0]?.status, 'skipped');
    assert.equal(runs[0]?.failureCode, null);
  });

  it('records a failed restart as unverified rather than as success', async () => {
    const context = await fixture();
    const created = await schedule(context, [{ kind: 'restart', timeoutSeconds: 60 }]);
    const scheduler = loop(context, {
      async execute() {
        return { outcome: 'failed', failureCode: 'restart-timed-out' };
      },
    });
    await scheduler.runOnce();

    const runs = await context.repositories.schedules.listRuns(created.scheduleId);
    assert.equal(runs[0]?.status, 'failed');
    assert.equal(runs[0]?.failureCode, 'restart-timed-out');
    // The server did not come back, and the run says so.
    assert.equal(runs[0]?.postRestartVerified, false);
  });
});

describe('alerts and retention', () => {
  it('opens the alerts it can judge and leaves the rest to the control plane', async () => {
    const context = await fixture();
    // A process that exited without being asked to.
    await context.repositories.processStates.observe({
      serverInstanceId: context.server.id,
      lifecycle: 'error',
      bootId: randomUUID(),
      observedBy: AGENT_ID,
      eventId: randomUUID(),
      correlationId: randomUUID(),
      now: NOW,
    });

    const { runtime, events } = runtimeFor(context);
    await runtime.collectAndStoreMetrics();

    const open = await context.repositories.telemetry.listAlerts({
      serverInstanceId: context.server.id,
      status: 'open',
    });
    const kinds = open.map((alert) => alert.kind);
    assert.ok(kinds.includes('server.crashed'));
    // An agent cannot evaluate its own absence, and a running one would clear
    // the alert every cycle. That judgement is not its to make.
    assert.equal(kinds.includes('agent.offline'), false);
    // Unacknowledged failures are counted where acknowledgement happens. From
    // here the count only grows, so the alert could never be resolved.
    assert.equal(kinds.includes('job.failed'), false);
    assert.ok(events.some((event) => event.kind === 'alerts-reconciled'));
  });

  it('does not raise a crash from a state nobody is observing', async () => {
    const context = await fixture();
    await context.repositories.processStates.observe({
      serverInstanceId: context.server.id,
      lifecycle: 'error',
      bootId: randomUUID(),
      observedBy: AGENT_ID,
      eventId: randomUUID(),
      correlationId: randomUUID(),
      now: new Date(NOW.getTime() - 3_600_000),
    });
    const { runtime } = runtimeFor(context);
    // Reconciliation marks it stale first: a state nobody has looked at is
    // evidence about the observer, not about the server.
    await runtime.reconcileOrphanProcessStates();
    await runtime.collectAndStoreMetrics();

    const open = await context.repositories.telemetry.listAlerts({
      serverInstanceId: context.server.id,
      status: 'open',
    });
    assert.equal(
      open.some((alert) => alert.kind === 'server.crashed'),
      false,
    );
  });

  it('opens a crash alert once rather than every cycle', async () => {
    const context = await fixture();
    await context.repositories.processStates.observe({
      serverInstanceId: context.server.id,
      lifecycle: 'error',
      bootId: randomUUID(),
      observedBy: AGENT_ID,
      eventId: randomUUID(),
      correlationId: randomUUID(),
      now: NOW,
    });
    const { runtime } = runtimeFor(context);
    await runtime.collectAndStoreMetrics();
    await runtime.collectAndStoreMetrics();

    const open = await context.repositories.telemetry.listAlerts({
      serverInstanceId: context.server.id,
      status: 'open',
    });
    // One alert an operator can act on, not a new one every sample.
    assert.equal(open.filter((alert) => alert.kind === 'server.crashed').length, 1);
  });

  it('prunes metric buckets past the retention window and keeps the rest', async () => {
    const context = await fixture();
    const { runtime, events } = runtimeFor(context);
    await runtime.collectAndStoreMetrics();

    // Nothing is old enough yet, so nothing is discarded.
    assert.deepEqual(await runtime.pruneRetention(), { buckets: 0, backups: 0 });
    assert.ok(events.some((event) => event.kind === 'retention-pruned'));

    // A year on, the same buckets are past the window.
    const later = runtimeFor(context, { clock: () => new Date(NOW.getTime() + 365 * 86_400_000) });
    const pruned = await later.runtime.pruneRetention();
    assert.ok(pruned.buckets > 0);
  });
});

describe('a host that actually launches a server', () => {
  /** Scripted so no JVM is spawned; the controller and adapter are the real ones. */
  class OfflineAdapter implements MinecraftProcessAdapter, MinecraftConsoleAdapter {
    async inspect(): Promise<ProcessObservation> {
      return { state: 'offline', observedAt: NOW.toISOString(), source: 'process-adapter' };
    }
    async start(): Promise<ProcessObservation> {
      throw new Error('This test never starts a server.');
    }
    async requestGracefulStop(): Promise<ProcessObservation> {
      throw new Error('This test never stops a server.');
    }
    readOutput(): never {
      throw new Error('not used');
    }
    readConsole(): never {
      throw new Error('not used');
    }
    async requestConsoleCommand(): Promise<never> {
      throw new Error('This test never dispatches a command.');
    }
  }

  function withProcess(context: Awaited<ReturnType<typeof fixture>>) {
    const adapter = new OfflineAdapter();
    const launchPlan = createMinecraftProcessPlan({
      platform: process.platform === 'win32' ? 'win32' : 'linux',
      // Built from the platform's own temp root, so the plan is absolute on the
      // runner it runs on rather than on the one it was written on.
      javaExecutable: join(tmpdir(), 'java', process.platform === 'win32' ? 'java.exe' : 'java'),
      serverDirectory: join(tmpdir(), 'voidfall-server'),
      serverJar: 'forge-server.jar',
      initialMemoryMiB: 1_024,
      maximumMemoryMiB: 2_048,
    });
    return runtimeFor(context, {
      processController: new MinecraftProcessController({ adapter, launchPlan }),
      consoleAdapter: adapter,
      processAdapter: adapter,
      // Deliberately no injected guards: the runtime must build the real ones
      // from the adapter, which is the whole point of this case.
      backupGuard: undefined as never,
      configurationGuard: undefined as never,
    });
  }

  it('announces everything a configured host can serve, and only that', async () => {
    const context = await fixture({ withBackups: true, withFiles: true });
    const { runtime } = withProcess(context);

    const announced = [...runtime.readiness.announced].sort();
    assert.deepEqual(announced, [
      'backup.create',
      'backup.restore',
      'configuration.apply',
      'console.command',
      'process.control',
    ]);
    // Still equal in both directions, now with five capabilities instead of two.
    assert.deepEqual(Object.keys(runtime.handlers).sort(), announced);

    // Force kill remains a decision, not a missing dependency.
    assert.equal(
      runtime.readiness.capabilities.find((entry) => entry.capability === 'process.force-kill')
        ?.reason,
      'deliberately-disabled',
    );
  });

  it('builds the real guards from the adapter rather than announcing without one', async () => {
    const bare = await fixture({ withFiles: true });
    // No adapter: nothing can prove the server is offline, so nothing is built.
    assert.equal(
      runtimeFor(bare, { backupGuard: undefined as never, configurationGuard: undefined as never })
        .runtime.readiness.capabilities.find(
          (entry) => entry.capability === 'configuration.apply',
        )?.reason,
      'no-configuration-guard-configured',
    );

    const configured = await fixture({ withFiles: true });
    assert.ok(withProcess(configured).runtime.readiness.announced.includes('configuration.apply'));
  });
});

describe('continuous console capture', () => {
  class IncrementalConsoleAdapter implements MinecraftConsoleAdapter {
    readCalls = 0;
    acknowledgements: number[] = [];
    readonly pending = [
      {
        stream: 'stdout' as const,
        text: 'rcon.password=hunter2',
        occurredAt: NOW.toISOString(),
        truncated: true,
      },
    ];

    async inspect(): Promise<ProcessObservation> {
      return { state: 'online', observedAt: NOW.toISOString(), source: 'process-adapter' };
    }

    readConsole(): never {
      throw new Error('incremental capture must not read a legacy snapshot');
    }

    readConsoleDelta(): MinecraftConsoleDelta {
      this.readCalls += 1;
      return {
        readAt: NOW.toISOString(),
        source: 'process-adapter',
        lines: [...this.pending],
        acknowledgementCount: this.pending.length,
        sourceTruncated: false,
      };
    }

    acknowledgeConsoleDelta(count: number): void {
      this.acknowledgements.push(count);
      this.pending.splice(0, count);
    }

    async requestConsoleCommand(): Promise<never> {
      throw new Error('not used');
    }
  }

  it('serializes overlapping ticks and acknowledges only the persisted prefix', async () => {
    const context = await fixture();
    const adapter = new IncrementalConsoleAdapter();
    const { runtime, events } = runtimeFor(context, { consoleAdapter: adapter });

    const [first, overlapping] = await Promise.all([
      runtime.captureConsoleOutput(),
      runtime.captureConsoleOutput(),
    ]);
    assert.equal(first, 1);
    assert.equal(overlapping, 1);
    assert.equal(adapter.readCalls, 1);
    assert.deepEqual(adapter.acknowledgements, [1]);

    const page = await context.repositories.console.read({
      serverInstanceId: context.server.id,
      now: NOW,
    });
    assert.equal(page.lines.length, 1);
    assert.equal(page.lines[0]?.redacted, true);
    assert.equal(page.lines[0]?.truncated, true);
    assert.equal(page.lines[0]?.text.includes('hunter2'), false);
    assert.ok(
      events.some((event) => event.kind === 'console-captured' && event.count === 1),
    );

    assert.equal(await runtime.captureConsoleOutput(), 0);
    assert.equal(adapter.readCalls, 2);
    assert.deepEqual(adapter.acknowledgements, [1]);
  });

  it('persists a visible marker when process-side retention dropped output', async () => {
    const context = await fixture();
    let acknowledged = false;
    const adapter: MinecraftConsoleAdapter = {
      async inspect() {
        return { state: 'online', observedAt: NOW.toISOString(), source: 'process-adapter' };
      },
      readConsole(): never {
        throw new Error('not used');
      },
      readConsoleDelta(): MinecraftConsoleDelta {
        return {
          readAt: NOW.toISOString(),
          source: 'process-adapter',
          lines: [],
          acknowledgementCount: 0,
          sourceTruncated: !acknowledged,
        };
      },
      acknowledgeConsoleDelta(count): void {
        assert.equal(count, 0);
        acknowledged = true;
      },
      async requestConsoleCommand(): Promise<never> {
        throw new Error('not used');
      },
    };
    const { runtime } = runtimeFor(context, { consoleAdapter: adapter });

    assert.equal(await runtime.captureConsoleOutput(), 0);
    assert.equal(acknowledged, true);
    const page = await context.repositories.console.read({
      serverInstanceId: context.server.id,
      now: NOW,
    });
    assert.equal(page.lines.length, 1);
    assert.match(page.lines[0]?.text ?? '', /Output gap/u);
    assert.equal(page.lines[0]?.truncated, true);
    assert.equal(await runtime.captureConsoleOutput(), 0);
    assert.equal((await context.repositories.console.retainedCount(context.server.id)), 1);
  });
});

describe('readiness published where the control plane can read it', () => {
  it('publishes what it serves and why the rest is missing', async () => {
    const context = await fixture({ withFiles: true });
    const { runtime } = runtimeFor(context);
    await runtime.publishReadiness();

    const agent = await context.repositories.agents.findById(AGENT_ID);
    assert.deepEqual([...(agent?.capabilities ?? [])], ['configuration.apply']);
    // Degraded, because backups and process control are absent for reasons an
    // operator could still act on.
    assert.equal(agent?.status, 'degraded');
    // And it moved last_seen_at: an agent that just wrote this is here.
    assert.equal(agent?.lastSeenAt, NOW.toISOString());
  });

  it('reports online when nothing fixable is missing', async () => {
    const context = await fixture({ withBackups: true, withFiles: true });
    const adapter = {
      async inspect(): Promise<ProcessObservation> {
        return { state: 'offline', observedAt: NOW.toISOString(), source: 'process-adapter' };
      },
      async start(): Promise<ProcessObservation> {
        throw new Error('unused');
      },
      async requestGracefulStop(): Promise<ProcessObservation> {
        throw new Error('unused');
      },
      readOutput(): never {
        throw new Error('unused');
      },
      readConsole(): never {
        throw new Error('unused');
      },
      async requestConsoleCommand(): Promise<never> {
        throw new Error('unused');
      },
    };
    const launchPlan = createMinecraftProcessPlan({
      platform: process.platform === 'win32' ? 'win32' : 'linux',
      javaExecutable: join(tmpdir(), 'java', process.platform === 'win32' ? 'java.exe' : 'java'),
      serverDirectory: join(tmpdir(), 'voidfall-server'),
      serverJar: 'forge-server.jar',
      initialMemoryMiB: 1_024,
      maximumMemoryMiB: 2_048,
    });
    const { runtime } = runtimeFor(context, {
      processController: new MinecraftProcessController({ adapter, launchPlan }),
      consoleAdapter: adapter,
      processAdapter: adapter,
      datapackLoadOrderRuntime: {
        workspaceId: randomUUID(),
        workspaceRoot: context.directory,
      },
      backupGuard: undefined as never,
      configurationGuard: undefined as never,
    });
    await runtime.publishReadiness();

    const agent = await context.repositories.agents.findById(AGENT_ID);
    // Force kill and the build worker's capabilities are absent by design. A
    // host exactly as capable as it was meant to be is not degraded, and an
    // agent permanently reporting degraded is one nobody looks at.
    assert.equal(agent?.status, 'online');
  });
});
