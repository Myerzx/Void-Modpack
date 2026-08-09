import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConfigurationInferenceError,
  inferForm,
  validateProposedValue,
  type InferredField,
} from '../src/index.js';

/**
 * Inference against configuration text shaped the way Forge writes it.
 *
 * The property under test throughout: structure is inferred, meaning is not,
 * and a bound only exists when the file declared one.
 */

/** The shape `ForgeConfigSpec` actually emits, comments and all. */
const FORGE_TOML = `#Common configuration
[general]
	#Whether the feature is enabled at all.
	#Default: true
	enabled = true

	#Scales incoming damage.
	#Range: 0.0 ~ 4.0
	damageScale = 1.5

	#How many entities may spawn.
	#Range: > 0
	spawnCap = 64

	#Which preset to use.
	#Allowed Values: EASY, NORMAL, HARD
	preset = "NORMAL"

[general.advanced]
	#Dimensions the feature applies to.
	blockedDimensions = ["minecraft:the_nether", "minecraft:the_end"]
`;

function fieldAt(form: ReturnType<typeof inferForm>, path: string): InferredField {
  const field = form.fields.find((entry) => entry.path === path);
  assert.notEqual(field, undefined, `expected a field at ${path}`);
  return field as InferredField;
}

describe('reading a Forge configuration', () => {
  it('infers type and value, and nests by table', () => {
    const form = inferForm({ format: 'toml', content: FORGE_TOML });
    assert.equal(form.complete, true);

    assert.equal(fieldAt(form, 'general.enabled').type, 'boolean');
    assert.equal(fieldAt(form, 'general.enabled').value, true);
    assert.equal(fieldAt(form, 'general.damageScale').type, 'number');
    assert.equal(fieldAt(form, 'general.damageScale').value, 1.5);
    // An integer is distinguished from a number: a form that offered 0.5 for a
    // spawn cap would be offering a value the mod cannot take.
    assert.equal(fieldAt(form, 'general.spawnCap').type, 'integer');
    assert.deepEqual(fieldAt(form, 'general.advanced.blockedDimensions').value, [
      'minecraft:the_nether',
      'minecraft:the_end',
    ]);
  });

  it('reads Forge table labels expressed as quoted TOML key segments', () => {
    const form = inferForm({
      format: 'toml',
      content: '[general."Default Feature Configs"]\n"Starter Items" = true\n',
    });
    assert.equal(form.complete, true);
    const field = fieldAt(form, 'general.Default Feature Configs.Starter Items');
    assert.deepEqual(field.segments, ['general', 'Default Feature Configs', 'Starter Items']);
    assert.equal(field.value, true);
  });

  it('reads the bounds the mod declared, and attributes them', () => {
    const form = inferForm({ format: 'toml', content: FORGE_TOML });

    // Not inference. ForgeConfigSpec wrote these into the file, so reading them
    // is reading a declaration.
    assert.deepEqual(fieldAt(form, 'general.damageScale').constraints, [
      { kind: 'range', minimum: 0, maximum: 4, source: 'declared' },
    ]);
    assert.deepEqual(fieldAt(form, 'general.spawnCap').constraints, [
      { kind: 'range', minimum: 0, maximum: null, source: 'declared' },
    ]);
    assert.deepEqual(fieldAt(form, 'general.preset').constraints, [
      { kind: 'allowed-values', values: ['EASY', 'NORMAL', 'HARD'], source: 'declared' },
    ]);
    // A field the mod said nothing about carries nothing. Inventing a range
    // here would be the editor's opinion wearing the mod's clothes.
    assert.deepEqual(fieldAt(form, 'general.enabled').constraints, []);
  });

  it('keeps the author documentation verbatim', () => {
    const form = inferForm({ format: 'toml', content: FORGE_TOML });
    // Kept as written. It is the only description of the field that exists, and
    // rewording it would be this package inventing meaning through the back
    // door.
    assert.deepEqual(fieldAt(form, 'general.enabled').documentation, [
      'Whether the feature is enabled at all.',
      'Default: true',
    ]);
  });

  it('does not let a comment block drift onto the next field', () => {
    const form = inferForm({
      format: 'toml',
      content: '#Range: 0 ~ 10\nfirst = 5\n\nsecond = 500\n',
    });
    assert.deepEqual(fieldAt(form, 'first').constraints.length, 1);
    // A blank line ended the block. `second` was never described by it, and
    // carrying the range down would bound a field nobody bounded.
    assert.deepEqual(fieldAt(form, 'second').constraints, []);
  });

  it('records what it will not represent instead of approximating it', () => {
    const form = inferForm({
      format: 'toml',
      content: 'good = 1\nmixed = [1, "two"]\ninline = { a = 1 }\n[[array_of_tables]]\n',
    });
    // The file is still readable, and the form says it is partial. Silently
    // dropping these would let a save lose the part nobody rendered.
    assert.equal(form.complete, false);
    assert.deepEqual(
      form.issues.map((issue) => issue.code).sort(),
      ['unsupported-construct', 'unsupported-value', 'unsupported-value'],
    );
    assert.deepEqual(
      form.fields.map((field) => field.path),
      ['good'],
    );
  });

  it('refuses a misread bound rather than guessing at one', () => {
    const form = inferForm({
      format: 'toml',
      content: '#Range: sometimes ~ often\nvalue = 3\n',
    });
    // A misread bound is worse than no bound: it rejects values the mod accepts
    // or accepts values it does not, and both look like the editor working.
    assert.deepEqual(fieldAt(form, 'value').constraints, []);
    // The line is still shown to the reader.
    assert.deepEqual(fieldAt(form, 'value').documentation, ['Range: sometimes ~ often']);
  });

  it('reads JSON as structure only', () => {
    const form = inferForm({
      format: 'json',
      content: '{"resourcePacks":{"enabled":true,"additionalFolders":[]},"weight":3}',
    });
    assert.equal(fieldAt(form, 'resourcePacks.enabled').type, 'boolean');
    assert.equal(fieldAt(form, 'weight').type, 'integer');
    // JSON carries no comments, so there is nothing declared to read, and the
    // form says so by having no constraints at all.
    assert.ok(form.fields.every((field) => field.constraints.length === 0));
  });

  it('refuses a document that is not the text file it claimed to be', () => {
    assert.throws(
      () => inferForm({ format: 'json', content: `a${String.fromCharCode(0)}b` }),
      (error: unknown) =>
        error instanceof ConfigurationInferenceError && error.code === 'not-utf8',
    );
    assert.throws(
      () => inferForm({ format: 'json', content: '{ not json' }),
      (error: unknown) =>
        error instanceof ConfigurationInferenceError && error.code === 'malformed-document',
    );
  });
});

