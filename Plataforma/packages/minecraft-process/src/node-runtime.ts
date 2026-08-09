import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import {
  minecraftConsoleCommandLiteral,
  type MinecraftConsoleCommand,
} from './console.js';
import { validateProcessLaunchPlan, type ProcessLaunchPlan } from './launch-plan.js';
import type {
  ProcessExit,
  ProcessOutputLine,
  ProcessOutputLinePage,
  ProcessOutputStream,
  ProcessOutputSnapshot,
  ProcessRuntime,
  SpawnedProcess,
} from './runtime.js';

const DEFAULT_OUTPUT_BYTES_PER_STREAM = 64 * 1_024;
const DEFAULT_OUTPUT_LINES = 1_000;
const MAXIMUM_OUTPUT_CHARACTERS_PER_LINE = 2_048;

class BoundedByteBuffer {
  #buffer = Buffer.alloc(0);
  #truncated = false;

  constructor(private readonly maximumBytes: number) {}

  append(chunk: Buffer): void {
    const combined = Buffer.concat([this.#buffer, chunk]);
    if (combined.length <= this.maximumBytes) {
      this.#buffer = combined;
      return;
    }
    let start = combined.length - this.maximumBytes;
    while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start += 1;
    this.#buffer = combined.subarray(start);
    this.#truncated = true;
  }

  snapshot(): { readonly text: string; readonly truncated: boolean } {
    return { text: this.#buffer.toString('utf8'), truncated: this.#truncated };
  }
}

/**
 * The variables a spawned server is given, and nothing else.
 *
 * Minimal on purpose: an inherited environment carries tokens, credentials and
 * a `PATH` a mod could resolve a binary from, none of which a Minecraft server
 * needs from us.
 *
 * The per-user directory variables are here because leaving them out does not
 * make a server safer, it makes it crash. Mods resolve a global storage
 * directory through them, and `Path.of(System.getenv("APPDATA"))` with nothing
 * set is `Path.of(null)` — which is a NullPointerException inside a static
 * initialiser, i.e. a mod loading failure with no useful message. That is a
 * real first-boot observation, not a precaution: ResourcefulLib and ModernFix
 * both failed exactly there.
 *
 * These are paths, not secrets. The distinction is the whole rule: hand over
 * where the user's directories are, never what is in the environment beyond
 * that.
 */
function minimalEnvironment(platform: ProcessLaunchPlan['platform']): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  if (platform === 'win32') {
    for (const name of [
      'SystemRoot',
      'TEMP',
      'TMP',
      'APPDATA',
      'LOCALAPPDATA',
      'USERPROFILE',
      'HOMEDRIVE',
      'HOMEPATH',
    ] as const) {
      const value = process.env[name];
      if (value !== undefined) environment[name] = value;
    }
  } else {
    environment['LANG'] = 'C.UTF-8';
    environment['TMPDIR'] = process.env['TMPDIR'] ?? tmpdir();
    for (const name of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME'] as const) {
      const value = process.env[name];
      if (value !== undefined) environment[name] = value;
    }
  }
  return environment;
}

class NodeSpawnedProcess implements SpawnedProcess {
  readonly #stdout: BoundedByteBuffer;
  readonly #stderr: BoundedByteBuffer;
  readonly #exitPromise: Promise<ProcessExit>;
  readonly #stdoutDecoder = new StringDecoder('utf8');
  readonly #stderrDecoder = new StringDecoder('utf8');
  readonly #outputLines: ProcessOutputLine[] = [];
  readonly #remainders: Record<ProcessOutputStream, { text: string; truncated: boolean }> = {
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
  };
  #nextOutputSequence = 1;
  #exit: ProcessExit | undefined;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    maximumOutputBytesPerStream: number,
    private readonly maximumOutputLines: number,
    clock: () => Date,
  ) {
    this.#stdout = new BoundedByteBuffer(maximumOutputBytesPerStream);
    this.#stderr = new BoundedByteBuffer(maximumOutputBytesPerStream);
    child.stdout.on('data', (chunk: Buffer) => {
      this.#stdout.append(chunk);
      this.#appendConsoleText('stdout', this.#stdoutDecoder.write(chunk), clock);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr.append(chunk);
      this.#appendConsoleText('stderr', this.#stderrDecoder.write(chunk), clock);
    });
    this.#exitPromise = new Promise<ProcessExit>((resolve) => {
      child.once('close', (code, signal) => {
        this.#appendConsoleText('stdout', this.#stdoutDecoder.end(), clock);
        this.#appendConsoleText('stderr', this.#stderrDecoder.end(), clock);
        this.#flushRemainder('stdout', clock);
        this.#flushRemainder('stderr', clock);
        const exit = { code, signal, exitedAt: clock().toISOString() };
        this.#exit = exit;
        resolve(exit);
      });
    });
  }

  get pid(): number {
    const pid = this.child.pid;
    if (pid === undefined) throw new Error('Spawned process did not provide a PID.');
    return pid;
  }

  getExit(): ProcessExit | undefined {
    return this.#exit;
  }

  readOutput(): ProcessOutputSnapshot {
    const stdout = this.#stdout.snapshot();
    const stderr = this.#stderr.snapshot();
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  }

  readOutputLines(fromSequence = 1): ProcessOutputLinePage {
    if (!Number.isInteger(fromSequence) || fromSequence < 1) {
      throw new Error('Process output cursor is invalid.');
    }
    const oldestRetainedSequence = this.#outputLines[0]?.sequence ?? null;
    const effectiveCursor = Math.max(fromSequence, oldestRetainedSequence ?? fromSequence);
    const lines = Object.freeze(
      this.#outputLines.filter((line) => line.sequence >= effectiveCursor),
    );
    return Object.freeze({
      lines,
      nextCursor: Math.max(fromSequence, this.#nextOutputSequence),
      oldestRetainedSequence,
    });
  }

  requestConsoleCommand(command: MinecraftConsoleCommand): Promise<void> {
    return this.#writeLiteral(minecraftConsoleCommandLiteral(command));
  }

  requestGracefulStop(): Promise<void> {
    return this.#writeLiteral('stop\n');
  }

  async forceTerminate(): Promise<void> {
    if (this.#exit !== undefined) return;
    // SIGKILL on POSIX; on Windows Node maps this to a terminate that the JVM
    // cannot decline. Either way the caller has already asked politely.
    this.child.kill('SIGKILL');
  }

  async #writeLiteral(literal: string): Promise<void> {
    if (!this.child.stdin.writable || this.child.stdin.destroyed) {
      throw new Error('The process stdin is not available for a managed request.');
    }
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(literal, 'utf8', (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }

  #appendConsoleText(
    stream: ProcessOutputStream,
    decoded: string,
    clock: () => Date,
  ): void {
    if (decoded.length === 0) return;
    const remainder = this.#remainders[stream];
    const fragments = decoded.split('\n');
    const completeCount = fragments.length - 1;

    for (let index = 0; index < completeCount; index += 1) {
      const fragment = fragments[index] ?? '';
      const text = index === 0 ? remainder.text + fragment : fragment;
      const withoutCarriageReturn = text.endsWith('\r') ? text.slice(0, -1) : text;
      this.#pushConsoleLine(
        stream,
        withoutCarriageReturn,
        index === 0 ? remainder.truncated : false,
        clock,
      );
    }

    const trailing = fragments.at(-1) ?? '';
    const pending = completeCount === 0 ? remainder.text + trailing : trailing;
    const characters = [...pending];
    remainder.text = characters.slice(0, MAXIMUM_OUTPUT_CHARACTERS_PER_LINE).join('');
    remainder.truncated =
      (completeCount === 0 && remainder.truncated) ||
      characters.length > MAXIMUM_OUTPUT_CHARACTERS_PER_LINE;
  }

  #flushRemainder(stream: ProcessOutputStream, clock: () => Date): void {
    const remainder = this.#remainders[stream];
    if (remainder.text.length === 0 && !remainder.truncated) return;
    this.#pushConsoleLine(stream, remainder.text, remainder.truncated, clock);
    remainder.text = '';
    remainder.truncated = false;
  }

  #pushConsoleLine(
    stream: ProcessOutputStream,
    rawText: string,
    alreadyTruncated: boolean,
    clock: () => Date,
  ): void {
    const characters = [...rawText];
    const occurredAt = clock();
    if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
      throw new Error('Process output clock returned an invalid date.');
    }
    this.#outputLines.push(
      Object.freeze({
        sequence: this.#nextOutputSequence,
        stream,
        text: characters.slice(0, MAXIMUM_OUTPUT_CHARACTERS_PER_LINE).join(''),
        occurredAt: occurredAt.toISOString(),
        truncated:
          alreadyTruncated || characters.length > MAXIMUM_OUTPUT_CHARACTERS_PER_LINE,
      }),
    );
    this.#nextOutputSequence += 1;
    if (this.#outputLines.length > this.maximumOutputLines) {
      this.#outputLines.splice(0, this.#outputLines.length - this.maximumOutputLines);
    }
  }

  async waitForExit(timeoutMs: number): Promise<ProcessExit | undefined> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
      throw new Error('Process exit timeout is invalid.');
    }
    if (this.#exit !== undefined) return this.#exit;
    return new Promise<ProcessExit | undefined>((resolve) => {
      const timeout = setTimeout(() => resolve(undefined), timeoutMs);
      void this.#exitPromise.then((exit) => {
        clearTimeout(timeout);
        resolve(exit);
      });
    });
  }
}

