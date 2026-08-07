import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { inferForm } from '@voidfall/configuration-inference';

import {
  ConfigurationStaging,
  ConfigurationStagingError,
  changedLines,
  rewriteConfiguration,
} from '../src/index.js';

/**
 * Staging, against real temporary directories.
 *
 * The property under test throughout: the workspace is never written to, and a
 * document keeps everything the reader never claimed to understand.
 */

const FORGE_TOML = `#Common configuration
[general]
	#Whether the feature is enabled.
	enabled = true

	#Scales incoming damage.
	#Range: 0.0 ~ 4.0
	damageScale = 1.5

	#Which preset to use.
	#Allowed Values: EASY, NORMAL, HARD
	preset = "NORMAL" # chosen by the pack author

	#Something this reader will not represent.
	weird = { inline = true }

[general.advanced]
	blockedDimensions = ["minecraft:the_nether"]
`;

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function fixture(content = FORGE_TOML) {
  const base = await mkdtemp(join(tmpdir(), 'voidfall-staging-'));
  roots.push(base);
  const workspaceRoot = join(base, 'workspace');
  const stagingRoot = join(base, 'staging');
  await mkdir(join(workspaceRoot, 'config'), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'config', 'example.toml'), content, 'utf8');
  const staging = new ConfigurationStaging({ workspaceRoot, stagingRoot });
  return { base, workspaceRoot, stagingRoot, staging };
}

describe('staging a change', () => {
  it('writes to staging and leaves the workspace byte-for-byte untouched', async () => {
    const { workspaceRoot, staging } = await fixture();
    const before = await readFile(join(workspaceRoot, 'config', 'example.toml'), 'utf8');

    const staged = await staging.stage({
      path: 'config/example.toml',
      changes: [{ path: 'general.damageScale', value: 2.5 }],
    });

    const after = await readFile(join(workspaceRoot, 'config', 'example.toml'), 'utf8');
    assert.equal(after, before, 'the workspace file must not change');
    assert.notEqual(staged.stagedSha256, staged.baseSha256);
    assert.match((await staging.readStaged('config/example.toml')) ?? '', /damageScale = 2\.5/u);
  });

  it('keeps everything it never claimed to understand', async () => {
    const { staging } = await fixture();
    await staging.stage({
      path: 'config/example.toml',
      changes: [{ path: 'general.enabled', value: false }],
    });
    const result = (await staging.readStaged('config/example.toml')) ?? '';

    // The inline table is a construct the reader refuses. Re-serialising from
    // the form would have dropped it from a file somebody thought they edited
    // one boolean in.
    assert.ok(result.includes('weird = { inline = true }'));
    assert.ok(result.includes('#Common configuration'));
    assert.ok(result.includes('	#Scales incoming damage.'));
    // And the trailing comment on an untouched line survives too.
    assert.ok(result.includes('# chosen by the pack author'));
  });

  it('preserves a trailing comment on the line it edits', async () => {
    const { staging } = await fixture();
    await staging.stage({
      path: 'config/example.toml',
      changes: [{ path: 'general.preset', value: 'HARD' }],
    });
    const result = (await staging.readStaged('config/example.toml')) ?? '';
    // The comment belongs to the author, not to the editor.
    assert.ok(result.includes('preset = "HARD" # chosen by the pack author'));
  });

  it('refuses a value the mod said it would not take', async () => {
    const { staging } = await fixture();
    await assert.rejects(
      staging.stage({
        path: 'config/example.toml',
        changes: [{ path: 'general.damageScale', value: 99 }],
      }),
      (error: unknown) =>
        error instanceof ConfigurationStagingError &&
        error.code === 'value-rejected' &&
        error.path === 'general.damageScale',
    );
    // Nothing was written, so there is nothing half-staged to find later.
    assert.equal(await staging.readStaged('config/example.toml'), undefined);
  });

  it('refuses a field that is not in the form', async () => {
    const { staging } = await fixture();
    await assert.rejects(
      staging.stage({
        path: 'config/example.toml',
        changes: [{ path: 'general.invented', value: 1 }],
      }),
      (error: unknown) =>
        error instanceof ConfigurationStagingError && error.code === 'unknown-field',
    );
  });

  it('refuses a path that would escape the staging tree', async () => {
    const { staging } = await fixture();
    for (const path of ['../outside.toml', 'config/../../outside.toml']) {
      await assert.rejects(
        staging.stage({ path, changes: [{ path: 'general.enabled', value: false }] }),
        (error: unknown) =>
          error instanceof ConfigurationStagingError && error.code === 'invalid-input',
        path,
      );
    }
  });

  it('keeps a float a float', async () => {
    const { staging } = await fixture();
    await staging.stage({
      path: 'config/example.toml',
      changes: [{ path: 'general.damageScale', value: 2 }],
    });
    const result = (await staging.readStaged('config/example.toml')) ?? '';
    // Written as `2` the mod's own parser would read an integer and reject it,
    // because the field was declared as a float.
    assert.ok(result.includes('damageScale = 2.0'), result);
  });

  it('does not rewrite line endings it was not asked to change', () => {
    const crlf = '[general]\r\nenabled = true\r\nother = 1\r\n';
    const form = inferForm({ format: 'toml', content: crlf });
    const result = rewriteConfiguration({
      form,
      content: crlf,
      changes: [{ path: 'general.enabled', value: false }],
    });
    // Rewriting CRLF as LF would present the whole file as changed in a diff
    // nobody asked for.
    assert.equal(result, '[general]\r\nenabled = false\r\nother = 1\r\n');
  });
});

