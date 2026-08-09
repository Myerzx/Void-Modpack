import type { Database } from './database.js';

export type MinecraftProcessOwnershipStatus = 'reserved' | 'running' | 'orphaned';

export interface MinecraftProcessOwnershipRecord {
  readonly serverInstanceId: string;
  readonly ownershipId: string;
  readonly agentId: string;
  readonly agentBootId: string;
  readonly status: MinecraftProcessOwnershipStatus;
  readonly pid: number | null;
  readonly acquiredAt: string;
  readonly spawnedAt: string | null;
  readonly updatedAt: string;
  readonly version: number;
}

interface OwnershipRow {
  readonly server_instance_id: string;
  readonly ownership_id: string;
  readonly agent_id: string;
  readonly agent_boot_id: string;
  readonly status: MinecraftProcessOwnershipStatus;
  readonly pid: string | number | null;
  readonly acquired_at: Date | string;
  readonly spawned_at: Date | string | null;
  readonly updated_at: Date | string;
  readonly version: string | number;
}

const OWNERSHIP_COLUMNS = `server_instance_id, ownership_id, agent_id, agent_boot_id,
  status, pid, acquired_at, spawned_at, updated_at, version`;

function isoString(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ProcessOwnershipPersistenceError('invalid-record');
  return parsed.toISOString();
}

function mapOwnership(row: OwnershipRow): MinecraftProcessOwnershipRecord {
  const pid = row.pid === null ? null : Number(row.pid);
  const version = Number(row.version);
  if (
    (pid !== null && (!Number.isInteger(pid) || pid < 1 || pid > 2_147_483_647)) ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    throw new ProcessOwnershipPersistenceError('invalid-record');
  }
  return Object.freeze({
    serverInstanceId: row.server_instance_id,
    ownershipId: row.ownership_id,
    agentId: row.agent_id,
    agentBootId: row.agent_boot_id,
    status: row.status,
    pid,
    acquiredAt: isoString(row.acquired_at),
    spawnedAt: row.spawned_at === null ? null : isoString(row.spawned_at),
    updatedAt: isoString(row.updated_at),
    version,
  });
}

export type ProcessOwnershipPersistenceErrorCode =
  | 'invalid-record'
  | 'stale-ownership';

export class ProcessOwnershipPersistenceError extends Error {
  override readonly name = 'ProcessOwnershipPersistenceError';

  public constructor(readonly code: ProcessOwnershipPersistenceErrorCode) {
    super(`process-ownership:${code}`);
  }
}

/**
 * Stores the ownership fence; policy about PID liveness stays in the agent.
 *
 * Every mutation names the random ownership generation. An old agent can
 * therefore never attach a PID to, orphan, or release a newer owner's row.
 */
export class ProcessOwnershipRepository {
  public constructor(private readonly database: Database) {}

  public async find(
    serverInstanceId: string,
  ): Promise<MinecraftProcessOwnershipRecord | undefined> {
    const result = await this.database.query<OwnershipRow>(
      `SELECT ${OWNERSHIP_COLUMNS}
       FROM minecraft_process_ownership WHERE server_instance_id = $1`,
      [serverInstanceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapOwnership(row);
  }

  /** Returns undefined when another generation already owns the instance. */
  public async reserve(input: {
    readonly serverInstanceId: string;
    readonly ownershipId: string;
    readonly agentId: string;
    readonly agentBootId: string;
    readonly now: Date;
  }): Promise<MinecraftProcessOwnershipRecord | undefined> {
    const result = await this.database.query<OwnershipRow>(
      `INSERT INTO minecraft_process_ownership (
         server_instance_id, ownership_id, agent_id, agent_boot_id, status,
         acquired_at, updated_at
       ) VALUES ($1,$2,$3,$4,'reserved',$5,$5)
       ON CONFLICT (server_instance_id) DO NOTHING
       RETURNING ${OWNERSHIP_COLUMNS}`,
      [input.serverInstanceId, input.ownershipId, input.agentId, input.agentBootId, input.now],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapOwnership(row);
  }

  public async attachPid(input: {
    readonly ownershipId: string;
    readonly pid: number;
    readonly now: Date;
  }): Promise<MinecraftProcessOwnershipRecord> {
    const result = await this.database.query<OwnershipRow>(
      `UPDATE minecraft_process_ownership
       SET status = 'running', pid = $2, spawned_at = $3, updated_at = $3,
           version = version + 1
       WHERE ownership_id = $1 AND status = 'reserved'
       RETURNING ${OWNERSHIP_COLUMNS}`,
      [input.ownershipId, input.pid, input.now],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ProcessOwnershipPersistenceError('stale-ownership');
    return mapOwnership(row);
  }

  public async markOrphaned(input: {
    readonly ownershipId: string;
    readonly now: Date;
  }): Promise<MinecraftProcessOwnershipRecord> {
    const result = await this.database.query<OwnershipRow>(
      `UPDATE minecraft_process_ownership
       SET status = 'orphaned', updated_at = $2, version = version + 1
       WHERE ownership_id = $1
       RETURNING ${OWNERSHIP_COLUMNS}`,
      [input.ownershipId, input.now],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ProcessOwnershipPersistenceError('stale-ownership');
    return mapOwnership(row);
  }

  /** Returns false when this generation was already replaced or cleared. */
  public async release(ownershipId: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM minecraft_process_ownership WHERE ownership_id = $1',
      [ownershipId],
    );
    return result.rowCount === 1;
  }
}
