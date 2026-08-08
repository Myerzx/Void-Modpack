import { readdir, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { forgeArgsFileName, type SupportedHostPlatform } from './launch-plan.js';

/**
 * Reads a server directory and works out how it has to be started.
 *
 * The panel could start a server the day this exists, because everything else
 * already did: the controller, the adapters, the state machine, the capability
 * and the route have all been there since Phase 9. What was missing is this —
 * the agent assembled `java -jar` for every installation, and Forge 1.20.1 has
 * no fat jar, so the one server it could not start was the one the operator
 * owns.
 *
 * Two rules shape it:
 *
 * **Detected, never typed.** An operator who has to state their loader and
 * their jar name is an operator who will state them wrong once, and the wrong
 * launch plan runs a JVM in the directory that holds the world.
 *
 * **An unrecognised layout is refused by name.** Guessing `-jar` against
 * something that is not a fat jar produces a process that exits in a way that
 * reads like a broken mod. Saying "I do not know this layout" is worth more
 * than a plan that is probably wrong.
 */

export type ServerRuntimeFamily =
  | 'forge'
  | 'neoforge'
  | 'fabric'
  | 'paper'
  | 'spigot'
  | 'vanilla';

/** How the process is assembled once the family is known. */
export type LaunchShape =
  /** `java @user_jvm_args.txt @<args file> nogui` — Forge and NeoForge. */
  | 'args-file'
  /** `java -jar <jar> nogui` — everything else. */
  | 'jar';

export interface DetectedServerRuntime {
  readonly family: ServerRuntimeFamily;
  readonly shape: LaunchShape;
  /**
   * Relative to the server directory, `/`-separated.
   *
   * The args file for `args-file`, the jar name for `jar`. Relative because an
   * absolute path here would be a host path travelling with a descriptor that
   * ends up in a database and, eventually, on a screen.
   */
  readonly entry: string;
  /** What was found on disk that decided it. */
  readonly evidence: string;
}

export type RuntimeDetectionCode =
  | 'directory-unreadable'
  | 'no-recognised-runtime'
  | 'multiple-candidate-jars';

export class RuntimeDetectionError extends Error {
  public readonly code: RuntimeDetectionCode;
  /** What was looked for, never where. */
  public readonly detail: string | null;

  public constructor(code: RuntimeDetectionCode, detail: string | null = null) {
    super(detail === null ? `runtime-detection:${code}` : `runtime-detection:${code}:${detail}`);
    this.name = 'RuntimeDetectionError';
    this.code = code;
    this.detail = detail;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Finds `<root>/libraries/<vendor path>/<version>/<args file>`. */
async function findArgsFile(
  serverDirectory: string,
  vendorSegments: readonly string[],
  argsFile: string,
): Promise<string | null> {
  const vendorRoot = join(serverDirectory, 'libraries', ...vendorSegments);
  const versions = await readdir(vendorRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of versions) {
    if (!entry.isDirectory()) continue;
    if (await isFile(join(vendorRoot, entry.name, argsFile))) {
      return ['libraries', ...vendorSegments, entry.name, argsFile].join(posix.sep);
    }
  }
  return null;
}

/**
 * Jars that are never the server.
 *
 * A directory holds installers, backups and whatever somebody left there. The
 * point of the list is that a wrong match here starts the wrong process.
 */
const NOT_A_SERVER_JAR = /installer|sources|javadoc|shaded|universal|-slim/iu;

function familyFromJarName(name: string): ServerRuntimeFamily | null {
  const lower = name.toLowerCase();
  if (lower.startsWith('paper')) return 'paper';
  if (lower.startsWith('spigot') || lower.startsWith('craftbukkit')) return 'spigot';
  if (lower.includes('fabric')) return 'fabric';
  if (lower.startsWith('minecraft_server') || lower === 'server.jar') return 'vanilla';
  return null;
}

export async function detectServerRuntime(input: {
  readonly serverDirectory: string;
  readonly platform: SupportedHostPlatform;
}): Promise<DetectedServerRuntime> {
  let entries: readonly string[];
  try {
    entries = (await readdir(input.serverDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    throw new RuntimeDetectionError('directory-unreadable');
  }

  const argsFile = forgeArgsFileName(input.platform);

  // Args-file loaders first: a Forge install also carries jars in `libraries`,
  // and matching one of those would start something that is not the server.
  const forge = await findArgsFile(input.serverDirectory, ['net', 'minecraftforge', 'forge'], argsFile);
  if (forge !== null) {
    return Object.freeze({ family: 'forge', shape: 'args-file', entry: forge, evidence: forge });
  }
  const neoforge = await findArgsFile(input.serverDirectory, ['net', 'neoforged', 'neoforge'], argsFile);
  if (neoforge !== null) {
    return Object.freeze({
      family: 'neoforge',
      shape: 'args-file',
      entry: neoforge,
      evidence: neoforge,
    });
  }

  // Fabric names its launcher, so it is recognised before the generic sweep.
  if (entries.includes('fabric-server-launch.jar')) {
    return Object.freeze({
      family: 'fabric',
      shape: 'jar',
      entry: 'fabric-server-launch.jar',
      evidence: 'fabric-server-launch.jar',
    });
  }

  const candidates = entries.filter(
    (name) => name.toLowerCase().endsWith('.jar') && !NOT_A_SERVER_JAR.test(name),
  );
  const named = candidates
    .map((name) => ({ name, family: familyFromJarName(name) }))
    .filter((entry): entry is { name: string; family: ServerRuntimeFamily } => entry.family !== null);

  if (named.length === 1) {
    const only = named[0] as { name: string; family: ServerRuntimeFamily };
    return Object.freeze({
      family: only.family,
      shape: 'jar',
      entry: only.name,
      evidence: only.name,
    });
  }
  if (named.length > 1) {
    // Two servers in one directory is a question for a person. Picking one
    // would be right half the time and silent the other half.
    throw new RuntimeDetectionError(
      'multiple-candidate-jars',
      named.map((entry) => entry.name).join(', '),
    );
  }

  if (candidates.length === 1) {
    // One unrecognised jar and nothing else: treated as vanilla, and the
    // evidence says it was a guess from being the only candidate.
    const only = candidates[0] as string;
    return Object.freeze({
      family: 'vanilla',
      shape: 'jar',
      entry: only,
      evidence: `only jar in the directory: ${only}`,
    });
  }

  throw new RuntimeDetectionError('no-recognised-runtime');
}
