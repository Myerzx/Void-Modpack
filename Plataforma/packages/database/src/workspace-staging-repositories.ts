import { randomUUID } from 'node:crypto';

import type { Database } from './database.js';

/**
 * What somebody intends to change, and what happened when it was tried.
 *
 * Staging used to be a file on disk and nothing else, so the panel could show
 * a diff and then forget which fields produced it. That is enough to review a
 * change and not enough to do anything with it — booting a sandbox against a
 * change needs the change, not a rewritten file somebody would have to read
 * back and guess at.
 *
 * The two halves have different natures on purpose. A staged change is an
 * intention still being edited, so it is replaced in place and deleted when
 * discarded. A sandbox run is evidence with a time on it, so it is created
 * once and completed once, and never reused.
 */

export interface StagedChangeSet {
  readonly path: string;
  readonly changes: readonly { readonly path: string; readonly value: unknown }[];
  /** What the source hashed to when the change was computed. */
  readonly baseSha256: string;
  readonly stagedSha256: string;
  readonly stagedAt: string;
}

export type SandboxRunStatus = 'running' | 'finished' | 'refused';

export interface SandboxRun {
  readonly runId: string;
  readonly workspaceId: string;
  readonly status: SandboxRunStatus;
  /** `null` while it runs. Not knowing yet is its own state, never a failure. */
  readonly outcome: string | null;
  /** Why the runner would not start at all. Named, never a bare failure. */
  readonly refusal: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly testedChanges: boolean;
  readonly progress: readonly string[];
  readonly evidence: unknown;
}

interface StagedRow {
  readonly path: string;
  readonly changes: unknown;
  readonly base_sha256: string;
  readonly staged_sha256: string;
  readonly staged_at: string | Date;
}

interface SandboxRunRow {
  readonly run_id: string;
  readonly workspace_id: string;
  readonly status: SandboxRunStatus;
  readonly outcome: string | null;
  readonly refusal: string | null;
  readonly started_at: string | Date;
  readonly finished_at: string | Date | null;
  readonly duration_ms: number | string | null;
  readonly tested_changes: boolean;
  readonly progress: unknown;
  readonly evidence: unknown;
}

function asIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function mapStaged(row: StagedRow): StagedChangeSet {
  return Object.freeze({
    path: row.path,
    changes: parseJson<StagedChangeSet['changes']>(row.changes, []),
    baseSha256: row.base_sha256,
    stagedSha256: row.staged_sha256,
    stagedAt: asIso(row.staged_at),
  });
}

function mapRun(row: SandboxRunRow): SandboxRun {
  return Object.freeze({
    runId: row.run_id,
    workspaceId: row.workspace_id,
    status: row.status,
    outcome: row.outcome,
    refusal: row.refusal,
    startedAt: asIso(row.started_at),
    finishedAt: row.finished_at === null ? null : asIso(row.finished_at),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    testedChanges: row.tested_changes,
    progress: parseJson<readonly string[]>(row.progress, []),
    evidence: parseJson<unknown>(row.evidence, null),
  });
}

export class WorkspaceStagingRepository {
  public constructor(private readonly database: Database) {}

