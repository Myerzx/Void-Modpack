import { posix, win32 } from 'node:path';

export type SupportedHostPlatform = 'win32' | 'linux';

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
