import { randomUUID } from 'node:crypto';

import type { AgentCapability, AlertKind, MetricReading } from '@voidfall/contracts';
import type { Repositories } from '@voidfall/database';
import type {
  MinecraftConsoleAdapter,
  MinecraftProcessAdapter,
  MinecraftProcessController,
} from '@voidfall/minecraft-process';
import { AuthorizedFileService } from '@voidfall/authorized-files';
import { FilesystemBackupService, type OfflineExclusiveBackupGuard } from '@voidfall/server-backup';
import {
  listReviewedConfigurationIds,
  type OfflineExclusiveConfigurationGuard,
} from '@voidfall/server-configuration';

import type { AgentIdentity } from './agent-client.js';
import {
  createArtifactInstallHandler,
  type ApprovedArtifactPayloadReader,
} from './artifact-install-operation.js';
import { createBackupHandler, createRestoreHandler } from './backup-operation.js';
import { collectReadings } from './collectors.js';
import {
  ConfigurationOperationCapability,
  createConfigurationApplyHandler,
} from './configuration-operation.js';
import { createConsoleCommandHandler } from './console-operation.js';
import {
  DatapackLoadOrderObservationCapability,
  createDatapackLoadOrderObservationHandler,
  type TrustedDatapackLoadOrderRuntime,
} from './datapack-load-order-operation.js';
import {
  createOfflineExclusiveBackupGuard,
  createOfflineExclusiveConfigurationGuard,
} from './offline-guards.js';
import { createProcessControlHandler } from './process-operation.js';
import type { ProcessOwnershipReconciler } from './process-ownership.js';
import { evaluateReadiness, type AgentReadiness, type RuntimeDependencies } from './readiness.js';
import type { AgentRuntimeConfiguration } from './runtime-config.js';
import { createDurableScheduleExecutor } from './schedule-executor.js';
import { SchedulerLoop, type ScheduleStepExecutor } from './scheduler-loop.js';
import { AgentSupervisor, type LeaseHandler, type SupervisorEvent } from './supervisor.js';
import type { AgentWorkTransport } from './work-transport.js';

/**
 * Assembles the agent from validated configuration and injected dependencies.
 *
 * Everything is passed in. The runtime constructs no clock, no controller and
 * no database of its own, which is what lets the whole thing be started against
 * temporary directories and a scripted process in a test — and is why those
 * tests prove something about the real startup path rather than about a
 * parallel one written for them.
 *
 * The ordering here is the point: dependencies are built first, readiness is
 * computed from **what was actually built**, and only then are handlers
 * registered for the capabilities readiness allows. A capability cannot be
 * announced by accident, because the handler map is derived from readiness
 * rather than assembled beside it.
 */

/** How long a process state may go unobserved before it is treated as stale. */
const DEFAULT_STALE_PROCESS_SECONDS = 120;
const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
const DEFAULT_METRICS_INTERVAL_MS = 60_000;
const DEFAULT_METRICS_BUCKET_SECONDS = 60;
const DEFAULT_CONSOLE_CAPTURE_INTERVAL_MS = 500;
const DEFAULT_CONSOLE_RETAIN_LINES = 5_000;
/** Retention runs far less often than it changes anything. */
const DEFAULT_RETENTION_INTERVAL_MS = 3_600_000;
const METRICS_RETENTION_DAYS = 30;

/**
 * The alert kinds this agent decides.
 *
 * The two it does not: `agent.offline`, because an agent that has stopped
 * reporting cannot evaluate its own absence and a running one would clear it
 * every cycle; and `job.failed`, because it counts failures nobody has
 * acknowledged and acknowledgement happens in the panel — from here the count
 * only grows, so the alert would open once and never resolve.
 */
const AGENT_OWNED_ALERT_KINDS: ReadonlySet<AlertKind> = new Set<AlertKind>([
  'disk.low',
  'memory.low',
  'server.crashed',
]);

