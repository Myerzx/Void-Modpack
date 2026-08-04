import { isAbsolute, resolve, sep } from 'node:path';

import { VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY } from '@voidfall/configuration-schemas';

import {
  JAVA_PROPERTIES_V1,
  OPENLOADER_ADVANCED_OPTIONS_V1,
  type ApplyConfigurationPlan,
  type BasicConfigurationField,
  type ConfigurationResourceDefinition,
  type ConfigurationValue,
  ConfigurationOperationError,
  type RollbackConfigurationPlan,
} from './types.js';

const IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/u;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SCHEMA_VERSION = /^[a-z0-9][a-z0-9.+_-]{0,127}$/u;
const MAXIMUM_CONFIGURATION_BYTES = 1_048_576;
const MAXIMUM_FIELDS = 256;
const MAXIMUM_ENUM_VALUES = 128;
const MAXIMUM_STRING_LENGTH = 4096;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ConfigurationOperationError('invalid-plan', 'plan');
  }
}

export function validateIdentifier(value: unknown, definition = false): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new ConfigurationOperationError(
      definition ? 'invalid-definition' : 'invalid-plan',
      definition ? 'definition' : 'plan',
    );
  }
}

export function validateSchemaVersion(
  value: unknown,
  definition = false,
): asserts value is string {
  if (typeof value !== 'string' || !SCHEMA_VERSION.test(value)) {
    throw new ConfigurationOperationError(
      definition ? 'invalid-definition' : 'invalid-plan',
      definition ? 'definition' : 'plan',
    );
  }
}

export function validateFieldName(value: unknown, definition = false): asserts value is string {
  if (typeof value !== 'string' || !FIELD_NAME.test(value)) {
    throw new ConfigurationOperationError(
      definition ? 'invalid-definition' : 'invalid-content',
      definition ? 'definition' : 'preflight',
    );
  }
}

export function validateSha256(value: unknown, definition = false): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new ConfigurationOperationError(
      definition ? 'invalid-definition' : 'invalid-plan',
      definition ? 'definition' : 'plan',
    );
  }
}

export function canonicalTimestamp(clock: () => Date): string {
  let value: Date;
  try {
    value = clock();
  } catch {
    throw new ConfigurationOperationError('invalid-plan', 'plan');
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ConfigurationOperationError('invalid-plan', 'plan');
  }
  return value.toISOString();
}

export function parseCanonicalTimestamp(value: unknown): Date {
  if (typeof value !== 'string') {
    throw new ConfigurationOperationError('revision-integrity-mismatch', 'verify');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ConfigurationOperationError('revision-integrity-mismatch', 'verify');
  }
  return parsed;
}

function validateRestart(value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new ConfigurationOperationError('invalid-definition', 'definition');
  }
}

