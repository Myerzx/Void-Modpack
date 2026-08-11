import { randomUUID } from 'node:crypto';

import type { EcosystemAnalysis } from '@voidfall/ecosystem-analysis';

import type { Database } from './database.js';

export interface StoredEcosystemAnalysis {
  readonly recordId: string;
  readonly workspaceId: string;
  readonly inventoryId: string;
  readonly inventorySha256: string;
  readonly analysisId: string;
  readonly analyzerVersion: string;
  readonly generatedAt: string;
  readonly document: EcosystemAnalysis;
}

interface EcosystemAnalysisRow {
  readonly record_id: string;
  readonly workspace_id: string;
  readonly inventory_id: string;
  readonly inventory_sha256: string;
  readonly analysis_id: string;
  readonly analyzer_version: string;
  readonly generated_at: string | Date;
  readonly document: EcosystemAnalysis | string;
}

function mapRow(row: EcosystemAnalysisRow): StoredEcosystemAnalysis {
  return Object.freeze({
    recordId: row.record_id,
    workspaceId: row.workspace_id,
    inventoryId: row.inventory_id,
    inventorySha256: row.inventory_sha256,
    analysisId: row.analysis_id,
    analyzerVersion: row.analyzer_version,
    generatedAt:
      row.generated_at instanceof Date
        ? row.generated_at.toISOString()
        : new Date(row.generated_at).toISOString(),
    document:
      typeof row.document === 'string'
        ? (JSON.parse(row.document) as EcosystemAnalysis)
        : row.document,
  });
}

const COLUMNS = `record_id, workspace_id, inventory_id, inventory_sha256,
  analysis_id, analyzer_version, generated_at, document`;

/** Immutable cache of normalized ecosystem analysis snapshots. */
export class EcosystemAnalysisRepository {
  public constructor(private readonly database: Database) {}

  public async findForInventory(input: {
    readonly workspaceId: string;
    readonly inventorySha256: string;
    readonly analyzerVersion: string;
  }): Promise<StoredEcosystemAnalysis | undefined> {
    const result = await this.database.query<EcosystemAnalysisRow>(
      `SELECT ${COLUMNS} FROM workspace_ecosystem_analyses
       WHERE workspace_id = $1 AND inventory_sha256 = $2 AND analyzer_version = $3`,
      [input.workspaceId, input.inventorySha256, input.analyzerVersion],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  }

  public async latest(workspaceId: string): Promise<StoredEcosystemAnalysis | undefined> {
    const result = await this.database.query<EcosystemAnalysisRow>(
      `SELECT ${COLUMNS} FROM workspace_ecosystem_analyses
       WHERE workspace_id = $1 ORDER BY generated_at DESC, record_id DESC LIMIT 1`,
      [workspaceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  }

  public async findByAnalysisId(input: {
    readonly workspaceId: string;
    readonly analysisId: string;
  }): Promise<StoredEcosystemAnalysis | undefined> {
    const result = await this.database.query<EcosystemAnalysisRow>(
      `SELECT ${COLUMNS} FROM workspace_ecosystem_analyses
       WHERE workspace_id = $1 AND analysis_id = $2`,
      [input.workspaceId, input.analysisId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  }

  public async save(input: {
    readonly workspaceId: string;
    readonly inventoryId: string;
    readonly document: EcosystemAnalysis;
  }): Promise<StoredEcosystemAnalysis> {
    const result = await this.database.query<EcosystemAnalysisRow>(
      `INSERT INTO workspace_ecosystem_analyses (
         record_id, workspace_id, inventory_id, inventory_sha256,
         analysis_id, analyzer_version, generated_at, document
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (workspace_id, inventory_sha256, analyzer_version) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        input.workspaceId,
        input.inventoryId,
        input.document.inventorySha256,
        input.document.analysisId,
        input.document.analyzerVersion,
        input.document.generatedAt,
        JSON.stringify(input.document),
      ],
    );
    const inserted = result.rows[0];
    if (inserted !== undefined) return mapRow(inserted);

    const existing = await this.findForInventory({
      workspaceId: input.workspaceId,
      inventorySha256: input.document.inventorySha256,
      analyzerVersion: input.document.analyzerVersion,
    });
    if (existing === undefined) {
      throw new Error('Ecosystem analysis conflict returned no stored row.');
    }
    return existing;
  }
}
