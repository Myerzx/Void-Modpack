import {
  BOOT_COMPLETED_PATTERN,
  createForgeArgsFileProcessPlan,
  createMinecraftProcessPlan,
  NodeProcessRuntime,
  type ProcessRuntime,
  type SpawnedProcess,
  type SupportedHostPlatform,
} from '@voidfall/minecraft-process';

import { SandboxError, type SandboxBootOutcome, type SandboxBootRunner } from './types.js';

/**
 * The boot runner that actually starts a JVM.
 *
 * It composes the pieces that already exist — the validated launch plan, the
 * Node process runtime, and the very line the process adapter watches for —
 * rather than growing a second opinion about how a Minecraft server starts.
 *
 * The rule this file is built around: **it never returns with the process
 * still running.** The caller's next move is usually `dispose`, which deletes
 * the directory the JVM has open. A boot that left one alive would leak a
 * process, hold a lock on a directory somebody is trying to remove, and keep a
 * port bound for the next sandbox to collide with.
 */

/** How long to wait for a polite stop before ending it outright. */
const GRACEFUL_STOP_MS = 20_000;
const FORCED_STOP_MS = 5_000;
const DEFAULT_POLL_MS = 500;
/** Lines of output kept for a failed boot. Bounded: a crashing mod is loud. */
const TAIL_LINES = 40;

export interface ProcessSandboxBootRunnerOptions {
  /** Absolute path to the Java binary. Local configuration, never a lease. */
  readonly javaExecutable: string;
  /**
   * How the server is launched, and there are two real shapes.
   *
   * Modern Forge does not ship a jar to `-jar`: its installer writes an
   * argument file and a script that runs `java @.../unix_args.txt nogui`. A
   * plan built with `-jar` cannot start a 1.20.1 server at all, so the shape is
   * named rather than guessed.
   */
  readonly launch:
    | { readonly kind: 'jar'; readonly serverJar: string }
    | { readonly kind: 'forge-args-file'; readonly argsFile: string };
  readonly initialMemoryMiB: number;
  readonly maximumMemoryMiB: number;
  readonly platform?: SupportedHostPlatform;
  /** Injectable so the boot sequence is testable without a JVM. */
  readonly runtime?: ProcessRuntime;
  readonly pollIntervalMs?: number;
  readonly clock?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds).unref();
  });
}

function tailOf(stdout: string, stderr: string): readonly string[] {
  const lines = [...stdout.split(/\r?\n/u), ...stderr.split(/\r?\n/u)].filter(
    (line) => line.trim().length > 0,
  );
  return Object.freeze(lines.slice(-TAIL_LINES));
}

/**
 * Stops the process, politely and then not.
 *
 * `stop` is written first because a Minecraft server that has finished loading
 * will save and shut down cleanly, and a sandbox that always killed would give
 * a misleading picture of how long a real shutdown takes. If it does not go,
 * it is ended — this is a JVM we spawned, in a temporary directory, over an
 * empty world, and it is not the operator's server.
 */
async function ensureStopped(handle: SpawnedProcess): Promise<void> {
  if (handle.getExit() !== undefined) return;
  await handle.requestGracefulStop().catch(() => undefined);
  if ((await handle.waitForExit(GRACEFUL_STOP_MS)) !== undefined) return;
  await handle.forceTerminate().catch(() => undefined);
  await handle.waitForExit(FORCED_STOP_MS);
}

export function createProcessSandboxBootRunner(
  options: ProcessSandboxBootRunnerOptions,
): SandboxBootRunner {
  if (options === null || typeof options !== 'object') throw new SandboxError('invalid-input');
  const platform =
    options.platform ?? (process.platform === 'win32' ? 'win32' : 'linux');
  const runtime = options.runtime ?? new NodeProcessRuntime();
  const clock = options.clock ?? ((): number => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;

  return {
    async boot({ sandboxRoot, timeoutMs }) {
      // Built per boot because the working directory is the sandbox, and the
      // plan validates that everything in it is an absolute trusted path.
      let plan;
      try {
        const shared = {
          platform,
          javaExecutable: options.javaExecutable,
          serverDirectory: sandboxRoot,
          initialMemoryMiB: options.initialMemoryMiB,
          maximumMemoryMiB: options.maximumMemoryMiB,
        };
        plan =
          options.launch.kind === 'forge-args-file'
            ? createForgeArgsFileProcessPlan({ ...shared, argsFile: options.launch.argsFile })
            : createMinecraftProcessPlan({ ...shared, serverJar: options.launch.serverJar });
      } catch {
        return { outcome: 'failed-to-start' as SandboxBootOutcome, tail: [] };
      }

      let handle: SpawnedProcess;
      try {
        handle = await runtime.spawn(plan);
      } catch (error) {
        return {
          outcome: 'failed-to-start' as SandboxBootOutcome,
          tail: Object.freeze([error instanceof Error ? error.message : 'spawn refused']),
        };
      }

      try {
        const deadline = clock() + timeoutMs;
        for (;;) {
          const exit = handle.getExit();
          const output = handle.readOutput();
          if (exit !== undefined) {
            // It ended before it finished loading. That is a distinct answer
            // from "still starting", and the tail is the only actionable part.
            return {
              outcome: 'exited-early' as SandboxBootOutcome,
              tail: tailOf(output.stdout, output.stderr),
            };
          }
          if (BOOT_COMPLETED_PATTERN.test(output.stdout)) {
            return {
              outcome: 'booted' as SandboxBootOutcome,
              tail: tailOf(output.stdout, output.stderr),
            };
          }
          if (clock() >= deadline) {
            return {
              outcome: 'timed-out' as SandboxBootOutcome,
              tail: tailOf(output.stdout, output.stderr),
            };
          }
          await sleep(pollIntervalMs);
        }
      } finally {
        // Every path out of the loop passes through here, including the throw
        // nobody expected. The directory is about to be deleted.
        await ensureStopped(handle);
      }
    },
  };
}