describe('applying is a separate, verified step', () => {
  it('refuses when the source moved on after the change was computed', async () => {
    const { workspaceRoot, staging } = await fixture();
    const staged = await staging.stage({
      path: 'config/example.toml',
      changes: [{ path: 'general.enabled', value: false }],
    });
    await staging.verifyBase(staged);

    // Somebody edited the file in the meantime — a hand, a mod regenerating
    // its config, a restore.
    await writeFile(
      join(workspaceRoot, 'config', 'example.toml'),
      `${FORGE_TOML}\n#touched\n`,
      'utf8',
    );

    await assert.rejects(
      staging.verifyBase(staged),
      (error: unknown) =>
        error instanceof ConfigurationStagingError && error.code === 'base-digest-mismatch',
    );
  });

  it('discards a staged change without touching the workspace', async () => {
    const { workspaceRoot, staging } = await fixture();
    const before = await readFile(join(workspaceRoot, 'config', 'example.toml'), 'utf8');
    await staging.stage({
      path: 'config/example.toml',
      changes: [{ path: 'general.enabled', value: false }],
    });
    await staging.discard('config/example.toml');

    assert.equal(await staging.readStaged('config/example.toml'), undefined);
    // Rollback before apply is deleting a file this service wrote; nothing in
    // the workspace was ever touched to roll back.
    assert.equal(await readFile(join(workspaceRoot, 'config', 'example.toml'), 'utf8'), before);
  });
});

describe('the diff a person reads before applying', () => {
  it('reports exactly the lines that changed', async () => {
    const { staging } = await fixture();
    await staging.stage({
      path: 'config/example.toml',
      changes: [{ path: 'general.damageScale', value: 3.5 }],
    });

    const changed = changedLines(await staging.diff('config/example.toml'));
    assert.equal(changed.length, 2);
    assert.equal(changed[0]?.kind, 'removed');
    assert.match(changed[0]?.text ?? '', /damageScale = 1\.5/u);
    assert.equal(changed[1]?.kind, 'added');
    assert.match(changed[1]?.text ?? '', /damageScale = 3\.5/u);
  });

  it('refuses to diff a file nothing is staged for', async () => {
    const { staging } = await fixture();
    await assert.rejects(
      staging.diff('config/example.toml'),
      (error: unknown) => error instanceof ConfigurationStagingError && error.code === 'not-staged',
    );
  });
});

describe('JSON, where there is no line to edit surgically', () => {
  it('rebuilds the document only when the form held all of it', () => {
    const complete = inferForm({
      format: 'json',
      content: '{\n  "enabled": true,\n  "weight": 3\n}\n',
    });
    const rebuilt = rewriteConfiguration({
      form: complete,
      content: '{\n  "enabled": true,\n  "weight": 3\n}\n',
      changes: [{ path: 'weight', value: 7 }],
    });
    assert.equal(JSON.parse(rebuilt).weight, 7);
    assert.equal(JSON.parse(rebuilt).enabled, true);

    // A null is a value this reader refuses, so the form is partial. Rebuilding
    // from it would drop the key entirely from a file somebody edited one
    // number in.
    const partialContent = '{"enabled":true,"unknown":null}';
    const partial = inferForm({ format: 'json', content: partialContent });
    assert.equal(partial.complete, false);
    assert.throws(
      () =>
        rewriteConfiguration({
          form: partial,
          content: partialContent,
          changes: [{ path: 'enabled', value: false }],
        }),
      (error: unknown) =>
        error instanceof ConfigurationStagingError && error.code === 'incomplete-form',
    );
  });
});
