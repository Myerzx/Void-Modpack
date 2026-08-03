import { createHash } from 'node:crypto';

import {
  JAVA_PROPERTIES_V1,
  VOIDFALL_CONFIGURATION_REVISION_FORMAT,
  VOIDFALL_CONFIGURATION_REVISION_SCHEMA_VERSION,
  type ConfigurationOperation,
  ConfigurationOperationError,
} from './types.js';
import {
  isRecord,
  parseCanonicalTimestamp,
  validateFieldName,
  validateIdentifier,
  validateSha256,
} from './validation.js';

export interface ConfigurationRevisionManifest {
  readonly format: typeof VOIDFALL_CONFIGURATION_REVISION_FORMAT;
  readonly manifestSchemaVersion: typeof VOIDFALL_CONFIGURATION_REVISION_SCHEMA_VERSION;
  readonly revisionId: string;
  readonly resourceId: string;
  readonly resourceSchemaVersion: string;
  readonly configurationFormat: typeof JAVA_PROPERTIES_V1;
  readonly createdAt: string;
  readonly reasonCode: string;
  readonly operation: ConfigurationOperation;
  readonly restoredFromRevisionId: string | null;
  readonly previousSizeBytes: number;
  readonly previousSha256: string;
  readonly intendedSha256: string;
  readonly changedFields: readonly string[];
  readonly restartRequired: boolean;
}

function invalidManifest(): never {
  throw new ConfigurationOperationError('revision-integrity-mismatch', 'verify');
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalidManifest();
  }
}

function validateManifestObject(value: unknown): ConfigurationRevisionManifest {
  if (!isRecord(value)) invalidManifest();
  exactKeys(value, [
    'format',
    'manifestSchemaVersion',
    'revisionId',
    'resourceId',
    'resourceSchemaVersion',
    'configurationFormat',
    'createdAt',
    'reasonCode',
    'operation',
    'restoredFromRevisionId',
    'previousSizeBytes',
    'previousSha256',
    'intendedSha256',
    'changedFields',
    'restartRequired',
  ]);
  if (
    value.format !== VOIDFALL_CONFIGURATION_REVISION_FORMAT ||
    value.manifestSchemaVersion !== VOIDFALL_CONFIGURATION_REVISION_SCHEMA_VERSION ||
    value.configurationFormat !== JAVA_PROPERTIES_V1 ||
    (value.operation !== 'update' && value.operation !== 'rollback') ||
    !Number.isSafeInteger(value.previousSizeBytes) ||
    (value.previousSizeBytes as number) < 0 ||
    typeof value.createdAt !== 'string' ||
    typeof value.restartRequired !== 'boolean' ||
    !Array.isArray(value.changedFields) ||
    value.changedFields.length === 0 ||
    value.changedFields.length > 256
  ) {
    invalidManifest();
  }
  try {
    validateIdentifier(value.revisionId);
    validateIdentifier(value.resourceId);
    validateIdentifier(value.resourceSchemaVersion);
    validateIdentifier(value.reasonCode);
    validateSha256(value.previousSha256);
    validateSha256(value.intendedSha256);
    parseCanonicalTimestamp(value.createdAt);
  } catch {
    invalidManifest();
  }
  if (
    value.operation === 'rollback' &&
    (typeof value.restoredFromRevisionId !== 'string' || value.restoredFromRevisionId.length === 0)
  ) {
    invalidManifest();
  }
  if (value.operation === 'update' && value.restoredFromRevisionId !== null) invalidManifest();
  if (value.restoredFromRevisionId !== null) {
    try {
      validateIdentifier(value.restoredFromRevisionId);
    } catch {
      invalidManifest();
    }
  }
  const changedFields = value.changedFields.map((item) => {
    try {
      validateFieldName(item);
      return item;
    } catch {
      return invalidManifest();
    }
  });
  const sorted = [...changedFields].sort();
  if (
    new Set(changedFields).size !== changedFields.length ||
    changedFields.some((field, index) => field !== sorted[index])
  ) {
    invalidManifest();
  }
  return Object.freeze({
    format: VOIDFALL_CONFIGURATION_REVISION_FORMAT,
    manifestSchemaVersion: VOIDFALL_CONFIGURATION_REVISION_SCHEMA_VERSION,
    revisionId: value.revisionId,
    resourceId: value.resourceId,
    resourceSchemaVersion: value.resourceSchemaVersion,
    configurationFormat: JAVA_PROPERTIES_V1,
    createdAt: value.createdAt,
    reasonCode: value.reasonCode,
    operation: value.operation,
    restoredFromRevisionId: value.restoredFromRevisionId,
    previousSizeBytes: value.previousSizeBytes as number,
    previousSha256: value.previousSha256,
    intendedSha256: value.intendedSha256,
    changedFields: Object.freeze(changedFields),
    restartRequired: value.restartRequired,
  });
}

function canonicalObject(manifest: ConfigurationRevisionManifest): Record<string, unknown> {
  return {
    format: manifest.format,
    manifestSchemaVersion: manifest.manifestSchemaVersion,
    revisionId: manifest.revisionId,
    resourceId: manifest.resourceId,
    resourceSchemaVersion: manifest.resourceSchemaVersion,
    configurationFormat: manifest.configurationFormat,
    createdAt: manifest.createdAt,
    reasonCode: manifest.reasonCode,
    operation: manifest.operation,
    restoredFromRevisionId: manifest.restoredFromRevisionId,
    previousSizeBytes: manifest.previousSizeBytes,
    previousSha256: manifest.previousSha256,
    intendedSha256: manifest.intendedSha256,
    changedFields: [...manifest.changedFields],
    restartRequired: manifest.restartRequired,
  };
}

export function serializeConfigurationRevisionManifest(
  manifest: ConfigurationRevisionManifest,
): string {
  const validated = validateManifestObject(canonicalObject(manifest));
  return `${JSON.stringify(canonicalObject(validated))}\n`;
}

export function parseConfigurationRevisionManifest(
  serialized: string,
): ConfigurationRevisionManifest {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return invalidManifest();
  }
  const manifest = validateManifestObject(value);
  if (`${JSON.stringify(canonicalObject(manifest))}\n` !== serialized) invalidManifest();
  return manifest;
}

export function configurationRevisionManifestSha256(
  manifest: ConfigurationRevisionManifest,
): string {
  return createHash('sha256')
    .update(serializeConfigurationRevisionManifest(manifest), 'utf8')
    .digest('hex');
}
