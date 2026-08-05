import { BackupOperationError } from './types.js';

/**
 * Quotas and retention.
 *
 * These are the same policy seen from two ends. A quota refuses a backup that
 * would not fit; retention decides which existing backups stop being kept. They
 * are computed here as pure functions over a listing, so what gets deleted is
 * decided — and testable — before anything touches a disk.
 *
 * Retention never selects the newest surviving backup for deletion, whatever
 * the policy says. A retention rule that could empty a repository is a rule
 * that turns a misconfiguration into total data loss.
 */

export interface RetentionPolicy {
  readonly policyId: string;
  /** Newest N are always kept, regardless of age. */
  readonly keepLatest: number;
  /** Anything older than this is eligible, once `keepLatest` is satisfied. */
  readonly maximumAgeDays: number;
}

export interface BackupQuota {
  /** Refuses a new backup once this many are already stored. */
  readonly maximumBackups: number;
  readonly maximumTotalBytes: number;
}

export interface StoredBackupSummary {
  readonly backupId: string;
  readonly createdAt: string;
  readonly sizeBytes: number;
}

const POLICY_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;

export function validateRetentionPolicy(policy: RetentionPolicy): RetentionPolicy {
  if (
    policy === null ||
    typeof policy !== 'object' ||
    typeof policy.policyId !== 'string' ||
    !POLICY_ID_PATTERN.test(policy.policyId) ||
    !Number.isSafeInteger(policy.keepLatest) ||
    // At least one backup is always kept: a policy that keeps none is a policy
    // that deletes the only copy of a world.
    policy.keepLatest < 1 ||
    policy.keepLatest > 10_000 ||
    !Number.isSafeInteger(policy.maximumAgeDays) ||
    policy.maximumAgeDays < 1 ||
    policy.maximumAgeDays > 3_650
  ) {
    throw new BackupOperationError('invalid-plan', 'plan');
  }
  return Object.freeze({ ...policy });
}

export function validateQuota(quota: BackupQuota): BackupQuota {
  if (
    quota === null ||
    typeof quota !== 'object' ||
    !Number.isSafeInteger(quota.maximumBackups) ||
    quota.maximumBackups < 1 ||
    quota.maximumBackups > 100_000 ||
    !Number.isSafeInteger(quota.maximumTotalBytes) ||
    quota.maximumTotalBytes < 1
  ) {
    throw new BackupOperationError('invalid-plan', 'plan');
  }
  return Object.freeze({ ...quota });
}

function parseInstant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new BackupOperationError('invalid-plan', 'plan');
  }
  return parsed;
}

/**
 * Refuses a backup that would breach the quota, **before** it is taken.
 *
 * Checking afterwards would mean the disk already holds the bytes the quota
 * exists to prevent, and the only remedy left would be deleting something.
 */
export function assertQuotaAllows(input: {
  readonly quota: BackupQuota;
  readonly stored: readonly StoredBackupSummary[];
  readonly incomingBytes: number;
}): void {
  const quota = validateQuota(input.quota);
  if (!Number.isSafeInteger(input.incomingBytes) || input.incomingBytes < 0) {
    throw new BackupOperationError('invalid-plan', 'plan');
  }
  if (input.stored.length + 1 > quota.maximumBackups) {
    throw new BackupOperationError('limit-exceeded', 'preflight');
  }
  const used = input.stored.reduce((total, backup) => total + backup.sizeBytes, 0);
  if (used + input.incomingBytes > quota.maximumTotalBytes) {
    throw new BackupOperationError('limit-exceeded', 'preflight');
  }
}

/**
 * Decides which stored backups are no longer kept.
 *
 * Ordering is by creation instant, newest first, with the backup id breaking
 * ties: two backups written in the same millisecond must not produce a
 * different answer depending on how the directory happened to be listed.
 */
export function selectExpiredBackups(input: {
  readonly policy: RetentionPolicy;
  readonly stored: readonly StoredBackupSummary[];
  readonly now: Date;
}): readonly StoredBackupSummary[] {
  const policy = validateRetentionPolicy(input.policy);
  const now = input.now.getTime();
  if (!Number.isFinite(now)) {
    throw new BackupOperationError('invalid-plan', 'plan');
  }

  const ordered = [...input.stored].sort((left, right) => {
    const difference = parseInstant(right.createdAt) - parseInstant(left.createdAt);
    if (difference !== 0) return difference;
    return left.backupId < right.backupId ? -1 : left.backupId > right.backupId ? 1 : 0;
  });

  const cutoff = now - policy.maximumAgeDays * 24 * 60 * 60 * 1_000;
  const expired: StoredBackupSummary[] = [];
  for (const [index, backup] of ordered.entries()) {
    if (index < policy.keepLatest) continue;
    if (parseInstant(backup.createdAt) >= cutoff) continue;
    expired.push(backup);
  }

  // Belt and braces: even if the loop above were wrong, never propose deleting
  // everything. Losing every backup is not a recoverable state.
  if (expired.length >= ordered.length && ordered.length > 0) {
    throw new BackupOperationError('invalid-plan', 'plan');
  }
  return Object.freeze(expired);
}
