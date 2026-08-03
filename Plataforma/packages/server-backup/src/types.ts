export const VOIDFALL_BACKUP_FORMAT = 'voidfall-backup' as const;
export const VOIDFALL_BACKUP_SCHEMA_VERSION = 1 as const;

export type BackupScope = 'world' | 'configurations' | 'complete';
export type BackupConsistencyMethod = 'offline-exclusive-v1';
export type BackupOperationStage =
  | 'plan'
  | 'guard'
  | 'preflight'
  | 'copy'
  | 'verify'
  | 'promote'
  | 'cleanup';
export type BackupOperationErrorCode =
  | 'invalid-plan'
  | 'consistency-unavailable'
  | 'unsafe-path'
  | 'unsupported-entry'
  | 'limit-exceeded'
  | 'insufficient-space'
  | 'integrity-mismatch'
  | 'destination-conflict'
  | 'filesystem-failure'
  | 'promotion-failed'
  | 'cleanup-failed';

const ERROR_MESSAGES: Readonly<Record<BackupOperationErrorCode, string>> = Object.freeze({
  'invalid-plan': 'The backup operation plan is invalid.',
  'consistency-unavailable': 'Exclusive offline consistency is unavailable.',
  'unsafe-path': 'The backup operation rejected an unsafe path.',
  'unsupported-entry': 'The backup operation found an unsupported filesystem entry.',
  'limit-exceeded': 'The backup operation exceeded a configured safety limit.',
  'insufficient-space': 'The backup repository does not have the required free space.',
  'integrity-mismatch': 'Backup integrity verification failed.',
  'destination-conflict': 'The backup operation destination already exists.',
  'filesystem-failure': 'The backup filesystem operation failed.',
  'promotion-failed': 'The verified backup could not be promoted atomically.',
  'cleanup-failed': 'The backup operation could not clean its private partial directory.',
});

export class BackupOperationError extends Error {
  readonly code: BackupOperationErrorCode;
  readonly stage: BackupOperationStage;

  constructor(code: BackupOperationErrorCode, stage: BackupOperationStage) {
    super(ERROR_MESSAGES[code]);
    this.name = 'BackupOperationError';
    this.code = code;
    this.stage = stage;
  }
}

export interface BackupLimits {
  readonly maximumFiles: number;
  readonly maximumTotalBytes: number;
  readonly maximumFileBytes: number;
  readonly maximumDepth: number;
  readonly minimumFreeBytesAfterCopy: number;
}

export const DEFAULT_BACKUP_LIMITS: BackupLimits = Object.freeze({
  maximumFiles: 250_000,
  maximumTotalBytes: 512 * 1_024 ** 3,
  maximumFileBytes: 32 * 1_024 ** 3,
  maximumDepth: 64,
  minimumFreeBytesAfterCopy: 1 * 1_024 ** 3,
});

export interface BackupConsistencyLease {
  readonly method: BackupConsistencyMethod;
  readonly acquiredAt: string;
}

export interface OfflineExclusiveBackupGuard {
  runWithExclusiveOfflineAccess<T>(
    operation: (lease: BackupConsistencyLease) => Promise<T>,
  ): Promise<T>;
}

export interface BackupSourceDirectory {
  readonly logicalName: string;
  readonly path: string;
}

export interface CreateBackupPlan {
  readonly backupId: string;
  readonly serverInstanceId: string;
  readonly serverRelease: string;
  readonly retentionPolicyId: string;
  readonly scope: BackupScope;
  readonly sources: readonly BackupSourceDirectory[];
}

export interface RestoreBackupPlan {
  readonly backupId: string;
  readonly isolatedParentRoot: string;
  readonly targetName: string;
}

export interface BackupTotals {
  readonly files: number;
  readonly directories: number;
  readonly bytes: number;
}

export interface BackupReceipt {
  readonly operation: 'backup';
  readonly backupId: string;
  readonly createdAt: string;
  readonly consistencyMethod: BackupConsistencyMethod;
  readonly manifestSha256: string;
  readonly totals: BackupTotals;
}

export interface RestoreReceipt {
  readonly operation: 'restore';
  readonly backupId: string;
  readonly restoredAt: string;
  readonly manifestSha256: string;
  readonly totals: BackupTotals;
}

export interface BackupFileCopier {
  copyFile(source: string, destination: string): Promise<void>;
}

export interface FilesystemBackupServiceOptions {
  readonly repositoryRoot: string;
  readonly guard: OfflineExclusiveBackupGuard;
  readonly limits?: Partial<BackupLimits>;
  readonly clock?: () => Date;
  readonly fileCopier?: BackupFileCopier;
}
