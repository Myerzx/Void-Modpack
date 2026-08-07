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
}

export interface RunIsolatedBootOptions {
  readonly workspaceRoot: string;
  readonly timeoutMs?: number;
  readonly serverPort?: number;
  readonly maximumMemoryMiB?: number;
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

  try {
    await sandbox.compose({
      workspaceRoot,
      files,
      // Derived, not asserted: the operator accepted for this server already.
      eulaAccepted: true,
      serverPort: options.serverPort ?? 25_999,
    });
    report('Sandbox composed. Starting the server.');
    const bootReport = await sandbox.boot({ timeoutMs: options.timeoutMs ?? 600_000 });
    return Object.freeze({
      workspaceRoot,
      java,
      argsFile,
      sandboxParent,
      filesCopied: files.length,
      bytesCopied,
      report: bootReport,
    });
  } finally {
    // Disposable means disposed, including when the boot threw.
    await sandbox.dispose();
    report('Sandbox disposed.');
  }
}
