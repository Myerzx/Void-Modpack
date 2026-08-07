import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runIsolatedBoot } from './first-boot.js';
import { SandboxError } from './types.js';

/**
 * `voidfall-sandbox-boot <workspace>` — prove that a server still starts.
 *
 * One argument, because everything else is discovered: the Java runtime by
 * probing the host, the Forge argument file by looking inside the server, the
 * EULA by reading the acceptance the operator already made, and the sandbox
 * location by provisioning a disposable one. A panel that received a server
 * would call `runIsolatedBoot` directly; this is the same thing with a
 * terminal in front of it.
 *
 * The exit code distinguishes the outcomes rather than collapsing them:
 * a server that timed out is not a server that failed, and a host that could
 * not even be prepared is neither.
 */

const EXIT_BOOTED = 0;
const EXIT_DID_NOT_BOOT = 1;
const EXIT_NOT_PREPARED = 2;
const EXIT_MISUSED = 64;

export async function main(argv: readonly string[]): Promise<number> {
  const workspaceRoot = argv[0];
  if (workspaceRoot === undefined || workspaceRoot.startsWith('-')) {
    process.stderr.write('usage: voidfall-sandbox-boot <workspace-directory>\n');
    return EXIT_MISUSED;
  }

  const startedAt = Date.now();
  const say = (message: string): void => {
    const seconds = ((Date.now() - startedAt) / 1_000).toFixed(1);
    process.stdout.write(`[${seconds}s] ${message}\n`);
  };

  let evidence;
  try {
    evidence = await runIsolatedBoot({ workspaceRoot, onProgress: say });
  } catch (error) {
    if (error instanceof SandboxError) {
      // Every refusal names what was looked for, so an operator is told what
      // to change rather than that something went wrong.
      process.stderr.write(`refused: ${error.code}${error.path === null ? '' : ` (${error.path})`}\n`);
      return EXIT_NOT_PREPARED;
    }
    throw error;
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        outcome: evidence.report.outcome,
        durationMs: evidence.report.durationMs,
        java: { version: evidence.java.version, source: evidence.java.source },
        argsFile: evidence.argsFile,
        filesCopied: evidence.filesCopied,
        mebibytesCopied: Math.round(evidence.bytesCopied / 1_048_576),
        generatedFiles: evidence.report.generatedFiles,
        disposed: evidence.disposed,
        disposalError: evidence.disposalError,
      },
      null,
      2,
    )}\n`,
  );
  if (evidence.report.outcome !== 'booted') {
    // The tail is the only actionable part of a boot that did not finish.
    for (const line of evidence.report.tail) process.stderr.write(`${line}\n`);
  }
  return evidence.report.outcome === 'booted' ? EXIT_BOOTED : EXIT_DID_NOT_BOOT;
}

/**
 * Whether this module was run directly rather than imported.
 *
 * Compared as filesystem paths, not as strings. `import.meta.url` is a URL, so
 * a directory containing a space arrives percent-encoded and any string
 * comparison against `argv[1]` silently fails — the process then exits zero
 * having done nothing, which is exactly what happened the first time this
 * command was run from a path with a space in it.
 */
function runDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
  } catch {
    return false;
  }
}

// Guarded so importing this module in a test does not boot a Minecraft server
// as a side effect.
if (runDirectly()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`fatal: ${error instanceof Error ? error.name : 'error'}\n`);
      process.exitCode = 1;
    });
}
