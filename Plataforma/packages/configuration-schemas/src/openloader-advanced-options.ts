import { Buffer } from 'node:buffer';

import type { GenericConfigurationSchema } from './types.js';
import { freezeConfigurationSchema, validateConfigurationValues } from './validation.js';

export const OPENLOADER_ADVANCED_OPTIONS_SCHEMA_ID = 'openloader-advanced-options';
export const OPENLOADER_ADVANCED_OPTIONS_RESOURCE_ID = 'openloader-advanced-options';
export const OPENLOADER_ADVANCED_OPTIONS_SCHEMA_VERSION = '1.0.0';
export const OPENLOADER_ADVANCED_OPTIONS_FILE_PATH = 'config/openloader/advanced_options.json';
export const OPENLOADER_ADVANCED_OPTIONS_MAXIMUM_BYTES = 4_096;

export const OPENLOADER_ADVANCED_OPTIONS_V1: GenericConfigurationSchema =
  freezeConfigurationSchema({
    schemaId: OPENLOADER_ADVANCED_OPTIONS_SCHEMA_ID,
    resourceId: OPENLOADER_ADVANCED_OPTIONS_RESOURCE_ID,
    schemaVersion: OPENLOADER_ADVANCED_OPTIONS_SCHEMA_VERSION,
    format: 'json',
    filePath: OPENLOADER_ADVANCED_OPTIONS_FILE_PATH,
    fields: {
      'dataPacks.enabled': {
        type: 'boolean',
        required: true,
        restartRequired: true,
        defaultValue: true,
        description: 'Enable OpenLoader data packs after the next Minecraft restart.',
      },
      'resourcePacks.enabled': {
        type: 'boolean',
        required: true,
        restartRequired: true,
        defaultValue: true,
        description: 'Enable OpenLoader resource packs after the next Minecraft restart.',
      },
    },
  });

export const OPENLOADER_ADVANCED_OPTIONS_POLICY_V1 = Object.freeze({
  owner: 'voidfall-product-owner',
  parser: 'strict-openloader-json-v1',
  serializer: 'canonical-openloader-json-v1',
  maximumBytes: OPENLOADER_ADVANCED_OPTIONS_MAXIMUM_BYTES,
  secretFields: Object.freeze([]) as readonly string[],
  userSuppliedPaths: false,
  applyMode: 'offline-only',
  migration: 'strict-compatible-or-manual-review',
});

export interface OpenLoaderAdvancedOptionsValues {
  readonly 'dataPacks.enabled': boolean;
  readonly 'resourcePacks.enabled': boolean;
}

export type OpenLoaderAdvancedOptionsCodecErrorCode =
  | 'maximum-bytes-exceeded'
  | 'invalid-json'
  | 'schema-mismatch'
  | 'invalid-values';

export class OpenLoaderAdvancedOptionsCodecError extends Error {
  public readonly code: OpenLoaderAdvancedOptionsCodecErrorCode;

  public constructor(code: OpenLoaderAdvancedOptionsCodecErrorCode) {
    super(`openloader-advanced-options:${code}`);
    this.name = 'OpenLoaderAdvancedOptionsCodecError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function hasExpectedKeyOccurrences(input: string): boolean {
  const occurrences = new Map<string, number>();
  for (const match of input.matchAll(/"(?:\\.|[^"\\])*"\s*:/gu)) {
    const token = match[0].slice(0, match[0].lastIndexOf(':')).trim();
    let key: unknown;
    try {
      key = JSON.parse(token);
    } catch {
      return false;
    }
    if (typeof key !== 'string') return false;
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }
  return (
    occurrences.size === 4 &&
    occurrences.get('resourcePacks') === 1 &&
    occurrences.get('dataPacks') === 1 &&
    occurrences.get('enabled') === 2 &&
    occurrences.get('additionalFolders') === 2
  );
}

function parseGroup(input: unknown): boolean | undefined {
  if (!isRecord(input) || !hasExactKeys(input, ['enabled', 'additionalFolders'])) return undefined;
  if (typeof input.enabled !== 'boolean') return undefined;
  if (!Array.isArray(input.additionalFolders) || input.additionalFolders.length !== 0) return undefined;
  return input.enabled;
}

export function parseOpenLoaderAdvancedOptions(input: string): OpenLoaderAdvancedOptionsValues {
  if (Buffer.byteLength(input, 'utf8') > OPENLOADER_ADVANCED_OPTIONS_MAXIMUM_BYTES) {
    throw new OpenLoaderAdvancedOptionsCodecError('maximum-bytes-exceeded');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new OpenLoaderAdvancedOptionsCodecError('invalid-json');
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ['resourcePacks', 'dataPacks'])) {
    throw new OpenLoaderAdvancedOptionsCodecError('schema-mismatch');
  }
  const resourcePacksEnabled = parseGroup(parsed.resourcePacks);
  const dataPacksEnabled = parseGroup(parsed.dataPacks);
  if (
    resourcePacksEnabled === undefined ||
    dataPacksEnabled === undefined ||
    !hasExpectedKeyOccurrences(input)
  ) {
    throw new OpenLoaderAdvancedOptionsCodecError('schema-mismatch');
  }
  return Object.freeze({
    'dataPacks.enabled': dataPacksEnabled,
    'resourcePacks.enabled': resourcePacksEnabled,
  });
}

export function serializeOpenLoaderAdvancedOptions(input: unknown): string {
  const validated = validateConfigurationValues(OPENLOADER_ADVANCED_OPTIONS_V1, input);
  if (!validated.success) {
    throw new OpenLoaderAdvancedOptionsCodecError('invalid-values');
  }
  const dataPacksEnabled = validated.values['dataPacks.enabled'];
  const resourcePacksEnabled = validated.values['resourcePacks.enabled'];
  if (typeof dataPacksEnabled !== 'boolean' || typeof resourcePacksEnabled !== 'boolean') {
    throw new OpenLoaderAdvancedOptionsCodecError('invalid-values');
  }
  const document = {
    resourcePacks: {
      enabled: resourcePacksEnabled,
      additionalFolders: [] as readonly string[],
    },
    dataPacks: {
      enabled: dataPacksEnabled,
      additionalFolders: [] as readonly string[],
    },
  };
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > OPENLOADER_ADVANCED_OPTIONS_MAXIMUM_BYTES) {
    throw new OpenLoaderAdvancedOptionsCodecError('maximum-bytes-exceeded');
  }
  return serialized;
}
