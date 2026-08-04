import {
  OpenLoaderAdvancedOptionsCodecError,
  VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY,
} from '@voidfall/configuration-schemas';

import {
  diffPropertiesDocuments,
  mutatePropertiesDocument,
  parsePropertiesDocument,
  type ParsedPropertiesDocument,
} from './properties.js';
import {
  JAVA_PROPERTIES_V1,
  OPENLOADER_ADVANCED_OPTIONS_V1,
  ConfigurationOperationError,
  type ConfigurationResourceDefinition,
  type ConfigurationValue,
} from './types.js';

interface ParsedOpenLoaderDocument {
  readonly format: typeof OPENLOADER_ADVANCED_OPTIONS_V1;
  readonly values: Readonly<Record<string, ConfigurationValue>>;
}

interface ParsedJavaPropertiesDocument {
  readonly format: typeof JAVA_PROPERTIES_V1;
  readonly document: ParsedPropertiesDocument;
  readonly values: Readonly<Record<string, ConfigurationValue>>;
}

export type ParsedConfigurationDocument =
  | ParsedOpenLoaderDocument
  | ParsedJavaPropertiesDocument;

export interface ConfigurationDocumentMutation {
  readonly content: Uint8Array;
  readonly changedFields: readonly string[];
  readonly restartRequired: boolean;
}

function codecFailure(error: unknown): never {
  if (error instanceof OpenLoaderAdvancedOptionsCodecError) {
    if (error.code === 'maximum-bytes-exceeded') {
      throw new ConfigurationOperationError('content-too-large', 'preflight');
    }
    if (error.code === 'schema-mismatch') {
      throw new ConfigurationOperationError('schema-mismatch', 'preflight');
    }
  }
  throw new ConfigurationOperationError('invalid-content', 'preflight');
}

function openLoaderCodec(resource: ConfigurationResourceDefinition) {
  try {
    const codec = VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY.require(resource.resourceId);
    if (
      codec.codecId !== OPENLOADER_ADVANCED_OPTIONS_V1 ||
      codec.schema.schemaId !== resource.schemaId ||
      codec.schema.schemaVersion !== resource.schemaVersion ||
      codec.schemaSha256 !== resource.schemaSha256
    ) {
      throw new Error('reviewed codec mismatch');
    }
    return codec;
  } catch {
    throw new ConfigurationOperationError('schema-mismatch', 'preflight');
  }
}

export function parseConfigurationDocument(
  content: Uint8Array,
  resource: ConfigurationResourceDefinition,
): ParsedConfigurationDocument {
  if (resource.format === JAVA_PROPERTIES_V1) {
    const document = parsePropertiesDocument(content, resource);
    return Object.freeze({ format: JAVA_PROPERTIES_V1, document, values: document.values });
  }
  const codec = openLoaderCodec(resource);
  let serialized: string;
  try {
    serialized = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new ConfigurationOperationError('invalid-content', 'preflight');
  }
  try {
    return Object.freeze({
      format: OPENLOADER_ADVANCED_OPTIONS_V1,
      values: codec.parse(serialized),
    });
  } catch (error) {
    return codecFailure(error);
  }
}

export function mutateConfigurationDocument(
  document: ParsedConfigurationDocument,
  resource: ConfigurationResourceDefinition,
  changes: Readonly<Record<string, ConfigurationValue>>,
): ConfigurationDocumentMutation {
  if (document.format === JAVA_PROPERTIES_V1) {
    if (resource.format !== JAVA_PROPERTIES_V1) {
      throw new ConfigurationOperationError('schema-mismatch', 'preflight');
    }
    return mutatePropertiesDocument(document.document, resource, changes);
  }
  if (resource.format !== OPENLOADER_ADVANCED_OPTIONS_V1) {
    throw new ConfigurationOperationError('schema-mismatch', 'preflight');
  }
  const changedFields = Object.keys(changes)
    .map((fieldName) => {
      if (!Object.hasOwn(resource.fields, fieldName)) {
        throw new ConfigurationOperationError('invalid-content', 'preflight');
      }
      return fieldName;
    })
    .filter((fieldName) => document.values[fieldName] !== changes[fieldName])
    .sort();
  if (changedFields.length === 0) {
    throw new ConfigurationOperationError('no-change', 'preflight');
  }
  const values = Object.freeze({ ...document.values, ...changes });
  try {
    return Object.freeze({
      content: new TextEncoder().encode(openLoaderCodec(resource).serialize(values)),
      changedFields: Object.freeze(changedFields),
      restartRequired: changedFields.some(
        (fieldName) => resource.fields[fieldName]?.restartRequired === true,
      ),
    });
  } catch (error) {
    return codecFailure(error);
  }
}

export function diffConfigurationDocuments(
  current: ParsedConfigurationDocument,
  restored: ParsedConfigurationDocument,
  resource: ConfigurationResourceDefinition,
): readonly string[] {
  if (current.format !== restored.format || current.format !== resource.format) {
    throw new ConfigurationOperationError('schema-mismatch', 'preflight');
  }
  if (current.format === JAVA_PROPERTIES_V1 && restored.format === JAVA_PROPERTIES_V1) {
    return diffPropertiesDocuments(current.document, restored.document, resource);
  }
  const changed = Object.keys(resource.fields)
    .filter((fieldName) => current.values[fieldName] !== restored.values[fieldName])
    .sort();
  if (changed.length === 0) {
    throw new ConfigurationOperationError('no-change', 'preflight');
  }
  return Object.freeze(changed);
}

export function revisionPayloadFileName(resource: ConfigurationResourceDefinition): string {
  return resource.format === JAVA_PROPERTIES_V1 ? 'previous.properties' : 'previous.json';
}
