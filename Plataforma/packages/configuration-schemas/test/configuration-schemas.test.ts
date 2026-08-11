import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  ConfigurationSchemaOperationError,
  ConfigurationSchemaRegistry,
  MINECRAFT_SERVER_PROPERTIES_FILE_PATH,
  MINECRAFT_SERVER_PROPERTIES_POLICY_V1,
  MINECRAFT_SERVER_PROPERTIES_V1,
  OPENLOADER_ADVANCED_OPTIONS_FILE_PATH,
  OPENLOADER_ADVANCED_OPTIONS_MAXIMUM_BYTES,
  OPENLOADER_ADVANCED_OPTIONS_POLICY_V1,
  OPENLOADER_ADVANCED_OPTIONS_V1,
  OpenLoaderAdvancedOptionsCodecError,
  TrustedConfigurationRegistryError,
  VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY,
  hashConfigurationSchema,
  parseOpenLoaderAdvancedOptions,
  serializeOpenLoaderAdvancedOptions,
  validateConfigurationValues,
  type GenericConfigurationSchema,
} from '../src/index.js';

const openLoaderFixture = (name: string): Promise<string> =>
  readFile(new URL(`../fixtures/openloader-advanced-options-v1/${name}`, import.meta.url), 'utf8');

const actorId = '018f6b8c-76a3-7d10-9f2e-1d9e52a63702';

function schema(overrides: Partial<GenericConfigurationSchema> = {}): GenericConfigurationSchema {
  return {
    schemaId: 'minecraft-server',
    resourceId: 'server-properties',
    schemaVersion: '1.0.0',
    format: 'java-properties',
    filePath: 'config/server.properties',
    fields: {
      enabled: {
        type: 'boolean',
        required: false,
        restartRequired: false,
        defaultValue: true,
      },
      hostname: {
        type: 'string',
        required: true,
        restartRequired: true,
        maximumLength: 253,
        pattern: 'hostname',
      },
      maxPlayers: {
        type: 'integer',
        required: true,
        restartRequired: true,
        minimum: 1,
        maximum: 100,
      },
      difficulty: {
        type: 'enum',
        required: false,
        restartRequired: false,
        values: ['peaceful', 'easy', 'normal', 'hard'],
        defaultValue: 'normal',
      },
    },
    ...overrides,
  };
}

function registry(maximumSchemas = 10, maximumRevisionsPerSchema = 10): ConfigurationSchemaRegistry {
  return new ConfigurationSchemaRegistry({ maximumSchemas, maximumRevisionsPerSchema });
}

function firstPlan(definition = schema()) {
  return {
    revisionId: 'schema-revision-1',
    actorId,
    reasonCode: 'initial-schema',
    createdAt: '2026-08-03T17:00:00.000Z',
    expectedSchemaSha256: null,
    schema: definition,
  } as const;
}

describe('ConfigurationSchemaRegistry', () => {
  it('registers and returns an immutable initial generic schema', () => {
    const store = registry();
    const receipt = store.register(firstPlan());
    assert.equal(receipt.revision.schemaVersion, '1.0.0');
    assert.equal(receipt.revision.previousSchemaSha256, null);
    assert.equal(receipt.revision.currentSchemaSha256, hashConfigurationSchema(receipt.schema));
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(Object.isFrozen(receipt.schema.fields), true);
    assert.equal(store.current('minecraft-server'), receipt);
  });

  it('appends a revision only when the expected schema hash matches', () => {
    const store = registry();
    const first = store.register(firstPlan());
    const secondSchema = schema({ schemaVersion: '1.1.0' });
    const second = store.register({
      ...firstPlan(secondSchema),
      revisionId: 'schema-revision-2',
      reasonCode: 'document-version',
      createdAt: '2026-08-03T17:01:00.000Z',
      expectedSchemaSha256: first.revision.currentSchemaSha256,
    });
    assert.equal(second.revision.previousSchemaSha256, first.revision.currentSchemaSha256);
    assert.equal(store.history('minecraft-server').length, 2);
    assert.equal(store.current('minecraft-server'), second);
  });

  it('rejects stale hashes, duplicate revisions and no-op schemas', () => {
    const store = registry();
    const first = store.register(firstPlan());
    assert.throws(
      () =>
        store.register({
          ...firstPlan(schema({ schemaVersion: '1.1.0' })),
          revisionId: 'schema-revision-2',
          expectedSchemaSha256: 'a'.repeat(64),
        }),
      (error) =>
        error instanceof ConfigurationSchemaOperationError &&
        error.code === 'concurrent-modification',
    );
    assert.throws(
      () => store.register(firstPlan(schema({ schemaVersion: '1.1.0' }))),
      (error) =>
        error instanceof ConfigurationSchemaOperationError && error.code === 'revision-conflict',
    );
    assert.throws(
      () =>
        store.register({
          ...firstPlan(),
          revisionId: 'schema-revision-3',
          expectedSchemaSha256: first.revision.currentSchemaSha256,
        }),
      (error) => error instanceof ConfigurationSchemaOperationError && error.code === 'no-change',
    );
  });

  it('enforces schema and history bounds', () => {
    const store = registry(1, 1);
    const first = store.register(firstPlan());
    assert.throws(
      () =>
        store.register({
          ...firstPlan(schema({ schemaId: 'other-schema', resourceId: 'other-resource' })),
          revisionId: 'other-revision',
        }),
      (error) =>
        error instanceof ConfigurationSchemaOperationError && error.code === 'schema-limit-exceeded',
    );
    assert.throws(
      () =>
        store.register({
          ...firstPlan(schema({ schemaVersion: '1.1.0' })),
          revisionId: 'schema-revision-2',
          expectedSchemaSha256: first.revision.currentSchemaSha256,
        }),
      (error) =>
        error instanceof ConfigurationSchemaOperationError && error.code === 'history-limit-exceeded',
    );
  });
});

