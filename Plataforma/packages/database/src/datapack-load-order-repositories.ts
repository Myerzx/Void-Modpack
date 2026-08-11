import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { AuditEvent } from '@voidfall/contracts';
import {
  projectObservedDatapackLoadOrder,
  validateDatapackLoadOrderObservation,
  validateDatapackLoadOrderProjection,
  type DatapackLoadOrderObservation,
  type DatapackLoadOrderProjection,
  type EcosystemAnalysis,
} from '@voidfall/ecosystem-analysis';

import { appendAuditRecord } from './audit-persistence.js';
import type { Database, SqlClient } from './database.js';

export type DatapackLoadOrderPersistenceErrorCode =
  | 'analysis-not-found'
  | 'inventory-mismatch'
  | 'stored-record-invalid'
  | 'immutable-replay-mismatch';

export class DatapackLoadOrderPersistenceError extends Error {
  public readonly code: DatapackLoadOrderPersistenceErrorCode;

  public constructor(code: DatapackLoadOrderPersistenceErrorCode) {
    super(`datapack-load-order-persistence:${code}`);
    this.name = 'DatapackLoadOrderPersistenceError';
    this.code = code;
  }
}

export interface StoredDatapackLoadOrderObservation {
  readonly recordId: string;
  /** Durable job identity for operational captures; null for isolated evidence. */
  readonly jobId: string | null;
  readonly workspaceId: string;
  readonly analysisId: string;
  readonly inventorySha256: string;
  readonly observationId: string;
  readonly source: DatapackLoadOrderObservation['source'];
  readonly observedAt: string;
  readonly evidenceSha256: string;
  readonly observation: DatapackLoadOrderObservation;
  readonly projection: DatapackLoadOrderProjection;
  readonly createdAt: string;
}

interface DatapackLoadOrderRow {
  readonly record_id: string;
  readonly job_id: string | null;
  readonly workspace_id: string;
  readonly analysis_id: string;
  readonly inventory_sha256: string;
  readonly observation_id: string;
  readonly source: string;
  readonly observed_at: string | Date;
  readonly evidence_sha256: string;
  readonly observation_document: unknown;
  readonly projection_document: unknown;
  readonly created_at: string | Date;
}

interface AnalysisRow {
  readonly analysis_id: string;
  readonly inventory_sha256: string;
  readonly document: unknown;
}

function jsonValue(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) as unknown : value;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: DatapackLoadOrderRow): StoredDatapackLoadOrderObservation {
  try {
    const observation = validateDatapackLoadOrderObservation(jsonValue(row.observation_document));
    const projection = validateDatapackLoadOrderProjection(jsonValue(row.projection_document));
    const observedAt = iso(row.observed_at);
    const createdAt = iso(row.created_at);
    if (
      observation.observationId !== row.observation_id ||
      observation.inventorySha256 !== row.inventory_sha256 ||
      observation.source !== row.source ||
      observation.observedAt !== observedAt ||
      observation.evidenceSha256 !== row.evidence_sha256 ||
      projection.analysisId !== row.analysis_id ||
      projection.inventorySha256 !== row.inventory_sha256 ||
      projection.observationId !== row.observation_id ||
      projection.observationSource !== row.source ||
      projection.observedAt !== observedAt ||
      projection.evidenceSha256 !== row.evidence_sha256
    ) {
      throw new DatapackLoadOrderPersistenceError('stored-record-invalid');
    }
    return Object.freeze({
      recordId: row.record_id,
      jobId: row.job_id,
      workspaceId: row.workspace_id,
      analysisId: row.analysis_id,
      inventorySha256: row.inventory_sha256,
      observationId: row.observation_id,
      source: observation.source,
      observedAt,
      evidenceSha256: row.evidence_sha256,
      observation,
      projection,
      createdAt,
    });
  } catch (error) {
    if (error instanceof DatapackLoadOrderPersistenceError) throw error;
    throw new DatapackLoadOrderPersistenceError('stored-record-invalid');
  }
}

const COLUMNS = `record_id, job_id, workspace_id, analysis_id, inventory_sha256,
  observation_id, source, observed_at, evidence_sha256,
  observation_document, projection_document, created_at`;

/** Immutable observations and projections, separate from the analyzer cache. */
export class DatapackLoadOrderRepository {
  public constructor(private readonly database: Database) {}

