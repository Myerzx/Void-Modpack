import { rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDirectory = resolve(packageRoot, 'dist');
const buildInfoFile = resolve(packageRoot, 'tsconfig.build.tsbuildinfo');

if (
  dirname(outputDirectory) !== packageRoot ||
  basename(outputDirectory) !== 'dist' ||
  dirname(buildInfoFile) !== packageRoot ||
  basename(buildInfoFile) !== 'tsconfig.build.tsbuildinfo'
) {
  throw new Error('Refusing to clean an unexpected output directory.');
}

await Promise.all([
  rm(outputDirectory, { recursive: true, force: true }),
  rm(buildInfoFile, { force: true }),
]);
