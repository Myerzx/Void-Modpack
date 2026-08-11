import {
  VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY,
  type GenericConfigurationField,
} from '@voidfall/configuration-schemas';
import type {
  ConfigurationFieldDescriptor,
  ConfigurationFieldValue,
  ConfigurationSchemaDescriptor,
  ConfigurationValueIssue,
} from '@voidfall/contracts';

import {
  ConfigurationOperationError,
  type ConfigurationValue,
} from './types.js';

/**
 * Presentation policy for the public configuration boundary.
 *
 * Everything published here is derived from the closed trusted registry: the
 * caller can only name a reviewed resourceId. The policy is deliberately
 * deny-by-default — a field is published only when the reviewed codec declares
 * it non-secret and the observed value still matches its declared type. Every
 * other case is emitted as redacted, without a `value` property at all.
 *
 * Descriptors never carry a relative or absolute path, the schema document or
 * codec internals.
 */

/**
 * Freezes a contract value without widening it to a readonly type. The public
 * contracts are generated from TypeBox, which models arrays as mutable, so
 * immutability stays a runtime guarantee.
 */
function frozen<T>(value: T): T {
  return Object.freeze(value);
}

function fieldDescriptor(
  name: string,
  field: GenericConfigurationField,
  readable: boolean,
): ConfigurationFieldDescriptor {
  switch (field.type) {
    case 'boolean':
      return frozen({
        name,
        type: 'boolean' as const,
        restartRequired: field.restartRequired,
        readable,
      });
    case 'integer':
      return frozen({
        name,
        type: 'integer' as const,
        minimum: field.minimum,
        maximum: field.maximum,
        restartRequired: field.restartRequired,
        readable,
      });
    case 'enum':
      return frozen({
        name,
        type: 'enum' as const,
        values: frozen([...field.values]),
        restartRequired: field.restartRequired,
        readable,
      });
    case 'string':
      return frozen({
        name,
        type: 'string' as const,
        maximumLength: field.maximumLength,
        restartRequired: field.restartRequired,
        readable,
      });
    case 'number':
      // A float has no reviewed codec, so it must not reach the boundary.
      throw new ConfigurationOperationError('invalid-definition', 'definition');
  }
}

function sortedFieldNames(fields: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(fields).sort((left, right) => left.localeCompare(right, 'en'));
}

function reviewedCodec(resourceId: string) {
  if (typeof resourceId !== 'string') {
    throw new ConfigurationOperationError('invalid-definition', 'definition');
  }
  let codec;
  try {
    codec = VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY.require(resourceId);
  } catch {
    throw new ConfigurationOperationError('resource-not-found', 'plan');
  }
  return codec;
}

/** True when the reviewed policy allows publishing this field's value. */
export function isPublishableConfigurationField(resourceId: string, fieldName: string): boolean {
  const codec = reviewedCodec(resourceId);
  return Object.hasOwn(codec.schema.fields, fieldName) && !codec.secretFields.includes(fieldName);
}

/**
 * Builds the public descriptor of a reviewed resource.
 * `registered` reports whether the server instance already persisted it.
 */
export function describeReviewedConfiguration(
  resourceId: string,
  registered: boolean,
): ConfigurationSchemaDescriptor {
  const codec = reviewedCodec(resourceId);
  const fields = sortedFieldNames(codec.schema.fields).map((name) => {
    const field = codec.schema.fields[name];
    if (field === undefined) {
      throw new ConfigurationOperationError('invalid-definition', 'definition');
    }
    return fieldDescriptor(name, field, !codec.secretFields.includes(name));
  });
  if (fields.length === 0) {
    throw new ConfigurationOperationError('invalid-definition', 'definition');
  }
  return frozen({
    schemaId: codec.schema.schemaId,
    resourceId: codec.schema.resourceId,
    definitionVersion: codec.schema.schemaVersion,
    definitionSha256: codec.schemaSha256,
    codecId: codec.codecId,
    applyMode: 'offline-only' as const,
    maximumBytes: codec.maximumBytes,
    restartRequired: fields.some((field) => field.restartRequired),
    registered: registered === true,
    fields: frozen(fields),
  });
}