export interface NodeProcessRuntimeOptions {
  readonly maximumOutputBytesPerStream?: number;
  readonly maximumOutputLines?: number;
  readonly clock?: () => Date;
}

export class NodeProcessRuntime implements ProcessRuntime {
  readonly #maximumOutputBytesPerStream: number;
  readonly #maximumOutputLines: number;
  readonly #clock: () => Date;

  constructor(options: NodeProcessRuntimeOptions = {}) {
    const maximum = options.maximumOutputBytesPerStream ?? DEFAULT_OUTPUT_BYTES_PER_STREAM;
    if (!Number.isInteger(maximum) || maximum < 256 || maximum > 1_048_576) {
      throw new Error('maximumOutputBytesPerStream is outside the safe range.');
    }
    this.#maximumOutputBytesPerStream = maximum;
    const maximumLines = options.maximumOutputLines ?? DEFAULT_OUTPUT_LINES;
    if (!Number.isInteger(maximumLines) || maximumLines < 100 || maximumLines > 10_000) {
      throw new Error('maximumOutputLines is outside the safe range.');
    }
    this.#maximumOutputLines = maximumLines;
    this.#clock = options.clock ?? (() => new Date());
  }

  async spawn(plan: ProcessLaunchPlan): Promise<SpawnedProcess> {
    validateProcessLaunchPlan(plan);
    if (plan.platform !== process.platform) {
      throw new Error(`Cannot execute a ${plan.platform} launch plan on ${process.platform}.`);
    }
    const child = spawn(plan.executable, [...plan.args], {
      cwd: plan.cwd,
      detached: false,
      env: minimalEnvironment(plan.platform),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: plan.windowsHide,
    });
    const handle = new NodeSpawnedProcess(
      child,
      this.#maximumOutputBytesPerStream,
      this.#maximumOutputLines,
      this.#clock,
    );
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        child.off('spawn', onSpawn);
        child.off('error', onError);
      };
      const onSpawn = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    return handle;
  }
}
