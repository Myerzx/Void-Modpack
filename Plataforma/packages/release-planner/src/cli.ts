import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkspaceInventoryService } from '@voidfall/workspace-inventory';

import { buildPackage, PackageError, type PackageIntent, type PackageSide } from './package.js';
import { classifySides, presenceFromProfiles } from './side.js';
import { evaluateDistribution, type ReviewedDistributionEntry } from './distribution.js';
import { ArchiveError } from './archive.js';

/**
 * `voidfall-release-package <server> --version <v> --out <dir>` — produce a
 * package somebody can install.
 *
 * The side split needs a second installation to compare against, because the
 * only honest evidence of which side a mod belongs to is where it was observed.
 * Without `--client` every mod archive is left unassigned and reported as such:
 * an empty mods folder that says why beats a full one built on a guess.
 *
 * `--intent distribution` applies the licence gate. It is an argument rather
 * than a default so nobody produces a redistributable artefact by omission.
 */

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_MISUSED = 64;

interface Arguments {
  readonly workspace: string;
  readonly clientProfile: string | null;
  readonly output: string;
  readonly version: string;
  readonly intent: PackageIntent;
  readonly sides: readonly PackageSide[];
  readonly includeRuntime: boolean;
}

function parseArguments(argv: readonly string[]): Arguments | string {
  const positional: string[] = [];
  const named = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === 'include-runtime') {
      flags.add(key);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) return `missing value for --${key}`;
    named.set(key, value);
    index += 1;
  }

  const workspace = positional[0];
  if (workspace === undefined) return 'missing workspace directory';
  const version = named.get('version');
  if (version === undefined) return 'missing --version';
  const output = named.get('out');
  if (output === undefined) return 'missing --out';

  const intent = named.get('intent') ?? 'local-use';
  if (intent !== 'local-use' && intent !== 'distribution') return `unknown intent: ${intent}`;

  const sideArgument = named.get('side') ?? 'server,client';
  const sides = sideArgument.split(',').map((value) => value.trim());
  if (sides.some((side) => side !== 'server' && side !== 'client')) {
    return `unknown side: ${sideArgument}`;
  }

  return {
    workspace: resolve(workspace),
    clientProfile: named.has('client') ? resolve(named.get('client') as string) : null,
    output: resolve(output),
    version,
    intent,
    sides: sides as readonly PackageSide[],
    includeRuntime: flags.has('include-runtime'),
  };
}

/** Names of the archives in a profile's mods directory, or none if it has none. */
async function modNamesIn(profileRoot: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(join(profileRoot, 'mods'), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
      .map((entry) => entry.name);
  } catch {
    // A profile with no mods directory is a fact, not a failure. The side split
    // then reports every archive as unassigned, which is the truth.
    return [];
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArguments(argv);
  if (typeof parsed === 'string') {
    process.stderr.write(
      `${parsed}\nusage: voidfall-release-package <server-workspace> --version <v> --out <dir>` +
        ` [--client <profile>] [--side server,client] [--intent local-use|distribution]` +
        ` [--include-runtime]\n`,
    );
    return EXIT_MISUSED;
  }

  const started = Date.now();
  const say = (message: string): void => {
    process.stdout.write(`[${((Date.now() - started) / 1_000).toFixed(1)}s] ${message}\n`);
  };

  say(`scanning ${parsed.workspace}`);
  const inventory = await new WorkspaceInventoryService().build({
    root: parsed.workspace,
    includeRuntime: parsed.includeRuntime,
  });
  say(`${String(inventory.totals.files)} files, ${String(inventory.totals.mods)} declared mods`);

  const clientNames =
    parsed.clientProfile === null ? [] : await modNamesIn(parsed.clientProfile);
  const assignments = classifySides(
    presenceFromProfiles({
      serverFiles: inventory.files
        .filter((file) => file.role === 'mod-archive')
        .map((file) => file.path),
      clientFiles: clientNames,
    }),
  );
  const counted = new Map<string, number>();
  for (const assignment of assignments) {
    counted.set(assignment.side, (counted.get(assignment.side) ?? 0) + 1);
  }
  say(
    `sides: ${[...counted]
      .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
      .map(([side, count]) => `${String(count)} ${side}`)
      .join(', ')}`,
  );

  // No reviewed catalogue is passed here: the gate's own rule is that an
  // unreviewed archive is unreviewed, so a local build says so and a
  // distribution build refuses.
  const catalogue: readonly ReviewedDistributionEntry[] = [];
  const distribution = evaluateDistribution({ inventory, catalogue });

  for (const side of parsed.sides) {
    try {
      const built = await buildPackage({
        workspaceRoot: parsed.workspace,
        outputDirectory: parsed.output,
        inventory,
        assignments,
        distribution,
        side,
        version: parsed.version,
        intent: parsed.intent,
        includeRuntime: parsed.includeRuntime,
      });
      say(
        `${side}: ${String(built.manifest.archive.entries)} entries, ` +
          `${String(Math.round(built.manifest.archive.bytes / 1_048_576))} MiB, ` +
          `${String(built.manifest.excluded.length)} excluded → ${built.manifest.archive.fileName}`,
      );
    } catch (error) {
      if (error instanceof PackageError || error instanceof ArchiveError) {
        process.stderr.write(`refused (${side}): ${error.message}\n`);
        return EXIT_REFUSED;
      }
      throw error;
    }
  }

  return EXIT_OK;
}

/** Compared as paths, not as strings — a directory with a space arrives encoded. */
function runDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
  } catch {
    return false;
  }
}

if (runDirectly()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`fatal: ${error instanceof Error ? error.message : 'error'}\n`);
      process.exitCode = 1;
    });
}