function freezeField(field: BasicConfigurationField): BasicConfigurationField {
  validateRestart(field.restartRequired);
  switch (field.type) {
    case 'boolean':
      if (Object.keys(field).sort().join(',') !== 'restartRequired,type') {
        throw new ConfigurationOperationError('invalid-definition', 'definition');
      }
      return Object.freeze({ type: field.type, restartRequired: field.restartRequired });
    case 'integer':
      if (
        Object.keys(field).sort().join(',') !== 'maximum,minimum,restartRequired,type' ||
        !Number.isSafeInteger(field.minimum) ||
        !Number.isSafeInteger(field.maximum) ||
        field.minimum > field.maximum
      ) {
        throw new ConfigurationOperationError('invalid-definition', 'definition');
      }
      return Object.freeze({
        type: field.type,
        minimum: field.minimum,
        maximum: field.maximum,
        restartRequired: field.restartRequired,
      });
    case 'enum': {
      if (
        Object.keys(field).sort().join(',') !== 'restartRequired,type,values' ||
        !Array.isArray(field.values) ||
        field.values.length === 0 ||
        field.values.length > MAXIMUM_ENUM_VALUES
      ) {
        throw new ConfigurationOperationError('invalid-definition', 'definition');
      }
      const seen = new Set<string>();
      const values = field.values.map((item) => {
        if (
          typeof item !== 'string' ||
          item.length === 0 ||
          item.length > MAXIMUM_STRING_LENGTH ||
          /[\\\u0000-\u001f\u007f]/u.test(item) ||
          seen.has(item)
        ) {
          throw new ConfigurationOperationError('invalid-definition', 'definition');
        }
        seen.add(item);
        return item;
      });
      return Object.freeze({
        type: field.type,
        values: Object.freeze(values),
        restartRequired: field.restartRequired,
      });
    }
    case 'string':
      if (
        Object.keys(field).sort().join(',') !== 'maximumLength,restartRequired,type' ||
        !Number.isSafeInteger(field.maximumLength) ||
        field.maximumLength < 1 ||
        field.maximumLength > MAXIMUM_STRING_LENGTH
      ) {
        throw new ConfigurationOperationError('invalid-definition', 'definition');
      }
      return Object.freeze({
        type: field.type,
        maximumLength: field.maximumLength,
        restartRequired: field.restartRequired,
      });
    default:
      throw new ConfigurationOperationError('invalid-definition', 'definition');
  }
}

export function freezeResourceDefinition(
  input: ConfigurationResourceDefinition,
): ConfigurationResourceDefinition {
  if (!isRecord(input)) {
    throw new ConfigurationOperationError('invalid-definition', 'definition');
  }
  const resource = input as unknown as Record<string, unknown>;
  const expected = [
    'resourceId',
    'schemaId',
    'schemaVersion',
    'schemaSha256',
    'filePath',
    'format',
    'maximumBytes',
    'fields',
  ];
  const actual = Object.keys(resource).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== [...expected].sort()[index])) {
    throw new ConfigurationOperationError('invalid-definition', 'definition');
  }
  validateIdentifier(input.resourceId, true);
  validateIdentifier(input.schemaId, true);
  validateSchemaVersion(input.schemaVersion, true);
  validateSha256(input.schemaSha256, true);
  if (
    typeof input.filePath !== 'string' ||
    !isAbsolute(input.filePath) ||
    input.filePath.includes('\u0000') ||
    (input.format !== JAVA_PROPERTIES_V1 &&
      input.format !== OPENLOADER_ADVANCED_OPTIONS_V1) ||
    (input.format === JAVA_PROPERTIES_V1 &&
      !input.filePath.toLowerCase().endsWith('.properties')) ||
    (input.format === OPENLOADER_ADVANCED_OPTIONS_V1 &&
      !input.filePath.toLowerCase().endsWith('.json')) ||
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < 1 ||
    input.maximumBytes > MAXIMUM_CONFIGURATION_BYTES ||
    !isRecord(input.fields)
  ) {
    throw new ConfigurationOperationError('invalid-definition', 'definition');
  }
  const entries = Object.entries(input.fields);
  if (entries.length === 0 || entries.length > MAXIMUM_FIELDS) {
    throw new ConfigurationOperationError('invalid-definition', 'definition');
  }
  const caseFolded = new Set<string>();
  const fields: Record<string, BasicConfigurationField> = {};
  for (const [name, field] of entries.sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    validateFieldName(name, true);
    const folded = name.toLocaleLowerCase('en-US');
    if (caseFolded.has(folded) || !isRecord(field) || typeof field.type !== 'string') {
      throw new ConfigurationOperationError('invalid-definition', 'definition');
    }
    caseFolded.add(folded);
    fields[name] = freezeField(field as unknown as BasicConfigurationField);
  }
  if (input.format === OPENLOADER_ADVANCED_OPTIONS_V1) {
    let reviewed;
    try {
      reviewed = VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY.require(input.resourceId);
    } catch {
      throw new ConfigurationOperationError('invalid-definition', 'definition');
    }
    const suffix = reviewed.schema.filePath.split('/').join(sep);
    const comparablePath = resolve(input.filePath).toLocaleLowerCase('en-US');
    const comparableSuffix = `${sep}${suffix}`.toLocaleLowerCase('en-US');
    const reviewedFields = Object.keys(reviewed.schema.fields).sort();
    const actualFields = Object.keys(fields).sort();
    if (
      reviewed.codecId !== OPENLOADER_ADVANCED_OPTIONS_V1 ||
      input.schemaId !== reviewed.schema.schemaId ||
      input.schemaVersion !== reviewed.schema.schemaVersion ||
      input.schemaSha256 !== reviewed.schemaSha256 ||
      input.maximumBytes !== reviewed.maximumBytes ||
      !comparablePath.endsWith(comparableSuffix) ||
      actualFields.length !== reviewedFields.length ||
      actualFields.some((name, index) => name !== reviewedFields[index]) ||
      actualFields.some((name) => {
        const field = fields[name];
        const reviewedField = reviewed.schema.fields[name];
        return (
          field?.type !== 'boolean' ||
          reviewedField?.type !== 'boolean' ||
          field.restartRequired !== reviewedField.restartRequired
        );
      })
    ) {
      throw new ConfigurationOperationError('invalid-definition', 'definition');
    }
  }
  return Object.freeze({
    resourceId: input.resourceId,
    schemaId: input.schemaId,
    schemaVersion: input.schemaVersion,
    schemaSha256: input.schemaSha256,
    filePath: resolve(input.filePath),
    format: input.format,
    maximumBytes: input.maximumBytes,
    fields: Object.freeze(fields),
  });
}

