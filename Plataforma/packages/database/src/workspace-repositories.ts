import { randomUUID } from 'node:crypto';

import type { Database } from './database.js';

/**
 * Where an imported workspace and its scans live.
 *
 * The build path — inventory, mods, configuration, sandbox, release — all
 * starts from a directory somebody imported, and until now there was no way to
 * name one except by writing SQL. This is that registry, and it follows the
 * rule the authorized-file core already set: the root is registered once by an
 * operator, and every later request names the workspace by id. A screen never
 * sends a path, so no route has to decide whether a path is allowed.
 *
 * A scan is never overwritten. Each one is evidence with a time on it, and
 * replacing the previous in place would make "what did this look like before I
 * changed it?" unanswerable — which is the question the release path is built
 * around.
 */

export type WorkspaceKind = 'server' | 'client-profile';

export interface PanelWorkspace {
  readonly workspaceId: string;
  readonly slug: string;
  readonly displayName: string;
  /** Absolute host path. Never returned to a browser — see `PublicWorkspace`. */
  readonly rootPath: string;
  readonly kind: WorkspaceKind;
  /** The live instance this imported server configures, when explicitly linked. */
  readonly serverInstanceId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A workspace as a screen may see it.
 *
 * The root path is deliberately absent. A panel that never receives a host
 * path cannot leak one, and it has no use for it: everything it can ask for is
 * addressed by id.
 */
export interface PublicWorkspace {
  readonly workspaceId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly kind: WorkspaceKind;
  readonly serverInstanceId: string | null;
  readonly createdAt: string;
  readonly lastScan: {
    readonly inventoryId: string;
    readonly inventorySha256: string;
    readonly scannedAt: string;
    readonly totalFiles: number;
    readonly totalMods: number;
    readonly totalBytes: number;
  } | null;
}

export interface StoredInventory {
  readonly inventoryId: string;
  readonly workspaceId: string;
  readonly inventorySha256: string;
  readonly scannedAt: string;
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly totalMods: number;
  /** The scanner's own document, stored whole and returned unchanged. */
  readonly document: unknown;
}

export type WorkspaceErrorCode = 'slug-taken' | 'workspace-not-found' | 'no-inventory';

export class WorkspaceError extends Error {
  public readonly code: WorkspaceErrorCode;

