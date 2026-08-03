import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Database } from './database.js';

interface MigrationRow {
  readonly id: string;
  readonly checksum: string;
}

export function migrationsDirectory(): URL {
  return new URL('../migrations/', import.meta.url);
}

export async function runMigrations(
  database: Database,
  directory = migrationsDirectory(),
): Promise<readonly string[]> {
  await database.executeScript(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const filenames = (await readdir(directory))
    .filter((filename) => /^[0-9]{4}_[a-z0-9_]+\.sql$/u.test(filename))
    .sort();
  const applied: string[] = [];

  for (const filename of filenames) {
    const sql = await readFile(new URL(filename, directory), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await database.query<MigrationRow>(
      'SELECT id, checksum FROM schema_migrations WHERE id = $1',
      [filename],
    );

    if (existing.rowCount > 0) {
      if (existing.rows[0]?.checksum !== checksum) {
        throw new Error(`Applied migration ${filename} has changed.`);
      }
      continue;
    }

    await database.transaction(async (client) => {
      await client.executeScript(sql);
      await client.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [
        filename,
        checksum,
      ]);
    });
    applied.push(filename);
  }

  return applied;
}
