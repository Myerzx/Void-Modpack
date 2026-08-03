import { rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDirectory = resolve(packageRoot, 'dist');

if (dirname(outputDirectory) !== packageRoot || basename(outputDirectory) !== 'dist') {
  throw new Error('Refusing to clean an unexpected output directory.');
}

await rm(outputDirectory, { recursive: true, force: true });
