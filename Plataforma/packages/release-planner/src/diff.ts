import {
  ReleasePlannerError,
  type FileChange,
  type InventoriedMod,
  type ModChange,
  type WorkspaceDiff,
  type WorkspaceInventory,
} from './types.js';

/**
 * Compares two inventories.
 *
 * Everything is decided by digest, not by version string. A mod whose version
 * did not change but whose archive did is `rebuilt` — a real and common thing
 * when a pack author replaces a jar in place, and reporting it as "unchanged"
 * because the version matched would hide the only evidence that anything
 * happened.
 */

function modsById(inventory: WorkspaceInventory): ReadonlyMap<string, InventoriedMod> {
  const map = new Map<string, InventoriedMod>();
  for (const mod of inventory.mods) {
    // A pack can hold two archives declaring one id. The first by archive path
    // wins, deterministically, because the inventory is already sorted that way
    // and an arbitrary winner would make two runs disagree.
    if (!map.has(mod.modId)) map.set(mod.modId, mod);
  }
  return map;
}

export function diffInventories(input: {
  readonly from: WorkspaceInventory | null;
  readonly to: WorkspaceInventory;
}): WorkspaceDiff {
  if (input === null || typeof input !== 'object' || input.to === undefined) {
    throw new ReleasePlannerError('invalid-input');
  }

  const previousMods = input.from === null ? new Map() : modsById(input.from);
  const currentMods = modsById(input.to);
  const mods: ModChange[] = [];

  for (const [modId, mod] of currentMods) {
    const before = previousMods.get(modId);
    if (before === undefined) {
      mods.push({
        kind: 'added',
        modId,
        displayName: mod.displayName,
        fromVersion: null,
        toVersion: mod.version,
        fromSha256: null,
        toSha256: mod.archiveSha256,
      });
      continue;
    }
    if (before.archiveSha256 === mod.archiveSha256) continue;
    mods.push({
      // Same version, different bytes: somebody replaced the jar. Calling that
      // unchanged would hide the only evidence that anything happened.
      kind: before.version === mod.version ? 'rebuilt' : 'updated',
      modId,
      displayName: mod.displayName,
      fromVersion: before.version,
      toVersion: mod.version,
      fromSha256: before.archiveSha256,
      toSha256: mod.archiveSha256,
    });
  }

  for (const [modId, mod] of previousMods) {
    if (currentMods.has(modId)) continue;
    mods.push({
      kind: 'removed',
      modId,
      displayName: mod.displayName,
      fromVersion: mod.version,
      toVersion: null,
      fromSha256: mod.archiveSha256,
      toSha256: null,
    });
  }

  const previousFiles = new Map(
    (input.from?.files ?? []).map((file) => [file.path, file] as const),
  );
  const currentFiles = new Map(input.to.files.map((file) => [file.path, file] as const));
  const files: FileChange[] = [];

  for (const [path, file] of currentFiles) {
    const before = previousFiles.get(path);
    if (before === undefined) {
      files.push({
        kind: 'added',
        path,
        role: file.role,
        fromSha256: null,
        toSha256: file.sha256,
      });
      continue;
    }
    if (before.sha256 === file.sha256) continue;
    files.push({
      kind: 'changed',
      path,
      role: file.role,
      fromSha256: before.sha256,
      toSha256: file.sha256,
    });
  }

  for (const [path, file] of previousFiles) {
    if (currentFiles.has(path)) continue;
    files.push({
      kind: 'removed',
      path,
      role: file.role,
      fromSha256: file.sha256,
      toSha256: null,
    });
  }

  mods.sort((left, right) => left.modId.localeCompare(right.modId, 'en-US'));
  files.sort((left, right) => left.path.localeCompare(right.path, 'en-US'));

  return Object.freeze({
    mods: Object.freeze(mods),
    files: Object.freeze(files),
    totals: {
      modsAdded: mods.filter((change) => change.kind === 'added').length,
      modsRemoved: mods.filter((change) => change.kind === 'removed').length,
      modsUpdated: mods.filter((change) => change.kind === 'updated' || change.kind === 'rebuilt')
        .length,
      filesChanged: files.length,
    },
    // Compared on the inventory digest, which covers every file's hash. Two
    // scans of one tree produce the same digest, so this is a fact about the
    // content rather than about when the scans happened.
    identical: input.from !== null && input.from.inventorySha256 === input.to.inventorySha256,
  });
}
