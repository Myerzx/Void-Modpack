import pg from 'pg';

export interface SqlResult<Row extends object = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface SqlClient {
  query<Row extends object = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
  executeScript(sql: string): Promise<void>;
}

export interface Database extends SqlClient {
  transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function normalizeResult<Row extends object>(result: pg.QueryResult<Row>): SqlResult<Row> {
  return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

export class PostgresDatabase implements Database {
  readonly #pool: pg.Pool;

  constructor(connectionString: string, maximumConnections = 10) {
    this.#pool = new pg.Pool({
      connectionString,
      max: maximumConnections,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'voidfall-control-plane',
    });
  }

  async query<Row extends object = Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    return normalizeResult(await this.#pool.query<Row>(sql, [...parameters]));
  }

  async executeScript(sql: string): Promise<void> {
    await this.#pool.query(sql);
  }

  async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    const connection = await this.#pool.connect();
    try {
      await connection.query('BEGIN');
      const client: SqlClient = {
        query: async <Row extends object>(sql: string, parameters: readonly unknown[] = []) =>
          normalizeResult(await connection.query<Row>(sql, [...parameters])),
        executeScript: async (sql: string) => {
          await connection.query(sql);
        },
      };
      const value = await callback(client);
      await connection.query('COMMIT');
      return value;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
