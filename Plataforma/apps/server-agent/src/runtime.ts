import type { AgentCapability } from '@voidfall/contracts';
import type { Repositories } from '@voidfall/database';
import type { MinecraftConsoleAdapter, MinecraftProcessController } from '@voidfall/minecraft-process';
import { AuthorizedFileService } from '@voidfall/authorized-files';
import { FilesystemBackupService, type OfflineExclusiveBackupGuard } from '@voidfall/server-backup';

import { createBackupHandler, createRestoreHandler } from './backup-operation.js';
import { collectReadings } from './collectors.js';
import { createConsoleCommandHandler } from './console-operation.js';
import { createProcessControlHandler } from './process-operation.js';
import { evaluateReadiness, type AgentReadiness, type RuntimeDependencies } from './readiness.js';
import type { AgentRuntimeConfiguration } from './runtime-config.js';
import { SchedulerLoop, type ScheduleStepExecutor } from './scheduler-loop.js';
import type { LeaseHandler } from './supervisor.js';

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
  /** Guards the exclusive offline window a backup needs. */
  readonly backupGuard?: OfflineExclusiveBackupGuard;
  readonly scheduleExecutor?: ScheduleStepExecutor;
  readonly clock?: () => Date;
  readonly onEvent?: (event: AgentRuntimeEvent) => void;
}

export type AgentRuntimeEvent =
  | { readonly kind: 'ready'; readonly announced: readonly AgentCapability[] }
  | { readonly kind: 'reconciled'; readonly count: number }
  | { readonly kind: 'metrics-recorded'; readonly count: number }
  | { readonly kind: 'metrics-failed' }
  | { readonly kind: 'shutdown' };

export class AgentRuntime {
  readonly #dependencies: AgentRuntimeDependencies;
  readonly #authorizedFiles: AuthorizedFileService | null;
  readonly #backupService: FilesystemBackupService | null;
  readonly #readiness: AgentReadiness;
  readonly #handlers: Readonly<Partial<Record<AgentCapability, LeaseHandler>>>;
  readonly #scheduler: SchedulerLoop | null;
  #timers: NodeJS.Timeout[] = [];

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

    this.#backupService =
      configuration.backups === null || dependencies.backupGuard === undefined
        ? null
        : new FilesystemBackupService({
            repositoryRoot: configuration.backups.repositoryRoot,
            guard: dependencies.backupGuard,
            sealKey: configuration.backups.sealKey,
            ...(configuration.backups.encryptionKey === null
              ? {}
              : { encryptionKey: configuration.backups.encryptionKey }),
            ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
          });

    // --- Readiness from what exists, not from what was asked for. -----------
    const runtimeDependencies: RuntimeDependencies = {
      hasAuthorizedFiles: this.#authorizedFiles !== null,
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

    this.#scheduler =
      configuration.schedulerEnabled && dependencies.scheduleExecutor !== undefined
        ? new SchedulerLoop({
            repositories: dependencies.repositories,
            serverInstanceId: configuration.serverInstanceId,
            agentId: configuration.agentId,
            executor: dependencies.scheduleExecutor,
            ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
          })
        : null;
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
    const observedBefore = new Date(now.getTime() - DEFAULT_STALE_PROCESS_SECONDS * 1_000);
    const reconciled = await this.#dependencies.repositories.processStates.reconcileStale({
      observedBefore,
      now,
    });
    this.#dependencies.onEvent?.({ kind: 'reconciled', count: reconciled.length });
    return reconciled.length;
  }

  /**
   * Takes one metrics sample and stores it as buckets.
   *
   * Failure is swallowed and reported as an event. Losing a metrics sample must
   * never take down an agent that is otherwise serving operations.
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
      return stored;
    } catch {
      this.#dependencies.onEvent?.({ kind: 'metrics-failed' });
      return 0;
    }
  }

  /**
   * Starts the periodic work and returns when the signal aborts.
   *
   * Reconciliation runs once before anything is scheduled, so an agent that
   * crashed mid-operation does not serve a first request against a state it
   * knows is stale.
   */
  public async start(signal: AbortSignal): Promise<void> {
    await this.reconcileOrphanProcessStates();
    await this.collectAndStoreMetrics();
    this.#dependencies.onEvent?.({ kind: 'ready', announced: this.#readiness.announced });

    const reconcileTimer = setInterval(() => {
      void this.reconcileOrphanProcessStates().catch(() => undefined);
    }, DEFAULT_RECONCILE_INTERVAL_MS);
    const metricsTimer = setInterval(() => {
      void this.collectAndStoreMetrics();
    }, DEFAULT_METRICS_INTERVAL_MS);
    // Timers must not hold the process open on their own; shutdown is decided
    // by the signal, not by whether a periodic task happens to be pending.
    reconcileTimer.unref();
    metricsTimer.unref();
    this.#timers = [reconcileTimer, metricsTimer];

    const scheduler = this.#scheduler?.run(signal);
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    await scheduler;
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
    await this.#scheduler?.releaseHeldRuns();
    this.#dependencies.onEvent?.({ kind: 'shutdown' });
  }
}
