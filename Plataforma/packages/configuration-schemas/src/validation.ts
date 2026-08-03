import {
  ConfigurationSchemaOperationError,
  type ConfigurationValueIssue,
  type ConfigurationValueValidationResult,
  type GenericConfigurationField,
  type GenericConfigurationFormat,
  type GenericConfigurationSchema,
  type GenericConfigurationValue,
  type GenericStringField,
} from './types.js';

const IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/u;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[a-z0-9.-]{1,64})?$/u;
const MAXIMUM_FIELDS = 512;
const MAXIMUM_ENUM_VALUES = 256;
const MAXIMUM_STRING_LENGTH = 16_384;
const FORMATS = new Set<GenericConfigurationFormat>([
  'java-properties',
  'json',
  'toml',
  'yaml',
  'cfg',
]);
const FORMAT_EXTENSIONS: Readonly<Record<GenericConfigurationFormat, ReadonlySet<string>>> = {
  'java-properties': new Set(['properties']),
  json: new Set(['json']),
  toml: new Set(['toml']),
  yaml: new Set(['yaml', 'yml']),
  cfg: new Set(['cfg']),
};

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactOrOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

function validRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1_024 ||
    value.includes('\\') ||
    value.includes('\u0000') ||
    value !== value.normalize('NFC')
  ) {
    return false;
  }
  return value.split('/').every(
    (segment) =>
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      segment.length <= 255 &&
      !/[\u0000-\u001f\u007f:]/u.test(segment),
  );
}

function validDescription(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function baseValid(value: Record<string, unknown>): boolean {
  return (
    typeof value.required === 'boolean' &&
    typeof value.restartRequired === 'boolean' &&
    (value.description === undefined || validDescription(value.description))
  );
}

function validFiniteRange(minimum: unknown, maximum: unknown): minimum is number {
  return (
    typeof minimum === 'number' &&
    Number.isFinite(minimum) &&
    typeof maximum === 'number' &&
    Number.isFinite(maximum) &&
    minimum <= maximum
  );
}

function patternMatches(field: GenericStringField, value: string): boolean {
  switch (field.pattern) {
    case undefined:
      return true;
    case 'identifier':
      return IDENTIFIER.test(value);
    case 'hostname':
      return (
        value.length <= 253 &&
        value.split('.').every(
          (label) =>
            /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/u.test(label),
        )
      );
    case 'relative-path':
      return validRelativePath(value);
    case 'non-empty':
      return value.trim().length > 0;
  }
  return false;
}

function fieldValueIssue(
  field: GenericConfigurationField,
  value: unknown,
): ConfigurationValueIssue['code'] | undefined {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'invalid-type';
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 'invalid-type';
      return value < field.minimum || value > field.maximum ? 'out-of-range' : undefined;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'invalid-type';
      return value < field.minimum || value > field.maximum ? 'out-of-range' : undefined;
    case 'string':
      if (typeof value !== 'string') return 'invalid-type';
      if (value.length > field.maximumLength) return 'too-long';
      return patternMatches(field, value) ? undefined : 'pattern-mismatch';
    case 'enum':
      if (typeof value !== 'string') return 'invalid-type';
      return field.values.includes(value) ? undefined : 'out-of-range';
  }
}

