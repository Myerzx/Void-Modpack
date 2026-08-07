import { scanWorkspace } from '@voidfall/workspace-inventory';

import { createProcessSandboxBootRunner } from './process-runner.js';
import {
  discoverForgeArgsFile,
  discoverJavaRuntime,
  provisionSandboxParent,
  readEulaAcceptance,
  type DiscoveredJava,
} from './provision.js';
import { Sandbox } from './sandbox.js';
import { SandboxError, type SandboxBootReport, type SandboxSourceFile } from './types.js';
import { ChangeVerification, type FileChangeSet, type StagedChangeOutcome } from './verify-change.js';

/**
 * Prepares and runs one isolated boot, discovering everything it needs.
 *
 * This is the product's own answer to "here is a server, does it start?" — the
 * panel will call it with a directory and nothing else. Every input a person
 * might otherwise have typed is found: the Java runtime by probing, the Forge
 * argument file by looking in the tree, the EULA by reading the acceptance the
 * operator already made, and the sandbox location by provisioning a disposable
 * one.
 */

/** Roles a boot actually needs. Everything else stays in the workspace. */
const BOOTABLE_ROLES: ReadonlySet<string> = new Set([
  'mod-archive',
  'configuration',
  'datapack',
  'script',
  'runtime',
]);

export interface FirstBootEvidence {
  readonly workspaceRoot: string;
  readonly java: DiscoveredJava;
  readonly argsFile: string;
  readonly sandboxParent: string;
  readonly filesCopied: number;
  readonly bytesCopied: number;
  readonly report: SandboxBootReport;
  /**
   * Whether the sandbox was actually deleted.
   *
   * Reported rather than thrown. On the first real run a disposal failure
   * replaced the boot result entirely, so the answer to "did the server start"
   * was an `EBUSY` about a directory — cleanup destroying the evidence it was
   * cleaning up after.
   */
  readonly disposed: boolean;
  readonly disposalError: string | null;
  /** Empty when the boot tested what is installed rather than a change. */
  readonly changes: readonly StagedChangeOutcome[];
  /** `null` when nothing was staged, so there was nothing to leave alone. */
  readonly workspaceUnchanged: boolean | null;
}

export interface RunIsolatedBootOptions {
  readonly workspaceRoot: string;
  readonly timeoutMs?: number;
  readonly serverPort?: number;
  readonly maximumMemoryMiB?: number;
  /**
   * Configuration changes to test.
   *
   * Staged into a temporary area and used in place of the workspace copy, so
   * the boot answers "does this change still start?" rather than "does what is
   * already installed still start?".
   */
  readonly changeSets?: readonly FileChangeSet[];
  /** Called with progress, so a long copy is not silence. */
  readonly onProgress?: (message: string) => void;
}

export async function runIsolatedBoot(
  options: RunIsolatedBootOptions,
): Promise<FirstBootEvidence> {
  const report = options.onProgress ?? ((): void => undefined);
  const { workspaceRoot } = options;

  // The acceptance is read first, because everything after it is work that
  // would be wasted if the answer is no.
  if (!(await readEulaAcceptance(workspaceRoot))) {
    throw new SandboxError('eula-not-accepted-in-workspace', workspaceRoot);
  }
  report('EULA acceptance found in the imported server.');

  const java = await discoverJavaRuntime();
  report(`Java ${java.version} via ${java.source}.`);

  const argsFile = await discoverForgeArgsFile(workspaceRoot);
  report(`Forge argument file: ${argsFile}`);

  // Runtime included: without the libraries there is nothing to start.
  const scan = await scanWorkspace({ root: workspaceRoot, includeRuntime: true });
  const files: SandboxSourceFile[] = scan.files
    .filter((file) => BOOTABLE_ROLES.has(file.role))
    .map((file) => ({ path: file.path, role: file.role as SandboxSourceFile['role'] }));
  const bytesCopied = scan.files
    .filter((file) => BOOTABLE_ROLES.has(file.role))
    .reduce((total, file) => total + file.sizeBytes, 0);
  report(`${String(files.length)} files to copy (${String(Math.round(bytesCopied / 1_048_576))} MiB).`);

  const sandboxParent = await provisionSandboxParent({
    workspaceRoot,
    // Headroom for what the boot itself writes: a world, logs, generated config.
    requiredBytes: Math.round(bytesCopied * 1.5),
  });
  report(`Sandbox parent: ${sandboxParent}`);

  const sandbox = new Sandbox({
    parentDirectory: sandboxParent,
    runner: createProcessSandboxBootRunner({
      javaExecutable: java.executable,
      launch: { kind: 'forge-args-file', argsFile },
      initialMemoryMiB: 1_024,
      maximumMemoryMiB: options.maximumMemoryMiB ?? 4_096,
    }),
  });

  let disposed = false;
  let disposalError: string | null = null;
  let changes: readonly StagedChangeOutcome[] = [];
  let workspaceUnchanged: boolean | null = null;

  const changeSets = options.changeSets ?? [];
  const prepared =
    changeSets.length === 0
      ? undefined
      : await ChangeVerification.prepare({ workspaceRoot, changeSets });
  if (prepared !== undefined) {
    report(`${String(changeSets.length)} file(s) staged; the sandbox will boot the change.`);
  }

  try {
    const composed = await sandbox.compose({
      workspaceRoot,
      files,
      ...(prepared === undefined ? {} : { stagedFiles: prepared.stagedFiles }),
      // Derived, not asserted: the operator accepted for this server already.
      eulaAccepted: true,
      serverPort: options.serverPort ?? 25_999,
    });
    report('Sandbox composed. Starting the server.');
    const bootReport = await sandbox.boot({ timeoutMs: options.timeoutMs ?? 600_000 });

    if (prepared !== undefined) {
      // Read back before disposal, because afterwards there is nothing to read.
      // Believing the staged bytes were used because we passed them in is the
      // assumption this pipeline exists to avoid.
      changes = await prepared.verification.observe(composed.root);
      workspaceUnchanged = await prepared.verification.workspaceUnchanged();
      await prepared.verification.dispose();
    }

    // Disposed here, before returning, and its failure is carried rather than
    // thrown: an answer about the boot is what the caller asked for, and a
    // cleanup problem must not take its place.
    try {
      await sandbox.dispose();
      disposed = true;
      report('Sandbox disposed.');
    } catch (error) {
      disposalError = error instanceof Error ? error.message : 'disposal failed';
      report(`Sandbox could NOT be disposed: ${disposalError}`);
    }

    return Object.freeze({
      workspaceRoot,
      java,
      argsFile,
      sandboxParent,
      filesCopied: files.length,
      bytesCopied,
      report: bootReport,
      disposed,
      disposalError,
      changes,
      workspaceUnchanged,
    });
  } catch (error) {
    // The boot never produced a result, so there is nothing to protect: clean
    // up as best we can and let the original failure surface.
    await sandbox.dispose().catch(() => undefined);
    await prepared?.verification.dispose();
    throw error;
  }
}