  public async put(input: {
    readonly workspaceId: string;
    readonly path: string;
    readonly changes: readonly { readonly path: string; readonly value: unknown }[];
    readonly baseSha256: string;
    readonly stagedSha256: string;
    readonly stagedBy: unknown;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO workspace_staged_changes
         (workspace_id, path, changes, base_sha256, staged_sha256, staged_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (workspace_id, path) DO UPDATE SET
         changes = EXCLUDED.changes,
         base_sha256 = EXCLUDED.base_sha256,
         staged_sha256 = EXCLUDED.staged_sha256,
         staged_by = EXCLUDED.staged_by,
         staged_at = now()`,
      [
        input.workspaceId,
        input.path,
        JSON.stringify(input.changes),
        input.baseSha256,
        input.stagedSha256,
        JSON.stringify(input.stagedBy),
      ],
    );
  }

  public async list(workspaceId: string): Promise<readonly StagedChangeSet[]> {
    const result = await this.database.query<StagedRow>(
      `SELECT path, changes, base_sha256, staged_sha256, staged_at
       FROM workspace_staged_changes WHERE workspace_id = $1 ORDER BY path`,
      [workspaceId],
    );
    return Object.freeze(result.rows.map(mapStaged));
  }

  public async remove(workspaceId: string, path: string): Promise<void> {
    await this.database.query(
      'DELETE FROM workspace_staged_changes WHERE workspace_id = $1 AND path = $2',
      [workspaceId, path],
    );
  }
}

export class SandboxRunRepository {
  public constructor(private readonly database: Database) {}

  public async start(input: {
    readonly workspaceId: string;
    readonly testedChanges: boolean;
    readonly startedBy: unknown;
  }): Promise<SandboxRun> {
    const result = await this.database.query<SandboxRunRow>(
      `INSERT INTO workspace_sandbox_runs (run_id, workspace_id, status, tested_changes, started_by)
       VALUES ($1,$2,'running',$3,$4)
       RETURNING run_id, workspace_id, status, outcome, refusal, started_at, finished_at,
                 duration_ms, tested_changes, progress, evidence`,
      [randomUUID(), input.workspaceId, input.testedChanges, JSON.stringify(input.startedBy)],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Sandbox run insert returned no row.');
    return mapRun(row);
  }

  /** Appends a progress line, so a reload mid-boot sees where it got to. */
  public async appendProgress(runId: string, line: string): Promise<void> {
    await this.database.query(
      `UPDATE workspace_sandbox_runs
       SET progress = progress || to_jsonb($2::text)
       WHERE run_id = $1 AND status = 'running'`,
      [runId, line],
    );
  }

  public async finish(input: {
    readonly runId: string;
    readonly outcome: string;
    readonly durationMs: number;
    readonly evidence: unknown;
  }): Promise<void> {
    await this.database.query(
      `UPDATE workspace_sandbox_runs
       SET status = 'finished', outcome = $2, duration_ms = $3, evidence = $4, finished_at = now()
       WHERE run_id = $1 AND status = 'running'`,
      [input.runId, input.outcome, input.durationMs, JSON.stringify(input.evidence)],
    );
  }

  public async refuse(runId: string, refusal: string): Promise<void> {
    await this.database.query(
      `UPDATE workspace_sandbox_runs
       SET status = 'refused', refusal = $2, finished_at = now()
       WHERE run_id = $1 AND status = 'running'`,
      [runId, refusal],
    );
  }

  public async findById(runId: string): Promise<SandboxRun | undefined> {
    const result = await this.database.query<SandboxRunRow>(
      `SELECT run_id, workspace_id, status, outcome, refusal, started_at, finished_at,
              duration_ms, tested_changes, progress, evidence
       FROM workspace_sandbox_runs WHERE run_id = $1`,
      [runId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRun(row);
  }

  public async list(workspaceId: string, limit = 20): Promise<readonly SandboxRun[]> {
    const result = await this.database.query<SandboxRunRow>(
      `SELECT run_id, workspace_id, status, outcome, refusal, started_at, finished_at,
              duration_ms, tested_changes, progress, evidence
       FROM workspace_sandbox_runs WHERE workspace_id = $1
       ORDER BY started_at DESC LIMIT $2`,
      [workspaceId, Math.min(Math.max(limit, 1), 100)],
    );
    return Object.freeze(result.rows.map(mapRun));
  }

  /**
   * True when this workspace already has a boot in flight.
   *
   * One JVM at a time per workspace. Two sandboxes composed from the same
   * server would contend for the same source files and the same port, and the
   * second one would fail in a way that reads like the change under test.
   */
  public async hasRunning(workspaceId: string): Promise<boolean> {
    const result = await this.database.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count FROM workspace_sandbox_runs
       WHERE workspace_id = $1 AND status = 'running'`,
      [workspaceId],
    );
    return Number(result.rows[0]?.count ?? '0') > 0;
  }
}
