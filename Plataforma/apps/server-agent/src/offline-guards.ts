import type { OperationalLockLease, Repositories } from '@voidfall/database';
import type {
  DatapackLoadOrderConsistencyLease,
  OfflineExclusiveDatapackLoadOrderGuard,
} from '@voidfall/ecosystem-analysis';
import type { MinecraftProcessAdapter } from '@voidfall/minecraft-process';
import type {
  BackupConsistencyLease,
  OfflineExclusiveBackupGuard,
} from '@voidfall/server-backup';
import type {
  ConfigurationConsistencyLease,
  OfflineExclusiveConfigurationGuard,
} from '@voidfall/server-configuration';

/**
 * Proof that the server was offline, and stayed offline, while a file was
 * rewritten or a world was copied.
 *
 * Until now both guards were injected trust boundaries with no implementation
 * outside tests. What `offline-exclusive-v1` is supposed to assert is two
 * things at once, and the guard checks both:
 *
 *  - **Offline.** The process adapter is asked, not the database. A stored
 *    lifecycle is somebody's earlier observation; the adapter is the thing that
 *    actually holds the child process.
 *  - **Exclusive.** The durable `minecraft-exclusive` lock is held by this
 *    agent and has not lapsed. Being offline at one instant means nothing on
 *    its own — without the lock, an operator's start could land in the middle.
 *
 * Both are re-checked after the operation. A copy taken while somebody started
 * the server is a copy of a world in an unknown state, and finding out
 * afterwards is the difference between a failed backup and a bad one nobody
 * knows is bad.
 *
 * The guard never takes the lock itself. The capability that runs the operation
 * holds it across the whole thing, including the parts before and after the
 * guard's window; a guard that acquired and released its own would leave those
 * parts unprotected while looking like it had covered them.
 */

const LOCK_NAME = 'minecraft-exclusive';

export type OfflineGuardFailureReason =
  | 'server-not-offline'
  | 'exclusive-lock-not-held'
  | 'server-started-during-operation';

export class OfflineGuardError extends Error {
  public readonly reason: OfflineGuardFailureReason;

  public constructor(reason: OfflineGuardFailureReason) {
    super(`offline-guard:${reason}`);
    this.name = 'OfflineGuardError';
    this.reason = reason;
  }
}

export interface OfflineGuardOptions {
  readonly repositories: Repositories;
  readonly adapter: MinecraftProcessAdapter;
  readonly serverInstanceId: string;
  /**
   * Whether the lock currently held is the window this operation is running in.
   *
   * Supplied per caller because the two paths take the lock under different
   * owners: the backup capability takes it as this agent, while the persistent
   * configuration service mints an owner id of its own. A guard that assumed
   * either shape would pass for one caller and refuse the other forever.
   */
  readonly ownsLock: (lease: OperationalLockLease) => boolean;
  readonly clock?: () => Date;
}

/**
 * Asserts the two conditions, or throws.
 *
 * Returns when both hold, so the caller can use the return as the moment the
 * window opened rather than reading a clock separately and being slightly wrong
 * about it.
 */
async function requireOfflineAndExclusive(options: OfflineGuardOptions): Promise<Date> {
  const now = (options.clock ?? ((): Date => new Date()))();

  const lock = await options.repositories.operationalLocks.current(
    options.serverInstanceId,
    LOCK_NAME,
  );
  if (
    lock === undefined ||
    !options.ownsLock(lock) ||
    Date.parse(lock.leaseExpiresAt) <= now.getTime()
  ) {
    throw new OfflineGuardError('exclusive-lock-not-held');
  }

  const observation = await options.adapter.inspect();
  if (observation.state !== 'offline') {
    throw new OfflineGuardError('server-not-offline');
  }
  return now;
}

/** Re-asserts after the work, so a start that raced the window is detected. */
async function requireStillOffline(options: OfflineGuardOptions): Promise<void> {
  const observation = await options.adapter.inspect();
  if (observation.state !== 'offline') {
    throw new OfflineGuardError('server-started-during-operation');
  }
}

export function createOfflineExclusiveBackupGuard(
  options: OfflineGuardOptions,
): OfflineExclusiveBackupGuard {
  return {
    async runWithExclusiveOfflineAccess<T>(
      operation: (lease: BackupConsistencyLease) => Promise<T>,
    ): Promise<T> {
      const acquiredAt = await requireOfflineAndExclusive(options);
      const result = await operation({
        method: 'offline-exclusive-v1',
        acquiredAt: acquiredAt.toISOString(),
      });
      await requireStillOffline(options);
      return result;
    },
  };
}

export function createOfflineExclusiveConfigurationGuard(
  options: OfflineGuardOptions,
): OfflineExclusiveConfigurationGuard {
  return {
    async runWithExclusiveOfflineAccess<T>(
      _resourceId: string,
      operation: (lease: ConfigurationConsistencyLease) => Promise<T>,
    ): Promise<T> {
      // The resource is not consulted. This guard's claim is about the server,
      // and every reviewed resource belongs to the one server this agent holds
      // — a per-resource window would suggest a granularity the process does
      // not have.
      const acquiredAt = await requireOfflineAndExclusive(options);
      const result = await operation({ method: 'offline-exclusive-v1', acquiredAt });
      await requireStillOffline(options);
      return result;
    },
  };
}

export function createOfflineExclusiveDatapackLoadOrderGuard(
  options: OfflineGuardOptions,
): OfflineExclusiveDatapackLoadOrderGuard {
  return {
    async runWithExclusiveOfflineAccess<T>(
      operation: (lease: DatapackLoadOrderConsistencyLease) => Promise<T>,
    ): Promise<T> {
      const acquiredAt = await requireOfflineAndExclusive(options);
      const result = await operation({
        method: 'offline-exclusive-v1',
        acquiredAt: acquiredAt.toISOString(),
      });
      await requireStillOffline(options);
      return result;
    },
  };
}