export interface AgentRuntimeDependencies {
  readonly configuration: AgentRuntimeConfiguration;
  readonly repositories: Repositories;
  readonly bootId: string;
  /**
   * Optional. Its absence disables process control, the console and restore —
   * and readiness says so rather than announcing them in a degraded form.
   */
  readonly processController?: MinecraftProcessController;
  readonly consoleAdapter?: MinecraftConsoleAdapter;
  /**
   * What the guards ask whether the server is running. Given separately from
   * the controller because a guard must observe without being able to start
   * anything: the whole claim it makes is that nothing started.
   */
  readonly processAdapter?: MinecraftProcessAdapter;
  /**
   * Reconciles the durable JVM ownership generation before this boot claims
   * work. A different live or uncertain owner is never adopted by PID.
   */
  readonly processOwnership?: ProcessOwnershipReconciler;
  /** Trusted local source and destination for approved artifact installation. */
  readonly artifactInstaller?: {
    readonly reader: ApprovedArtifactPayloadReader;
    readonly serverRoot: string;
  };
  /**
   * Guards the exclusive offline window a backup needs. Built from the adapter
   * when absent; injectable so a test can hold a window open deliberately.
   */
  readonly backupGuard?: OfflineExclusiveBackupGuard;
  /**
   * Guards the exclusive offline window a configuration write needs. Its
   * absence disables `configuration.apply`: rewriting a file a running server
   * has open is how a world comes back with half a config.
   */
  readonly configurationGuard?: OfflineExclusiveConfigurationGuard;
  /** Registered server workspace resolved locally, never from a lease. */
  readonly datapackLoadOrderRuntime?: TrustedDatapackLoadOrderRuntime;
  readonly scheduleExecutor?: ScheduleStepExecutor;
  /**
   * The signing identity and the outbound transport. Both or neither: an
   * identity with nowhere to dial and a transport with nothing to sign are each
   * half of a work loop, and half a work loop claims nothing.
   */
  readonly identity?: AgentIdentity;
  readonly workTransport?: AgentWorkTransport;
  readonly clock?: () => Date;
  readonly onEvent?: (event: AgentRuntimeEvent) => void;
}

export type AgentRuntimeEvent =
  | { readonly kind: 'ready'; readonly announced: readonly AgentCapability[] }
  | { readonly kind: 'reconciled'; readonly count: number }
  | {
      readonly kind: 'process-ownership-reconciled';
      readonly outcome: 'vacant' | 'current' | 'dead-owner-cleared' | 'orphaned';
    }
  | { readonly kind: 'metrics-recorded'; readonly count: number }
  | { readonly kind: 'metrics-failed' }
  | {
      readonly kind: 'process-observed';
      readonly lifecycle: 'unknown' | 'offline' | 'starting' | 'online' | 'stopping' | 'error';
    }
  | { readonly kind: 'process-observation-failed' }
  | {
      readonly kind: 'console-captured';
      readonly count: number;
      readonly sourceTruncated: boolean;
    }
  | { readonly kind: 'console-capture-failed' }
  | { readonly kind: 'alerts-reconciled'; readonly opened: number; readonly resolved: number }
  | { readonly kind: 'retention-pruned'; readonly buckets: number; readonly backups: number }
  | { readonly kind: 'supervisor'; readonly event: SupervisorEvent }
  | {
      readonly kind: 'work-loop-skipped';
      readonly reason: 'no-transport-configured' | 'no-capability-handler';
    }
  | { readonly kind: 'shutdown' };

export class AgentRuntime {
  readonly #dependencies: AgentRuntimeDependencies;
  readonly #authorizedFiles: AuthorizedFileService | null;
  readonly #backupGuard: OfflineExclusiveBackupGuard | undefined;
  readonly #configurationGuard: OfflineExclusiveConfigurationGuard | undefined;
  readonly #backupService: FilesystemBackupService | null;
  readonly #configurationCapability: ConfigurationOperationCapability | null;
  readonly #datapackLoadOrderCapability: DatapackLoadOrderObservationCapability | null;
  readonly #readiness: AgentReadiness;
  readonly #handlers: Readonly<Partial<Record<AgentCapability, LeaseHandler>>>;
  readonly #scheduler: SchedulerLoop | null;
  readonly #supervisor: AgentSupervisor | null;
  #timers: NodeJS.Timeout[] = [];
  #consoleCaptureInFlight: Promise<number> | undefined;

