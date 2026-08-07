import { execFile } from 'node:child_process';
import { access, mkdir, readdir, readFile, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, posix, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { forgeArgsFileName, type SupportedHostPlatform } from '@voidfall/minecraft-process';

import { SandboxError } from './types.js';

/**
 * Finds everything a sandbox boot needs, without being told any of it.
 *
 * A panel that receives a server has to prepare the environment itself. Asking
 * an operator for a Java path is asking them to do the discovery the product
 * exists to do — and a path typed once is a path that goes stale the next time
 * they upgrade.
 *
 * Everything here is discovery or derivation from what is already on the host
 * and in the imported server. Nothing is defaulted to a value that happens to
 * work on one machine, and every refusal names what was looked for.
 */

const run = promisify(execFile);

/** Forge 1.20.1 runs on Java 17. Older will not start it; newer is a gamble. */
export const REQUIRED_JAVA_MAJOR = 17;

export interface DiscoveredJava {
  readonly executable: string;
  readonly major: number;
  readonly version: string;
  /** Where it was found, so a report can say how rather than just what. */
  readonly source: 'JAVA_HOME' | 'PATH' | 'well-known-install';
}

function javaBinaryName(platform: SupportedHostPlatform): string {
  return platform === 'win32' ? 'java.exe' : 'java';
}

/**
 * Install roots the platform's own installers use.
 *
 * Not a list of one machine's paths: these are where Adoptium, Oracle and the
 * distributions put a JDK by default. A host with none of them still resolves
 * through `JAVA_HOME` or `PATH` first.
 */
function wellKnownRoots(platform: SupportedHostPlatform): readonly string[] {
  return platform === 'win32'
    ? [
        join('C:', 'Program Files', 'Java'),
        join('C:', 'Program Files', 'Eclipse Adoptium'),
        join('C:', 'Program Files', 'Microsoft', 'jdk'),
        join('C:', 'Program Files', 'Amazon Corretto'),
      ]
    : ['/usr/lib/jvm', '/usr/java', '/opt/java'];
}

/** Runs `java -version` and reads the major from what it prints. */
async function probe(executable: string): Promise<{ major: number; version: string } | undefined> {
  let output: string;
  try {
    // `-version` goes to stderr on every JVM ever shipped.
    const result = await run(executable, ['-version'], { timeout: 20_000 });
    output = `${result.stdout}${result.stderr}`;
  } catch (error) {
    const withOutput = error as { readonly stderr?: string; readonly stdout?: string };
    output = `${withOutput.stdout ?? ''}${withOutput.stderr ?? ''}`;
    if (output.trim().length === 0) return undefined;
  }
  const quoted = /version "([^"]+)"/u.exec(output);
  if (quoted === null) return undefined;
  const version = quoted[1] ?? '';
  // `17.0.12` and the legacy `1.8.0_412` both appear in the wild.
  const parts = version.split('.');
  const first = Number(parts[0]);
  if (!Number.isInteger(first)) return undefined;
  const major = first === 1 ? Number(parts[1]) : first;
  return Number.isInteger(major) ? { major, version } : undefined;
}

async function isFile(candidate: string): Promise<boolean> {
  const info = await stat(candidate).catch(() => undefined);
  return info?.isFile() === true;
}

/**
 * Finds a Java runtime that can actually start the server.
 *
 * Ordered by how deliberate the answer is: an explicit `JAVA_HOME` beats
 * whatever happens to be first on `PATH`, which beats a directory scan. Every
 * candidate is *probed* rather than trusted — a `java` on `PATH` is frequently
 * a launcher shim, a stale symlink, or the wrong major version, and finding
 * that out at `-version` is far better than finding out at boot.
 */