describe('generic schema validation', () => {
  it('applies safe defaults and reports changed fields that require restart', () => {
    const result = validateConfigurationValues(schema(), {
      hostname: 'play.voidfall.example',
      maxPlayers: 24,
    });
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.deepEqual(result.values, {
      difficulty: 'normal',
      enabled: true,
      hostname: 'play.voidfall.example',
      maxPlayers: 24,
    });
    assert.deepEqual(result.restartRequiredFields, ['hostname', 'maxPlayers']);
  });

  it('reports unknown, missing, type, range and closed-pattern violations deterministically', () => {
    const result = validateConfigurationValues(schema(), {
      hostname: '-invalid-host',
      maxPlayers: 101,
      enabled: null,
      extra: true,
    });
    assert.equal(result.success, false);
    if (result.success) return;
    assert.deepEqual(result.issues, [
      { field: 'enabled', code: 'invalid-type' },
      { field: 'extra', code: 'unknown-field' },
      { field: 'hostname', code: 'pattern-mismatch' },
      { field: 'maxPlayers', code: 'out-of-range' },
    ]);
  });

  it('rejects invalid formats, traversal, extra keys and invalid defaults', () => {
    for (const invalid of [
      schema({ format: 'json', filePath: 'config/server.properties' }),
      schema({ filePath: '../server.properties' }),
      schema({
        fields: {
          amount: {
            type: 'integer',
            required: true,
            restartRequired: false,
            minimum: 1,
            maximum: 10,
            defaultValue: 11,
          },
        },
      }),
      { ...schema(), executableValidator: 'eval(value)' } as never,
    ]) {
      assert.throws(
        () => hashConfigurationSchema(invalid),
        (error) =>
          error instanceof ConfigurationSchemaOperationError && error.code === 'invalid-schema',
      );
    }
  });

  it('hashes equivalent field insertion orders identically', () => {
    const first = schema({
      fields: {
        beta: { type: 'boolean', required: true, restartRequired: false },
        alpha: { type: 'number', required: true, restartRequired: false, minimum: 0, maximum: 1 },
      },
    });
    const second = schema({
      fields: {
        alpha: { type: 'number', required: true, restartRequired: false, minimum: 0, maximum: 1 },
        beta: { type: 'boolean', required: true, restartRequired: false },
      },
    });
    assert.equal(hashConfigurationSchema(first), hashConfigurationSchema(second));
  });
});

