import { mkdir } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { cleanOutput, compileJava, integrationRoot, run } from './java-tools.mjs';

const output = resolve(integrationRoot, 'build', 'test-classes');
await cleanOutput(output);
await mkdir(output, { recursive: true });
await compileJava({ includeTests: true, output });
const classpath = output.split(delimiter).join(delimiter);
const suites = [
  'dev.voidfall.forgebridge.BuildCommandServiceTest',
  'dev.voidfall.forgebridge.permissions.PermissionCommandServiceTest',
];
for (const suite of suites) {
  await run('java', ['-ea', '-cp', classpath, suite]);
}