  public constructor(dependencies: AgentRuntimeDependencies) {
    this.#dependencies = dependencies;
    const { configuration } = dependencies;

    // --- Build what the configuration authorizes, and nothing else. ----------
    this.#authorizedFiles =
      configuration.authorizedFiles === null
        ? null
        : new AuthorizedFileService({
            revisionRoot: configuration.authorizedFiles.revisionRoot,
            roots: [
              {
                rootId: configuration.authorizedFiles.rootId,
                rootPath: configuration.authorizedFiles.rootPath,
                readableExtensions: ['.json', '.properties', '.toml'],
                writableExtensions: ['.json', '.properties', '.toml'],
                maximumFileBytes: 1_048_576,
              },
            ],
          });

    // Guards first: they are what makes `offline-exclusive-v1` an assertion
    // rather than a label, and the backup service below cannot be built without
    // one. They exist exactly when there is an adapter to ask.
    this.#backupGuard =
      dependencies.backupGuard ??
      (dependencies.processAdapter === undefined
        ? undefined
        : createOfflineExclusiveBackupGuard({
            repositories: dependencies.repositories,
            adapter: dependencies.processAdapter,
            serverInstanceId: configuration.serverInstanceId,
            // The backup capability takes the lock as this agent.
            ownsLock: (lease) => lease.ownerId === configuration.agentId,
            ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
          }));
    this.#configurationGuard =
      dependencies.configurationGuard ??
      (dependencies.processAdapter === undefined
        ? undefined
        : createOfflineExclusiveConfigurationGuard({
            repositories: dependencies.repositories,
            adapter: dependencies.processAdapter,
            serverInstanceId: configuration.serverInstanceId,
            // The persistent configuration service mints its own owner id, so
            // the window is recognised by what it was taken for.
            ownsLock: (lease) => lease.operation.startsWith('configuration.'),
            ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
          }));

    this.#backupService =
      configuration.backups === null || this.#backupGuard === undefined
        ? null
        : new FilesystemBackupService({
            repositoryRoot: configuration.backups.repositoryRoot,
            guard: this.#backupGuard,
            sealKey: configuration.backups.sealKey,
            ...(configuration.backups.encryptionKey === null
              ? {}
              : { encryptionKey: configuration.backups.encryptionKey }),
            ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
          });

    this.#configurationCapability = this.#buildConfigurationCapability();
    this.#datapackLoadOrderCapability = this.#buildDatapackLoadOrderCapability();

    // --- Readiness from what exists, not from what was asked for. -----------
    const runtimeDependencies: RuntimeDependencies = {
      hasAuthorizedFiles: this.#authorizedFiles !== null,
      hasConfigurationGuard: this.#configurationGuard !== undefined,
      hasConfigurationCapability: this.#configurationCapability !== null,
      hasArtifactInstaller:
        dependencies.artifactInstaller !== undefined && dependencies.processAdapter !== undefined,
      hasRegisteredServerWorkspace: dependencies.datapackLoadOrderRuntime !== undefined,
      hasDatapackLoadOrderGuard: dependencies.processAdapter !== undefined,
      hasDatapackLoadOrderCapability: this.#datapackLoadOrderCapability !== null,
      hasBackupService: this.#backupService !== null,
      hasProcessController: dependencies.processController !== undefined,
      hasConsoleAdapter: dependencies.consoleAdapter !== undefined,
    };
    this.#readiness = evaluateReadiness({
      bootId: dependencies.bootId,
      configuration,
      dependencies: runtimeDependencies,
    });

    this.#handlers = this.#registerHandlers();

    // An enabled scheduler gets an executor either way. Building the loop only
    // when one was injected meant `schedulerEnabled=true` could come up with
    // nothing running the windows and nothing saying so — the schedules were
    // simply never claimed, which looks exactly like a scheduler that has
    // nothing due.
    this.#scheduler = configuration.schedulerEnabled
      ? new SchedulerLoop({
          repositories: dependencies.repositories,
          serverInstanceId: configuration.serverInstanceId,
          agentId: configuration.agentId,
          executor:
            dependencies.scheduleExecutor ??
            createDurableScheduleExecutor({
              repositories: dependencies.repositories,
              serverInstanceId: configuration.serverInstanceId,
              ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
            }),
          ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
        })
      : null;

    // The supervisor is built only when it has somewhere to dial, something to
    // sign with, and at least one capability to serve. It is given the runtime's
    // boot id rather than minting its own, so a receipt, a process state and a
    // console capture from this process all name the same run.
    this.#supervisor =
      dependencies.identity === undefined ||
      dependencies.workTransport === undefined ||
      Object.keys(this.#handlers).length === 0
        ? null
        : new AgentSupervisor({
            identity: dependencies.identity,
            transport: dependencies.workTransport,
            handlers: this.#handlers,
            bootId: dependencies.bootId,
            ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
            onEvent: (event) => dependencies.onEvent?.({ kind: 'supervisor', event }),
          });
  }

  /**
   * Builds the typed configuration capability, or nothing.
   *
   * `null` rather than a throw: a capability that cannot be constructed is one
   * this deployment does not have, and readiness reports it with a reason. The
   * alternative — letting construction fail the whole startup — would take an
   * agent that can still serve backups and process control offline over a
   * configuration root it was never going to use.
   */
  #buildConfigurationCapability(): ConfigurationOperationCapability | null {
    const { configuration, repositories } = this.#dependencies;
    const configurationGuard = this.#configurationGuard;
    if (configuration.authorizedFiles === null || configurationGuard === undefined) return null;
    // The allowlist is the closed product registry, never anything the control
    // plane sends. A command may select a reviewed resource; it may not name one.
    const authorizedResourceIds = listReviewedConfigurationIds();
    if (authorizedResourceIds.length === 0) return null;
    try {
      return new ConfigurationOperationCapability({
        serverInstanceId: configuration.serverInstanceId,
        runtime: {
          configurationRoot: configuration.authorizedFiles.rootPath,
          revisionRepositoryRoot: configuration.authorizedFiles.revisionRoot,
          authorizedResourceIds,
        },
        guard: configurationGuard,
        configurationRepository: repositories.configuration,
        operationalLocks: repositories.operationalLocks,
        ...(this.#dependencies.clock === undefined ? {} : { clock: this.#dependencies.clock }),
      });
    } catch {
      return null;
    }
  }

  #buildDatapackLoadOrderCapability(): DatapackLoadOrderObservationCapability | null {
    const runtime = this.#dependencies.datapackLoadOrderRuntime;
    const adapter = this.#dependencies.processAdapter;
    if (runtime === undefined || adapter === undefined) return null;
    try {
      return new DatapackLoadOrderObservationCapability({
        repositories: this.#dependencies.repositories,
        processAdapter: adapter,
        serverInstanceId: this.#dependencies.configuration.serverInstanceId,
        agentId: this.#dependencies.configuration.agentId,
        runtime,
        ...(this.#dependencies.clock === undefined ? {} : { clock: this.#dependencies.clock }),
      });
    } catch {
      return null;
    }
  }

  /**
   * Builds the handler map from readiness.
   *
   * Derived rather than assembled independently: if a capability is announced,
   * a handler exists for it, and if a handler exists it was announced. Keeping
   * the two lists in step by hand is how an agent ends up claiming work it
   * cannot serve.
   */
  #registerHandlers(): Readonly<Partial<Record<AgentCapability, LeaseHandler>>> {
    const { configuration, repositories, bootId } = this.#dependencies;
    const handlers: Partial<Record<AgentCapability, LeaseHandler>> = {};
    const available = new Set(this.#readiness.announced);

    if (available.has('configuration.apply') && this.#configurationCapability !== null) {
      handlers['configuration.apply'] = createConfigurationApplyHandler({
        repositories,
        capability: this.#configurationCapability,
        serverInstanceId: configuration.serverInstanceId,
      });
    }

    if (
      available.has('artifact.install') &&
      this.#dependencies.artifactInstaller !== undefined &&
      this.#dependencies.processAdapter !== undefined
    ) {
      handlers['artifact.install'] = createArtifactInstallHandler({
        repositories,
        reader: this.#dependencies.artifactInstaller.reader,
        processAdapter: this.#dependencies.processAdapter,
        serverInstanceId: configuration.serverInstanceId,
        serverRoot: this.#dependencies.artifactInstaller.serverRoot,
        ...(this.#dependencies.clock === undefined ? {} : { clock: this.#dependencies.clock }),
      });
    }

    if (
      available.has('datapack-load-order.observe') &&
      this.#datapackLoadOrderCapability !== null
    ) {
      handlers['datapack-load-order.observe'] = createDatapackLoadOrderObservationHandler({
        repositories,
        capability: this.#datapackLoadOrderCapability,
        serverInstanceId: configuration.serverInstanceId,
        ...(this.#dependencies.clock === undefined ? {} : { clock: this.#dependencies.clock }),
      });
    }

    if (available.has('process.control') && this.#dependencies.processController !== undefined) {
      handlers['process.control'] = createProcessControlHandler({
        repositories,
        controller: this.#dependencies.processController,
        ...(this.#dependencies.consoleAdapter === undefined
          ? {}
          : { consoleAdapter: this.#dependencies.consoleAdapter }),
        serverInstanceId: configuration.serverInstanceId,
        agentId: configuration.agentId,
        bootId,
        ...(this.#dependencies.clock === undefined ? {} : { clock: this.#dependencies.clock }),
      });
    }

    if (available.has('console.command') && this.#dependencies.consoleAdapter !== undefined) {
      handlers['console.command'] = createConsoleCommandHandler({
        repositories,
        consoleAdapter: this.#dependencies.consoleAdapter,
        serverInstanceId: configuration.serverInstanceId,
        agentId: configuration.agentId,
        bootId,
        ...(this.#dependencies.clock === undefined ? {} : { clock: this.#dependencies.clock }),
      });
    }

    if (
      available.has('backup.create') &&
      this.#backupService !== null &&
      configuration.backups !== null
    ) {
      const shared = {
        repositories,
        backupService: this.#backupService,
        serverInstanceId: configuration.serverInstanceId,
        serverRelease: configuration.serverRelease,
        agentId: configuration.agentId,
        sources: [{ logicalName: 'world', path: configuration.backups.worldSourcePath }],
        retentionPolicyId: 'default',
        sealKeyId: configuration.backups.sealKey.keyId,
        encryptionKeyId: configuration.backups.encryptionKey?.keyId ?? null,
        ...(this.#dependencies.clock === undefined ? {} : { clock: this.#dependencies.clock }),
      };
      handlers['backup.create'] = createBackupHandler(shared);

      if (available.has('backup.restore') && this.#dependencies.processController !== undefined) {
        handlers['backup.restore'] = createRestoreHandler({
          ...shared,
          isolatedParentRoot: configuration.backups.isolatedRestoreRoot,
          controller: this.#dependencies.processController,
        });
      }
    }

    return Object.freeze(handlers);
  }

  public get readiness(): AgentReadiness {
    return this.#readiness;
  }

  public get handlers(): Readonly<Partial<Record<AgentCapability, LeaseHandler>>> {
    return this.#handlers;
  }

  public get authorizedFiles(): AuthorizedFileService | null {
    return this.#authorizedFiles;
  }

  public get configurationCapability(): ConfigurationOperationCapability | null {
    return this.#configurationCapability;
  }

  public get datapackLoadOrderCapability(): DatapackLoadOrderObservationCapability | null {
    return this.#datapackLoadOrderCapability;
  }

  /** `null` when this agent is not claiming work, for whatever reason. */
  public get supervisor(): AgentSupervisor | null {
    return this.#supervisor;
  }

  public get backupService(): FilesystemBackupService | null {
    return this.#backupService;
  }

  /**
   * Reconciles process states nobody has observed recently.
   *
   * Run at startup **and** periodically. At startup because this agent's own
   * previous run may have died holding a state that says a server is online
   * when the process is gone; periodically because an agent that stops
   * reporting leaves the same stale claim behind, and nothing else notices.
   */
  public async reconcileOrphanProcessStates(): Promise<number> {
    const now = (this.#dependencies.clock ?? (() => new Date()))();
    let ownershipInvalidated = 0;
    const ownership = await this.#dependencies.processOwnership?.reconcile();
    if (ownership !== undefined) {
      this.#dependencies.onEvent?.({
        kind: 'process-ownership-reconciled',
        outcome: ownership.kind,
      });
      if (ownership.kind === 'dead-owner-cleared' || ownership.kind === 'orphaned') {
        const invalidated = await this.#dependencies.repositories.processStates.invalidate({
          serverInstanceId: this.#dependencies.configuration.serverInstanceId,
          eventId: randomUUID(),
          // The ownership generation is a UUID and is the causal identity for
          // this invalidation; no operation exists during startup recovery.
          correlationId: ownership.correlationId,
          now,
        });
        if (invalidated !== undefined) ownershipInvalidated = 1;
      }
    }
    const observedBefore = new Date(now.getTime() - DEFAULT_STALE_PROCESS_SECONDS * 1_000);
    const reconciled = await this.#dependencies.repositories.processStates.reconcileStale({
      observedBefore,
      now,
    });
    const count = ownershipInvalidated + reconciled.length;
    this.#dependencies.onEvent?.({ kind: 'reconciled', count });
    return count;
  }

  /**
   * Refreshes the durable process snapshot from the adapter that owns it.
   *
   * Operation completion records an immediate result, but that result is not
   * a heartbeat. Without this periodic observation an otherwise healthy JVM
   * becomes `unknown` as soon as the stale-state window elapses. A failed
   * inspection is deliberately not written: reconciliation can then expire
   * the previous observation instead of replacing uncertainty with a guess.
   */
  public async observeProcessState(): Promise<boolean> {
    const adapter = this.#dependencies.processAdapter;
    if (adapter === undefined) return false;
    try {
      const observation = await adapter.inspect();
      const now = new Date(observation.observedAt);
      if (Number.isNaN(now.getTime())) throw new Error('invalid process observation timestamp');
      await this.#dependencies.repositories.processStates.observe({
        serverInstanceId: this.#dependencies.configuration.serverInstanceId,
        eventId: randomUUID(),
        lifecycle: observation.state,
        observedBy: this.#dependencies.configuration.agentId,
        correlationId: this.#dependencies.bootId,
        now,
        ...(observation.pid === undefined ? {} : { observedPid: observation.pid }),
        ...(observation.pid === undefined ? {} : { bootId: this.#dependencies.bootId }),
      });
      this.#dependencies.onEvent?.({
        kind: 'process-observed',
        lifecycle: observation.state,
      });
      return true;
    } catch {
      this.#dependencies.onEvent?.({ kind: 'process-observation-failed' });
      return false;
    }
  }

  /**
   * Takes one sample, stores it, and decides what it means.
   *
   * One sample for both, deliberately. Evaluating alerts against a second,
   * separately taken sample would raise an alert naming a number that is not
   * the number stored, and an operator who went to check the metric that
   * raised it would find a different one.
   *
   * Failure is swallowed and reported as an event. Losing a sample must never
   * take down an agent that is otherwise serving operations.
   */
  public async collectAndStoreMetrics(): Promise<number> {
    try {
      const { aggregateReadings } = await import('@voidfall/server-telemetry');
      const readings = await collectReadings({
        diskPath: this.#dependencies.configuration.metricsDiskPath,
        ...(this.#dependencies.clock === undefined ? {} : { clock: this.#dependencies.clock }),
      });
      const buckets = aggregateReadings({
        readings,
        bucketSeconds: DEFAULT_METRICS_BUCKET_SECONDS,
      });
      const stored = await this.#dependencies.repositories.telemetry.recordBuckets({
        serverInstanceId: this.#dependencies.configuration.serverInstanceId,
        buckets,
        now: (this.#dependencies.clock ?? (() => new Date()))(),
      });
      this.#dependencies.onEvent?.({ kind: 'metrics-recorded', count: stored });
      await this.#reconcileAlerts(readings);
      return stored;
    } catch {
      this.#dependencies.onEvent?.({ kind: 'metrics-failed' });
      return 0;
    }
  }

  /**
   * Persists a retryable prefix of complete process output lines.
   *
   * The adapter keeps the prefix until this method acknowledges it after the
   * database commit. Calls are serialized because a timer tick may overlap a
   * slow PGlite/PostgreSQL write; overlapping reads would persist one prefix
   * twice before either caller could acknowledge it.
   */
  public captureConsoleOutput(): Promise<number> {
    if (this.#consoleCaptureInFlight !== undefined) return this.#consoleCaptureInFlight;
    const capture = this.#captureConsoleOutputOnce().finally(() => {
      if (this.#consoleCaptureInFlight === capture) this.#consoleCaptureInFlight = undefined;
    });
    this.#consoleCaptureInFlight = capture;
    return capture;
  }

  async #captureConsoleOutputOnce(): Promise<number> {
    const adapter = this.#dependencies.consoleAdapter;
    if (
      adapter?.readConsoleDelta === undefined ||
      adapter.acknowledgeConsoleDelta === undefined
    ) {
      return 0;
    }
    try {
      const delta = adapter.readConsoleDelta();
      if (delta.lines.length > 0 || delta.sourceTruncated) {
        const now = (this.#dependencies.clock ?? (() => new Date()))();
        await this.#dependencies.repositories.console.append({
          serverInstanceId: this.#dependencies.configuration.serverInstanceId,
          lines: [
            ...(delta.sourceTruncated
              ? [{
                  stream: 'stderr' as const,
                  text: '[VoidFall] Output gap: process-side retention discarded earlier lines.',
                  occurredAt: now,
                  truncated: true,
                }]
              : []),
            ...delta.lines.map((line) => ({
              stream: line.stream,
              text: line.text,
              occurredAt: new Date(line.occurredAt),
              truncated: line.truncated,
            })),
          ],
          bootId: this.#dependencies.bootId,
          retainLines: DEFAULT_CONSOLE_RETAIN_LINES,
          now,
        });
        adapter.acknowledgeConsoleDelta(delta.acknowledgementCount);
      }
      if (delta.lines.length > 0 || delta.sourceTruncated) {
        this.#dependencies.onEvent?.({
          kind: 'console-captured',
          count: delta.lines.length,
          sourceTruncated: delta.sourceTruncated,
        });
      }
      return delta.lines.length;
    } catch {
      this.#dependencies.onEvent?.({ kind: 'console-capture-failed' });
      return 0;
    }
  }

  /**
   * Opens and resolves the alerts this agent is in a position to judge.
   *
   * Deliberately only three of the five kinds. `agent.offline` is decided by
   * whoever notices the silence — an agent that has stopped reporting cannot
   * evaluate its own absence, and one that is running would clear the alert
   * every cycle. `job.failed` counts failures nobody has acknowledged, and
   * acknowledgement happens in the panel; from here the count only ever grows,
   * so the alert would open once and never be resolvable.
   *
   * Both the candidates and the open alerts are filtered to the same set.
   * Passing every open alert while producing only some kinds of candidate would
   * resolve the control plane's alerts on the strength of this agent not having
   * looked at them.
   */
  async #reconcileAlerts(readings: readonly MetricReading[]): Promise<void> {
    const { evaluateAlerts, reconcileAlerts } = await import('@voidfall/server-telemetry');
    const { repositories, configuration } = this.#dependencies;
    const now = (this.#dependencies.clock ?? (() => new Date()))();

    const state = await repositories.processStates.find(configuration.serverInstanceId);
    const candidates = evaluateAlerts({
      readings,
      observed: {
        // `error` is the lifecycle a process reaches by exiting without having
        // been asked to. A stale state is not evidence of a crash — it is
        // evidence that nobody is looking.
        serverCrashed: state?.lifecycle === 'error' && state.stale !== true,
        // Fixed inputs for the two kinds this agent does not own, so their
        // candidates never appear and the filter below has nothing to drop.
        agentLastSeenAt: now.toISOString(),
        failedJobCount: 0,
      },
      now,
    }).filter((candidate) => AGENT_OWNED_ALERT_KINDS.has(candidate.kind));

    const open = (
      await repositories.telemetry.listAlerts({
        serverInstanceId: configuration.serverInstanceId,
        status: 'open',
        limit: 200,
      })
    ).filter((alert) => AGENT_OWNED_ALERT_KINDS.has(alert.kind));

    const { toOpen, toResolve } = reconcileAlerts({
      open: open.map((alert) => ({ kind: alert.kind, alertId: alert.alertId })),
      candidates,
      readings,
    });

    for (const candidate of toOpen) {
      await repositories.telemetry.openAlert({
        alertId: randomUUID(),
        serverInstanceId: configuration.serverInstanceId,
        kind: candidate.kind,
        severity: candidate.severity,
        metricName: candidate.metricName,
        observedValue: candidate.observedValue,
        threshold: candidate.threshold,
        // Carried through so an operator can tell an alert raised from a
        // measurement apart from one derived or asserted.
        source: candidate.source,
        now,
      });
    }
    for (const alertId of toResolve) {
      await repositories.telemetry.resolveAlert(alertId, now);
    }
    if (toOpen.length > 0 || toResolve.length > 0) {
      this.#dependencies.onEvent?.({
        kind: 'alerts-reconciled',
        opened: toOpen.length,
        resolved: toResolve.length,
      });
    }
  }

  /**
   * Publishes readiness where the control plane can read it.
   *
   * This agent never listens, so there is nothing on the host to ask. Readiness
   * is published instead of served, which is the same reason the work loop
   * dials out rather than accepting connections.
   *
   * `degraded` when anything an operator could still fix is missing. Force kill
   * and the capabilities that belong to other processes are excluded: a host
   * that is exactly as capable as it was designed to be is not degraded, and an
   * agent permanently reporting `degraded` is one nobody looks at.
   */
  public async publishReadiness(): Promise<void> {
    const { repositories, configuration } = this.#dependencies;
    const now = (this.#dependencies.clock ?? (() => new Date()))();
    const fixable = this.#readiness.capabilities.filter(
      (entry) => !entry.available && entry.reason !== 'no-handler-implemented' && entry.reason !== 'deliberately-disabled',
    );
    await repositories.agents
      .publishReadiness({
        agentId: configuration.agentId,
        status: fixable.length === 0 ? 'online' : 'degraded',
        capabilities: this.#readiness.announced,
        readiness: this.#readiness.capabilities.map((entry) => ({
          capability: entry.capability,
          available: entry.available,
          reason: entry.reason,
        })),
        observedAt: now,
      })
      // Swallowed: an agent that cannot publish what it can do can still do it,
      // and refusing to serve because the notice did not land would be worse
      // than serving quietly.
      .catch(() => undefined);
  }

  /**
   * Discards what the retention windows no longer cover.
   *
   * It runs on a timer as well as after a backup, because a repository that
   * stopped growing still has expiries passing: an agent that only pruned when
   * something new arrived would hold a stopped server's last snapshots forever.
   *
   * Failures are swallowed per target. Metrics retention and backup retention
   * are unrelated, and a disk error in one is no reason to stop trimming the
   * other.
   */
  public async pruneRetention(): Promise<{ readonly buckets: number; readonly backups: number }> {
    const now = (this.#dependencies.clock ?? (() => new Date()))();
    const before = new Date(now.getTime() - METRICS_RETENTION_DAYS * 86_400_000);
    const buckets = await this.#dependencies.repositories.telemetry
      .pruneBuckets(before)
      .catch(() => 0);
    const backups = (await this.#backupService?.pruneExpiredBackups().catch(() => []))?.length ?? 0;
    this.#dependencies.onEvent?.({ kind: 'retention-pruned', buckets, backups });
    return { buckets, backups };
  }

  /**
   * Starts the periodic work and returns when the signal aborts.
   *
   * Reconciliation runs once before anything is scheduled, so an agent that
   * crashed mid-operation does not serve a first request against a state it
   * knows is stale. Only then does the work loop start claiming: the first job
   * this agent accepts must not be decided against a state it already knows to
   * be false.
   */
  public async start(signal: AbortSignal): Promise<void> {
    await this.reconcileOrphanProcessStates();
    await this.observeProcessState();
    await this.publishReadiness();
    await this.collectAndStoreMetrics();
    await this.captureConsoleOutput();
    this.#dependencies.onEvent?.({ kind: 'ready', announced: this.#readiness.announced });

    if (this.#supervisor === null) {
      // Not claiming work is a state worth naming. An agent that quietly never
      // dials looks identical to one whose control plane went away, and only
      // one of those is something an operator can fix.
      this.#dependencies.onEvent?.({
        kind: 'work-loop-skipped',
        reason:
          this.#dependencies.identity === undefined ||
          this.#dependencies.workTransport === undefined
            ? 'no-transport-configured'
            : 'no-capability-handler',
      });
    }

    const reconcileTimer = setInterval(() => {
      void this.observeProcessState()
        .then(() => this.reconcileOrphanProcessStates())
        .catch(() => undefined);
    }, DEFAULT_RECONCILE_INTERVAL_MS);
    const metricsTimer = setInterval(() => {
      // Republished on the same tick: it also moves `last_seen_at`, and an
      // agent that published once at boot and then went quiet is exactly the
      // one an operator needs to be able to tell apart from a healthy one.
      void this.publishReadiness();
      void this.collectAndStoreMetrics();
    }, DEFAULT_METRICS_INTERVAL_MS);
    const retentionTimer = setInterval(() => {
      void this.pruneRetention().catch(() => undefined);
    }, DEFAULT_RETENTION_INTERVAL_MS);
    const consoleTimer = setInterval(() => {
      void this.captureConsoleOutput();
    }, DEFAULT_CONSOLE_CAPTURE_INTERVAL_MS);
    // Timers must not hold the process open on their own; shutdown is decided
    // by the signal, not by whether a periodic task happens to be pending.
    reconcileTimer.unref();
    metricsTimer.unref();
    retentionTimer.unref();
    consoleTimer.unref();
    this.#timers = [reconcileTimer, metricsTimer, retentionTimer, consoleTimer];

    // Both loops take the same signal, so one shutdown stops the whole agent
    // rather than leaving a work loop claiming jobs a stopped scheduler can no
    // longer settle.
    const scheduler = this.#scheduler?.run(signal);
    const work = this.#supervisor?.run(signal);
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    await scheduler;
    await work;
    await this.shutdown();
  }

  /**
   * Releases everything this process holds.
   *
   * Idempotent: shutdown may arrive from a signal handler and from the run loop
   * ending, and doing it twice must be harmless.
   */
  public async shutdown(): Promise<void> {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
    await this.captureConsoleOutput();
    await this.#scheduler?.releaseHeldRuns();
    this.#dependencies.onEvent?.({ kind: 'shutdown' });
  }
}
