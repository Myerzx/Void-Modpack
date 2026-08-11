import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { packager } from '@electron/packager';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const platformRoot = resolve(desktopRoot, '..', '..');
const runtimeOutput = join(desktopRoot, '.package-runtime', 'voidfall');
const packageOutput = join(desktopRoot, 'out');
const appVersion = '0.1.0';

function assertWithin(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('..'))) return;
  throw new Error(`Refusing to mutate a path outside ${parent}: ${candidate}`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function workspaceMap() {
  const result = new Map();
  for (const group of ['packages', 'apps']) {
    const groupRoot = join(platformRoot, group);
    for (const entry of await readdir(groupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(groupRoot, entry.name);
      const packagePath = join(directory, 'package.json');
      try {
        const manifest = await readJson(packagePath);
        if (typeof manifest.name === 'string' && manifest.name.startsWith('@voidfall/')) {
          result.set(manifest.name, { directory, manifest });
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  return result;
}

function dependencyEntries(manifest) {
  return Object.entries(manifest.dependencies ?? {});
}

function runtimeClosure(workspaces, rootManifest) {
  const internal = new Set();
  const external = new Map();
  const pending = [...dependencyEntries(rootManifest)];
  while (pending.length > 0) {
    const [name, version] = pending.shift();
    if (name.startsWith('@voidfall/')) {
      if (internal.has(name)) continue;
      const workspace = workspaces.get(name);
      if (workspace === undefined) throw new Error(`Missing internal runtime workspace: ${name}`);
      internal.add(name);
      pending.push(...dependencyEntries(workspace.manifest));
      continue;
    }
    const existing = external.get(name);
    if (existing !== undefined && existing !== version) {
      throw new Error(`Conflicting runtime versions for ${name}: ${existing} and ${version}`);
    }
    external.set(name, version);
  }
  return { internal: [...internal].sort(), external };
}

function runtimePackageManifest(source) {
  return Object.fromEntries(
    ['name', 'version', 'description', 'license', 'type', 'main', 'exports', 'dependencies']
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
}

async function copyRequiredDirectory(source, destination, label) {
  try {
    const info = await stat(source);
    if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${source}`);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${label} is missing. Build the platform before packaging: ${source}`);
    }
    throw error;
  }
  await cp(source, destination, { recursive: true, force: true });
}

async function run(command, args, options = {}) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
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

async function collectThirdPartyNotices(nodeModulesRoot) {
  const seenDirectories = new Set();
  const notices = new Map();

  async function visit(directory) {
    const canonical = resolve(directory);
    if (seenDirectories.has(canonical)) return;
    seenDirectories.add(canonical);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.bin') continue;
      const child = join(directory, entry.name);
      if (entry.name.startsWith('@')) {
        await visit(child);
        continue;
      }
      const manifestPath = join(child, 'package.json');
      try {
        const manifest = await readJson(manifestPath);
        if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
          notices.set(`${manifest.name}@${manifest.version}`, {
            name: manifest.name,
            version: manifest.version,
            license: manifest.license ?? 'UNKNOWN',
          });
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const nested = join(child, 'node_modules');
      try {
        if ((await stat(nested)).isDirectory()) await visit(nested);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }

  await visit(nodeModulesRoot);
  return [...notices.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
}

async function prepareRuntime(stagingRoot) {
  const runtimeRoot = join(stagingRoot, 'runtime');
  const inputsRoot = join(stagingRoot, 'inputs');
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(inputsRoot, { recursive: true });

  const workspaces = await workspaceMap();
  const controlApi = workspaces.get('@voidfall/control-api');
  if (controlApi === undefined) throw new Error('The Control API workspace is missing.');
  const closure = runtimeClosure(workspaces, controlApi.manifest);
  const dependencies = Object.fromEntries([...closure.external.entries()].sort());

  for (const name of closure.internal) {
    const workspace = workspaces.get(name);
    const shortName = name.slice('@voidfall/'.length);
    const inputRoot = join(inputsRoot, shortName);
    await mkdir(inputRoot, { recursive: true });
    await writeFile(
      join(inputRoot, 'package.json'),
      `${JSON.stringify(runtimePackageManifest(workspace.manifest), null, 2)}\n`,
      'utf8',
    );
    await copyRequiredDirectory(join(workspace.directory, 'dist'), join(inputRoot, 'dist'), name);
    const migrations = join(workspace.directory, 'migrations');
    try {
      if ((await stat(migrations)).isDirectory()) {
        await cp(migrations, join(inputRoot, 'migrations'), { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    dependencies[name] = `file:../inputs/${shortName}`;
  }

  await writeFile(
    join(runtimeRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'voidfall-desktop-runtime',
        version: appVersion,
        private: true,
        license: 'UNLICENSED',
        type: 'module',
        dependencies: Object.fromEntries(Object.entries(dependencies).sort()),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const npmCli = process.env['npm_execpath'];
  if (npmCli === undefined) {
    throw new Error('npm_execpath is missing; run this script through the package:qa npm script.');
  }
  await run(
    process.execPath,
    [
      npmCli,
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--install-links',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--workspaces=false',
    ],
    {
      cwd: runtimeRoot,
      env: { ...process.env, NODE_ENV: 'production' },
    },
  );

  await copyRequiredDirectory(
    join(platformRoot, 'apps', 'control-api', 'dist'),
    join(runtimeRoot, 'control-api'),
    'compiled Control API',
  );
  await mkdir(join(runtimeRoot, 'desktop'), { recursive: true });
  await cp(
    join(desktopRoot, 'dist', 'backend.js'),
    join(runtimeRoot, 'desktop', 'backend.js'),
    { force: true },
  );
  await copyRequiredDirectory(
    join(platformRoot, 'apps', 'panel-web', 'out'),
    join(runtimeRoot, 'panel'),
    'exported panel',
  );

  const notices = await collectThirdPartyNotices(join(runtimeRoot, 'node_modules'));
  await writeFile(
    join(runtimeRoot, 'THIRD_PARTY_NOTICES.json'),
    `${JSON.stringify({ schemaVersion: 1, packages: notices }, null, 2)}\n`,
    'utf8',
  );

  for (const required of [
    join(runtimeRoot, 'node_modules', '@electric-sql', 'pglite'),
    join(runtimeRoot, 'node_modules', '@voidfall', 'database', 'migrations'),
    join(runtimeRoot, 'control-api', 'local.js'),
    join(runtimeRoot, 'desktop', 'backend.js'),
    join(runtimeRoot, 'panel', 'index.html'),
  ]) {
    await stat(required);
  }

  assertWithin(desktopRoot, runtimeOutput);
  await rm(dirname(runtimeOutput), { recursive: true, force: true });
  await mkdir(dirname(runtimeOutput), { recursive: true });
  await cp(runtimeRoot, runtimeOutput, { recursive: true, force: true });
  return { internalPackages: closure.internal.length, notices: notices.length };
}

async function sha256(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

async function packageApplication() {
  assertWithin(desktopRoot, packageOutput);
  await rm(packageOutput, { recursive: true, force: true });
  await mkdir(packageOutput, { recursive: true });

  const [packagedDirectory] = await packager({
    dir: desktopRoot,
    name: 'VoidFall',
    executableName: 'VoidFall',
    platform: 'win32',
    arch: 'x64',
    out: packageOutput,
    overwrite: true,
    asar: true,
    prune: true,
    extraResource: runtimeOutput,
    appVersion,
    buildVersion: appVersion,
    appCopyright: 'VoidFall QA build',
    ignore: [
      /[\\/]src(?:[\\/]|$)/u,
      /[\\/]test(?:[\\/]|$)/u,
      /[\\/]scripts(?:[\\/]|$)/u,
      /[\\/]out(?:[\\/]|$)/u,
      /[\\/]\.package-runtime(?:[\\/]|$)/u,
      /[\\/]tsconfig[^\\/]*\.json$/u,
    ],
  });

  const artifactDirectory = join(packageOutput, 'make', 'zip', 'win32', 'x64');
  await mkdir(artifactDirectory, { recursive: true });
  const archive = join(artifactDirectory, `VoidFall-win32-x64-${appVersion}.zip`);
  await run('tar.exe', ['-a', '-c', '-f', archive, '-C', packagedDirectory, '.']);
  const archiveInfo = await stat(archive);
  const digest = await sha256(archive);
  await writeFile(join(artifactDirectory, 'SHA256SUMS.txt'), `${digest}  ${basename(archive)}\n`, 'utf8');
  await writeFile(
    join(artifactDirectory, 'qa-manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        product: 'VoidFall',
        version: appVersion,
        platform: 'win32',
        architecture: 'x64',
        signed: false,
        autoUpdate: false,
        artifact: basename(archive),
        bytes: archiveInfo.size,
        sha256: digest,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { archive, bytes: archiveInfo.size, digest };
}

const temporary = await mkdtemp(join(tmpdir(), 'voidfall-desktop-package-'));
try {
  const runtime = await prepareRuntime(temporary);
  const artifact = await packageApplication();
  process.stdout.write(
    [
      `Runtime: ${String(runtime.internalPackages)} pacotes VoidFall, ${String(runtime.notices)} dependencias inventariadas`,
      `Artefato: ${artifact.archive}`,
      `Tamanho: ${String(artifact.bytes)} bytes`,
      `SHA-256: ${artifact.digest}`,
      'Assinatura: ausente (QA local apenas)',
      '',
    ].join('\n'),
  );
} finally {
  assertWithin(tmpdir(), temporary);
  await rm(temporary, { recursive: true, force: true });
}
