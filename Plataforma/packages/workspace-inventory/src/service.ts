import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ArtifactInspectionService } from '@voidfall/artifact-inspection';

import { classifyEditLevel, configurationCandidatesFor } from './classify.js';
import { scanWorkspace, type ScanWorkspaceOptions } from './scan.js';
import {
  type InventoriedMod,
  type UndeclaredArchive,
  type WorkspaceInventory,
} from './types.js';

/**
 * Produces the inventory of an imported workspace.
 *
 * It composes rather than reimplements: `artifact-inspection` already answers
 * "what does this archive declare?" without loading a class or executing
 * anything, and the reviewed schema registry already answers "does anybody
 * know what these fields mean?". This module answers only the question neither
 * of them does — what is in this directory, and how far can each mod be edited.
 */

export interface WorkspaceInventoryServiceOptions {
  /**
   * Paths of reviewed resources, relative to the root.
   *
   * Supplied rather than imported so the closed product registry stays the
   * caller's concern; a mod is `FULLY_MANAGED` exactly when one of these names
   * a file it owns.
   */
  readonly reviewedResourcePaths?: readonly string[];
  readonly inspection?: ArtifactInspectionService;
}

export type BuildInventoryOptions = ScanWorkspaceOptions;

/**
 * Produces a conservative file alias from names the artifact declared.
 *
 * Forge does not declare its generated configuration filename. A normalized
 * display name is the one additional signal available without executing or
 * decompiling a mod, so matches using it remain visibly attributed to the
 * `serverconfig-file-by-mod-alias` rule.
 */
export function configurationAliasesFor(input: {
  readonly modId: string;
  readonly displayName: string | null;
}): readonly string[] {
  const aliases = new Set([input.modId.toLocaleLowerCase('en-US')]);
  if (input.displayName !== null) {
    const displayAlias = input.displayName
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLocaleLowerCase('en-US')
      .replace(/[^a-z0-9]+/gu, '_')
      .replace(/^_+|_+$/gu, '')
      .replace(/_+/gu, '_');
    if (/^[a-z0-9][a-z0-9_-]{1,127}$/u.test(displayAlias)) aliases.add(displayAlias);
  }
  return Object.freeze([...aliases].sort((left, right) => left.localeCompare(right, 'en-US')));
}

export class WorkspaceInventoryService {
  readonly #reviewedResourcePaths: readonly string[];
  readonly #inspection: ArtifactInspectionService;

  public constructor(options: WorkspaceInventoryServiceOptions = {}) {
    this.#reviewedResourcePaths = Object.freeze([...(options.reviewedResourcePaths ?? [])]);
    this.#inspection = options.inspection ?? new ArtifactInspectionService();
  }

  public async build(options: BuildInventoryOptions): Promise<WorkspaceInventory> {
    const scan = await scanWorkspace(options);
    const mods: InventoriedMod[] = [];
    const undeclaredArchives: UndeclaredArchive[] = [];

    for (const file of scan.files) {
      if (file.role !== 'mod-archive') continue;

      let report;
      try {
        const content = await readFile(join(options.root, ...file.path.split('/')));
        report = this.#inspection.inspect({ content, expectedSha256: file.sha256 });
      } catch {
        // An archive the inspector refuses is recorded, not dropped. A JAR in
        // the mods folder that cannot be read is a fact about the installation,
        // and omitting it would make the inventory disagree with the folder.
        undeclaredArchives.push({
          path: file.path,
          sha256: file.sha256,
          reason: 'inspection-refused',
        });
        continue;
      }

      if (report.mods.length === 0) {
        // Only when the selective read actually ran. A metadata layer stopped
        // by a limit knows nothing about what the archive declares, and
        // recording that as "no declared mod" is the confusion this whole
        // layering exists to remove.
        const metadata = report.layers.find((layer) => layer.layer === 'metadata');
        undeclaredArchives.push({
          path: file.path,
          sha256: file.sha256,
          reason: metadata?.outcome === 'completed' ? 'no-declared-mod' : 'inspection-refused',
        });
        continue;
      }

      for (const declared of report.mods) {
        const configurationCandidates = configurationCandidatesFor({
          modId: declared.modId,
          aliases: configurationAliasesFor(declared),
          files: scan.files,
          reviewedResourcePaths: this.#reviewedResourcePaths,
        });
        const decision = classifyEditLevel(configurationCandidates);
        mods.push({
          modId: declared.modId,
          displayName: declared.displayName,
          version: declared.version,
          loader: declared.loader,
          dependencies: declared.dependencies,
          archivePath: file.path,
          archiveSha256: file.sha256,
          editLevel: decision.level,
          editLevelReason: decision.reason,
          configurationCandidates,
        });
      }
    }

    // Sorted by mod id and then by archive, so an inventory of the same tree is
    // the same document. Two archives declaring one mod id is a real condition
    // in a 195-mod pack, and the second sort key keeps that stable rather than
    // arbitrary.
    mods.sort(
      (left, right) =>
        left.modId.localeCompare(right.modId, 'en-US') ||
        left.archivePath.localeCompare(right.archivePath, 'en-US'),
    );
    undeclaredArchives.sort((left, right) => left.path.localeCompare(right.path, 'en-US'));

    const body = {
      schemaVersion: 1 as const,
      files: scan.files,
      exclusions: scan.exclusions,
      mods: Object.freeze(mods),
      undeclaredArchives: Object.freeze(undeclaredArchives),
      totals: {
        files: scan.files.length,
        bytes: scan.files.reduce((total, file) => total + file.sizeBytes, 0),
        mods: mods.length,
      },
    };

    // The digest covers the inventory's own content and nothing else — no
    // timestamp, no absolute path, no host detail. That is what lets two scans
    // be compared at all, and what makes a diff between versions meaningful.
    return Object.freeze({
      ...body,
      inventorySha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    });
  }
}