function validateChanges(value: unknown): Readonly<Record<string, ConfigurationValue>> {
  if (!isRecord(value)) {
    throw new ConfigurationOperationError('invalid-plan', 'plan');
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAXIMUM_FIELDS) {
    throw new ConfigurationOperationError('invalid-plan', 'plan');
  }
  const changes: Record<string, ConfigurationValue> = {};
  for (const [key, item] of entries) {
    validateFieldName(key);
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new ConfigurationOperationError('invalid-plan', 'plan');
    }
    changes[key] = item;
  }
  return Object.freeze(changes);
}

export function validateApplyPlan(input: ApplyConfigurationPlan): ApplyConfigurationPlan {
  if (!isRecord(input)) throw new ConfigurationOperationError('invalid-plan', 'plan');
  exactKeys(input, [
    'resourceId',
    'revisionId',
    'expectedCurrentSha256',
    'reasonCode',
    'changes',
  ]);
  validateIdentifier(input.resourceId);
  validateIdentifier(input.revisionId);
  validateIdentifier(input.reasonCode);
  validateSha256(input.expectedCurrentSha256);
  return Object.freeze({
    resourceId: input.resourceId,
    revisionId: input.revisionId,
    expectedCurrentSha256: input.expectedCurrentSha256,
    reasonCode: input.reasonCode,
    changes: validateChanges(input.changes),
  });
}

export function validateRollbackPlan(input: RollbackConfigurationPlan): RollbackConfigurationPlan {
  if (!isRecord(input)) throw new ConfigurationOperationError('invalid-plan', 'plan');
  exactKeys(input, [
    'resourceId',
    'revisionId',
    'sourceRevisionId',
    'expectedCurrentSha256',
    'reasonCode',
  ]);
  validateIdentifier(input.resourceId);
  validateIdentifier(input.revisionId);
  validateIdentifier(input.sourceRevisionId);
  validateIdentifier(input.reasonCode);
  validateSha256(input.expectedCurrentSha256);
  if (input.revisionId === input.sourceRevisionId) {
    throw new ConfigurationOperationError('invalid-plan', 'plan');
  }
  return Object.freeze({ ...input });
}