function freezeField(input: unknown): GenericConfigurationField {
  if (!isRecord(input) || typeof input.type !== 'string' || !baseValid(input)) {
    throw new ConfigurationSchemaOperationError('invalid-schema');
  }
  const optionalBase = ['description', 'defaultValue'];
  let field: GenericConfigurationField;
  switch (input.type) {
    case 'boolean':
      if (!exactOrOptionalKeys(input, ['type', 'required', 'restartRequired'], optionalBase)) {
        throw new ConfigurationSchemaOperationError('invalid-schema');
      }
      field = {
        type: 'boolean',
        required: input.required as boolean,
        restartRequired: input.restartRequired as boolean,
        ...(input.description !== undefined ? { description: input.description as string } : {}),
        ...(input.defaultValue !== undefined ? { defaultValue: input.defaultValue as boolean } : {}),
      };
      break;
    case 'integer':
      if (
        !exactOrOptionalKeys(
          input,
          ['type', 'required', 'restartRequired', 'minimum', 'maximum'],
          optionalBase,
        ) ||
        !validFiniteRange(input.minimum, input.maximum) ||
        !Number.isSafeInteger(input.minimum) ||
        !Number.isSafeInteger(input.maximum)
      ) {
        throw new ConfigurationSchemaOperationError('invalid-schema');
      }
      field = {
        type: 'integer',
        required: input.required as boolean,
        restartRequired: input.restartRequired as boolean,
        minimum: input.minimum,
        maximum: input.maximum as number,
        ...(input.description !== undefined ? { description: input.description as string } : {}),
        ...(input.defaultValue !== undefined ? { defaultValue: input.defaultValue as number } : {}),
      };
      break;
    case 'number':
      if (
        !exactOrOptionalKeys(
          input,
          ['type', 'required', 'restartRequired', 'minimum', 'maximum'],
          optionalBase,
        ) ||
        !validFiniteRange(input.minimum, input.maximum)
      ) {
        throw new ConfigurationSchemaOperationError('invalid-schema');
      }
      field = {
        type: 'number',
        required: input.required as boolean,
        restartRequired: input.restartRequired as boolean,
        minimum: input.minimum,
        maximum: input.maximum as number,
        ...(input.description !== undefined ? { description: input.description as string } : {}),
        ...(input.defaultValue !== undefined ? { defaultValue: input.defaultValue as number } : {}),
      };
      break;
    case 'string':
      if (
        !exactOrOptionalKeys(
          input,
          ['type', 'required', 'restartRequired', 'maximumLength'],
          [...optionalBase, 'pattern'],
        ) ||
        !Number.isSafeInteger(input.maximumLength) ||
        (input.maximumLength as number) < 1 ||
        (input.maximumLength as number) > MAXIMUM_STRING_LENGTH ||
        (input.pattern !== undefined &&
          !['identifier', 'hostname', 'relative-path', 'non-empty'].includes(input.pattern as string))
      ) {
        throw new ConfigurationSchemaOperationError('invalid-schema');
      }
      field = {
        type: 'string',
        required: input.required as boolean,
        restartRequired: input.restartRequired as boolean,
        maximumLength: input.maximumLength as number,
        ...(input.pattern !== undefined
          ? { pattern: input.pattern as NonNullable<GenericStringField['pattern']> }
          : {}),
        ...(input.description !== undefined ? { description: input.description as string } : {}),
        ...(input.defaultValue !== undefined ? { defaultValue: input.defaultValue as string } : {}),
      };
      break;
    case 'enum': {
      if (
        !exactOrOptionalKeys(
          input,
          ['type', 'required', 'restartRequired', 'values'],
          optionalBase,
        ) ||
        !Array.isArray(input.values) ||
        input.values.length === 0 ||
        input.values.length > MAXIMUM_ENUM_VALUES
      ) {
        throw new ConfigurationSchemaOperationError('invalid-schema');
      }
      const values = new Set<string>();
      for (const value of input.values) {
        if (
          typeof value !== 'string' ||
          value.length < 1 ||
          value.length > MAXIMUM_STRING_LENGTH ||
          /[\u0000-\u001f\u007f]/u.test(value) ||
          values.has(value)
        ) {
          throw new ConfigurationSchemaOperationError('invalid-schema');
        }
        values.add(value);
      }
      field = {
        type: 'enum',
        required: input.required as boolean,
        restartRequired: input.restartRequired as boolean,
        values: Object.freeze([...values].sort(compareOrdinal)),
        ...(input.description !== undefined ? { description: input.description as string } : {}),
        ...(input.defaultValue !== undefined ? { defaultValue: input.defaultValue as string } : {}),
      };
      break;
    }
    default:
      throw new ConfigurationSchemaOperationError('invalid-schema');
  }
  if (input.defaultValue !== undefined && fieldValueIssue(field, input.defaultValue) !== undefined) {
    throw new ConfigurationSchemaOperationError('invalid-schema');
  }
  return Object.freeze(field);
}

