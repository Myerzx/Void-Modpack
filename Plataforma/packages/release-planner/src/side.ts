/**
 * Which side a file belongs on, from where it was actually observed.
 *
 * Nothing in a Forge `mods.toml` states whether the mod itself is client-only
 * or server-only — the `side` field there describes a *dependency*, not the
 * mod. So the honest evidence is presence: a jar in the server profile and not
 * in the client profile is a server-side file, because that is where somebody
 * put it.
 *
 * That is observation, not declaration, and the distinction is kept in the
 * type. A mod present in both profiles may still be a client mod somebody
 * installed server-side by mistake; this says where it was seen, and leaves
 * the judgement to whoever is reading.
 */

export type ReleaseSide = 'both' | 'client-only' | 'server-only' | 'neither';

export interface ProfilePresence {
  readonly fileName: string;
  readonly inServer: boolean;
  readonly inClient: boolean;
}

export interface SideAssignment {
  readonly fileName: string;
  readonly side: ReleaseSide;
  /** Always `observed-presence` today. Named so a future source is not silent. */
  readonly evidence: 'observed-presence';
}

/**
 * Builds presence records by comparing two real installations.
 *
 * Matched by file name rather than by digest, deliberately. A server and a
 * client routinely carry different builds of the same mod, and digest matching
 * would then report one jar as server-only and the other as client-only —
 * two wrong answers from one correct observation. The name is what identifies
 * the mod across the two profiles.
 */
export function presenceFromProfiles(input: {
  /** Mod archive names present in the server installation. */
  readonly serverFiles: readonly string[];
  /** Mod archive names present in the client installation. */
  readonly clientFiles: readonly string[];
}): readonly ProfilePresence[] {
  const baseName = (value: string): string => (value.split('/').pop() ?? value).toLowerCase();
  const server = new Set(input.serverFiles.map(baseName));
  const client = new Set(input.clientFiles.map(baseName));
  const names = [...new Set([...server, ...client])].sort((left, right) =>
    left.localeCompare(right, 'en-US'),
  );
  return Object.freeze(
    names.map((fileName) => ({
      fileName,
      inServer: server.has(fileName),
      inClient: client.has(fileName),
    })),
  );
}

export function classifySides(
  presence: readonly ProfilePresence[],
): readonly SideAssignment[] {
  const assignments = presence.map((entry): SideAssignment => {
    const side: ReleaseSide =
      entry.inServer && entry.inClient
        ? 'both'
        : entry.inServer
          ? 'server-only'
          : entry.inClient
            ? 'client-only'
            : // In neither profile. Not a side, and not nothing: it is a file
              // somebody has that no reviewed profile accounts for, which is
              // worth seeing rather than quietly filing under "both".
              'neither';
    return { fileName: entry.fileName, side, evidence: 'observed-presence' };
  });
  return Object.freeze(
    [...assignments].sort((left, right) => left.fileName.localeCompare(right.fileName, 'en-US')),
  );
}

/**
 * Splits a release's files by side.
 *
 * A file with no presence record is **not** assigned a side. Putting an
 * unrecorded jar in the server archive because most jars are server files
 * would be exactly the inference this module exists to avoid, so it lands in
 * `unassigned` and somebody decides.
 */
export function splitBySide(input: {
  readonly paths: readonly string[];
  readonly assignments: readonly SideAssignment[];
}): {
  readonly server: readonly string[];
  readonly client: readonly string[];
  readonly unassigned: readonly string[];
} {
  const byName = new Map(input.assignments.map((entry) => [entry.fileName.toLowerCase(), entry]));
  const server: string[] = [];
  const client: string[] = [];
  const unassigned: string[] = [];

  for (const path of input.paths) {
    const name = (path.split('/').pop() ?? '').toLowerCase();
    const assignment = byName.get(name);
    if (assignment === undefined || assignment.side === 'neither') {
      unassigned.push(path);
      continue;
    }
    if (assignment.side !== 'client-only') server.push(path);
    if (assignment.side !== 'server-only') client.push(path);
  }

  return Object.freeze({
    server: Object.freeze(server.sort((a, b) => a.localeCompare(b, 'en-US'))),
    client: Object.freeze(client.sort((a, b) => a.localeCompare(b, 'en-US'))),
    unassigned: Object.freeze(unassigned.sort((a, b) => a.localeCompare(b, 'en-US'))),
  });
}
