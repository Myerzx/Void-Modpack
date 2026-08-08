import { PGlite } from '@electric-sql/pglite';

import { databaseFromPGlite } from './embedded.js';
import type { Database } from './database.js';

/**
 * An in-memory PostgreSQL for tests.
 *
 * Same engine the local environment persists to disk, wired through the same
 * mapping — so a test and a running panel disagree about SQL behaviour only if
 * the SQL is genuinely different.
 */
export async function createPGliteTestDatabase(): Promise<Database> {
  return databaseFromPGlite((await PGlite.create()) as never);
}
