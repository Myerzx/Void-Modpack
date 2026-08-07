import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canExportCurseForgePack,
  diffInventories,
  evaluateDistribution,
  planRelease,
  renderChangelog,
  type InventoriedMod,
  type WorkspaceInventory,
} from '../src/index.js';

/**
 * Release planning over two inventories.
 *
 * The properties under test: a difference is decided by digest, and permission
 * to hand an artefact to somebody is never inferred from having built it.
 */

function mod(
  modId: string,
  version: string,
  sha: string,
  archivePath = `mods/${modId}.jar`,
): InventoriedMod {
  return {
    modId,
    displayName: modId,
    version,
    loader: 'forge',
    archivePath,
    archiveSha256: sha.padEnd(64, '0'),
    editLevel: 'STRUCTURED',
    editLevelReason: 'fixture',
    configurationCandidates: [],
  };
}

function inventory(input: {
  readonly mods: readonly InventoriedMod[];
  readonly files?: readonly { path: string; role: string; sha: string }[];
  readonly digest?: string;
}): WorkspaceInventory {
  const files = (input.files ?? []).map((file) => ({
    path: file.path,
    role: file.role as WorkspaceInventory['files'][number]['role'],
    sizeBytes: 1,
    sha256: file.sha.padEnd(64, '0'),
  }));
  return {
    schemaVersion: 1,
    inventorySha256: (input.digest ?? 'aa').padEnd(64, '0'),
    files,
    exclusions: [],
    mods: input.mods,
    undeclaredArchives: [],
    totals: { files: files.length, bytes: files.length, mods: input.mods.length },
  };
}

describe('diffing two inventories', () => {
  it('tells added, removed and updated apart', () => {
    const from = inventory({ mods: [mod('alpha', '1.0.0', 'a1'), mod('beta', '2.0.0', 'b1')] });
    const to = inventory({ mods: [mod('alpha', '1.1.0', 'a2'), mod('gamma', '3.0.0', 'c1')] });

    const diff = diffInventories({ from, to });
    assert.deepEqual(
      diff.mods.map((change) => [change.modId, change.kind]),
      [
        ['alpha', 'updated'],
        ['beta', 'removed'],
        ['gamma', 'added'],
      ],
    );
    assert.equal(diff.totals.modsAdded, 1);
    assert.equal(diff.totals.modsRemoved, 1);
    assert.equal(diff.totals.modsUpdated, 1);
  });

  it('reports a replaced jar even when the version did not move', () => {
    const from = inventory({ mods: [mod('alpha', '1.0.0', 'a1')] });
    const to = inventory({ mods: [mod('alpha', '1.0.0', 'a2')] });

    // A pack author replacing a jar in place is real and common. Calling it
    // unchanged because the version matched would hide the only evidence that
    // anything happened.
    assert.deepEqual(
      diffInventories({ from, to }).mods.map((change) => change.kind),
      ['rebuilt'],
    );
  });

  it('treats a first release as everything added', () => {
    const diff = diffInventories({ from: null, to: inventory({ mods: [mod('alpha', '1.0.0', 'a1')] }) });
    assert.deepEqual(diff.mods.map((change) => change.kind), ['added']);
    assert.equal(diff.identical, false);
  });

  it('decides sameness on the inventory digest, not on the version', () => {
    const one = inventory({ mods: [mod('alpha', '1.0.0', 'a1')], digest: 'dd' });
    const same = inventory({ mods: [mod('alpha', '1.0.0', 'a1')], digest: 'dd' });
    assert.equal(diffInventories({ from: one, to: same }).identical, true);
  });

  it('reports configuration and content changes by digest', () => {
    const from = inventory({
      mods: [],
      files: [
        { path: 'config/a.toml', role: 'configuration', sha: 'f1' },
        { path: 'kubejs/x.js', role: 'script', sha: 'f2' },
      ],
    });
    const to = inventory({
      mods: [],
      files: [
        { path: 'config/a.toml', role: 'configuration', sha: 'f9' },
        { path: 'datapacks/new.json', role: 'datapack', sha: 'f3' },
      ],
    });

    assert.deepEqual(
      diffInventories({ from, to }).files.map((file) => [file.path, file.kind]),
      [
        ['config/a.toml', 'changed'],
        ['datapacks/new.json', 'added'],
        ['kubejs/x.js', 'removed'],
      ],
    );
  });
});

