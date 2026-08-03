import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Database, SqlClient, SqlResult } from './database.js';

interface PGliteQueryResult<Row extends object> {
  readonly rows: readonly Row[];
  readonly affectedRows?: number;
}

function pgliteClient(client: PGlite | Transaction): SqlClient {
  return {
    query: async <Row extends object>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<SqlResult<Row>> => {
      const result = (await client.query<Row>(sql, [...parameters])) as PGliteQueryResult<Row>;
      return {
        rows: result.rows,
        rowCount: Math.max(result.affectedRows ?? 0, result.rows.length),
      };
    },
    executeScript: async (sql: string) => {
      await client.exec(sql);
    },
  };
}

export async function createPGliteTestDatabase(): Promise<Database> {
  const pglite = await PGlite.create();
  const client = pgliteClient(pglite);
  return {
    ...client,
    transaction: async <T>(callback: (transactionClient: SqlClient) => Promise<T>) =>
      pglite.transaction(async (transaction) => callback(pgliteClient(transaction))),
    close: async () => pglite.close(),
  };
}
