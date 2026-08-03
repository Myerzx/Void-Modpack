import { access, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const workspaceRoot = resolve(process.cwd());
const outputDirectory = resolve(workspaceRoot, 'dist');
const buildInfoFile = resolve(workspaceRoot, 'tsconfig.build.tsbuildinfo');

await access(resolve(workspaceRoot, 'package.json'));

if (
  dirname(outputDirectory) !== workspaceRoot ||
  basename(outputDirectory) !== 'dist' ||
  dirname(buildInfoFile) !== workspaceRoot ||
  basename(buildInfoFile) !== 'tsconfig.build.tsbuildinfo'
) {
  throw new Error('Refusing to clean unexpected build paths.');
}

await Promise.all([
  rm(outputDirectory, { recursive: true, force: true }),
  rm(buildInfoFile, { force: true }),
]);
