import type { AgentWorkLease } from '@voidfall/contracts';
import { ConfigurationPersistenceError, type Repositories } from '@voidfall/database';
import type { MinecraftProcessController } from '@voidfall/minecraft-process';
import {
  BackupOperationError,
  type BackupScope,
  type BackupSourceDirectory,
  type FilesystemBackupService,
} from '@voidfall/server-backup';

import type { LeaseHandlerResult } from './supervisor.js';

/**
 * The `backup.create` and `backup.restore` capabilities.
 *
 * Both run under the durable `minecraft-exclusive` lock — the same one process
 * control and configuration take — so a copy is never taken while a start is in
 * progress, and a restore never lands on a world a server is still holding.
 *
 * The lease carries only which server. The repository root, the source
 * directories, the seal key and the encryption key all come from trusted local
 * configuration on this host: nothing on the wire names a path or holds key
 * material, so an attacker who can enqueue work still cannot say where to read
 * from or write to.
 *
 * They are separate capabilities on purpose. An agent trusted to copy a world
 * is not thereby trusted to overwrite one with an older copy.
 */

const LOCK_NAME = 'minecraft-exclusive';
const DEFAULT_LOCK_SECONDS = 3_600;

export interface BackupCapabilityOptions {
  readonly repositories: Repositories;
  readonly backupService: FilesystemBackupService;
  /** The server this agent is responsible for; a lease for another is refused. */
  readonly serverInstanceId: string;
  readonly serverRelease: string;
  readonly agentId: string;
  /** Where a backup reads from. Local configuration, never the lease. */
  readonly sources: readonly BackupSourceDirectory[];
  readonly retentionPolicyId: string;
  /** Identifiers only; the key material itself never leaves the service. */
  readonly sealKeyId: string;
  readonly encryptionKeyId: string | null;
  readonly lockSeconds?: number;
  readonly clock?: () => Date;
}

export interface RestoreCapabilityOptions extends BackupCapabilityOptions {
  /** Where a restore materialises the snapshot. Never inside a live world. */
  readonly isolatedParentRoot: string;
  /**
   * Starts the server after the swap so the restore is observed to boot.
   * Optional: without a controller the capability reports the restore as
   * complete but unverified rather than claiming a boot that never happened.
   */
  readonly controller?: MinecraftProcessController;
}

/**
 * Refuses a lease that is not this agent's work.
 *
 * A capability that guessed what an unfamiliar lease meant would be a generic
 * executor, which is the thing this design exists to avoid.
 */
function leaseIsOurs(lease: AgentWorkLease, serverInstanceId: string, jobType: string): boolean {
  return (
    lease.jobType === jobType &&
    lease.parameters.resourceType === 'server-instance' &&
    lease.parameters.resourceId === serverInstanceId
  );
}

async function withExclusiveLock<T>(
  options: BackupCapabilityOptions,
  jobType: string,
  now: Date,
  run: () => Promise<T>,
): Promise<T | { readonly locked: false }> {
  try {
    await options.repositories.operationalLocks.acquire({
      serverInstanceId: options.serverInstanceId,
      lockName: LOCK_NAME,
      ownerId: options.agentId,
      operation: jobType,
      acquiredAt: now.toISOString(),
      leaseExpiresAt: new Date(
        now.getTime() + (options.lockSeconds ?? DEFAULT_LOCK_SECONDS) * 1_000,
      ).toISOString(),
    });
  } catch (error) {
    if (error instanceof ConfigurationPersistenceError) return { locked: false };
    throw error;
  }
  try {
    return await run();
  } finally {
    await options.repositories.operationalLocks
      .release({
        serverInstanceId: options.serverInstanceId,
        lockName: LOCK_NAME,
        ownerId: options.agentId,
      })
      .catch(() => undefined);
  }
}

