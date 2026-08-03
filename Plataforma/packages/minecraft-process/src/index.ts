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

function assertPlainValue(value: string, field: string): void {
  if (value.length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new Error(`${field} contains an invalid value.`);
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

  return {
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
}

export type ObservedProcessState =
  | 'unknown'
  | 'offline'
  | 'starting'
  | 'online'
  | 'stopping'
  | 'error';

export type ProcessStateEvent =
  | 'launch-requested'
  | 'process-spawned'
  | 'boot-confirmed'
  | 'stop-requested'
  | 'process-exited'
  | 'fault-detected'
  | 'observation-reset';

const transitions: Readonly<
  Partial<Record<ObservedProcessState, Partial<Record<ProcessStateEvent, ObservedProcessState>>>>
> = {
  unknown: { 'process-exited': 'offline', 'fault-detected': 'error' },
  offline: { 'launch-requested': 'starting', 'fault-detected': 'error' },
  starting: {
    'process-spawned': 'starting',
    'boot-confirmed': 'online',
    'process-exited': 'error',
    'fault-detected': 'error',
  },
  online: { 'stop-requested': 'stopping', 'process-exited': 'error', 'fault-detected': 'error' },
  stopping: { 'process-exited': 'offline', 'fault-detected': 'error' },
  error: { 'observation-reset': 'unknown', 'process-exited': 'offline' },
};

export function transitionObservedProcessState(
  current: ObservedProcessState,
  event: ProcessStateEvent,
): ObservedProcessState {
  const next = transitions[current]?.[event];
  if (next === undefined) throw new Error(`Invalid process state transition: ${current} + ${event}.`);
  return next;
}

export interface ProcessObservation {
  readonly state: ObservedProcessState;
  readonly observedAt: string;
  readonly source: 'process-adapter';
  readonly pid?: number;
}

/**
 * Phase 3 integration boundary. Implementations must consume only a validated
 * ProcessLaunchPlan and must never expose an arbitrary shell command surface.
 */
export interface MinecraftProcessAdapter {
  inspect(): Promise<ProcessObservation>;
  start(plan: ProcessLaunchPlan): Promise<ProcessObservation>;
  requestGracefulStop(): Promise<ProcessObservation>;
}
