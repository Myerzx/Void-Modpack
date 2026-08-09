import {
  ConfigurationInferenceError,
  type FieldConstraint,
  type InferenceIssue,
  type InferredField,
  type InferredFieldType,
} from './types.js';

/**
 * Reads the TOML subset a Forge configuration actually uses, keeping comments.
 *
 * The comments are the point. `ForgeConfigSpec` writes its own bounds into the
 * file — `#Range: 0 ~ 100`, `#Allowed Values: EASY, NORMAL` — so a reader that
 * discarded them would throw away the only place the mod states what it will
 * accept, and then the editor would have to guess. It does not guess; it reads.
 *
 * Everything this subset cannot represent is **recorded as an issue**, never
 * approximated. A form built from a partial read is marked incomplete, because
 * writing a partial view back over the original would drop whatever was
 * refused.
 */

const MAXIMUM_BYTES = 4_194_304;

/** `#Range: 0 ~ 100`, `#Range: > 0`, `#Range: 1.0 ~ 2.5` */
const RANGE = /^range:\s*(.+)$/iu;
/** `#Allowed Values: EASY, NORMAL, HARD` */
const ALLOWED = /^allowed values:\s*(.+)$/iu;

/** Built from its code point so the literal cannot be mangled in an edit. */
const BACKSLASH = String.fromCharCode(92);

const BARE_KEY = /^[A-Za-z0-9_-]+$/u;

interface PendingComments {
  readonly documentation: string[];
  readonly constraints: FieldConstraint[];
}

/**
 * Parses a declared range.
 *
 * Returns nothing rather than a partial bound when the shape is unfamiliar. A
 * misread bound is worse than no bound: it would reject values the mod accepts,
 * or accept values it does not, and both look like the editor working.
 */
function parseRange(text: string): FieldConstraint | undefined {
  const trimmed = text.trim();
  const between = /^(-?[\d.]+)\s*~\s*(-?[\d.]+)$/u.exec(trimmed);
  if (between !== null) {
    const minimum = Number(between[1]);
    const maximum = Number(between[2]);
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return undefined;
    return { kind: 'range', minimum, maximum, source: 'declared' };
  }
  const comparison = /^(>=|<=|>|<)\s*(-?[\d.]+)$/u.exec(trimmed);
  if (comparison !== null) {
    const bound = Number(comparison[2]);
    if (!Number.isFinite(bound)) return undefined;
    const operator = comparison[1];
    return operator === '>' || operator === '>='
      ? { kind: 'range', minimum: bound, maximum: null, source: 'declared' }
      : { kind: 'range', minimum: null, maximum: bound, source: 'declared' };
  }
  return undefined;
}

function parseAllowed(text: string): FieldConstraint | undefined {
  const values = text
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return values.length === 0
    ? undefined
    : { kind: 'allowed-values', values: Object.freeze(values), source: 'declared' };
}

/**
 * Splits a value from the comment that may follow it on the same line.
 *
 * TOML allows a trailing `#` comment after a value, and Forge configurations
 * use them. Handing the whole remainder to the value parser makes a perfectly
 * ordinary line unreadable, and the field then vanishes from the form — which
 * is worse than a visible refusal, because the file looks like it has fewer
 * settings than it has.
 *
 * The `#` only counts outside a string; a hash inside `"a # b"` is text.
 */
export function splitTrailingComment(rest: string): {
  readonly value: string;
  readonly comment: string;
} {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < rest.length; index += 1) {
    const character = rest[index];
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (character === BACKSLASH && quote === '"') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#') {
      return { value: rest.slice(0, index), comment: rest.slice(index) };
    }
  }
  return { value: rest, comment: '' };
}

interface ParsedValue {
  readonly type: InferredFieldType;
  readonly value: InferredField['value'];
}

/**
 * Reads one TOML scalar or homogeneous array.
 *
 * Heterogeneous arrays and inline tables are refused. A list holding a string
 * and a number has no single type to offer a form, and rendering it as text
 * would let a save turn a number into a string without anybody choosing that.
 */