export function createBackupHandler(
  options: BackupCapabilityOptions,
): (lease: AgentWorkLease) => Promise<LeaseHandlerResult> {
  const clock = options.clock ?? (() => new Date());

  return async (lease: AgentWorkLease): Promise<LeaseHandlerResult> => {
    if (!leaseIsOurs(lease, options.serverInstanceId, 'backup.create')) {
      return { outcome: 'failed', failureCode: 'unsupported-parameters' };
    }

    // Which snapshot to take comes from the durable operation, not the wire —
    // exactly as the console capability reads its reviewed command.
    const operation = await options.repositories.operations.findByJobId(lease.jobId);
    if (operation === undefined || operation.kind !== 'backup.create' || operation.backupId === null) {
      return { outcome: 'failed', failureCode: 'unsupported-parameters' };
    }
    const pending = await options.repositories.backups.findById(operation.backupId);
    if (pending === undefined || pending.status !== 'creating') {
      return { outcome: 'failed', failureCode: 'unsupported-parameters' };
    }

    const now = clock();
    const result = await withExclusiveLock(options, 'backup.create', now, async () => {
      try {
        const receipt = await options.backupService.createBackup({
          backupId: pending.backupId,
          serverInstanceId: options.serverInstanceId,
          serverRelease: options.serverRelease,
          retentionPolicyId: options.retentionPolicyId,
          scope: pending.scope as BackupScope,
          sources: options.sources,
        });
        await options.repositories.backups.complete({
          backupId: pending.backupId,
          sizeBytes: receipt.totals.bytes,
          fileCount: receipt.totals.files,
          manifestSha256: receipt.manifestSha256,
          sealKeyId: options.sealKeyId,
          encryptionKeyId: options.encryptionKeyId,
          now: clock(),
        });
        // Retention runs after a successful backup, not on a timer nobody
        // scheduled: the moment the repository grew is the moment to check it.
        await options.backupService.pruneExpiredBackups().catch(() => []);
        return { outcome: 'succeeded' as const };
      } catch (error) {
        const failureCode =
          error instanceof BackupOperationError ? error.code : 'filesystem-failure';
        await options.repositories.backups
          .fail({ backupId: pending.backupId, failureCode, now: clock() })
          .catch(() => undefined);
        return {
          outcome: 'failed' as const,
          failureCode:
            error instanceof BackupOperationError && error.code === 'consistency-unavailable'
              ? ('precondition-not-met' as const)
              : ('operation-failed' as const),
        };
      }
    });

    if ('locked' in result) return { outcome: 'failed', failureCode: 'precondition-not-met' };
    return result;
  };
}

export function createRestoreHandler(
  options: RestoreCapabilityOptions,
): (lease: AgentWorkLease) => Promise<LeaseHandlerResult> {
  const clock = options.clock ?? (() => new Date());

  return async (lease: AgentWorkLease): Promise<LeaseHandlerResult> => {
    if (!leaseIsOurs(lease, options.serverInstanceId, 'backup.restore')) {
      return { outcome: 'failed', failureCode: 'unsupported-parameters' };
    }
    const operation = await options.repositories.operations.findByJobId(lease.jobId);
    if (
      operation === undefined ||
      operation.kind !== 'backup.restore' ||
      operation.backupId === null
    ) {
      return { outcome: 'failed', failureCode: 'unsupported-parameters' };
    }
    const target = await options.repositories.backups.findById(operation.backupId);
    // Re-checked here as well as at the route: the route decided minutes ago,
    // and retention may have pruned the snapshot since.
    if (
      target === undefined ||
      target.serverInstanceId !== options.serverInstanceId ||
      target.status !== 'available'
    ) {
      return { outcome: 'failed', failureCode: 'unsupported-parameters' };
    }

    const now = clock();
    const result = await withExclusiveLock(options, 'backup.restore', now, async () => {
      try {
        // The service verifies the seal, then the payload, then materialises
        // into an isolated parent and promotes atomically. Nothing is written
        // over a live world at any point.
        await options.backupService.restoreBackup({
          backupId: target.backupId,
          isolatedParentRoot: options.isolatedParentRoot,
          targetName: `restore-${target.backupId}`,
        });
      } catch (error) {
        return {
          outcome: 'failed' as const,
          failureCode:
            error instanceof BackupOperationError && error.code === 'integrity-mismatch'
              ? ('operation-failed' as const)
              : ('operation-failed' as const),
        };
      }

      if (options.controller === undefined) {
        // Restored but not booted. Reported as succeeded with an unknown
        // lifecycle rather than claiming a verification that did not run.
        return { outcome: 'succeeded' as const, observedLifecycle: 'unknown' as const };
      }

      try {
        const boot = await options.controller.execute({
          idempotencyKey: `${lease.jobId}:verification-boot`,
          action: 'start',
        });
        const observation = boot.observation;
        if (boot.outcome !== 'succeeded' || observation?.state !== 'online') {
          // The bytes are on disk but the server did not come up. Reporting
          // success here would hand an operator a restore nobody can use.
          return {
            outcome: 'failed' as const,
            failureCode: 'operation-failed' as const,
            observedLifecycle: observation?.state ?? ('unknown' as const),
          };
        }
        return {
          outcome: 'succeeded' as const,
          observedLifecycle: 'online' as const,
          ...(observation.pid === undefined ? {} : { observedPid: observation.pid }),
        };
      } catch {
        return { outcome: 'failed' as const, failureCode: 'operation-failed' as const };
      }
    });

    if ('locked' in result) return { outcome: 'failed', failureCode: 'precondition-not-met' };
    return result;
  };
}
