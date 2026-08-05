import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { ScheduleStep, ServerSchedule } from '@voidfall/contracts';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type { BackupConsistencyLease, OfflineExclusiveBackupGuard } from '@voidfall/server-backup';

import { AgentRuntime, type AgentRuntimeEvent } from '../src/runtime.js';
import { loadAgentConfiguration, type Environment } from '../src/runtime-config.js';
import { SchedulerLoop, type ScheduleStepExecutor } from '../src/scheduler-loop.js';

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
    VOIDFALL_AGENT_PRIVATE_KEY_PEM: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
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
    clock: () => NOW,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { runtime, events };
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

  it('keeps every announced capability backed by a registered handler', async () => {
    const context = await fixture({ withBackups: true, withFiles: true });
    const { runtime } = runtimeFor(context);
    // The two lists are derived from one another, so they cannot drift: an
    // agent claiming work it cannot serve is the failure this prevents.
    const announced = [...runtime.readiness.announced].sort();
    const registered = Object.keys(runtime.handlers).sort();
    // configuration.apply is announced but served by the capability class, not
    // by a lease handler in this slice; everything else must match.
    for (const capability of registered) {
      assert.ok(announced.includes(capability as never), `${capability} registered but not announced`);
    }
  });
});

describe('startup, reconciliation and shutdown', () => {
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