describe('validating a proposed value', () => {
  const form = inferForm({ format: 'toml', content: FORGE_TOML });

  it('checks a declared range and says that it did', () => {
    const field = fieldAt(form, 'general.damageScale');
    assert.deepEqual(validateProposedValue(field, 2), {
      accepted: true,
      checkedAgainstDeclaredBounds: true,
    });
    assert.deepEqual(validateProposedValue(field, 9), {
      accepted: false,
      code: 'out-of-declared-range',
    });
  });

  it('accepts on type alone when nothing was declared, and says so', () => {
    const field = fieldAt(form, 'general.enabled');
    // The distinction the operator needs: well-typed is not validated. Claiming
    // otherwise would hide that nobody knows what this field accepts.
    assert.deepEqual(validateProposedValue(field, false), {
      accepted: true,
      checkedAgainstDeclaredBounds: false,
    });
    assert.deepEqual(validateProposedValue(field, 'false'), {
      accepted: false,
      code: 'wrong-type',
    });
  });

  it('holds an integer field to integers', () => {
    const field = fieldAt(form, 'general.spawnCap');
    assert.deepEqual(validateProposedValue(field, 0.5), {
      accepted: false,
      code: 'not-an-integer',
    });
    assert.deepEqual(validateProposedValue(field, -1), {
      accepted: false,
      code: 'out-of-declared-range',
    });
  });

  it('holds a value to the list the mod allowed', () => {
    const field = fieldAt(form, 'general.preset');
    assert.equal(validateProposedValue(field, 'HARD').accepted, true);
    assert.deepEqual(validateProposedValue(field, 'IMPOSSIBLE'), {
      accepted: false,
      code: 'not-an-allowed-value',
    });
  });

  it('refuses a list that changed type halfway', () => {
    const field = fieldAt(form, 'general.advanced.blockedDimensions');
    assert.equal(validateProposedValue(field, ['minecraft:overworld']).accepted, true);
    assert.deepEqual(validateProposedValue(field, ['minecraft:overworld', 7]), {
      accepted: false,
      code: 'mixed-list',
    });
  });
});

describe('a value with a comment after it on the same line', () => {
  it('reads the value and keeps the comment out of it', () => {
    const form = inferForm({
      format: 'toml',
      content: 'preset = "NORMAL" # chosen by the pack author\ncount = 3 # why\n',
    });
    // Handing the whole remainder to the value parser made these lines
    // unreadable, and the fields vanished from the form — which is worse than a
    // visible refusal, because the file looks like it has fewer settings.
    assert.equal(form.complete, true);
    assert.equal(fieldAt(form, 'preset').value, 'NORMAL');
    assert.equal(fieldAt(form, 'count').value, 3);
  });

  it('does not mistake a hash inside a string for a comment', () => {
    const form = inferForm({ format: 'toml', content: 'colour = "#ff8800"\n' });
    assert.equal(fieldAt(form, 'colour').value, '#ff8800');
  });
});
