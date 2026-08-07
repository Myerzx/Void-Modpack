import { PostgresDatabase, runMigrations } from '@voidfall/database';
import { buildControlApi } from './app.js';
import { readControlApiConfig } from './config.js';
import { createWorkspaceScanner, defaultWorkspaceRootPolicy } from './workspace-scanner.js';

const config = readControlApiConfig();
const database = new PostgresDatabase(config.databaseUrl);

try {
  await runMigrations(database);
  const app = await buildControlApi({
    database,
    cookieSecure: config.cookieSecure,
    logger: true,
    // Reading an imported workspace is structurally read-only — the scanner
    // never opens a file for writing — so wiring it in the running API is safe
    // in a way that nothing touching a runtime would be.
    workspaceScanner: createWorkspaceScanner(),
    workspaceRootPolicy: defaultWorkspaceRootPolicy,
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await database.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  await database.close();
  throw error;
}
