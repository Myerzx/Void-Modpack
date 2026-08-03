import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConfigurationSchemaOperationError,
  ConfigurationSchemaRegistry,
  hashConfigurationSchema,
  validateConfigurationValues,
  type GenericConfigurationSchema,
} from '../src/index.js';

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