describe('OpenLoader advanced options v1', () => {
  it('freezes the selected schema and its deny-by-default path policy', () => {
    assert.equal(OPENLOADER_ADVANCED_OPTIONS_V1.schemaId, 'openloader-advanced-options');
    assert.equal(OPENLOADER_ADVANCED_OPTIONS_V1.schemaVersion, '1.0.0');
    assert.equal(OPENLOADER_ADVANCED_OPTIONS_V1.filePath, OPENLOADER_ADVANCED_OPTIONS_FILE_PATH);
    assert.deepEqual(Object.keys(OPENLOADER_ADVANCED_OPTIONS_V1.fields), [
      'dataPacks.enabled',
      'resourcePacks.enabled',
    ]);
    assert.equal(OPENLOADER_ADVANCED_OPTIONS_POLICY_V1.maximumBytes, 4_096);
    assert.equal(OPENLOADER_ADVANCED_OPTIONS_POLICY_V1.userSuppliedPaths, false);
    assert.deepEqual(OPENLOADER_ADVANCED_OPTIONS_POLICY_V1.secretFields, []);
    assert.equal(
      hashConfigurationSchema(OPENLOADER_ADVANCED_OPTIONS_V1),
      '25c2d9d41af6fb0ead2ecc25dd5b9eda130ab60353b37b1b707b6da7b9291ce0',
    );
  });

  it('parses and canonically serializes the sanitized default fixture', async () => {
    const fixture = await openLoaderFixture('default.json');
    const values = parseOpenLoaderAdvancedOptions(fixture);
    assert.deepEqual(values, {
      'dataPacks.enabled': true,
      'resourcePacks.enabled': true,
    });
    assert.equal(serializeOpenLoaderAdvancedOptions(values), fixture);
  });

  it('round-trips the reviewed disabled state without exposing pack paths', async () => {
    const fixture = await openLoaderFixture('data-packs-disabled.json');
    const values = parseOpenLoaderAdvancedOptions(fixture);
    assert.equal(values['dataPacks.enabled'], false);
    assert.equal(serializeOpenLoaderAdvancedOptions(values), fixture);
  });

  it('rejects additional folders, unknown fields and duplicate JSON keys', async () => {
    const userPath = await openLoaderFixture('rejected-user-path.json');
    for (const invalid of [
      userPath,
      '{"resourcePacks":{"enabled":true,"additionalFolders":[]},"dataPacks":{"enabled":true,"additionalFolders":[],"extra":true}}',
      '{"resourcePacks":{"enabled":true,"enabled":false,"additionalFolders":[]},"dataPacks":{"enabled":true,"additionalFolders":[]}}',
    ]) {
      assert.throws(
        () => parseOpenLoaderAdvancedOptions(invalid),
        (error) =>
          error instanceof OpenLoaderAdvancedOptionsCodecError && error.code === 'schema-mismatch',
      );
    }
  });

  it('enforces input size and typed serializer values', () => {
    assert.throws(
      () => parseOpenLoaderAdvancedOptions(' '.repeat(OPENLOADER_ADVANCED_OPTIONS_MAXIMUM_BYTES + 1)),
      (error) =>
        error instanceof OpenLoaderAdvancedOptionsCodecError &&
        error.code === 'maximum-bytes-exceeded',
    );
    assert.throws(
      () =>
        serializeOpenLoaderAdvancedOptions({
          'dataPacks.enabled': true,
          'resourcePacks.enabled': 'yes',
        }),
      (error) =>
        error instanceof OpenLoaderAdvancedOptionsCodecError && error.code === 'invalid-values',
    );
  });

  it('exposes the codec only through the closed reviewed registry', async () => {
    const entries = VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY.list();
    assert.equal(entries.length, 2);
    const entry = VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY.require(
      'openloader-advanced-options',
    );
    assert.equal(entry.codecId, 'openloader-advanced-options-v1');
    assert.equal(
      entry.schemaSha256,
      '25c2d9d41af6fb0ead2ecc25dd5b9eda130ab60353b37b1b707b6da7b9291ce0',
    );
    assert.deepEqual(entry.parse?.(await openLoaderFixture('default.json')), {
      'dataPacks.enabled': true,
      'resourcePacks.enabled': true,
    });
    assert.throws(
      () => VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY.require('unreviewed-mod'),
      (error) =>
        error instanceof TrustedConfigurationRegistryError &&
        error.code === 'resource-not-reviewed',
    );
  });
});

describe('Minecraft server properties security v1', () => {
  it('freezes the reviewed security subset and preserving path policy', () => {
    assert.equal(MINECRAFT_SERVER_PROPERTIES_V1.schemaId, 'minecraft-server-properties');
    assert.equal(MINECRAFT_SERVER_PROPERTIES_V1.schemaVersion, '1.0.0');
    assert.equal(
      MINECRAFT_SERVER_PROPERTIES_V1.filePath,
      MINECRAFT_SERVER_PROPERTIES_FILE_PATH,
    );
    assert.deepEqual(Object.keys(MINECRAFT_SERVER_PROPERTIES_V1.fields), [
      'broadcast-rcon-to-ops',
      'enable-rcon',
      'enforce-secure-profile',
      'enforce-whitelist',
      'online-mode',
      'white-list',
    ]);
    assert.equal(MINECRAFT_SERVER_PROPERTIES_POLICY_V1.maximumBytes, 65_536);
    assert.equal(MINECRAFT_SERVER_PROPERTIES_POLICY_V1.userSuppliedPaths, false);
    assert.equal(
      MINECRAFT_SERVER_PROPERTIES_POLICY_V1.preserveUnreviewedProperties,
      true,
    );
    assert.deepEqual(MINECRAFT_SERVER_PROPERTIES_POLICY_V1.secretFields, []);
    assert.equal(
      hashConfigurationSchema(MINECRAFT_SERVER_PROPERTIES_V1),
      '9caee4090f1da989ea9d20910cbe39765efb2d9d0b6e4ead62ba42b7baf19588',
    );
  });

  it('publishes only metadata through the closed registry', () => {
    const entry = VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY.require(
      'minecraft-server-properties',
    );
    assert.equal(entry.codecId, 'minecraft-server-properties-v1');
    assert.equal(entry.preserveUnreviewedProperties, true);
    assert.equal(entry.parse, undefined);
    assert.equal(entry.serialize, undefined);
  });
});
