import { mkdir } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { cleanOutput, compileJava, integrationRoot, run } from './java-tools.mjs';

const output = resolve(integrationRoot, 'build', 'test-classes');
await cleanOutput(output);
await mkdir(output, { recursive: true });
await compileJava({ includeTests: true, output });
await run('java', ['-ea', '-cp', output.split(delimiter).join(delimiter), 'dev.voidfall.forgebridge.BuildCommandServiceTest']);