export function freezeConfigurationSchema(input: GenericConfigurationSchema): GenericConfigurationSchema {
  if (
    !isRecord(input) ||
    !exactOrOptionalKeys(
      input,
      ['schemaId', 'resourceId', 'schemaVersion', 'format', 'filePath', 'fields'],
      [],
    ) ||
    typeof input.schemaId !== 'string' ||
    !IDENTIFIER.test(input.schemaId) ||
    typeof input.resourceId !== 'string' ||
    !IDENTIFIER.test(input.resourceId) ||
    typeof input.schemaVersion !== 'string' ||
    !VERSION.test(input.schemaVersion) ||
    !FORMATS.has(input.format) ||
    !validRelativePath(input.filePath) ||
    !isRecord(input.fields)
  ) {
    throw new ConfigurationSchemaOperationError('invalid-schema');
  }
  const extension = input.filePath.split('.').at(-1)?.toLocaleLowerCase('en-US') ?? '';
  if (!FORMAT_EXTENSIONS[input.format].has(extension)) {
    throw new ConfigurationSchemaOperationError('invalid-schema');
  }
  const entries = Object.entries(input.fields);
  if (entries.length === 0 || entries.length > MAXIMUM_FIELDS) {
    throw new ConfigurationSchemaOperationError('invalid-schema');
  }
  const fields: Record<string, GenericConfigurationField> = {};
  const caseFolded = new Set<string>();
  for (const [name, definition] of entries.sort(([left], [right]) => compareOrdinal(left, right))) {
    const folded = name.toLocaleLowerCase('en-US');
    if (!FIELD_NAME.test(name) || caseFolded.has(folded)) {
      throw new ConfigurationSchemaOperationError('invalid-schema');
    }
    caseFolded.add(folded);
    fields[name] = freezeField(definition);
  }
  return Object.freeze({
    schemaId: input.schemaId,
    resourceId: input.resourceId,
    schemaVersion: input.schemaVersion,
    format: input.format,
    filePath: input.filePath,
    fields: Object.freeze(fields),
  });
}

export function validateConfigurationValues(
  schemaInput: GenericConfigurationSchema,
  input: unknown,
): ConfigurationValueValidationResult {
  const schema = freezeConfigurationSchema(schemaInput);
  if (!isRecord(input)) {
    return Object.freeze({
      success: false,
      issues: Object.freeze([{ field: '', code: 'invalid-type' as const }]),
    });
  }
  const issues: ConfigurationValueIssue[] = [];
  for (const key of Object.keys(input)) {
    if (!(key in schema.fields)) issues.push({ field: key, code: 'unknown-field' });
  }
  const values: Record<string, GenericConfigurationValue> = {};
  const restartRequiredFields: string[] = [];
  for (const [name, field] of Object.entries(schema.fields)) {
    const suppliedByCaller = Object.hasOwn(input, name);
    const supplied = input[name];
    const value = suppliedByCaller ? supplied : field.defaultValue;
    if (value === undefined) {
      if (field.required) issues.push({ field: name, code: 'missing-required-field' });
      continue;
    }
    const issue = fieldValueIssue(field, value);
    if (issue !== undefined) {
      issues.push({ field: name, code: issue });
      continue;
    }
    values[name] = value as GenericConfigurationValue;
    if (field.restartRequired && suppliedByCaller) restartRequiredFields.push(name);
  }
  issues.sort((left, right) =>
    compareOrdinal(`${left.field}\u0000${left.code}`, `${right.field}\u0000${right.code}`),
  );
  if (issues.length > 0) {
    return Object.freeze({ success: false, issues: Object.freeze(issues) });
  }
  const noIssues = Object.freeze([]) as readonly [];
  return Object.freeze({
    success: true,
    values: Object.freeze(values),
    restartRequiredFields: Object.freeze(restartRequiredFields.sort(compareOrdinal)),
    issues: noIssues,
  });
}