export async function discoverJavaRuntime(
  options: {
    readonly platform?: SupportedHostPlatform;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly requiredMajor?: number;
  } = {},
): Promise<DiscoveredJava> {
  const platform = options.platform ?? (process.platform === 'win32' ? 'win32' : 'linux');
  const environment = options.environment ?? process.env;
  const requiredMajor = options.requiredMajor ?? REQUIRED_JAVA_MAJOR;
  const binary = javaBinaryName(platform);
  const rejected: string[] = [];

  const consider = async (
    candidate: string,
    source: DiscoveredJava['source'],
  ): Promise<DiscoveredJava | undefined> => {
    if (!isAbsolute(candidate) || !(await isFile(candidate))) return undefined;
    const probed = await probe(candidate);
    if (probed === undefined) {
      rejected.push(`${candidate} (did not report a version)`);
      return undefined;
    }
    if (probed.major < requiredMajor) {
      rejected.push(`${candidate} (Java ${String(probed.major)})`);
      return undefined;
    }
    return { executable: candidate, major: probed.major, version: probed.version, source };
  };

  const javaHome = environment.JAVA_HOME?.trim();
  if (javaHome !== undefined && javaHome.length > 0) {
    const found = await consider(join(javaHome, 'bin', binary), 'JAVA_HOME');
    if (found !== undefined) return found;
  }

  for (const entry of (environment.PATH ?? environment.Path ?? '').split(delimiter)) {
    const trimmed = entry.trim().replace(/^"|"$/gu, '');
    if (trimmed.length === 0) continue;
    const found = await consider(join(trimmed, binary), 'PATH');
    if (found !== undefined) return found;
  }

  for (const root of wellKnownRoots(platform)) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    // Newest-looking first, so a host with several JDKs does not boot on the
    // oldest one purely because it sorts first.
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, 'en-US'));
    for (const directory of directories) {
      const found = await consider(join(root, directory, 'bin', binary), 'well-known-install');
      if (found !== undefined) return found;
    }
  }

  throw new SandboxError('java-not-found', rejected.join('; ') || null);
}

/**
 * Finds the Forge argument file inside an imported server.
 *
 * Its path carries the Forge version, so it cannot be a constant. Discovered
 * rather than configured for the same reason everything else here is: the
 * server already knows, and asking would be asking somebody to read it out.
 */
export async function discoverForgeArgsFile(
  workspaceRoot: string,
  platform: SupportedHostPlatform = process.platform === 'win32' ? 'win32' : 'linux',
): Promise<string> {
  const wanted = forgeArgsFileName(platform);
  const forgeRoot = join(workspaceRoot, 'libraries', 'net', 'minecraftforge', 'forge');
  const versions = await readdir(forgeRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of versions) {
    if (!entry.isDirectory()) continue;
    const candidate = join(forgeRoot, entry.name, wanted);
    if (await isFile(candidate)) {
      return ['libraries', 'net', 'minecraftforge', 'forge', entry.name, wanted].join(posix.sep);
    }
  }
  throw new SandboxError('forge-args-file-not-found', wanted);
}

/**
 * Reads whether the operator has already accepted Mojang's EULA for this server.
 *
 * This is the whole reason the sandbox does not have to ask. The acceptance is
 * not being made here and is not being made on anybody's behalf: it is a fact
 * already recorded in the server being imported, by the person who installed
 * it, and it travels with the copy the way it travels with any other copy of
 * that server.
 *
 * A workspace that has not accepted produces `false`, and composition refuses.
 * Only the one key is read; nothing else in the file is inspected or carried.
 */
export async function readEulaAcceptance(workspaceRoot: string): Promise<boolean> {
  const content = await readFile(join(workspaceRoot, 'eula.txt'), 'utf8').catch(() => undefined);
  if (content === undefined) return false;
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('#'))
    .some((line) => /^eula\s*=\s*true$/iu.test(line));
}

/**
 * Provisions a place for sandboxes to live.
 *
 * The OS temporary directory, because a sandbox is disposable by definition and
 * that is what the directory is for. It needs no configuration, it is outside
 * every workspace, and it is outside the repository — so a sandbox can never be
 * picked up by the next import or committed by accident.
 */
export async function provisionSandboxParent(options: {
  readonly workspaceRoot: string;
  readonly requiredBytes: number;
}): Promise<string> {
  const parent = join(tmpdir(), 'voidfall-sandboxes');
  const inside = resolve(options.workspaceRoot);
  if (resolve(parent).startsWith(inside + sep)) {
    throw new SandboxError('sandbox-root-inside-workspace', parent);
  }
  await mkdir(parent, { recursive: true });
  await access(parent).catch(() => {
    throw new SandboxError('sandbox-parent-unusable', parent);
  });

  // Checked before copying rather than during. Failing halfway leaves a
  // part-built sandbox and a confusing error about a file nobody named.
  const space = await statfs(parent).catch(() => undefined);
  if (space !== undefined) {
    const free = Number(space.bavail) * Number(space.bsize);
    if (Number.isFinite(free) && free < options.requiredBytes) {
      throw new SandboxError('insufficient-space', `${String(Math.round(free / 1_048_576))} MiB free`);
    }
  }
  return parent;
}
