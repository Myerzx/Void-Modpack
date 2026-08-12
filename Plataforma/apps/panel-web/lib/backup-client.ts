import { panelRequest } from './workspace-client';

export type BackupScope = 'world' | 'configurations' | 'complete';
export type BackupStatus = 'creating' | 'available' | 'failed' | 'pruned';

export interface BackupRecord {
  readonly schemaVersion: 1;
  readonly backupId: string;
  readonly serverInstanceId: string;
  readonly scope: BackupScope;
  readonly status: BackupStatus;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly sizeBytes: number | null;
  readonly fileCount: number | null;
  readonly manifestSha256: string | null;
  readonly sealKeyId: string | null;
  readonly encryptionKeyId: string | null;
  readonly reasonCode: string;
  readonly failureCode: string | null;
}

export interface BackupPage {
  readonly schemaVersion: 1;
  readonly serverInstanceId: string;
  readonly backups: readonly BackupRecord[];
}

export interface BackupProcessState {
  readonly lifecycle: 'unknown' | 'offline' | 'starting' | 'online' | 'stopping' | 'error';
  readonly observedAt: string | null;
  readonly stale: boolean;
  readonly observed: boolean;
}

export function listBackups(serverId: string): Promise<BackupPage> {
  return panelRequest(`/api/v1/servers/${encodeURIComponent(serverId)}/backups`);
}

export function readBackupProcessState(serverId: string): Promise<BackupProcessState> {
  return panelRequest(`/api/v1/servers/${encodeURIComponent(serverId)}/process-state`);
}

export function createWorldBackup(input: {
  readonly serverId: string;
  readonly csrfToken: string;
  readonly backupId: string;
}): Promise<BackupRecord> {
  return panelRequest(`/api/v1/servers/${encodeURIComponent(input.serverId)}/backups`, {
    method: 'POST',
    csrfToken: input.csrfToken,
    body: {
      schemaVersion: 1,
      backupId: input.backupId,
      scope: 'world',
      idempotencyKey: `panel-backup-${globalThis.crypto.randomUUID()}`,
      reasonCode: 'panel-world-backup',
    },
  });
}
