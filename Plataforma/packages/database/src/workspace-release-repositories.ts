import { randomUUID } from 'node:crypto';

import type { Database } from './database.js';

/**
 * Releases produced from an approved inventory.
 *
 * Evidence, like an inventory and like a sandbox run: created once, completed
 * once, never rewritten. It answers "what was this server at version X" long
 * after the directory moved on, and it is what the knowledge graph will anchor
 * to in time.
 *
 * The plan and the package manifests are stored whole, as the builder wrote
 * them. The panel reads exactly what the engine produced rather than a second
 * shape somebody maintains by hand.
 */

export type ReleaseStatus = 'building' | 'ready' | 'refused';
export type ReleaseIntent = 'local-use' | 'distribution';

export interface WorkspaceRelease {
  readonly releaseId: string;
  readonly workspaceId: string;
  readonly version: string;
  readonly status: ReleaseStatus;
  readonly intent: ReleaseIntent;
  readonly inventoryId: string;
  readonly previousInventoryId: string | null;
  /** Named when the builder refused. A refusal without a cause is a defect. */
  readonly refusal: string | null;
  readonly plan: unknown;
  readonly packages: unknown;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

interface ReleaseRow {
  readonly release_id: string;
  readonly workspace_id: string;
  readonly version: string;
  readonly status: ReleaseStatus;
  readonly intent: ReleaseIntent;
  readonly inventory_id: string;
  readonly previous_inventory_id: string | null;
  readonly refusal: string | null;
  readonly plan: unknown;
  readonly packages: unknown;
  readonly started_at: string | Date;
  readonly finished_at: string | Date | null;
}

function asIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function mapRelease(row: ReleaseRow): WorkspaceRelease {
  return Object.freeze({
    releaseId: row.release_id,
    workspaceId: row.workspace_id,
    version: row.version,
    status: row.status,
    intent: row.intent,
    inventoryId: row.inventory_id,
    previousInventoryId: row.previous_inventory_id,
    refusal: row.refusal,
    plan: parseJson<unknown>(row.plan, null),
    packages: parseJson<unknown>(row.packages, null),
    startedAt: asIso(row.started_at),
    finishedAt: row.finished_at === null ? null : asIso(row.finished_at),
  });
}

const COLUMNS = `release_id, workspace_id, version, status, intent, inventory_id,
                 previous_inventory_id, refusal, plan, packages, started_at, finished_at`;

export type ReleaseErrorCode = 'version-taken';

export class ReleaseError extends Error {
  public readonly code: ReleaseErrorCode;

  public constructor(code: ReleaseErrorCode) {
    super(`release:${code}`);
    this.name = 'ReleaseError';
    this.code = code;
  }
}

export class WorkspaceReleaseRepository {
  public constructor(private readonly database: Database) {}

  public async start(input: {
    readonly workspaceId: string;
    readonly version: string;
    readonly intent: ReleaseIntent;
    readonly inventoryId: string;
    readonly previousInventoryId: string | null;
    readonly createdBy: unknown;
  }): Promise<WorkspaceRelease> {
    const existing = await this.database.query<{ readonly version: string }>(
      'SELECT version FROM workspace_releases WHERE workspace_id = $1 AND version = $2',
      [input.workspaceId, input.version],
    );
    if (existing.rows[0] !== undefined) {
      // Rebuilding the same version over different evidence is how a version
      // number stops meaning anything.
      throw new ReleaseError('version-taken');
    }

    const result = await this.database.query<ReleaseRow>(
      `INSERT INTO workspace_releases
         (release_id, workspace_id, version, status, intent, inventory_id,
          previous_inventory_id, created_by)
       VALUES ($1,$2,$3,'building',$4,$5,$6,$7)
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        input.workspaceId,
        input.version,
        input.intent,
        input.inventoryId,
        input.previousInventoryId,
        JSON.stringify(input.createdBy),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Release insert returned no row.');
    return mapRelease(row);
  }

  public async complete(input: {
    readonly releaseId: string;
    readonly plan: unknown;
    readonly packages: unknown;
  }): Promise<void> {
    await this.database.query(
      `UPDATE workspace_releases
       SET status = 'ready', plan = $2, packages = $3, finished_at = now()
       WHERE release_id = $1 AND status = 'building'`,
      [input.releaseId, JSON.stringify(input.plan), JSON.stringify(input.packages)],
    );
  }

  public async refuse(releaseId: string, refusal: string, plan: unknown = null): Promise<void> {
    await this.database.query(
      `UPDATE workspace_releases
       SET status = 'refused', refusal = $2, plan = $3, finished_at = now()
       WHERE release_id = $1 AND status = 'building'`,
      [releaseId, refusal, JSON.stringify(plan)],
    );
  }

  public async findById(releaseId: string): Promise<WorkspaceRelease | undefined> {
    const result = await this.database.query<ReleaseRow>(
      `SELECT ${COLUMNS} FROM workspace_releases WHERE release_id = $1`,
      [releaseId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRelease(row);
  }

  public async list(workspaceId: string, limit = 20): Promise<readonly WorkspaceRelease[]> {
    const result = await this.database.query<ReleaseRow>(
      `SELECT ${COLUMNS} FROM workspace_releases WHERE workspace_id = $1
       ORDER BY started_at DESC LIMIT $2`,
      [workspaceId, Math.min(Math.max(limit, 1), 100)],
    );
    return Object.freeze(result.rows.map(mapRelease));
  }

  /** One build at a time per workspace: two would write the same file names. */
  public async hasBuilding(workspaceId: string): Promise<boolean> {
    const result = await this.database.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count FROM workspace_releases
       WHERE workspace_id = $1 AND status = 'building'`,
      [workspaceId],
    );
    return Number(result.rows[0]?.count ?? '0') > 0;
  }
}
