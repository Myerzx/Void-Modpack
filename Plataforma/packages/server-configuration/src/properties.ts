import type {
  BasicConfigurationField,
  ConfigurationResourceDefinition,
  ConfigurationValue,
} from './types.js';
import { ConfigurationOperationError } from './types.js';
import { validateFieldName } from './validation.js';

interface RawLine {
  readonly kind: 'blank' | 'comment';
  readonly raw: string;
}

interface PropertyLine {
  readonly kind: 'property';
  readonly key: string;
  readonly value: string;
}

type PropertiesLine = RawLine | PropertyLine;

export interface ParsedPropertiesDocument {
  readonly lines: readonly PropertiesLine[];
  readonly lineEnding: '\n' | '\r\n';
  readonly trailingNewline: boolean;
  readonly values: Readonly<Record<string, ConfigurationValue>>;
}

const INVALID_VALUE = /[\\\u0000-\u001f\u007f]/u;

function invalidContent(): never {
  throw new ConfigurationOperationError('invalid-content', 'preflight');
}

function decodeContent(content: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return invalidContent();
  }
  if (text.startsWith('\uFEFF') || text.includes('\u0000')) invalidContent();
  return text;
}

function parseTypedValue(raw: string, field: BasicConfigurationField): ConfigurationValue {
  if (INVALID_VALUE.test(raw)) invalidContent();
  switch (field.type) {
    case 'boolean':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return invalidContent();
    case 'integer': {
      if (!/^-?(?:0|[1-9][0-9]*)$/u.test(raw)) invalidContent();
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < field.minimum || value > field.maximum) {
        invalidContent();
      }
      return value;
    }
    case 'enum':
      if (!field.values.includes(raw)) invalidContent();
      return raw;
    case 'string':
      if (raw.length > field.maximumLength) invalidContent();
      return raw;
  }
}

function serializeTypedValue(value: ConfigurationValue, field: BasicConfigurationField): string {
  switch (field.type) {
    case 'boolean':
      if (typeof value !== 'boolean') invalidContent();
      return value ? 'true' : 'false';
    case 'integer':
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < field.minimum ||
        value > field.maximum
      ) {
        invalidContent();
      }
      return String(value);
    case 'enum':
      if (typeof value !== 'string' || !field.values.includes(value)) invalidContent();
      return value;
    case 'string':
      if (
        typeof value !== 'string' ||
        value.length > field.maximumLength ||
        INVALID_VALUE.test(value)
      ) {
        invalidContent();
      }
      return value;
  }
}

export function parsePropertiesDocument(
  content: Uint8Array,
  resource: ConfigurationResourceDefinition,
): ParsedPropertiesDocument {
  const text = decodeContent(content);
  const hasCrLf = text.includes('\r\n');
  const withoutCrLf = text.replaceAll('\r\n', '');
  if (withoutCrLf.includes('\r') || (hasCrLf && withoutCrLf.includes('\n'))) invalidContent();
  const lineEnding: '\n' | '\r\n' = hasCrLf ? '\r\n' : '\n';
  const trailingNewline = text.endsWith(lineEnding);
  const rawLines = text.length === 0 ? [] : text.split(lineEnding);
  if (trailingNewline) rawLines.pop();

  const lines: PropertiesLine[] = [];
  const rawValues = new Map<string, string>();
  for (const raw of rawLines) {
    if (raw.length === 0 || /^\s+$/u.test(raw)) {
      lines.push(Object.freeze({ kind: 'blank', raw }));
      continue;
    }
    if (raw.startsWith('#') || raw.startsWith('!')) {
      lines.push(Object.freeze({ kind: 'comment', raw }));
      continue;
    }
    const separator = raw.indexOf('=');
    if (separator <= 0) invalidContent();
    const key = raw.slice(0, separator);
    const value = raw.slice(separator + 1);
    validateFieldName(key);
    if (
      rawValues.has(key) ||
      !Object.hasOwn(resource.fields, key) ||
      INVALID_VALUE.test(value)
    ) {
      invalidContent();
    }
    rawValues.set(key, value);
    lines.push(Object.freeze({ kind: 'property', key, value }));
  }

  const fieldNames = Object.keys(resource.fields).sort();
  if (
    rawValues.size !== fieldNames.length ||
    fieldNames.some((fieldName) => !rawValues.has(fieldName))
  ) {
    throw new ConfigurationOperationError('schema-mismatch', 'preflight');
  }
  const values: Record<string, ConfigurationValue> = {};
  for (const fieldName of fieldNames) {
    const field = resource.fields[fieldName];
    const raw = rawValues.get(fieldName);
    if (field === undefined || raw === undefined) {
      throw new ConfigurationOperationError('schema-mismatch', 'preflight');
    }
    values[fieldName] = parseTypedValue(raw, field);
  }
  return Object.freeze({
    lines: Object.freeze(lines),
    lineEnding,
    trailingNewline,
    values: Object.freeze(values),
  });
}

function serializeLines(
  lines: readonly PropertiesLine[],
  lineEnding: '\n' | '\r\n',
  trailingNewline: boolean,
): Uint8Array {
  const text = lines
    .map((line) =>
      line.kind === 'property' ? `${line.key}=${line.value}` : line.raw,
    )
    .join(lineEnding);
  return new TextEncoder().encode(text + (trailingNewline ? lineEnding : ''));
}

export interface PropertiesMutation {
  readonly content: Uint8Array;
  readonly changedFields: readonly string[];
  readonly restartRequired: boolean;
}

export function mutatePropertiesDocument(
  document: ParsedPropertiesDocument,
  resource: ConfigurationResourceDefinition,
  changes: Readonly<Record<string, ConfigurationValue>>,
): PropertiesMutation {
  const serialized = new Map<string, string>();
  const changedFields: string[] = [];
  for (const [fieldName, value] of Object.entries(changes)) {
    const field = resource.fields[fieldName];
    if (field === undefined) invalidContent();
    const next = serializeTypedValue(value, field);
    const current = document.values[fieldName];
    if (current === undefined) {
      throw new ConfigurationOperationError('schema-mismatch', 'preflight');
    }
    if (next !== serializeTypedValue(current, field)) {
      serialized.set(fieldName, next);
      changedFields.push(fieldName);
    }
  }
  if (changedFields.length === 0) {
    throw new ConfigurationOperationError('no-change', 'preflight');
  }
  changedFields.sort();
  const lines = document.lines.map((line) => {
    if (line.kind !== 'property') return line;
    const next = serialized.get(line.key);
    return next === undefined ? line : Object.freeze({ ...line, value: next });
  });
  return Object.freeze({
    content: serializeLines(lines, document.lineEnding, document.trailingNewline),
    changedFields: Object.freeze(changedFields),
    restartRequired: changedFields.some(
      (fieldName) => resource.fields[fieldName]?.restartRequired === true,
    ),
  });
}

export function diffPropertiesDocuments(
  current: ParsedPropertiesDocument,
  restored: ParsedPropertiesDocument,
  resource: ConfigurationResourceDefinition,
): readonly string[] {
  const changed = Object.keys(resource.fields)
    .filter((fieldName) => current.values[fieldName] !== restored.values[fieldName])
    .sort();
  if (changed.length === 0) {
    throw new ConfigurationOperationError('no-change', 'preflight');
  }
  return Object.freeze(changed);
}
