import { isAbsolute, resolve } from 'node:path';

import {
  VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY,
  type GenericConfigurationField,
} from '@voidfall/configuration-schemas';

import {
  OPENLOADER_ADVANCED_OPTIONS_V1,
  ConfigurationOperationError,
  type BasicConfigurationField,
  type ConfigurationResourceDefinition,
} from './types.js';
import { freezeResourceDefinition } from './validation.js';

function basicField(field: GenericConfigurationField): BasicConfigurationField {
  switch (field.type) {
    case 'boolean':
      return Object.freeze({ type: 'boolean', restartRequired: field.restartRequired });
    case 'integer':
      return Object.freeze({
        type: 'integer',
        minimum: field.minimum,
        maximum: field.maximum,
        restartRequired: field.restartRequired,
      });
    case 'enum':
      return Object.freeze({
        type: 'enum',
        values: Object.freeze([...field.values]),
        restartRequired: field.restartRequired,
      });
    case 'string':
      return Object.freeze({
        type: 'string',
        maximumLength: field.maximumLength,
        restartRequired: field.restartRequired,
      });
    case 'number':
      throw new ConfigurationOperationError('invalid-definition', 'definition');
  }
}

/** Builds a filesystem resource from a fixed reviewed relative path. */
export function createReviewedConfigurationResource(
  configurationRoot: string,
  resourceId: string,
): ConfigurationResourceDefinition {
  if (
    typeof configurationRoot !== 'string' ||
    !isAbsolute(configurationRoot) ||
    configurationRoot.includes('\u0000')
  ) {
    throw new ConfigurationOperationError('invalid-definition', 'definition');
  }
  let reviewed;
  try {
    reviewed = VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY.require(resourceId);
  } catch {
    throw new ConfigurationOperationError('invalid-definition', 'definition');
  }
  if (reviewed.codecId !== OPENLOADER_ADVANCED_OPTIONS_V1) {
    throw new ConfigurationOperationError('invalid-definition', 'definition');
  }
  const fields: Record<string, BasicConfigurationField> = {};
  for (const [name, field] of Object.entries(reviewed.schema.fields)) {
    fields[name] = basicField(field);
  }
  return freezeResourceDefinition({
    resourceId: reviewed.schema.resourceId,
    schemaId: reviewed.schema.schemaId,
    schemaVersion: reviewed.schema.schemaVersion,
    schemaSha256: reviewed.schemaSha256,
    filePath: resolve(configurationRoot, ...reviewed.schema.filePath.split('/')),
    format: reviewed.codecId,
    maximumBytes: reviewed.maximumBytes,
    fields: Object.freeze(fields),
  });
}
