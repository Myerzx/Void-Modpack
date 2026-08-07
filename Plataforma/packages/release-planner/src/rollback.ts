import { type PackageManifest, type PackageSide } from './package.js';

/**
 * Going back to a version that worked.
 *
 * A rollback is planned here and executed elsewhere. That split is deliberate:
 * this module reads two manifests and says exactly which files would be
 * restored and which removed, and every step is derived from a digest, so a
 * plan can be shown to somebody before anything on disk is touched.
 *
 * One caveat is encoded rather than left to be remembered. Restoring the mods
 * and configuration of an older version does **not** restore the world that ran
 * under the newer one. A world saved with a mod present can fail to load once
 * that mod is gone, and no file comparison can see that. `worldStateCovered` is
 * always false, and it is part of the plan rather than a line in a document,
 * because a rollback that silently loses a world is the worst outcome this
 * pipeline could produce.
 */

export type RollbackStepKind =
  /** Present in the target version with different bytes, or absent now. */
  | 'restore'
  /** Present now, absent from the target version. */
  | 'remove';

export interface RollbackStep {
  readonly kind: RollbackStepKind;
  readonly path: string;
  /** Digest currently installed. `null` when the file does not exist now. */
  readonly currentSha256: string | null;
  /** Digest to end at. `null` when the step removes the file. */
  readonly targetSha256: string | null;
}

export interface RollbackPlan {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly side: PackageSide;
  readonly steps: readonly RollbackStep[];
  readonly totals: {
    readonly restored: number;
    readonly removed: number;
    readonly unchanged: number;
  };
  /**
   * Always false. The world is deliberately outside every package, so no
   * rollback can return it — see the note at the top of this file.
   */
  readonly worldStateCovered: false;
  /** True when the two versions hold the same files with the same bytes. */
  readonly identical: boolean;
}

export type RollbackErrorCode = 'sides-differ' | 'same-version';

export class RollbackError extends Error {
  public readonly code: RollbackErrorCode;

  public constructor(code: RollbackErrorCode) {
    super(`release-rollback:${code}`);
    this.name = 'RollbackError';
    this.code = code;
  }
}

/**
 * Plans a return from `current` to `target`.
 *
 * Direction matters and is not symmetric: the plan describes what to do to the
 * installation described by `current` so that it matches `target`.
 */
export function planRollback(input: {
  readonly current: PackageManifest;
  readonly target: PackageManifest;
}): RollbackPlan {
  if (input.current.side !== input.target.side) {
    // Comparing a client package to a server one would produce a plan that
    // removes every server file. Refusing is the only safe answer.
    throw new RollbackError('sides-differ');
  }
  if (input.current.version === input.target.version) {
    throw new RollbackError('same-version');
  }

  const currentFiles = new Map(input.current.files.map((file) => [file.path, file.sha256]));
  const targetFiles = new Map(input.target.files.map((file) => [file.path, file.sha256]));
  const steps: RollbackStep[] = [];
  let unchanged = 0;

  for (const [path, targetSha256] of targetFiles) {
    const currentSha256 = currentFiles.get(path) ?? null;
    if (currentSha256 === targetSha256) {
      unchanged += 1;
      continue;
    }
    steps.push({ kind: 'restore', path, currentSha256, targetSha256 });
  }

  for (const [path, currentSha256] of currentFiles) {
    if (targetFiles.has(path)) continue;
    steps.push({ kind: 'remove', path, currentSha256, targetSha256: null });
  }

  steps.sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
  const restored = steps.filter((step) => step.kind === 'restore').length;

  return Object.freeze({
    fromVersion: input.current.version,
    toVersion: input.target.version,
    side: input.current.side,
    steps: Object.freeze(steps),
    totals: { restored, removed: steps.length - restored, unchanged },
    worldStateCovered: false,
    identical: steps.length === 0,
  });
}
