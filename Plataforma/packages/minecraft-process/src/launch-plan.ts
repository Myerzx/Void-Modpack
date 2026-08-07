import { posix, win32 } from 'node:path';

export type SupportedHostPlatform = 'win32' | 'linux';

/** Built from its code point so the literal survives an edit intact. */
const BACKSLASH = String.fromCharCode(92);

export interface MinecraftProcessConfig {
  readonly platform: SupportedHostPlatform;
  readonly javaExecutable: string;
  readonly serverDirectory: string;
  readonly serverJar: string;
  readonly initialMemoryMiB: number;
  readonly maximumMemoryMiB: number;
}

export interface ProcessLaunchPlan {
  readonly platform: SupportedHostPlatform;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: false;
  readonly windowsHide: boolean;
  readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
}

function platformPath(platform: SupportedHostPlatform): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix;
}

function assertPlainValue(value: string, field: string, maximumLength = 4_096): void {
  if (value.length === 0 || value.length > maximumLength || /[\u0000\r\n]/u.test(value)) {
    throw new Error(`${field} contains an invalid value.`);
  }
}

export function validateProcessLaunchPlan(plan: ProcessLaunchPlan): void {
  if (plan.platform !== 'win32' && plan.platform !== 'linux') {
    throw new Error('Process platform is not supported.');
  }
  const pathApi = platformPath(plan.platform);
  assertPlainValue(plan.executable, 'executable');
  assertPlainValue(plan.cwd, 'cwd');
  if (!pathApi.isAbsolute(plan.executable) || !pathApi.isAbsolute(plan.cwd)) {
    throw new Error('Process executable and working directory must be absolute trusted paths.');
  }
  if (plan.args.length === 0 || plan.args.length > 32) {
    throw new Error('Process argument count is outside the trusted limit.');
  }
  for (const [index, argument] of plan.args.entries()) {
    assertPlainValue(argument, `args[${index}]`);
  }
  if (
    plan.shell !== false ||
    plan.windowsHide !== (plan.platform === 'win32') ||
    plan.stdio[0] !== 'pipe' ||
    plan.stdio[1] !== 'pipe' ||
    plan.stdio[2] !== 'pipe'
  ) {
    throw new Error('Process launch safety flags are invalid.');
  }
}

export function createMinecraftProcessPlan(config: MinecraftProcessConfig): ProcessLaunchPlan {
  const pathApi = platformPath(config.platform);
  assertPlainValue(config.javaExecutable, 'javaExecutable');
  assertPlainValue(config.serverDirectory, 'serverDirectory');
  assertPlainValue(config.serverJar, 'serverJar');
  if (!pathApi.isAbsolute(config.javaExecutable)) {
    throw new Error('javaExecutable must be an absolute trusted path.');
  }
  if (!pathApi.isAbsolute(config.serverDirectory)) {
    throw new Error('serverDirectory must be an absolute trusted path.');
  }
  if (
    config.serverJar !== pathApi.basename(config.serverJar) ||
    config.serverJar === '.' ||
    config.serverJar === '..' ||
    !config.serverJar.toLocaleLowerCase('en-US').endsWith('.jar')
  ) {
    throw new Error('serverJar must be a JAR filename without a path.');
  }
  if (
    !Number.isInteger(config.initialMemoryMiB) ||
    !Number.isInteger(config.maximumMemoryMiB) ||
    config.initialMemoryMiB < 512 ||
    config.maximumMemoryMiB > 262_144 ||
    config.initialMemoryMiB > config.maximumMemoryMiB
  ) {
    throw new Error('Minecraft memory limits are invalid.');
  }

  const plan: ProcessLaunchPlan = {
    platform: config.platform,
    executable: pathApi.normalize(config.javaExecutable),
    args: [
      `-Xms${config.initialMemoryMiB}M`,
      `-Xmx${config.maximumMemoryMiB}M`,
      '-Dfile.encoding=UTF-8',
      '-jar',
      config.serverJar,
      'nogui',
    ],
    cwd: pathApi.normalize(config.serverDirectory),
    shell: false,
    windowsHide: config.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  validateProcessLaunchPlan(plan);
  return plan;
}

/**
 * How a modern Forge server is actually launched.
 *
 * Forge 1.20.1 does not ship a fat jar to `-jar`. Its installer writes an
 * argument file and a `run.sh`/`run.bat` that does:
 *
 * ```
 * java @user_jvm_args.txt @libraries/net/minecraftforge/forge/<version>/unix_args.txt nogui
 * ```
 *
 * So a plan built with `-jar` cannot start it, and pretending otherwise would
 * fail at the only moment that matters. The memory flags are generated here
 * rather than taken from the operator's `user_jvm_args.txt`: a sandbox sizing
 * itself from a file it did not write is a sandbox whose heap changes when
 * somebody edits their real server.
 */
export interface ForgeArgsFileConfig {
  readonly platform: SupportedHostPlatform;
  readonly javaExecutable: string;
  readonly serverDirectory: string;
  /**
   * The Forge argument file, relative to the server directory.
   *
   * Relative on purpose: it lives inside the tree being launched, and an
   * absolute one would let a plan point at arguments from somewhere else.
   */
  readonly argsFile: string;
  readonly initialMemoryMiB: number;
  readonly maximumMemoryMiB: number;
}

/** `unix_args.txt` or `win_args.txt`, which is the only difference between them. */
export function forgeArgsFileName(platform: SupportedHostPlatform): string {
  return platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
}

export function createForgeArgsFileProcessPlan(config: ForgeArgsFileConfig): ProcessLaunchPlan {
  const pathApi = platformPath(config.platform);
  assertPlainValue(config.javaExecutable, 'javaExecutable');
  assertPlainValue(config.serverDirectory, 'serverDirectory');
  assertPlainValue(config.argsFile, 'argsFile');
  if (!pathApi.isAbsolute(config.javaExecutable)) {
    throw new Error('javaExecutable must be an absolute trusted path.');
  }
  if (!pathApi.isAbsolute(config.serverDirectory)) {
    throw new Error('serverDirectory must be an absolute trusted path.');
  }
  // Relative, inside the tree, and a real argument file. A traversal here would
  // hand the JVM arguments from outside the directory being launched.
  const segments = config.argsFile.split('/');
  if (
    pathApi.isAbsolute(config.argsFile) ||
    config.argsFile.includes(BACKSLASH) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    !config.argsFile.toLocaleLowerCase('en-US').endsWith('.txt')
  ) {
    throw new Error('argsFile must be a relative .txt path inside the server directory.');
  }
  if (
    !Number.isInteger(config.initialMemoryMiB) ||
    !Number.isInteger(config.maximumMemoryMiB) ||
    config.initialMemoryMiB < 512 ||
    config.maximumMemoryMiB > 262_144 ||
    config.initialMemoryMiB > config.maximumMemoryMiB
  ) {
    throw new Error('Minecraft memory limits are invalid.');
  }

  const plan: ProcessLaunchPlan = {
    platform: config.platform,
    executable: pathApi.normalize(config.javaExecutable),
    args: [
      `-Xms${config.initialMemoryMiB}M`,
      `-Xmx${config.maximumMemoryMiB}M`,
      '-Dfile.encoding=UTF-8',
      `@${config.argsFile}`,
      'nogui',
    ],
    cwd: pathApi.normalize(config.serverDirectory),
    shell: false,
    windowsHide: config.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  validateProcessLaunchPlan(plan);
  return plan;
}
