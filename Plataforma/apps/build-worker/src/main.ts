import { PostgresDatabase, runMigrations } from '@voidfall/database';
import { runNoopWorker } from './worker.js';

const databaseUrl = process.env['DATABASE_URL'];
const workerId = process.env['VOIDFALL_WORKER_ID'];
if (databaseUrl === undefined || databaseUrl.length === 0) throw new Error('DATABASE_URL is required.');
if (workerId === undefined || !/^[0-9a-f-]{36}$/iu.test(workerId)) {
  throw new Error('VOIDFALL_WORKER_ID must be a UUID.');
}

const database = new PostgresDatabase(databaseUrl);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

try {
  await runMigrations(database);
  await runNoopWorker({ database, workerId, signal: controller.signal });
} finally {
  await database.close();
}
