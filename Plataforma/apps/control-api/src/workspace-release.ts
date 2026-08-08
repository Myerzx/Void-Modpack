import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildPackage,
  canExportCurseForgePack,
  classifySides,
  diffInventories,
  evaluateDistribution,
  planRelease,
  presenceFromProfiles,
  renderChangelog,
  type PackageSide,
  type WorkspaceInventory,
} from '@voidfall/release-planner';

import type { ReleaseBuilder } from './workspace-routes.js';

/**
 * Wires the release builder into the API.
 *
 * Thin, like the other adapters. The diff is decided by digest in
 * `release-planner`, the licence gate refuses there, the side split comes from
 * observed presence there, and the archives are written there. This maps a
 * stored inventory onto those calls and hands back what they produced.
 *
 * Two properties travel through unchanged because they are the point:
 *
 * **Producing and distributing are different questions.** An operator may
 * always build for their own machine; handing the result to somebody needs a
 * reviewed licence for every archive in it. `intent` is an input, so nobody
 * produces a redistributable artefact by forgetting to ask.
 *
 * **A file with no observed side is never inferred into the server package.**
 * Most mods are server mods, so guessing would be right often enough to be
 * trusted and wrong often enough to crash a boot.
 */

/** Where a release's archives live. Provisioned, never configured. */
function releaseDirectory(parent: string, workspaceId: string): string {
  return join(parent, workspaceId);
}

export function createReleaseBuilder(releasesParent: string): ReleaseBuilder {
  return {
    preview(input) {
      const to = input.inventory as WorkspaceInventory;
      const from = (input.previousInventory ?? null) as WorkspaceInventory | null;
      const plan = planRelease({ from, to, catalogue: [] });
      const exportable = canExportCurseForgePack(plan.distribution);

      return {
        diff: {
          mods: plan.diff.mods,
          files: plan.diff.files.slice(0, 500),
          totals: plan.diff.totals,
          identical: plan.diff.identical,
          // Truncated for the screen, and said so rather than silently cut.
          filesTruncated: plan.diff.files.length > 500,
          filesTotal: plan.diff.files.length,
        },
        changelog: plan.changelog,
        changelogMarkdown: renderChangelog({
          entries: plan.changelog,
          version: input.version ?? 'próxima versão',
          previousVersion: from === null ? null : 'versão anterior',
        }),
        distribution: {
          distributable: plan.distribution.distributable,
          localUseOnly: plan.distribution.localUseOnly,
          blocks: plan.distribution.blocks.length,
          // Counted by reason, because "172 need provider metadata" tells an
          // operator what to do and "172 blocked" does not.
          blocksByReason: [
            ...plan.distribution.blocks.reduce((counts, block) => {
              counts.set(block.reason, (counts.get(block.reason) ?? 0) + 1);
              return counts;
            }, new Map<string, number>()),
          ].sort(([left], [right]) => left.localeCompare(right, 'en-US')),
          curseForge: exportable,
        },
      };
    },

    build(input) {
      void (async () => {
        try {
          const to = input.inventory as WorkspaceInventory;
          const from = (input.previousInventory ?? null) as WorkspaceInventory | null;
          const distribution = evaluateDistribution({ inventory: to, catalogue: [] });

          if (input.intent === 'distribution' && !distribution.distributable) {
            // Refused before anything is written, and with the gate's own
            // words: a licence refusal is not a smaller export, it is a
            // licence violation with a progress bar.
            await input.onRefused(
              canExportCurseForgePack(distribution).refusal ?? 'distribution-refused',
            );
            return;
          }

          const assignments = classifySides(
            presenceFromProfiles({
              serverFiles: to.files
                .filter((file) => file.role === 'mod-archive')
                .map((file) => file.path),
              clientFiles: input.clientModNames,
            }),
          );

          const output = releaseDirectory(releasesParent, input.workspaceId);
          await mkdir(output, { recursive: true });

          const built: Record<string, unknown> = {};
          for (const side of ['server', 'client'] as readonly PackageSide[]) {
            const result = await buildPackage({
              workspaceRoot: input.workspaceRoot,
              outputDirectory: output,
              inventory: to,
              assignments,
              distribution,
              side,
              version: input.version,
              intent: input.intent,
            });
            built[side] = {
              fileName: result.manifest.archive.fileName,
              sha256: result.manifest.archive.sha256,
              bytes: result.manifest.archive.bytes,
              entries: result.manifest.archive.entries,
              excluded: result.manifest.excluded.length,
              // A client package cut from a server installation is partial, and
              // the manifest says so rather than letting it read as complete.
              derivedFromServerWorkspace: result.manifest.derivedFromServerWorkspace,
            };
          }

          const plan = planRelease({ from, to, catalogue: [] });
          await input.onFinished({
            plan: {
              totals: plan.diff.totals,
              identical: plan.diff.identical,
              changelog: plan.changelog,
              changelogMarkdown: renderChangelog({
                entries: plan.changelog,
                version: input.version,
                previousVersion: from === null ? null : 'versão anterior',
              }),
              distribution: {
                distributable: distribution.distributable,
                localUseOnly: distribution.localUseOnly,
                blocks: distribution.blocks.length,
              },
              sides: classifySides(
                presenceFromProfiles({
                  serverFiles: to.files
                    .filter((file) => file.role === 'mod-archive')
                    .map((file) => file.path),
                  clientFiles: input.clientModNames,
                }),
              ).reduce<Record<string, number>>((counts, assignment) => {
                counts[assignment.side] = (counts[assignment.side] ?? 0) + 1;
                return counts;
              }, {}),
            },
            packages: built,
          });
        } catch (error) {
          const code =
            typeof (error as { code?: unknown }).code === 'string'
              ? (error as { code: string }).code
              : error instanceof Error
                ? error.name
                : 'unknown';
          await input.onRefused(code);
        }
      })();
    },

    async resolveArchive(input) {
      const directory = releaseDirectory(releasesParent, input.workspaceId);
      let entries: readonly string[];
      try {
        entries = await readdir(directory);
      } catch {
        return null;
      }
      // Matched against what is on disk rather than rebuilt from the request,
      // so a download never resolves a name the caller composed.
      const wanted = `voidfall-${input.side}-${input.version}.zip`;
      if (!entries.includes(wanted)) return null;
      const path = join(directory, wanted);
      try {
        const info = await stat(path);
        return info.isFile() ? { path, fileName: wanted, bytes: info.size } : null;
      } catch {
        return null;
      }
    },
  };
}