  public async find(input: {
    readonly workspaceId: string;
    readonly analysisId: string;
    readonly observationId: string;
  }): Promise<StoredDatapackLoadOrderObservation | undefined> {
    const result = await this.database.query<DatapackLoadOrderRow>(
      `SELECT ${COLUMNS} FROM workspace_datapack_load_order_observations
       WHERE workspace_id = $1 AND analysis_id = $2 AND observation_id = $3`,
      [input.workspaceId, input.analysisId, input.observationId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  }

  public async findByJobId(jobId: string): Promise<StoredDatapackLoadOrderObservation | undefined> {
    const result = await this.database.query<DatapackLoadOrderRow>(
      `SELECT ${COLUMNS} FROM workspace_datapack_load_order_observations
       WHERE job_id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  }

  public async latestForAnalysis(input: {
    readonly workspaceId: string;
    readonly analysisId: string;
  }): Promise<StoredDatapackLoadOrderObservation | undefined> {
    const result = await this.database.query<DatapackLoadOrderRow>(
      `SELECT ${COLUMNS} FROM workspace_datapack_load_order_observations
       WHERE workspace_id = $1 AND analysis_id = $2
       ORDER BY observed_at DESC, record_id DESC LIMIT 1`,
      [input.workspaceId, input.analysisId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  }

  public async save(input: {
    readonly workspaceId: string;
    readonly analysisId: string;
    readonly observation: DatapackLoadOrderObservation;
  }): Promise<StoredDatapackLoadOrderObservation> {
    const saved = await this.#save(this.database, { ...input, jobId: null });
    return saved.record;
  }

  /**
   * Persists the one effect of an agent job together with its sanitized audit.
   *
   * `job_id` is the idempotency boundary. If the agent lost its result response
   * after commit, the next lease returns the original record without reading
   * the world again or appending a second success event.
   */
  public async saveOperational(input: {
    readonly jobId: string;
    readonly workspaceId: string;
    readonly analysisId: string;
    readonly observation: DatapackLoadOrderObservation;
    readonly auditEvent: AuditEvent;
  }): Promise<{
    readonly record: StoredDatapackLoadOrderObservation;
    readonly replayed: boolean;
  }> {
    return this.database.transaction(async (client) => {
      const saved = await this.#save(client, input);
      if (!saved.replayed) {
        await appendAuditRecord(client, input.auditEvent, 'datapack-load-order');
      }
      return saved;
    });
  }

  async #save(
    client: SqlClient,
    input: {
      readonly jobId: string | null;
      readonly workspaceId: string;
      readonly analysisId: string;
      readonly observation: DatapackLoadOrderObservation;
    },
  ): Promise<{
    readonly record: StoredDatapackLoadOrderObservation;
    readonly replayed: boolean;
  }> {
    const observation = validateDatapackLoadOrderObservation(input.observation);
    const analysisResult = await client.query<AnalysisRow>(
      `SELECT analysis_id, inventory_sha256, document
       FROM workspace_ecosystem_analyses
       WHERE workspace_id = $1 AND analysis_id = $2
       LIMIT 1`,
      [input.workspaceId, input.analysisId],
    );
    const analysisRow = analysisResult.rows[0];
    if (analysisRow === undefined) {
      throw new DatapackLoadOrderPersistenceError('analysis-not-found');
    }
    let analysis: EcosystemAnalysis;
    try {
      analysis = jsonValue(analysisRow.document) as EcosystemAnalysis;
    } catch {
      throw new DatapackLoadOrderPersistenceError('stored-record-invalid');
    }
    if (
      analysis === null || typeof analysis !== 'object' ||
      analysis.analysisId !== analysisRow.analysis_id ||
      analysis.inventorySha256 !== analysisRow.inventory_sha256
    ) {
      throw new DatapackLoadOrderPersistenceError('stored-record-invalid');
    }
    if (observation.inventorySha256 !== analysis.inventorySha256) {
      throw new DatapackLoadOrderPersistenceError('inventory-mismatch');
    }
    const projection = projectObservedDatapackLoadOrder({ analysis, observation });

    const inserted = await client.query<DatapackLoadOrderRow>(
      `INSERT INTO workspace_datapack_load_order_observations (
         record_id, job_id, workspace_id, analysis_id, inventory_sha256,
         observation_id, source, observed_at, evidence_sha256,
         observation_document, projection_document
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        input.jobId,
        input.workspaceId,
        input.analysisId,
        observation.inventorySha256,
        observation.observationId,
        observation.source,
        observation.observedAt,
        observation.evidenceSha256,
        JSON.stringify(observation),
        JSON.stringify(projection),
      ],
    );
    const insertedRow = inserted.rows[0];
    if (insertedRow !== undefined) {
      return { record: mapRow(insertedRow), replayed: false };
    }

    const existingResult =
      input.jobId === null
        ? await client.query<DatapackLoadOrderRow>(
            `SELECT ${COLUMNS} FROM workspace_datapack_load_order_observations
             WHERE workspace_id = $1 AND analysis_id = $2 AND observation_id = $3`,
            [input.workspaceId, input.analysisId, observation.observationId],
          )
        : await client.query<DatapackLoadOrderRow>(
            `SELECT ${COLUMNS} FROM workspace_datapack_load_order_observations
             WHERE job_id = $1`,
            [input.jobId],
          );
    const existingRow = existingResult.rows[0];
    const existing = existingRow === undefined ? undefined : mapRow(existingRow);
    if (existing === undefined) {
      throw new DatapackLoadOrderPersistenceError('immutable-replay-mismatch');
    }
    if (
      existing.workspaceId !== input.workspaceId ||
      existing.analysisId !== input.analysisId ||
      existing.jobId !== input.jobId ||
      !isDeepStrictEqual(existing.observation, observation) ||
      !isDeepStrictEqual(existing.projection, projection)
    ) {
      throw new DatapackLoadOrderPersistenceError('immutable-replay-mismatch');
    }
    return { record: existing, replayed: true };
  }
}
