import { readForgeToml } from './toml.js';
import {
  ConfigurationInferenceError,
  type ConfigurationFormat,
  type InferenceIssue,
  type InferredField,
  type InferredFieldType,
  type InferredForm,
} from './types.js';

/**
 * Builds an editable form from a configuration file.
 *
 * The form describes **structure and declared bounds**, and stops there. It
 * never says what a field is for, never marks one recommended, and never
 * offers a default it made up. Where a bound exists it is because the mod
 * wrote it into the file, and the constraint says so.
 */

const MAXIMUM_JSON_DEPTH = 12;

/** Written as an escape rather than a literal, so the source stays text. */
const NUL = String.fromCharCode(0);

function jsonTypeOf(value: unknown): InferredFieldType | undefined {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'string-list';
    const kinds = new Set(value.map((entry) => typeof entry));
    if (kinds.size !== 1) return undefined;
    const [kind] = [...kinds];
    if (kind === 'string') return 'string-list';
    if (kind === 'boolean') return 'boolean-list';
    if (kind === 'number') return value.every((entry) => Number.isFinite(entry)) ? 'number-list' : undefined;
    return undefined;
  }
  return undefined;
}

function walkJson(
  value: unknown,
  segments: readonly string[],
  fields: InferredField[],
  issues: InferenceIssue[],
): void {
  if (segments.length > MAXIMUM_JSON_DEPTH) {
    issues.push({ line: 0, code: 'unsupported-construct' });
    return;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) {
      walkJson(nested, [...segments, key], fields, issues);
    }
    return;
  }
  const type = jsonTypeOf(value);
  if (type === undefined) {
    // `null`, a mixed array, a non-finite number. Recorded, not rendered as
    // something a save could turn into a different type.
    issues.push({ line: 0, code: 'unsupported-value' });
    return;
  }
  fields.push({
    path: segments.join('.'),
    segments: Object.freeze([...segments]),
    type,
    value: value as InferredField['value'],
    // JSON carries no comments, so there is nothing declared to read. The form
    // offers structure only, and says so by having no constraints at all.
    constraints: Object.freeze([]),
    documentation: Object.freeze([]),
    line: 0,
  });
}

export interface InferFormInput {
  readonly format: ConfigurationFormat;
  readonly content: string;
}

export function inferForm(input: InferFormInput): InferredForm {
  if (input === null || typeof input !== 'object' || typeof input.content !== 'string') {
    throw new ConfigurationInferenceError('invalid-input');
  }
  if (input.content.includes(NUL)) {
    // A NUL means this is not the text file it claimed to be.
    throw new ConfigurationInferenceError('not-utf8');
  }

  if (input.format === 'toml') {
    const { fields, issues } = readForgeToml(input.content);
    return Object.freeze({
      format: 'toml' as const,
      fields,
      issues,
      complete: issues.length === 0,
    });
  }

  if (input.format === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.content);
    } catch {
      throw new ConfigurationInferenceError('malformed-document');
    }
    const fields: InferredField[] = [];
    const issues: InferenceIssue[] = [];
    walkJson(parsed, [], fields, issues);
    fields.sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
    return Object.freeze({
      format: 'json' as const,
      fields: Object.freeze(fields),
      issues: Object.freeze(issues),
      complete: issues.length === 0,
    });
  }

  throw new ConfigurationInferenceError('invalid-input');
}
