/**
 * An editable form inferred from a configuration file nobody has reviewed.
 *
 * The whole package rests on one distinction: **structure can be inferred,
 * meaning cannot.** A value that is `true` is a boolean — that is a fact about
 * the file. What the field *does*, whether changing it is safe, and what it
 * interacts with are not in the file and are not guessed here.
 *
 * There is one exception, and it is not an exception at all: Forge's own
 * `ForgeConfigSpec` writes its bounds into the file as comments —
 * `#Range: 0 ~ 100`, `#Allowed Values: EASY, NORMAL`. Reading those is reading
 * a **declaration**, not inferring one. Every constraint therefore carries
 * where it came from, so a reader can tell "the mod says so" apart from "we
 * looked at the current value".
 */

export type InferredFieldType =
  | 'boolean'
  | 'integer'
  | 'number'
  | 'string'
  | 'string-list'
  | 'number-list'
  | 'boolean-list';

export type ConfigurationFormat = 'toml' | 'json';

/**
 * Where a constraint came from.
 *
 * `declared` is the mod stating its own bound. `observed` is only ever a
 * statement about the value that is there now, and never a restriction: a
 * field currently holding `5` is not thereby limited to integers 5 and below.
 */
export type ConstraintSource = 'declared' | 'observed';

export type FieldConstraint =
  | {
      readonly kind: 'range';
      readonly minimum: number | null;
      readonly maximum: number | null;
      readonly source: ConstraintSource;
    }
  | {
      readonly kind: 'allowed-values';
      readonly values: readonly string[];
      readonly source: ConstraintSource;
    };

export interface InferredField {
  /** Dotted path from the document root, e.g. `general.difficultyScale`. */
  readonly path: string;
  /** The path split into segments, so a caller need not re-parse it. */
  readonly segments: readonly string[];
  readonly type: InferredFieldType;
  readonly value: boolean | number | string | readonly (boolean | number | string)[];
  readonly constraints: readonly FieldConstraint[];
  /**
   * The comment lines above the field, verbatim and unparsed.
   *
   * Kept as written rather than summarised. It is the only description of the
   * field that exists, it was written by whoever wrote the mod, and rewording
   * it would be this package inventing meaning through the back door.
   */
  readonly documentation: readonly string[];
  /** 1-indexed line the assignment was read from, for a legible diff. */
  readonly line: number;
}

/**
 * Something the reader would not represent.
 *
 * Recorded rather than skipped, and the file is still usable: a form that
 * silently dropped a construct would let somebody save a document that lost
 * the part nobody rendered.
 */
export interface InferenceIssue {
  readonly line: number;
  readonly code:
    | 'unsupported-construct'
    | 'unsupported-value'
    | 'duplicate-key'
    | 'malformed-line';
}

export interface InferredForm {
  readonly format: ConfigurationFormat;
  readonly fields: readonly InferredField[];
  readonly issues: readonly InferenceIssue[];
  /**
   * Whether every line of the document was represented.
   *
   * `false` means the form is a partial view, and a partial view must not be
   * written back over the original — the round-trip would drop whatever the
   * reader refused.
   */
  readonly complete: boolean;
}

export type ConfigurationInferenceErrorCode =
  | 'invalid-input'
  | 'content-too-large'
  | 'not-utf8'
  | 'malformed-document';

export class ConfigurationInferenceError extends Error {
  public readonly code: ConfigurationInferenceErrorCode;

  public constructor(code: ConfigurationInferenceErrorCode) {
    super(`configuration-inference:${code}`);
    this.name = 'ConfigurationInferenceError';
    this.code = code;
  }
}
