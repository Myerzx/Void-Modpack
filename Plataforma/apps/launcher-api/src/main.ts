import { FilesystemReleaseRepository } from '@voidfall/modpack-release';
import { buildLauncherApi } from './app.js';
import { readLauncherApiConfig } from './config.js';

const config = readLauncherApiConfig();
const repository = new FilesystemReleaseRepository({ root: config.repositoryRoot });
const app = await buildLauncherApi({
  repository,
  publicKeys: config.publicKeys,
  logger: true,
});

const shutdown = async (): Promise<void> => {
  await app.close();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
await app.listen({ host: config.host, port: config.port });