  public constructor(code: WorkspaceErrorCode) {
    super(`workspace:${code}`);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

interface WorkspaceRow {
  readonly workspace_id: string;
  readonly slug: string;
  readonly display_name: string;
  readonly root_path: string;
  readonly kind: WorkspaceKind;
  readonly server_instance_id: string | null;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
}

interface InventoryRow {
  readonly inventory_id: string;
  readonly workspace_id: string;
  readonly inventory_sha256: string;
  readonly scanned_at: string | Date;
  readonly total_files: number | string;
  readonly total_bytes: number | string;
  readonly total_mods: number | string;
  readonly document: unknown;
}

function asIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

function mapWorkspace(row: WorkspaceRow): PanelWorkspace {
  return Object.freeze({
    workspaceId: row.workspace_id,
    slug: row.slug,
    displayName: row.display_name,
    rootPath: row.root_path,
    kind: row.kind,
    serverInstanceId: row.server_instance_id,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  });
}

function mapInventory(row: InventoryRow): StoredInventory {
  return Object.freeze({
    inventoryId: row.inventory_id,
    workspaceId: row.workspace_id,
    inventorySha256: row.inventory_sha256,
    scannedAt: asIso(row.scanned_at),
    totalFiles: asNumber(row.total_files),
    totalBytes: asNumber(row.total_bytes),
    totalMods: asNumber(row.total_mods),
    document: typeof row.document === 'string' ? JSON.parse(row.document) : row.document,
  });
}

export class WorkspaceRepository {
  public constructor(private readonly database: Database) {}

  public async register(input: {
    readonly slug: string;
    readonly displayName: string;
    readonly rootPath: string;
    readonly kind: WorkspaceKind;
    readonly createdBy: unknown;
  }): Promise<PanelWorkspace> {
    const existing = await this.database.query<WorkspaceRow>(
      'SELECT * FROM panel_workspaces WHERE slug = $1',
      [input.slug],
    );
    if (existing.rows[0] !== undefined) throw new WorkspaceError('slug-taken');

    const result = await this.database.query<WorkspaceRow>(
      `INSERT INTO panel_workspaces (workspace_id, slug, display_name, root_path, kind, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING workspace_id, slug, display_name, root_path, kind, server_instance_id,
                 created_at, updated_at`,
      [
        randomUUID(),
        input.slug,
        input.displayName,
        input.rootPath,
        input.kind,
        JSON.stringify(input.createdBy),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Workspace insert returned no row.');
    return mapWorkspace(row);
  }

  public async findById(workspaceId: string): Promise<PanelWorkspace | undefined> {
    const result = await this.database.query<WorkspaceRow>(
      `SELECT workspace_id, slug, display_name, root_path, kind, server_instance_id,
              created_at, updated_at
       FROM panel_workspaces WHERE workspace_id = $1`,
      [workspaceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapWorkspace(row);
  }

  /** Everything a screen may see, each with the last scan if there is one. */
  public async listPublic(): Promise<readonly PublicWorkspace[]> {
    const result = await this.database.query<
      WorkspaceRow & {
        readonly inventory_id: string | null;
        readonly inventory_sha256: string | null;
        readonly scanned_at: string | Date | null;
        readonly total_files: number | string | null;
        readonly total_mods: number | string | null;
        readonly total_bytes: number | string | null;
      }
    >(
      `SELECT w.workspace_id, w.slug, w.display_name, w.root_path, w.kind,
              w.server_instance_id,
              w.created_at, w.updated_at,
              i.inventory_id, i.inventory_sha256, i.scanned_at,
              i.total_files, i.total_mods, i.total_bytes
       FROM panel_workspaces w
       LEFT JOIN LATERAL (
         SELECT inventory_id, inventory_sha256, scanned_at, total_files, total_mods, total_bytes
         FROM workspace_inventories
         WHERE workspace_id = w.workspace_id
         ORDER BY scanned_at DESC LIMIT 1
       ) i ON TRUE
       ORDER BY w.display_name, w.slug`,
    );

    return Object.freeze(
      result.rows.map((row) =>
        Object.freeze({
          workspaceId: row.workspace_id,
          slug: row.slug,
          displayName: row.display_name,
          kind: row.kind,
          serverInstanceId: row.server_instance_id,
          createdAt: asIso(row.created_at),
          lastScan:
            row.inventory_id === null || row.scanned_at === null
              ? null
              : Object.freeze({
                  inventoryId: row.inventory_id,
                  inventorySha256: row.inventory_sha256 ?? '',
                  scannedAt: asIso(row.scanned_at),
                  totalFiles: asNumber(row.total_files ?? 0),
                  totalMods: asNumber(row.total_mods ?? 0),
                  totalBytes: asNumber(row.total_bytes ?? 0),
                }),
        }),
      ),
    );
  }

  public async recordScan(input: {
    readonly workspaceId: string;
    readonly inventorySha256: string;
    readonly totalFiles: number;
    readonly totalBytes: number;
    readonly totalMods: number;
    readonly document: unknown;
    readonly scannedBy: unknown;
    readonly scannedAt: Date;
  }): Promise<StoredInventory> {
    const result = await this.database.query<InventoryRow>(
      `INSERT INTO workspace_inventories (
         inventory_id, workspace_id, inventory_sha256, scanned_at, scanned_by,
         total_files, total_bytes, total_mods, document
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING inventory_id, workspace_id, inventory_sha256, scanned_at,
                 total_files, total_bytes, total_mods, document`,
      [
        randomUUID(),
        input.workspaceId,
        input.inventorySha256,
        input.scannedAt.toISOString(),
        JSON.stringify(input.scannedBy),
        input.totalFiles,
        input.totalBytes,
        input.totalMods,
        JSON.stringify(input.document),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Inventory insert returned no row.');
    return mapInventory(row);
  }

  public async latestInventory(workspaceId: string): Promise<StoredInventory | undefined> {
    const result = await this.database.query<InventoryRow>(
      `SELECT inventory_id, workspace_id, inventory_sha256, scanned_at,
              total_files, total_bytes, total_mods, document
       FROM workspace_inventories WHERE workspace_id = $1
       ORDER BY scanned_at DESC LIMIT 1`,
      [workspaceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapInventory(row);
  }

  /**
   * Scan history, newest first, without the documents.
   *
   * The documents are megabytes; a history list is a list. Whoever wants one
   * asks for it by id.
   */
  public async scanHistory(
    workspaceId: string,
    limit = 20,
  ): Promise<readonly Omit<StoredInventory, 'document'>[]> {
    const result = await this.database.query<Omit<InventoryRow, 'document'>>(
      `SELECT inventory_id, workspace_id, inventory_sha256, scanned_at,
              total_files, total_bytes, total_mods
       FROM workspace_inventories WHERE workspace_id = $1
       ORDER BY scanned_at DESC LIMIT $2`,
      [workspaceId, Math.min(Math.max(limit, 1), 100)],
    );
    return Object.freeze(
      result.rows.map((row) => {
        const { document: _ignored, ...rest } = mapInventory({ ...row, document: null });
        return Object.freeze(rest);
      }),
    );
  }

  public async findInventory(inventoryId: string): Promise<StoredInventory | undefined> {
    const result = await this.database.query<InventoryRow>(
      `SELECT inventory_id, workspace_id, inventory_sha256, scanned_at,
              total_files, total_bytes, total_mods, document
       FROM workspace_inventories WHERE inventory_id = $1`,
      [inventoryId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapInventory(row);
  }
}
