/**
 * A disposable copy of a server, built to answer one question and then deleted.
 *
 * The question is usually "does this still start?" — after a config change,
 * after a mod was added, after anything. Answering it against the real
 * installation would risk the thing being protected, so it is answered against
 * a sandbox instead.
 *
 * Three rules, and the first is absolute:
 *
 *  - **The world is never copied and never touched.** Not read, not linked,
 *    not referenced. A sandbox boots into a fresh, empty level inside itself.
 *    A boot test that could corrupt somebody's world is not a test, it is the
 *    accident it was meant to prevent.
 *  - **Only what is needed.** Mods, configuration, and the minimum to start.
 *    Everything else stays where it is.
 *  - **Disposal is structural.** The sandbox lives under a caller-supplied
 *    parent, is created there, and `dispose` removes it. Nothing outside that
 *    root is ever written.
 */

/** What the sandbox is allowed to bring in from the workspace. */
export type SandboxSourceRole =
  | 'mod-archive'
  | 'configuration'
  | 'datapack'
  | 'script'
  /**
   * The Forge runtime — libraries and argument files.
   *
   * Without it nothing boots. It is left out of an inventory because nobody
   * manages a library through a configuration panel, but a sandbox that omitted
   * it would be a directory of mods with no server to run them.
   */
  | 'runtime';

export interface SandboxSourceFile {
  /** Relative to the workspace root, `/`-separated. */
  readonly path: string;
  readonly role: SandboxSourceRole;
}

/**
 * The generated `server.properties` a sandbox boots with.
 *
 * Written fresh rather than copied. The real one holds the operator's port,
 * their seed, their motd and their RCON password — none of which a throwaway
 * boot needs, and one of which is a secret.
 */
export interface SandboxServerProperties {
  /** Bound to loopback, so a sandbox never appears on the network. */
  readonly serverIp: '127.0.0.1';
  readonly serverPort: number;
  /** Fresh and empty, inside the sandbox. Never the operator's level name. */
  readonly levelName: string;
  readonly onlineMode: false;
}

export interface ComposeSandboxInput {
  /** Read-only source. Nothing is written here, ever. */
  readonly workspaceRoot: string;
  /** Files to bring in, usually the inventory filtered to what matters. */
  readonly files: readonly SandboxSourceFile[];
  /**
   * Staged content to use instead of the workspace copy, by relative path.
   *
   * This is what makes a sandbox a test of the *change* rather than a test of
   * what is already installed.
   */
  readonly stagedFiles?: ReadonlyMap<string, string>;
  /**
   * The operator accepting Mojang's EULA for this boot.
   *
   * Required, with no default, and the sandbox refuses to compose without it.
   * Writing `eula=true` on somebody's behalf is accepting a licence agreement
   * for them, and no convenience is worth doing that quietly.
   */
  readonly eulaAccepted: boolean;
  readonly serverPort: number;
}

export type SandboxBootOutcome =
  /** The server reported it finished loading. */
  | 'booted'
  /** It was still starting when the window closed. Not a failure, an unknown. */
  | 'timed-out'
  /** The process ended before it finished loading. */
  | 'exited-early'
  /** The runner could not start it at all. */
  | 'failed-to-start';

export interface SandboxBootReport {
  readonly outcome: SandboxBootOutcome;
  readonly durationMs: number;
  /**
   * Configuration files that did not exist before the boot.
   *
   * The payoff of booting at all: a mod classified `RUNTIME_ONLY` because
   * nothing was found on disk writes its file the first time it runs, and this
   * is where that file turns up.
   */
  readonly generatedFiles: readonly string[];
  /**
   * The last lines the process produced, bounded.
   *
   * Kept because a boot that failed is only actionable with them, and bounded
   * because a crashing mod can produce megabytes in seconds.
   */
  readonly tail: readonly string[];
}

/**
 * Starts a composed sandbox and waits for it to finish loading.
 *
 * An interface because a real boot spawns a JVM, and a test that spawned one
 * would be testing the runner rather than the composition — and could not
 * arrange the failures that matter. The real implementation composes the
 * process controller that already exists.
 */
export interface SandboxBootRunner {
  boot(input: {
    readonly sandboxRoot: string;
    readonly timeoutMs: number;
  }): Promise<{ readonly outcome: SandboxBootOutcome; readonly tail: readonly string[] }>;
}

export type SandboxErrorCode =
  | 'invalid-input'
  | 'eula-not-accepted'
  | 'sandbox-root-inside-workspace'
  | 'unsafe-path'
  | 'not-composed'
  | 'source-missing';

export class SandboxError extends Error {
  public readonly code: SandboxErrorCode;
  public readonly path: string | null;

  public constructor(code: SandboxErrorCode, path: string | null = null) {
    super(`sandbox:${code}`);
    this.name = 'SandboxError';
    this.code = code;
    this.path = path;
  }
}
