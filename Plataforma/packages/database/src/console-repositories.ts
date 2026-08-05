import {
  redactConsoleText,
  validateConsolePage,
  type ConsoleLine,
  type ConsolePage,
  type ConsoleStream,
} from '@voidfall/contracts';

import type { Database } from './database.js';

/**
 * Durable console history.
 *
 * Until now the console existed only as a bounded snapshot the adapter held in
 * memory: nothing could be read incrementally, nothing was retained across a
 * restart, and redaction had to be reapplied on every read.
 *
 * Three properties define this store:
 *
 *  - **Append only, by sequence.** A cursor is a sequence, never an offset, so
 *    it stays meaningful while retention trims behind it. A reader can tell
 *    "nothing new" from "you fell off the end".
 *  - **Redacted on the way in.** A secret that reached storage in the clear
 *    would survive every later read policy.
 *  - **Bounded.** Retention is enforced here, so no caller can accumulate an
 *    unbounded console for a long-running server.
 */

export type ConsoleErrorCode = 'invalid-page' | 'invalid-cursor';

export class ConsolePersistenceError extends Error {
  public readonly code: ConsoleErrorCode;

  public constructor(code: ConsoleErrorCode) {
    super(`console:${code}`);
    this.name = 'ConsolePersistenceError';
    this.code = code;
  }
}

const MAXIMUM_PAGE = 500;
const DEFAULT_PAGE = 200;
const MAXIMUM_LINE_LENGTH = 2_048;

interface ConsoleRow {
  readonly sequence: string | number;
  readonly stream: ConsoleStream;
  readonly text: string;
  readonly occurred_at: Date | string;
  readonly truncated: boolean;
  readonly redacted: boolean;
}

function isoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapLine(row: ConsoleRow): ConsoleLine {
  return {
    sequence: Number(row.sequence),
    stream: row.stream,
    text: row.text,
    occurredAt: isoString(row.occurred_at),
    truncated: row.truncated,
    redacted: row.redacted,
  };
}

export interface AppendConsoleInput {
  readonly serverInstanceId: string;
  readonly lines: readonly {
    readonly stream: ConsoleStream;
    readonly text: string;
    readonly occurredAt: Date;
  }[];
  readonly bootId?: string;
  /** Maximum lines kept for this server; older ones are trimmed. */
  readonly retainLines: number;
  readonly now: Date;
}

export class ConsoleRepository {
  constructor(private readonly database: Database) {}

