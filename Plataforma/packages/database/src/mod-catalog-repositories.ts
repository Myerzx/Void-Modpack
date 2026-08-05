import {
  validateModCatalogEntry,
  type ActorRef,
  type ModCatalogEntry,
} from '@voidfall/contracts';

import type { Database } from './database.js';

/**
 * Durable storage for the reviewed mod catalog.
 *
 * Until Phase 9.1 the catalog was a pure in-memory domain: a reconciliation
 * could be computed but never remembered, so every restart lost the human
 * review that produced it. The reviewed entry is stored whole and validated
 * against its public contract; the columns beside it exist to index and to
 * enforce concurrency, never to become a second source of truth.
 *
 * Every change names the actor and the reason, over the version the caller
 * read — a classification decided against a stale entry loses instead of
 * silently overwriting a newer review.
 */

export type ModCatalogErrorCode =
  | 'entry-not-found'
  | 'stale-entry'
  | 'invalid-entry'
  | 'content-conflict';

export class ModCatalogPersistenceError extends Error {
  public readonly code: ModCatalogErrorCode;

  public constructor(code: ModCatalogErrorCode) {
    super(`mod-catalog:${code}`);
    this.name = 'ModCatalogPersistenceError';
    this.code = code;
  }
}

interface CatalogRow {
  readonly entry_id: string;
  readonly server_instance_id: string;
  readonly sha256: string;
  readonly review_state: ModCatalogEntry['reviewState'];
  readonly entry: ModCatalogEntry | string;
  readonly actor: ActorRef | string;
  readonly reason_code: string;
  readonly version: string | number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const CATALOG_COLUMNS = `entry_id, server_instance_id, sha256, review_state, entry, actor,
  reason_code, version, created_at, updated_at`;

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function isoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export interface PersistedCatalogEntry {
  readonly entry: ModCatalogEntry;
  readonly serverInstanceId: string;
  readonly actor: ActorRef;
  readonly reasonCode: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function mapEntry(row: CatalogRow): PersistedCatalogEntry {
  const entry = parseJson(row.entry);
  // The stored document is the authority; a row that no longer satisfies the
  // public contract is a defect, not a value to publish.
  const validated = validateModCatalogEntry(entry);
  if (!validated.success) throw new ModCatalogPersistenceError('invalid-entry');
  return {
    entry: validated.value,
    serverInstanceId: row.server_instance_id,
    actor: parseJson(row.actor),
    reasonCode: row.reason_code,
    version: Number(row.version),
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
  };
}

export interface UpsertCatalogEntryInput {
  readonly serverInstanceId: string;
  readonly entry: ModCatalogEntry;
  readonly actor: ActorRef;
  readonly reasonCode: string;
  /** Required to change an existing entry; omitted to record a new one. */
  readonly expectedVersion?: number;
  readonly now: Date;
}

export interface ListCatalogInput {
  readonly serverInstanceId: string;
  readonly reviewStates?: readonly ModCatalogEntry['reviewState'][];
  readonly sides?: readonly ModCatalogEntry['side'][];
  readonly limit: number;
  readonly offset: number;
}

export interface CatalogPage {
  readonly entries: readonly PersistedCatalogEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export class ModCatalogRepository {
  constructor(private readonly database: Database) {}

  /**
   * Records a reviewed entry, or replaces the one the caller read.
   *
   * Content identity is unique per server, so the same bytes cannot be
   * catalogued twice under two logical identifiers — the reconciliation
   * decides which entry owns a digest, and the storage holds it to that.
   */
  async upsert(input: UpsertCatalogEntryInput): Promise<PersistedCatalogEntry> {
    const validated = validateModCatalogEntry(input.entry);
    if (!validated.success) throw new ModCatalogPersistenceError('invalid-entry');
    const entry = validated.value;

    return this.database.transaction(async (client) => {
      const current = await client.query<CatalogRow>(
        `SELECT ${CATALOG_COLUMNS} FROM mod_catalog_entries WHERE entry_id = $1 FOR UPDATE`,
        [entry.id],
      );
      const existing = current.rows[0];

      if (existing === undefined) {
        if (input.expectedVersion !== undefined) {
          throw new ModCatalogPersistenceError('entry-not-found');
        }
        let inserted;
        try {
          inserted = await client.query<CatalogRow>(
            `INSERT INTO mod_catalog_entries (
               entry_id, server_instance_id, sha256, filename, side, requirement, review_state,
               distribution_decision, entry, actor, reason_code, created_at, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$12)
             RETURNING ${CATALOG_COLUMNS}`,
            [
              entry.id,
              input.serverInstanceId,
              entry.sha256,
              entry.filename,
              entry.side,
              entry.requirement,
              entry.reviewState,
              entry.distribution.decision,
              JSON.stringify(entry),
              JSON.stringify(input.actor),
              input.reasonCode,
              input.now,
            ],
          );
        } catch {
          // The unique content index refused a second entry for one digest.
          throw new ModCatalogPersistenceError('content-conflict');
        }
        const row = inserted.rows[0];
        if (row === undefined) throw new ModCatalogPersistenceError('entry-not-found');
        return mapEntry(row);
      }

      if (input.expectedVersion === undefined) {
        // Creating over something that already exists would silently discard a
        // review somebody else recorded.
        throw new ModCatalogPersistenceError('stale-entry');
      }
      if (Number(existing.version) !== input.expectedVersion) {
        throw new ModCatalogPersistenceError('stale-entry');
      }

      const updated = await client.query<CatalogRow>(
        `UPDATE mod_catalog_entries
         SET server_instance_id = $2, sha256 = $3, filename = $4, side = $5, requirement = $6,
             review_state = $7, distribution_decision = $8, entry = $9::jsonb,
             actor = $10::jsonb, reason_code = $11, version = version + 1, updated_at = $12
         WHERE entry_id = $1
         RETURNING ${CATALOG_COLUMNS}`,
        [
          entry.id,
          input.serverInstanceId,
          entry.sha256,
          entry.filename,
          entry.side,
          entry.requirement,
          entry.reviewState,
          entry.distribution.decision,
          JSON.stringify(entry),
          JSON.stringify(input.actor),
          input.reasonCode,
          input.now,
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new ModCatalogPersistenceError('entry-not-found');
      return mapEntry(row);
    });
  }

  async findById(entryId: string): Promise<PersistedCatalogEntry | undefined> {
    const result = await this.database.query<CatalogRow>(
      `SELECT ${CATALOG_COLUMNS} FROM mod_catalog_entries WHERE entry_id = $1`,
      [entryId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapEntry(row);
  }

  async findBySha256(
    serverInstanceId: string,
    sha256: string,
  ): Promise<PersistedCatalogEntry | undefined> {
    const result = await this.database.query<CatalogRow>(
      `SELECT ${CATALOG_COLUMNS} FROM mod_catalog_entries
       WHERE server_instance_id = $1 AND sha256 = $2`,
      [serverInstanceId, sha256],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapEntry(row);
  }

  async list(input: ListCatalogInput): Promise<CatalogPage> {
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
    const offset = Math.min(Math.max(Math.trunc(input.offset), 0), 1_000_000);
    const parameters: unknown[] = [input.serverInstanceId];
    let clause = '';
    if (input.reviewStates !== undefined && input.reviewStates.length > 0) {
      parameters.push([...input.reviewStates]);
      clause += ` AND review_state = ANY($${parameters.length}::text[])`;
    }
    if (input.sides !== undefined && input.sides.length > 0) {
      parameters.push([...input.sides]);
      clause += ` AND side = ANY($${parameters.length}::text[])`;
    }

    const total = await this.database.query<{ readonly count: string | number }>(
      `SELECT COUNT(*) AS count FROM mod_catalog_entries WHERE server_instance_id = $1${clause}`,
      parameters,
    );
    const rows = await this.database.query<CatalogRow>(
      `SELECT ${CATALOG_COLUMNS} FROM mod_catalog_entries
       WHERE server_instance_id = $1${clause}
       ORDER BY entry_id
       LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      [...parameters, limit, offset],
    );

    return {
      entries: rows.rows.map(mapEntry),
      total: Number(total.rows[0]?.count ?? 0),
      limit,
      offset,
    };
  }
}
