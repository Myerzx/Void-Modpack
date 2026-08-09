import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import {
  ClassFileInspectionError,
  inspectClassFile,
} from '../src/index.js';

import { forgeConfigFixtureClass } from './class-fixture.js';

describe('bounded Java class-file inspection', () => {
  it('extracts literal Forge definitions, calls and mixin targets without loading the class', () => {
    const report = inspectClassFile(forgeConfigFixtureClass());
    assert.equal(report.majorVersion, 61);
    assert.equal(report.className, 'example/config/Config');
    assert.ok(report.referencedClasses.includes('external/Target'));
    assert.deepEqual(
      report.configurationDefinitions.map((definition) => ({
        path: definition.path,
        field: definition.fieldName,
        type: definition.type,
        defaultValue: definition.defaultValue,
        minimum: definition.minimum,
        maximum: definition.maximum,
        comment: definition.comment,
      })),
      [
        {
          path: 'general.enabled',
          field: 'enabledField',
          type: 'boolean',
          defaultValue: true,
          minimum: null,
          maximum: null,
          comment: 'Enables the tested system.',
        },
        {
          path: 'general.scale',
          field: 'scaleField',
          type: 'number',
          defaultValue: 1.5,
          minimum: 0,
          maximum: 10,
          comment: null,
        },
      ],
    );
    assert.ok(report.invocations.some((call) => call.owner === 'external/Target' && call.name === 'connect'));
    assert.ok(report.invocations.some((call) => call.owner === 'external/Target' && call.name === 'register'));
    assert.deepEqual(report.annotations[0], {
      descriptor: 'Lorg/spongepowered/asm/mixin/Mixin;',
      memberName: null,
      classValues: ['external/Target'],
      stringValues: [],
    });
  });

  it('refuses malformed input and explicit capacity overruns', () => {
    assert.throws(
      () => inspectClassFile(Buffer.from('not a class')),
      (error: unknown) => error instanceof ClassFileInspectionError && error.code === 'invalid-class-file',
    );
    assert.throws(
      () => inspectClassFile(forgeConfigFixtureClass(), { maximumBytes: 32 }),
      (error: unknown) => error instanceof ClassFileInspectionError && error.code === 'class-file-limit-exceeded',
    );
    const invalidOpcode = forgeConfigFixtureClass();
    const returnOffset = invalidOpcode.lastIndexOf(0xb1);
    assert.notEqual(returnOffset, -1);
    invalidOpcode[returnOffset] = 0xff;
    assert.throws(
      () => inspectClassFile(invalidOpcode),
      (error: unknown) => error instanceof ClassFileInspectionError && error.code === 'invalid-class-file',
    );
  });
});