function parseValue(raw: string): ParsedValue | undefined {
  const text = raw.trim();
  if (text === 'true') return { type: 'boolean', value: true };
  if (text === 'false') return { type: 'boolean', value: false };

  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    const inner = text.slice(1, -1);
    // Only the escapes a Forge config actually emits. An unknown escape is
    // refused rather than passed through as literal backslash-something.
    if (/\\(?!["\\nrt])/u.test(inner)) return undefined;
    return {
      type: 'string',
      value: inner
        .replaceAll('\\n', '\n')
        .replaceAll('\\r', '\r')
        .replaceAll('\\t', '\t')
        .replaceAll('\\"', '"')
        .replaceAll('\\\\', '\\'),
    };
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return { type: 'string', value: text.slice(1, -1) };
  }

  if (/^-?\d+$/u.test(text)) {
    const value = Number(text);
    if (!Number.isSafeInteger(value)) return undefined;
    return { type: 'integer', value };
  }
  if (/^-?\d*\.\d+(?:[eE][+-]?\d+)?$/u.test(text) || /^-?\d+[eE][+-]?\d+$/u.test(text)) {
    const value = Number(text);
    if (!Number.isFinite(value)) return undefined;
    return { type: 'number', value };
  }

  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (inner.length === 0) return { type: 'string-list', value: Object.freeze([]) };
    const parts = splitTopLevel(inner);
    if (parts === undefined) return undefined;
    const parsed = parts.map((part) => parseValue(part));
    if (parsed.some((entry) => entry === undefined)) return undefined;
    const entries = parsed as ParsedValue[];
    const kinds = new Set(entries.map((entry) => entry.type));
    if (kinds.size !== 1) return undefined;
    const [kind] = [...kinds];
    const values = Object.freeze(entries.map((entry) => entry.value as boolean | number | string));
    if (kind === 'string') return { type: 'string-list', value: values };
    if (kind === 'boolean') return { type: 'boolean-list', value: values };
    if (kind === 'integer' || kind === 'number') return { type: 'number-list', value: values };
    return undefined;
  }
  return undefined;
}

/**
 * Reads TOML dotted keys with bare, basic-quoted or literal-quoted segments.
 * Forge uses quoted table segments for human labels such as
 * `[general."Default Feature Configs"]`; treating that as malformed made an
 * otherwise ordinary generated file impossible to edit safely.
 */
function parseDottedKey(raw: string): readonly string[] | undefined {
  const segments: string[] = [];
  let index = 0;
  const skipWhitespace = (): void => {
    while (/\s/u.test(raw[index] ?? '')) index += 1;
  };

  skipWhitespace();
  while (index < raw.length) {
    const start = index;
    const quote = raw[index];
    let segment: string | undefined;
    if (quote === '"' || quote === "'") {
      index += 1;
      let escaped = false;
      while (index < raw.length) {
        const character = raw[index];
        index += 1;
        if (escaped) escaped = false;
        else if (character === BACKSLASH && quote === '"') escaped = true;
        else if (character === quote) break;
      }
      const token = raw.slice(start, index);
      const parsed = parseValue(token);
      if (parsed?.type !== 'string') return undefined;
      segment = parsed.value as string;
    } else {
      while (index < raw.length && /[A-Za-z0-9_-]/u.test(raw[index] ?? '')) index += 1;
      const token = raw.slice(start, index);
      if (!BARE_KEY.test(token)) return undefined;
      segment = token;
    }
    segments.push(segment);
    skipWhitespace();
    if (index === raw.length) return segments;
    if (raw[index] !== '.') return undefined;
    index += 1;
    skipWhitespace();
  }
  return undefined;
}

/** Splits an array body on commas that are not inside a string. */
function splitTopLevel(inner: string): string[] | undefined {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const character of inner) {
    if (quote !== undefined) {
      current += character;
      if (escaped) escaped = false;
      else if (character === '\\' && quote === '"') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === '[' || character === ']' || character === '{' || character === '}') {
      // Nested arrays and inline tables are outside the subset.
      return undefined;
    }
    if (character === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (quote !== undefined) return undefined;
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

export interface TomlReadResult {
  readonly fields: readonly InferredField[];
  readonly issues: readonly InferenceIssue[];
}

export function readForgeToml(content: string): TomlReadResult {
  if (content.length > MAXIMUM_BYTES) {
    throw new ConfigurationInferenceError('content-too-large');
  }
  const fields: InferredField[] = [];
  const issues: InferenceIssue[] = [];
  const seen = new Set<string>();
  let table: string[] = [];
  let pending: PendingComments = { documentation: [], constraints: [] };

  const lines = content.split(/\r\n|\r|\n/u);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    const lineNumber = index + 1;

    if (line.length === 0) {
      // A blank line ends a comment block, so documentation does not drift down
      // onto a field it was never written for.
      pending = { documentation: [], constraints: [] };
      continue;
    }

    if (line.startsWith('#')) {
      const body = line.slice(1).trim();
      const range = RANGE.exec(body);
      const allowed = ALLOWED.exec(body);
      const constraint =
        range !== null
          ? parseRange(range[1] ?? '')
          : allowed !== null
            ? parseAllowed(allowed[1] ?? '')
            : undefined;
      if (constraint !== undefined) pending.constraints.push(constraint);
      // Kept in the documentation either way: the line is what the mod author
      // wrote, and a reader should see it whether or not we parsed it.
      pending.documentation.push(body);
      continue;
    }

    if (line.startsWith('[[')) {
      // Arrays of tables have no stable field path for a form.
      issues.push({ line: lineNumber, code: 'unsupported-construct' });
      pending = { documentation: [], constraints: [] };
      continue;
    }
    if (line.startsWith('[')) {
      const parsedTable = line.endsWith(']') ? parseDottedKey(line.slice(1, -1)) : undefined;
      if (parsedTable === undefined) {
        issues.push({ line: lineNumber, code: 'malformed-line' });
      } else {
        table = [...parsedTable];
      }
      pending = { documentation: [], constraints: [] };
      continue;
    }

    const equals = line.indexOf('=');
    if (equals <= 0) {
      issues.push({ line: lineNumber, code: 'malformed-line' });
      pending = { documentation: [], constraints: [] };
      continue;
    }
    const key = parseDottedKey(line.slice(0, equals));
    if (key === undefined) {
      issues.push({ line: lineNumber, code: 'unsupported-construct' });
      pending = { documentation: [], constraints: [] };
      continue;
    }
    const parsed = parseValue(splitTrailingComment(line.slice(equals + 1)).value);
    if (parsed === undefined) {
      issues.push({ line: lineNumber, code: 'unsupported-value' });
      pending = { documentation: [], constraints: [] };
      continue;
    }

    const segments = [...table, ...key];
    const path = segments.join('.');
    if (seen.has(path)) {
      issues.push({ line: lineNumber, code: 'duplicate-key' });
      pending = { documentation: [], constraints: [] };
      continue;
    }
    seen.add(path);

    fields.push({
      path,
      segments: Object.freeze(segments),
      type: parsed.type,
      value: parsed.value,
      constraints: Object.freeze([...pending.constraints]),
      documentation: Object.freeze([...pending.documentation]),
      line: lineNumber,
    });
    pending = { documentation: [], constraints: [] };
  }

  return { fields: Object.freeze(fields), issues: Object.freeze(issues) };
}
