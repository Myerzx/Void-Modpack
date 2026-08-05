import type { ActorRef, BackupRecordContract, BackupScopeContract } from '@voidfall/contracts';

import type { Database } from './database.js';

/**
 * The backup catalogue.
 *
 * The repository of bytes lives on the agent's host; what the control plane
 * keeps is the record of which backups were asked for, which completed, how
 * large they are and which keys sealed and encrypted them. No row here holds a
 * path, a storage endpoint or key material — a key identifier is a name.
 *
 * A backup moves through `creating` → `available` or `failed`, and later to
 * `pruned`. `available` is the only state a restore may name, and the database
 * refuses to call a backup available until its totals and seal are recorded, so
 * "nobody measured it" and "it is ready" cannot be the same row.
 */

export type BackupPersistenceErrorCode =
  | 'backup-in-flight'
  | 'backup-exists'
  | 'unknown-backup'
  | 'invalid-transition';

export class BackupPersistenceError extends Error {
  public readonly code: BackupPersistenceErrorCode;

  public constructor(code: BackupPersistenceErrorCode) {
    super(`backup:${code}`);
    this.name = 'BackupPersistenceError';
    this.code = code;
  }
}

interface BackupRow {
  readonly backup_id: string;
  readonly server_instance_id: string;
  readonly scope: BackupScopeContract;
  readonly status: BackupRecordContract['status'];
  readonly reason_code: string;
  readonly created_at: Date | string;
  readonly completed_at: Date | string | null;
  readonly size_bytes: string | number | null;
  readonly file_count: string | number | null;
  readonly manifest_sha256: string | null;
  readonly seal_key_id: string | null;
  readonly encryption_key_id: string | null;
  readonly failure_code: string | null;
}

function isoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function numberOrNull(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function mapRow(row: BackupRow): BackupRecordContract {
  return {
    schemaVersion: 1,
    backupId: row.backup_id,
    serverInstanceId: row.server_instance_id,
    scope: row.scope,
    status: row.status,
    createdAt: isoString(row.created_at),
    completedAt: row.completed_at === null ? null : isoString(row.completed_at),
    sizeBytes: numberOrNull(row.size_bytes),
    fileCount: numberOrNull(row.file_count),
    manifestSha256: row.manifest_sha256,
    sealKeyId: row.seal_key_id,
    encryptionKeyId: row.encryption_key_id,
    reasonCode: row.reason_code,
    failureCode: row.failure_code,
  };
}

const MAXIMUM_PAGE = 200;

export class BackupRepository {
  public constructor(private readonly database: Database) {}

  /**
   * Records a backup as being taken.
   *
   * The partial unique index refuses a second `creating` row for the same
   * server, so two concurrent copies of one world cannot both believe they hold
   * the exclusive offline window.
   */
  public async begin(input: {
    readonly backupId: string;
    readonly serverInstanceId: string;
    readonly scope: BackupScopeContract;
    readonly reasonCode: string;
    readonly requestedBy: ActorRef;
    readonly correlationId: string;
    readonly operationId: string;
    readonly now: Date;
  }): Promise<BackupRecordContract> {
    try {
      const result = await this.database.query<BackupRow>(
        `INSERT INTO server_backups (
           backup_id, server_instance_id, scope, status, reason_code, requested_by,
           correlation_id, operation_id, created_at
         ) VALUES ($1, $2, $3, 'creating', $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          input.backupId,
          input.serverInstanceId,
          input.scope,
          input.reasonCode,
          JSON.stringify(input.requestedBy),
          input.correlationId,
          input.operationId,
          input.now.toISOString(),
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new BackupPersistenceError('unknown-backup');
      return mapRow(row);
    } catch (error) {
      if (error instanceof BackupPersistenceError) throw error;
      const message = error instanceof Error ? error.message : '';
      if (message.includes('server_backups_in_flight_idx')) {
        throw new BackupPersistenceError('backup-in-flight');
      }
      if (message.includes('server_backups_pkey')) {
        throw new BackupPersistenceError('backup-exists');
      }
      throw error;
    }
  }

  /**
   * Closes a backup with what the agent measured.
   *
   * The transition is guarded in the statement rather than read-then-written:
   * a settle that arrives twice must not be able to move an already-closed
   * backup, and a `WHERE status = 'creating'` is what makes the second one a
   * no-op instead of a rewrite.
   */
  public async complete(input: {
    readonly backupId: string;
    readonly sizeBytes: number;
    readonly fileCount: number;
    readonly manifestSha256: string;
    readonly sealKeyId: string;
    readonly encryptionKeyId: string | null;
    readonly now: Date;
  }): Promise<BackupRecordContract> {
    const result = await this.database.query<BackupRow>(
      `UPDATE server_backups
          SET status = 'available',
              completed_at = $2,
              size_bytes = $3,
              file_count = $4,
              manifest_sha256 = $5,
              seal_key_id = $6,
              encryption_key_id = $7
        WHERE backup_id = $1 AND status = 'creating'
        RETURNING *`,
      [
        input.backupId,
        input.now.toISOString(),
        input.sizeBytes,
        input.fileCount,
        input.manifestSha256,
        input.sealKeyId,
        input.encryptionKeyId,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new BackupPersistenceError('invalid-transition');
    return mapRow(row);
  }

  public async fail(input: {
    readonly backupId: string;
    readonly failureCode: string;
    readonly now: Date;
  }): Promise<BackupRecordContract> {
    const result = await this.database.query<BackupRow>(
      `UPDATE server_backups
          SET status = 'failed', completed_at = $2, failure_code = $3
        WHERE backup_id = $1 AND status = 'creating'
        RETURNING *`,
      [input.backupId, input.now.toISOString(), input.failureCode.slice(0, 64)],
    );
    const row = result.rows[0];
    if (row === undefined) throw new BackupPersistenceError('invalid-transition');
    return mapRow(row);
  }

  /**
   * Marks a backup as no longer stored.
   *
   * Pruning records the fact rather than deleting the row: a restore that
   * names it should learn the backup is gone, not that it never existed.
   */
  public async markPruned(backupId: string, now: Date): Promise<void> {
    await this.database.query(
      `UPDATE server_backups
          SET status = 'pruned', completed_at = COALESCE(completed_at, $2)
        WHERE backup_id = $1 AND status = 'available'`,
      [backupId, now.toISOString()],
    );
  }

  public async findById(backupId: string): Promise<BackupRecordContract | undefined> {
    const result = await this.database.query<BackupRow>(
      'SELECT * FROM server_backups WHERE backup_id = $1',
      [backupId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  }

  public async listForServer(
    serverInstanceId: string,
    limit = 50,
  ): Promise<readonly BackupRecordContract[]> {
    const bounded = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), MAXIMUM_PAGE) : 50;
    const result = await this.database.query<BackupRow>(
      `SELECT * FROM server_backups
        WHERE server_instance_id = $1
        ORDER BY created_at DESC, backup_id ASC
        LIMIT $2`,
      [serverInstanceId, bounded],
    );
    return result.rows.map(mapRow);
  }
}