  /**
   * Appends lines and trims to the retention bound in one transaction.
   *
   * Trimming separately would leave a window where a crash keeps an unbounded
   * console, which is exactly what the bound exists to prevent.
   */
  async append(input: AppendConsoleInput): Promise<{ readonly lastSequence: number }> {
    if (input.lines.length === 0) {
      const current = await this.database.query<{ readonly next_sequence: string | number }>(
        'SELECT next_sequence FROM server_console_cursors WHERE server_instance_id = $1',
        [input.serverInstanceId],
      );
      return { lastSequence: Number(current.rows[0]?.next_sequence ?? 1) - 1 };
    }

    return this.database.transaction(async (client) => {
      const cursor = await client.query<{ readonly next_sequence: string | number }>(
        `INSERT INTO server_console_cursors (server_instance_id, next_sequence, updated_at)
         VALUES ($1, 1, $2)
         ON CONFLICT (server_instance_id) DO UPDATE SET updated_at = EXCLUDED.updated_at
         RETURNING next_sequence`,
        [input.serverInstanceId, input.now],
      );
      let sequence = Number(cursor.rows[0]?.next_sequence ?? 1);

      for (const line of input.lines) {
        const trimmed =
          line.text.length > MAXIMUM_LINE_LENGTH ? line.text.slice(0, MAXIMUM_LINE_LENGTH) : line.text;
        const { text, redacted } = redactConsoleText(trimmed);
        await client.query(
          `INSERT INTO server_console_lines (
             server_instance_id, sequence, stream, text, occurred_at, truncated, redacted,
             boot_id, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            input.serverInstanceId,
            sequence,
            line.stream,
            text,
            line.occurredAt,
            line.text.length > MAXIMUM_LINE_LENGTH,
            redacted,
            input.bootId ?? null,
            input.now,
          ],
        );
        sequence += 1;
      }

      // Retention, inside the same transaction as the append. The cutoff is
      // computed here rather than as `$2 - $3` in SQL, where two untyped
      // parameters leave the subtraction operator ambiguous.
      const retain = Math.max(1, Math.min(input.retainLines, 100_000));
      const cutoff = sequence - 1 - retain;
      await client.query(
        `DELETE FROM server_console_lines
         WHERE server_instance_id = $1 AND sequence <= $2`,
        [input.serverInstanceId, cutoff],
      );
      const remaining = await client.query<{ readonly count: string | number }>(
        'SELECT COUNT(*) AS count FROM server_console_lines WHERE server_instance_id = $1',
        [input.serverInstanceId],
      );
      await client.query(
        `UPDATE server_console_cursors
         SET next_sequence = $2, retained_lines = $3, updated_at = $4
         WHERE server_instance_id = $1`,
        [input.serverInstanceId, sequence, Number(remaining.rows[0]?.count ?? 0), input.now],
      );

      return { lastSequence: sequence - 1 };
    });
  }

  /**
   * Reads forward from a cursor.
   *
   * `oldestRetainedSequence` is returned so a reader whose cursor fell behind
   * retention can tell it missed lines instead of assuming it is up to date.
   */
  async read(input: {
    readonly serverInstanceId: string;
    /** Inclusive: the first sequence to return, which is what nextCursor is. */
    readonly fromSequence?: number;
    readonly limit?: number;
    readonly now: Date;
  }): Promise<ConsolePage> {
    const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_PAGE, MAXIMUM_PAGE));
    const from = Math.max(1, Math.trunc(input.fromSequence ?? 1));

    const rows = await this.database.query<ConsoleRow>(
      `SELECT sequence, stream, text, occurred_at, truncated, redacted
       FROM server_console_lines
       WHERE server_instance_id = $1 AND sequence >= $2
       ORDER BY sequence
       LIMIT $3`,
      [input.serverInstanceId, from, limit + 1],
    );

    const hasMore = rows.rows.length > limit;
    const lines = rows.rows.slice(0, limit).map(mapLine);

    const bounds = await this.database.query<{
      readonly oldest: string | number | null;
      readonly newest: string | number | null;
    }>(
      `SELECT MIN(sequence) AS oldest, MAX(sequence) AS newest
       FROM server_console_lines WHERE server_instance_id = $1`,
      [input.serverInstanceId],
    );
    const oldest = bounds.rows[0]?.oldest;
    const newest = bounds.rows[0]?.newest;

    const last = lines.at(-1);
    const page: ConsolePage = {
      schemaVersion: 1,
      serverInstanceId: input.serverInstanceId,
      lines,
      nextCursor:
        last !== undefined
          ? last.sequence + 1
          : newest === null || newest === undefined
            ? null
            : Number(newest) + 1,
      hasMore,
      oldestRetainedSequence: oldest === null || oldest === undefined ? null : Number(oldest),
      readAt: input.now.toISOString(),
    };

    const validated = validateConsolePage(page);
    if (!validated.success) throw new ConsolePersistenceError('invalid-page');
    return validated.value;
  }

  async retainedCount(serverInstanceId: string): Promise<number> {
    const result = await this.database.query<{ readonly count: string | number }>(
      'SELECT COUNT(*) AS count FROM server_console_lines WHERE server_instance_id = $1',
      [serverInstanceId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /** Drops lines older than a cutoff, for time-based retention. */
  async trimOlderThan(input: {
    readonly serverInstanceId: string;
    readonly olderThan: Date;
  }): Promise<number> {
    const result = await this.database.query(
      'DELETE FROM server_console_lines WHERE server_instance_id = $1 AND occurred_at < $2',
      [input.serverInstanceId, input.olderThan],
    );
    return result.rowCount;
  }
}
