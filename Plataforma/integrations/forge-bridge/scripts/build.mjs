import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cleanOutput, compileJava, integrationRoot } from './java-tools.mjs';

const output = resolve(integrationRoot, 'build', 'classes');
await cleanOutput(output);
await mkdir(output, { recursive: true });
await compileJava({ includeTests: false, output });