describe('the distribution gate', () => {
  const catalogue = [
    { fileName: 'alpha.jar', sha256: 'a1'.padEnd(64, '0'), review: 'provider-metadata-required' },
    { fileName: 'beta.jar', sha256: 'b1'.padEnd(64, '0'), review: 'approved' },
  ];

  it('refuses a mod nobody reviewed rather than assuming it is fine', () => {
    const decision = evaluateDistribution({
      inventory: inventory({ mods: [mod('alpha', '1.0.0', 'a1'), mod('zeta', '1.0.0', 'z9')] }),
      catalogue,
    });
    assert.equal(decision.distributable, false);
    assert.deepEqual(
      decision.blocks.map((block) => [block.path, block.reason]),
      [
        ['mods/alpha.jar', 'provider-metadata-required'],
        ['mods/zeta.jar', 'not-reviewed'],
      ],
    );
  });

  it('matches by digest, so a rename is still the same licence question', () => {
    const decision = evaluateDistribution({
      // Same bytes as the approved beta.jar, under a different name.
      inventory: inventory({ mods: [mod('beta', '2.0.0', 'b1', 'mods/renamed.jar')] }),
      catalogue,
    });
    assert.equal(decision.distributable, true);
    assert.deepEqual(decision.blocks, []);
  });

  it('lets an operator build for their own machine either way', () => {
    const decision = evaluateDistribution({
      inventory: inventory({ mods: [mod('alpha', '1.0.0', 'a1')] }),
      catalogue,
    });
    // A backup somebody restores onto their own host is not distribution, and
    // refusing it would treat a licence question as a backup question.
    assert.equal(decision.localUseOnly, true);
  });

  it('refuses a CurseForge pack and says exactly what is missing', () => {
    const decision = evaluateDistribution({
      inventory: inventory({ mods: [mod('alpha', '1.0.0', 'a1'), mod('zeta', '1.0.0', 'z9')] }),
      catalogue,
    });
    const result = canExportCurseForgePack(decision);
    // Without a project and file id there is nothing to reference a mod by, and
    // copying the jar into overrides instead is redistributing it. Both roads
    // need the review.
    assert.equal(result.allowed, false);
    assert.match(result.refusal ?? '', /provider metadata/u);
    assert.match(result.refusal ?? '', /never reviewed/u);
  });

  it('allows the export once everything is approved', () => {
    const decision = evaluateDistribution({
      inventory: inventory({ mods: [mod('beta', '2.0.0', 'b1')] }),
      catalogue,
    });
    assert.deepEqual(canExportCurseForgePack(decision), { allowed: true, refusal: null });
  });
});

describe('the changelog', () => {
  it('is written from the diff, and says nothing about what a change does', () => {
    const plan = planRelease({
      from: inventory({ mods: [mod('alpha', '1.0.0', 'a1'), mod('beta', '2.0.0', 'b1')] }),
      to: inventory({
        mods: [mod('alpha', '1.1.0', 'a2')],
        files: [{ path: 'config/alpha.toml', role: 'configuration', sha: 'f1' }],
      }),
      catalogue: [],
    });

    const rendered = renderChangelog({
      entries: plan.changelog,
      version: '1.1.0',
      previousVersion: '1.0.0',
    });
    assert.match(rendered, /# 1\.1\.0 \(from 1\.0\.0\)/u);
    assert.match(rendered, /## Updated\n\n- alpha 1\.0\.0 → 1\.1\.0/u);
    assert.match(rendered, /## Removed\n\n- beta 2\.0\.0/u);
    assert.match(rendered, /## Configuration\n\n- added: config\/alpha\.toml/u);
  });

  it('says a release is empty rather than producing an empty document', () => {
    const same = inventory({ mods: [mod('alpha', '1.0.0', 'a1')], digest: 'dd' });
    const plan = planRelease({ from: same, to: same, catalogue: [] });
    // An empty document reads like a generation failure.
    assert.match(
      renderChangelog({ entries: plan.changelog, version: '1.0.1', previousVersion: '1.0.0' }),
      /No mod, configuration or content changes/u,
    );
  });

  it('keeps "nobody checked" distinct from "it did not start"', () => {
    const to = inventory({ mods: [] });
    assert.equal(planRelease({ from: null, to, catalogue: [] }).bootOutcome, null);
    assert.equal(
      planRelease({ from: null, to, catalogue: [], bootOutcome: 'booted' }).bootOutcome,
      'booted',
    );
    // A release record that conflated the two would let an untested build read
    // as a tested one.
    assert.equal(
      planRelease({ from: null, to, catalogue: [], bootOutcome: 'exited-early' }).bootOutcome,
      'exited-early',
    );
  });
});
