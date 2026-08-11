import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const artifactDirectory = join(desktopRoot, 'out', 'make', 'zip', 'win32', 'x64');
const READY_TIMEOUT_MS = 90_000;

function assertWithin(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('..'))) return;
  throw new Error(`Refusing to mutate a path outside ${parent}: ${candidate}`);
}

async function newestArchive() {
  const entries = await readdir(artifactDirectory, { withFileTypes: true });
  const archives = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.zip')) continue;
    const path = join(artifactDirectory, entry.name);
    archives.push({ path, modified: (await stat(path)).mtimeMs });
  }
  archives.sort((left, right) => right.modified - left.modified);
  if (archives[0] === undefined) {
    throw new Error('No QA archive found. Run `npm run desktop:package` first.');
  }
  return archives[0].path;
}

async function run(command, args, cwd) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with code ${String(code)}`));
    });
  });
}

async function waitForFile(path, timeoutMs = READY_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function findExecutable(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === 'VoidFall.exe') return path;
    if (entry.isDirectory()) {
      const nested = await findExecutable(path);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function startApplication(executable, userData, reportDirectory) {
  const output = [];
  const child = spawn(executable, [], {
    cwd: dirname(executable),
    env: {
      ...process.env,
      VOIDFALL_DESKTOP_USER_DATA: userData,
      VOIDFALL_DESKTOP_QA_SMOKE_DIRECTORY: reportDirectory,
    },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk) => {
    if (output.join('').length < 32_000) output.push(String(chunk));
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  return { child, output };
}

async function waitForExit(running, timeoutMs) {
  if (running.child.exitCode !== null) return running.child.exitCode;
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`VoidFall did not exit in time.\n${running.output.join('')}`));
    }, timeoutMs);
    running.child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    running.child.once('exit', (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
}

async function stopApplication(running, reportDirectory) {
  await writeFile(join(reportDirectory, 'stop'), 'stop\n', 'utf8');
  const code = await waitForExit(running, 30_000);
  if (code !== 0) throw new Error(`VoidFall exited with code ${String(code)}.`);
  const stopped = JSON.parse(await waitForFile(join(reportDirectory, 'stopped.json'), 10_000));
  if (stopped.backendStopped !== true) {
    throw new Error('The packaged backend did not report a graceful shutdown.');
  }
}

async function sha256(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

const archive = await newestArchive();
const temporary = await mkdtemp(join(tmpdir(), 'voidfall-desktop-smoke-'));
const extracted = join(temporary, 'application');
const userData = join(temporary, 'user-data');
const live = [];

try {
  await mkdir(extracted, { recursive: true });
  await mkdir(userData, { recursive: true });
  await run('tar.exe', ['-x', '-f', archive, '-C', extracted], temporary);
  const executable = await findExecutable(extracted);
  if (executable === null) throw new Error('VoidFall.exe is missing from the QA archive.');

  const runOneDirectory = join(temporary, 'run-1');
  await mkdir(runOneDirectory, { recursive: true });
  const first = startApplication(executable, userData, runOneDirectory);
  live.push(first);
  const firstReady = JSON.parse(await waitForFile(join(runOneDirectory, 'ready.json')));
  if (firstReady.packaged !== true || new URL(firstReady.currentUrl).pathname !== '/workspaces') {
    throw new Error(`Packaged session did not land on /workspaces: ${JSON.stringify(firstReady)}`);
  }
  const health = await fetch(`${firstReady.baseUrl}/health/live`);
  if (!health.ok) throw new Error(`Packaged health check failed with HTTP ${String(health.status)}.`);
  const panel = await fetch(`${firstReady.baseUrl}/workspaces`);
  if (!panel.ok) throw new Error(`Packaged panel failed with HTTP ${String(panel.status)}.`);

  const ownerFile = join(userData, 'runtime', 'first-owner.txt');
  await waitForFile(ownerFile);
  const ownerDigest = await sha256(ownerFile);

  const runTwoDirectory = join(temporary, 'run-2');
  await mkdir(runTwoDirectory, { recursive: true });
  const second = startApplication(executable, userData, runTwoDirectory);
  const secondCode = await waitForExit(second, 15_000);
  if (secondCode !== 0) throw new Error(`Second instance exited with code ${String(secondCode)}.`);
  try {
    await stat(join(runTwoDirectory, 'ready.json'));
    throw new Error('A second packaged instance reached ready state despite the single-instance lock.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await stopApplication(first, runOneDirectory);
  live.splice(live.indexOf(first), 1);

  const runThreeDirectory = join(temporary, 'run-3');
  await mkdir(runThreeDirectory, { recursive: true });
  const third = startApplication(executable, userData, runThreeDirectory);
  live.push(third);
  const thirdReady = JSON.parse(await waitForFile(join(runThreeDirectory, 'ready.json')));
  if (new URL(thirdReady.currentUrl).pathname !== '/workspaces') {
    throw new Error('The reopened packaged session did not return to the panel.');
  }
  if ((await sha256(ownerFile)) !== ownerDigest) {
    throw new Error('The first-owner credential changed after reopening the same packaged state.');
  }
  await stat(join(userData, 'runtime', 'database'));
  await stopApplication(third, runThreeDirectory);
  live.splice(live.indexOf(third), 1);

  process.stdout.write(
    [
      'VoidFall packaged QA smoke: PASS',
      `Archive: ${archive}`,
      'Checks: external extraction, PGlite+migrations, panel session, health, single instance, graceful stop, persistence after reopen',
      '',
    ].join('\n'),
  );
} finally {
  for (const running of live) {
    if (running.child.exitCode === null) running.child.kill();
  }
  assertWithin(tmpdir(), temporary);
  await rm(temporary, { recursive: true, force: true });
}
