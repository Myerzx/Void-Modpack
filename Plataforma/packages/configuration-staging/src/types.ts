/**
 * Changes held outside the workspace until somebody decides to apply them.
 *
 * The workspace being edited is somebody's real installation, so nothing here
 * writes to it. A change lands in a staging directory, keeps the digest of the
 * file it was computed against, and only becomes real through a separate,
 * explicit apply.
 *
 * The digest is the part that matters. A staged change says "this was computed
 * against a file that hashed to X"; applying it later verifies X is still what
 * is on disk. Without that, an edit made in the meantime — by a hand, by a mod
 * regenerating its config, by a restore — would be silently overwritten by a
 * change that never saw it.
 */

export interface FieldChange {
  /** Dotted path, exactly as the inferred form reports it. */
  readonly path: string;
  readonly value: boolean | number | string | readonly (boolean | number | string)[];
}

export interface StagedFile {
  /** Relative to the workspace root, `/`-separated. */
  readonly path: string;
  /** What the source hashed to when the change was computed. */
  readonly baseSha256: string;
  /** What the staged content hashes to. */
  readonly stagedSha256: string;
  readonly changes: readonly FieldChange[];
}

/**
 * One line of the difference between the source and the staged file.
 *
 * Line-level and nothing cleverer. A configuration diff is read by a person
 * deciding whether to apply it, and a minimal edit script that reorders lines
 * to look smaller makes that harder, not easier.
 */
export interface DiffLine {
  readonly kind: 'context' | 'removed' | 'added';
  readonly line: number;
  readonly text: string;
}

export type StagingErrorCode =
  | 'invalid-input'
  | 'unknown-field'
  | 'value-rejected'
  | 'incomplete-form'
  | 'base-digest-mismatch'
  | 'unsupported-format'
  | 'not-staged';

export class ConfigurationStagingError extends Error {
  public readonly code: StagingErrorCode;
  /** The field the failure is about, when it is about one. */
  public readonly path: string | null;

  public constructor(code: StagingErrorCode, path: string | null = null) {
    super(`configuration-staging:${code}`);
    this.name = 'ConfigurationStagingError';
    this.code = code;
    this.path = path;
  }
}
