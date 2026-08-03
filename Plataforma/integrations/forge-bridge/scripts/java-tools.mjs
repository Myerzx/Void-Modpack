import { readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const integrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function javaSources(directory) {
  const result = [];
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.java')) result.push(path);
    }
  };
  await walk(directory);
  return result;
}

export async function cleanOutput(output) {
  const absolute = resolve(output);
  const buildRoot = resolve(integrationRoot, 'build');
  if (absolute !== buildRoot && !absolute.startsWith(`${buildRoot}\\`) && !absolute.startsWith(`${buildRoot}/`)) {
    throw new Error('Refusing to clean outside the Forge Bridge build directory.');
  }
  await rm(absolute, { recursive: true, force: true });
}

export async function compileJava({ includeTests, output }) {
  const sourceRoots = [resolve(integrationRoot, 'src', 'main', 'java')];
  if (includeTests) sourceRoots.push(resolve(integrationRoot, 'src', 'test', 'java'));
  const sources = (await Promise.all(sourceRoots.map(javaSources))).flat();
  if (sources.length === 0) throw new Error('No Java sources found.');
  await run('javac', ['--release', '17', '-encoding', 'UTF-8', '-d', output, ...sources]);
}

export async function run(executable, args) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd: integrationRoot,
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${executable} failed with code ${String(code)} signal ${String(signal)}.`));
    });
  });
}
