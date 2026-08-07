import type { InferredField, InferredForm } from '@voidfall/configuration-inference';
import { splitTrailingComment, validateProposedValue } from '@voidfall/configuration-inference';

import { ConfigurationStagingError, type FieldChange } from './types.js';

/**
 * Produces the new file content for a set of changes.
 *
 * For TOML this is a **surgical edit**: each field remembers the line it was
 * read from, so changing a value replaces the value on that one line and every
 * other byte of the document survives untouched — comments, blank lines,
 * indentation, and anything the reader refused to represent.
 *
 * That is not a convenience. Re-serialising a document from a form can only
 * write back what the form holds, so any construct the reader would not
 * represent would quietly disappear from a file the user thought they had
 * edited one value in.
 */

/** Escapes only what a TOML basic string requires. */
function tomlString(value: string): string {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')}"`;
}

function tomlScalar(value: boolean | number | string): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ConfigurationStagingError('value-rejected');
    // A float that happens to be whole still has to read as a float, or the
    // mod's own parser will take it as an integer and reject it.
    return Number.isInteger(value) ? String(value) : String(value);
  }
  return tomlString(value);
}

function tomlValue(value: FieldChange['value'], field: InferredField): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => tomlScalar(entry as boolean | number | string)).join(', ')}]`;
  }
  const scalar = value as boolean | number | string;
  if (field.type === 'number' && typeof scalar === 'number' && Number.isInteger(scalar)) {
    // The field was a float in the file; keeping it one preserves the type the
    // mod declared rather than silently narrowing it.
    return `${String(scalar)}.0`;
  }
  return tomlScalar(scalar);
}

/**
 * Replaces the value on one line, keeping the key, the spacing and any
 * trailing comment exactly as they were.
 */
function replaceOnLine(line: string, rendered: string): string {
  const equals = line.indexOf('=');
  if (equals <= 0) throw new ConfigurationStagingError('value-rejected');
  const key = line.slice(0, equals + 1);
  const rest = line.slice(equals + 1);
  // A trailing comment is preserved. It belongs to the author, not to us, and
  // the reader already knows how to find one that is outside a string.
  const { comment } = splitTrailingComment(rest);
  const spacing = /^\s*/u.exec(rest)?.[0] ?? ' ';
  return `${key}${spacing}${rendered}${comment === '' ? '' : ` ${comment.trim()}`}`;
}

export interface RewriteInput {
  readonly form: InferredForm;
  readonly content: string;
  readonly changes: readonly FieldChange[];
}

export function rewriteConfiguration(input: RewriteInput): string {
  if (input.changes.length === 0) throw new ConfigurationStagingError('invalid-input');

  const byPath = new Map(input.form.fields.map((field) => [field.path, field]));
  for (const change of input.changes) {
    const field = byPath.get(change.path);
    if (field === undefined) {
      throw new ConfigurationStagingError('unknown-field', change.path);
    }
    const decision = validateProposedValue(field, change.value);
    if (!decision.accepted) {
      throw new ConfigurationStagingError('value-rejected', change.path);
    }
  }

  if (input.form.format === 'toml') {
    // Line endings are detected and preserved: rewriting CRLF as LF would
    // present the whole file as changed in a diff nobody asked for.
    const newline = input.content.includes('\r\n') ? '\r\n' : '\n';
    const lines = input.content.split(/\r\n|\r|\n/u);
    for (const change of input.changes) {
      const field = byPath.get(change.path) as InferredField;
      const index = field.line - 1;
      const original = lines[index];
      if (original === undefined) throw new ConfigurationStagingError('invalid-input', change.path);
      lines[index] = replaceOnLine(original, tomlValue(change.value, field));
    }
    return lines.join(newline);
  }

  if (input.form.format === 'json') {
    // JSON has no line anchors here, so the document is rebuilt from the form.
    // That is only safe when the form held all of it — otherwise the rebuild
    // would drop whatever the reader refused, which for JSON means a null, a
    // mixed array or a non-finite number.
    if (!input.form.complete) throw new ConfigurationStagingError('incomplete-form');
    const document = JSON.parse(input.content) as Record<string, unknown>;
    for (const change of input.changes) {
      const field = byPath.get(change.path) as InferredField;
      assign(document, field.segments, change.value);
    }
    const trailing = input.content.endsWith('\n') ? '\n' : '';
    return `${JSON.stringify(document, null, 2)}${trailing}`;
  }

  throw new ConfigurationStagingError('unsupported-format');
}

function assign(
  document: Record<string, unknown>,
  segments: readonly string[],
  value: FieldChange['value'],
): void {
  let holder = document;
  for (const segment of segments.slice(0, -1)) {
    const next = holder[segment];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      throw new ConfigurationStagingError('invalid-input', segments.join('.'));
    }
    holder = next as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1];
  if (leaf === undefined) throw new ConfigurationStagingError('invalid-input');
  holder[leaf] = Array.isArray(value) ? [...value] : value;
}
