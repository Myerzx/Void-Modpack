import { mkdir } from 'node:fs/promises';

import type { Database, SqlClient, SqlResult } from './database.js';

/**
 * A PostgreSQL that the project provisions instead of the operator.
 *
 * The local environment needs a database, and every honest answer to "which
 * one?" used to end in the operator installing something: a container runtime,
 * a service, a connection string to copy. PGlite is a real PostgreSQL compiled
 * to WebAssembly, it was already in this repository running the test suite,
 * and it persists to a directory. So the local answer is the one the project
 * can provision on its own — no daemon, no port, no credential to store.
 *
 * This is the **local** database. Production keeps `PostgresDatabase` over a
 * real server: PGlite is single-connection and single-process, which is right
 * for one operator on one machine and wrong for anything else. The two are
 * separate factories precisely so nobody reaches for this one by accident.
 *
 * The import is dynamic so a deployment that never starts the local
 * environment does not load a WebAssembly Postgres to find that out.
 */

interface PGliteQueryResult<Row extends object> {
  readonly rows: readonly Row[];
  readonly affectedRows?: number;
}

interface PGliteLike {
  query<Row extends object>(sql: string, parameters?: unknown[]): Promise<unknown>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(callback: (transaction: PGliteLike) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Maps PGlite's result shape onto the repository's client contract. */
export function pgliteClient(client: PGliteLike): SqlClient {
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

export function databaseFromPGlite(pglite: PGliteLike): Database {
  const client = pgliteClient(pglite);
  return {
    ...client,
    transaction: async <T>(callback: (transactionClient: SqlClient) => Promise<T>) =>
      pglite.transaction(async (transaction) => callback(pgliteClient(transaction))),
    close: async () => pglite.close(),
  };
}

export class EmbeddedDatabaseUnavailableError extends Error {
  public constructor() {
    // Named rather than generic, because the fix is a specific one: the
    // embedded engine ships with this repository and a missing install is the
    // only way to get here.
    super(
      'The embedded database engine is not installed. Run `npm install` in Plataforma/ and try again.',
    );
    this.name = 'EmbeddedDatabaseUnavailableError';
  }
}

/**
 * Opens — creating if needed — a PostgreSQL that lives in one directory.
 *
 * The directory is the whole database. Deleting it resets the local
 * environment to first-run, which is the behaviour somebody experimenting with
 * a panel actually wants.
 */
export async function createEmbeddedDatabase(dataDirectory: string): Promise<Database> {
  await mkdir(dataDirectory, { recursive: true });

  let module: { readonly PGlite: { create(options: { dataDir: string }): Promise<PGliteLike> } };
  try {
    module = (await import('@electric-sql/pglite')) as never;
  } catch {
    throw new EmbeddedDatabaseUnavailableError();
  }

  return databaseFromPGlite(await module.PGlite.create({ dataDir: dataDirectory }));
}
