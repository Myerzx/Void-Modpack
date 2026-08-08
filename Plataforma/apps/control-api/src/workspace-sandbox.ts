import { runIsolatedBoot, SandboxError } from '@voidfall/sandbox-runner';

import type { SandboxLauncher } from './workspace-routes.js';

/**
 * Wires the disposable sandbox into the API.
 *
 * A boot spawns a real JVM against a copy of the server and takes minutes, so
 * it cannot happen inside a request. The route creates a run, hands it to this
 * launcher and answers immediately; the launcher reports progress and the
 * result as they arrive, and the panel reads the run back.
 *
 * Two properties come from the engine and are not re-decided here. The sandbox
 * is composed from the minimum files and deleted afterwards, and the original
 * world is never copied or touched — that is what makes running this against
 * somebody's real server acceptable at all. And a disposal failure is reported
 * beside the boot result rather than replacing it: on the first real run,
 * cleanup destroyed the evidence it was cleaning up after.
 */

/**
 * Removes host paths from a line before it reaches a browser.
 *
 * Caught by watching the panel rather than by a test: the runner's progress is
 * written for a terminal, and it names the sandbox parent and the argument
 * file by absolute path. Those went straight onto the screen — and a host path
 * in a browser is a host path in a screenshot, which is the rule the workspace
 * routes have held from the first slice.
 *
 * The line keeps its meaning. "Sandbox parent: C:\\Users\\…\\Temp\\x" becomes
 * "Sandbox parent: <caminho local>", which says the same thing to the person
 * reading it and nothing at all to anybody it is shown to.
 */
export function withoutHostPaths(line: string): string {
  return line
    .replace(/[A-Za-z]:[\\/][^\s,;)]*/gu, '<caminho local>')
    .replace(/(?<![\w<])\/(?:home|Users|tmp|var)\/[^\s,;)]*/gu, '<caminho local>');
}

export function createSandboxLauncher(): SandboxLauncher {
  return {
    launch(input) {
      // Deliberately not awaited. The caller has already recorded the run and
      // wants to answer the request; everything after this point reports
      // through the callbacks.
      void (async () => {
        try {
          const evidence = await runIsolatedBoot({
            workspaceRoot: input.workspaceRoot,
            ...(input.changeSets.length === 0 ? {} : { changeSets: input.changeSets }),
            onProgress: (message) => {
              void input.onProgress(withoutHostPaths(message));
            },
          });

          await input.onFinished({
            outcome: evidence.report.outcome,
            durationMs: evidence.report.durationMs,
            evidence: {
              java: { version: evidence.java.version, source: evidence.java.source },
              argsFile: withoutHostPaths(evidence.argsFile),
              filesCopied: evidence.filesCopied,
              mebibytesCopied: Math.round(evidence.bytesCopied / 1_048_576),
              // The payoff of booting at all: a mod classified RUNTIME_ONLY
              // because nothing was on disk writes its file the first time it
              // runs, and this is where that file turns up.
              generatedFiles: evidence.report.generatedFiles,
              // Bounded, because a crashing mod produces megabytes in seconds,
              // and scrubbed, because a server logs its own working directory.
              tail: evidence.report.tail.map(withoutHostPaths),
              disposed: evidence.disposed,
              disposalError: evidence.disposalError,
              changes: evidence.changes,
              workspaceUnchanged: evidence.workspaceUnchanged,
            },
          });
        } catch (error) {
          // A refusal names what was looked for, so an operator is told what to
          // change rather than that something went wrong.
          const refusal =
            error instanceof SandboxError
              ? error.code
              : error instanceof Error
                ? error.name
                : 'unknown';
          await input.onRefused(refusal);
        }
      })();
    },
  };
}