/** Lists every reviewed resource the closed product registry exposes. */
export function listReviewedConfigurationIds(): readonly string[] {
  return frozen(
    VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY.list().map((codec) => codec.schema.resourceId),
  );
}

export interface ConfigurationChangeSetEvaluation {
  readonly valid: boolean;
  readonly issues: readonly ConfigurationValueIssue[];
  /** True when at least one accepted field declares a restart requirement. */
  readonly restartRequired: boolean;
}

function changeIssue(
  field: GenericConfigurationField,
  value: ConfigurationValue,
): ConfigurationValueIssue['code'] | undefined {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'invalid-type';
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 'invalid-type';
      return value < field.minimum || value > field.maximum ? 'out-of-range' : undefined;
    case 'enum':
      if (typeof value !== 'string') return 'invalid-type';
      return field.values.includes(value) ? undefined : 'pattern-mismatch';
    case 'string':
      if (typeof value !== 'string') return 'invalid-type';
      return value.length > field.maximumLength ? 'too-long' : undefined;
    case 'number':
      return 'invalid-type';
  }
}

/**
 * Evaluates a partial change set against the reviewed schema without touching
 * the filesystem or producing any revision. It is the validate-without-apply
 * primitive: an unknown or duplicated field is an issue, never a silent drop.
 */
export function evaluateConfigurationChangeSet(
  resourceId: string,
  changes: readonly { readonly name: string; readonly value: ConfigurationValue }[],
): ConfigurationChangeSetEvaluation {
  const codec = reviewedCodec(resourceId);
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 64) {
    throw new ConfigurationOperationError('invalid-plan', 'plan');
  }
  const issues: ConfigurationValueIssue[] = [];
  const seen = new Set<string>();
  let restartRequired = false;

  for (const change of changes) {
    if (change === null || typeof change !== 'object' || typeof change.name !== 'string') {
      throw new ConfigurationOperationError('invalid-plan', 'plan');
    }
    if (seen.has(change.name)) {
      issues.push(frozen({ field: change.name, code: 'duplicate-field' as const }));
      continue;
    }
    seen.add(change.name);
    const field = codec.schema.fields[change.name];
    if (field === undefined) {
      issues.push(frozen({ field: change.name, code: 'unknown-field' as const }));
      continue;
    }
    const code = changeIssue(field, change.value);
    if (code !== undefined) {
      issues.push(frozen({ field: change.name, code }));
      continue;
    }
    if (field.restartRequired) restartRequired = true;
  }

  return frozen({
    valid: issues.length === 0,
    issues: frozen(issues),
    restartRequired: issues.length === 0 && restartRequired,
  });
}

function matchesDeclaredType(field: GenericConfigurationField, value: ConfigurationValue): boolean {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= field.minimum &&
        value <= field.maximum
      );
    case 'enum':
      return typeof value === 'string' && field.values.includes(value);
    case 'string':
      return typeof value === 'string' && value.length <= field.maximumLength;
    case 'number':
      return false;
  }
}

/**
 * Maps observed values onto the public contract. A field is published only when
 * the reviewed policy permits it and the observed value still matches the
 * declared type; every other case is redacted rather than guessed.
 */
export function presentConfigurationValues(
  resourceId: string,
  values: Readonly<Record<string, ConfigurationValue>>,
): readonly ConfigurationFieldValue[] {
  const codec = reviewedCodec(resourceId);
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    throw new ConfigurationOperationError('invalid-content', 'plan');
  }
  return frozen(
    sortedFieldNames(codec.schema.fields).map((name): ConfigurationFieldValue => {
      const field = codec.schema.fields[name];
      const value = values[name];
      if (
        field === undefined ||
        codec.secretFields.includes(name) ||
        value === undefined ||
        !matchesDeclaredType(field, value)
      ) {
        return frozen({ name, redacted: true as const });
      }
      return frozen({ name, redacted: false as const, value });
    }),
  );
}
