import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type {
  InventoryEntry,
  InventoryRuntime,
  InventoryScope,
  InventorySnapshot,
  ModCatalogEntry,
  ModCompatibilityAnalysisPlan,
} from '@voidfall/contracts';

import {
  CatalogClassificationError,
  CatalogDependencyAnalysisError,
  ContextualCompatibilityAnalysisError,
  CatalogReconciliationError,
  analyzeContextualCompatibility,
  analyzeCatalogDependencies,
  classifyCatalogEntry,
  hashCatalogEntry,
  evaluateMavenVersionRange,
  reconcileCatalog,
  type CatalogReconciliationPlan,
} from '../src/index.js';

interface CompatibilityRegressionFixture {
  readonly analysisPlan: ModCompatibilityAnalysisPlan;
  readonly expectations: {
    readonly componentStatus: Readonly<Record<string, 'compatible' | 'incompatible' | 'unknown'>>;
    readonly requiredFindingCodes: Readonly<Record<string, readonly string[]>>;
    readonly forbiddenFindingCodes: Readonly<Record<string, readonly string[]>>;
  };
  readonly versionRangeCases: readonly {
    readonly version: string;
    readonly range: string;
    readonly expected: 'match' | 'mismatch' | 'unknown';
  }[];
}

const compatibilityFixture = JSON.parse(
  readFileSync(
    new URL('../../../../tools/modpack/fixtures/contextual-compatibility-regressions.json', import.meta.url),
    'utf8',
  ),
) as CompatibilityRegressionFixture;

const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const hashC = 'c'.repeat(64);
const reviewerId = '018f6b8c-76a3-7d10-9f2e-1d9e52a63702';

const targetRuntime: InventoryRuntime = {
  minecraftVersion: '1.20.1',
  loader: 'forge',
  loaderVersion: '1.20.1-47.4.4',
};

function comparePath(left: InventoryEntry, right: InventoryEntry): number {
  const normalizedLeft = left.path.normalize('NFC').toLocaleLowerCase('en-US');
  const normalizedRight = right.path.normalize('NFC').toLocaleLowerCase('en-US');
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}

function inventoryEntry(
  filename: string,
  sha256: string,
  options: {
    readonly state?: InventoryEntry['state'];
    readonly sizeBytes?: number;
    readonly path?: string;
  } = {},
): InventoryEntry {
  return {
    path: options.path ?? `mods/${filename}`,
    filename,
    kind: 'mod',
    state: options.state ?? 'active',
    sizeBytes: options.sizeBytes ?? 1_024,
    sha256,
  };
}

function inventory(
  inventoryId: string,
  scope: InventoryScope,
  entries: readonly InventoryEntry[],
  runtime: InventoryRuntime = targetRuntime,
): InventorySnapshot {
  return {
    schemaVersion: 1,
    inventoryId,
    observedAt: '2026-08-03T12:00:00Z',
    source: {
      sourceId: scope === 'client' ? 'voidfall-launcher' : 'voidfall-server',
      scope,
      type: scope === 'client' ? 'launcher-export' : 'server-export',
    },
    runtime,
    entries: [...entries].sort(comparePath),
  };
}

function catalogEntry(
  id: string,
  filename: string,
  sha256: string,
  options: {
    readonly side?: ModCatalogEntry['side'];
    readonly version?: string;
    readonly sizeBytes?: number;
    readonly decision?: ModCatalogEntry['distribution']['decision'];
    readonly reviewState?: ModCatalogEntry['reviewState'];
    readonly runtime?: InventoryRuntime;
    readonly dependencies?: ModCatalogEntry['dependencies'];
  } = {},
): ModCatalogEntry {
  const decision = options.decision ?? 'allowed';
  const distribution: ModCatalogEntry['distribution'] =
    decision === 'allowed'
      ? {
          decision,
          licenseExpression: 'MIT',
          evidenceReference: 'https://example.invalid/license',
          reviewedBy: reviewerId,
          reviewedAt: '2026-08-03T11:00:00Z',
        }
      : { decision };

  return {
    schemaVersion: 1,
    id,
    logicalName: id,
    filename,
    path: `mods/${filename}`,
    kind: 'mod',
    side: options.side ?? 'both',
    requirement: 'required',
    ...(options.version !== undefined ? { version: options.version } : {}),
    sizeBytes: options.sizeBytes ?? 1_024,
    sha256,
    runtime: options.runtime ?? targetRuntime,
    source: {
      provider: 'manual-reviewed',
      sourceUrl: `https://example.invalid/${id}`,
    },
    distribution,
    reviewState: options.reviewState ?? 'reviewed',
    dependencies: options.dependencies ?? [],
  };
}

function plan(
  inventories: readonly InventorySnapshot[],
  catalog: readonly ModCatalogEntry[],
): CatalogReconciliationPlan {
  return {
    reconciliationId: 'reconcile-20260803',
    generatedAt: '2026-08-03T12:01:00Z',
    targetRuntime,
    inventories,
    catalog,
  };
}

function artifactByHash(
  report: ReturnType<typeof reconcileCatalog>,
  sha256: string,
): ReturnType<typeof reconcileCatalog>['artifacts'][number] {
  const artifact = report.artifacts.find((candidate) => candidate.sha256 === sha256);
  assert.ok(artifact);
  return artifact;
}

describe('reconcileCatalog', () => {
  it('groups identical client and server bytes by SHA-256', () => {
    const entry = inventoryEntry('example.jar', hashA);
    const report = reconcileCatalog(
      plan(
        [inventory('client-current', 'client', [entry]), inventory('server-current', 'server', [entry])],
        [catalogEntry('example-mod', 'example.jar', hashA)],
      ),
    );

    const artifact = artifactByHash(report, hashA);
    assert.equal(artifact.matchState, 'cataloged');
    assert.equal(artifact.suggestedSide, 'both');
    assert.deepEqual(artifact.catalogEntryIds, ['example-mod']);
    assert.deepEqual(artifact.blockers, []);
    assert.equal(report.summary.unblockedArtifacts, 1);
  });

  it('is deterministic across inventory, catalog and entry ordering', () => {
    const client = inventory('client-current', 'client', [
      inventoryEntry('zeta.jar', hashC),
      inventoryEntry('alpha.jar', hashA),
    ]);
    const server = inventory('server-current', 'server', [inventoryEntry('alpha.jar', hashA)]);
    const catalog = [
      catalogEntry('zeta-mod', 'zeta.jar', hashC, { side: 'client' }),
      catalogEntry('alpha-mod', 'alpha.jar', hashA),
    ];

    const first = reconcileCatalog(plan([client, server], catalog));
    const second = reconcileCatalog(plan([server, client], [...catalog].reverse()));
    assert.deepEqual(second, first);
  });

  it('keeps observed hashes without a catalog entry untracked', () => {
    const report = reconcileCatalog(
      plan([inventory('client-current', 'client', [inventoryEntry('unknown.jar', hashA)])], []),
    );
    const artifact = artifactByHash(report, hashA);
    assert.equal(artifact.matchState, 'untracked');
    assert.deepEqual(artifact.blockers, ['missing-catalog-entry']);
  });

  it('marks a hash assigned to multiple logical IDs as ambiguous', () => {
    const report = reconcileCatalog(
      plan(
        [inventory('client-current', 'client', [inventoryEntry('same.jar', hashA)])],
        [
          catalogEntry('logical-one', 'same.jar', hashA, { side: 'client' }),
          catalogEntry('logical-two', 'same.jar', hashA, { side: 'client' }),
        ],
      ),
    );
    const artifact = artifactByHash(report, hashA);
    assert.equal(artifact.matchState, 'ambiguous');
    assert.deepEqual(artifact.catalogEntryIds, ['logical-one', 'logical-two']);
    assert.ok(artifact.blockers.includes('ambiguous-catalog-match'));
  });

  it('retains catalog-only artifacts and disabled-only observations as blocked evidence', () => {
    const report = reconcileCatalog(
      plan(
        [
          inventory('client-current', 'client', [
            inventoryEntry('disabled.jar', hashB, { state: 'disabled' }),
          ]),
        ],
        [
          catalogEntry('missing-mod', 'missing.jar', hashA),
          catalogEntry('disabled-mod', 'disabled.jar', hashB, { side: 'client' }),
        ],
      ),
    );
    assert.ok(artifactByHash(report, hashA).blockers.includes('missing-inventory-evidence'));
    assert.ok(artifactByHash(report, hashB).blockers.includes('inactive-only'));
  });

  it('suggests a side from active presence without changing the reviewed side', () => {
    const report = reconcileCatalog(
      plan(
        [inventory('server-current', 'server', [inventoryEntry('server.jar', hashA)])],
        [catalogEntry('server-mod', 'server.jar', hashA, { side: 'unknown' })],
      ),
    );
    const artifact = artifactByHash(report, hashA);
    assert.equal(artifact.suggestedSide, 'server');
    assert.ok(artifact.blockers.includes('unknown-side'));
  });

  it('reports disagreement between reviewed side and active evidence', () => {
    const report = reconcileCatalog(
      plan(
        [inventory('server-current', 'server', [inventoryEntry('client.jar', hashA)])],
        [catalogEntry('client-mod', 'client.jar', hashA, { side: 'client' })],
      ),
    );
    assert.ok(artifactByHash(report, hashA).blockers.includes('side-conflict'));
  });

  it('preserves distribution and review blockers instead of granting approval', () => {
    const report = reconcileCatalog(
      plan(
        [
          inventory('client-current', 'client', [
            inventoryEntry('pending.jar', hashA),
            inventoryEntry('blocked.jar', hashB),
          ]),
        ],
        [
          catalogEntry('pending-mod', 'pending.jar', hashA, {
            side: 'client',
            decision: 'pending',
            reviewState: 'detected',
          }),
          catalogEntry('blocked-mod', 'blocked.jar', hashB, {
            side: 'client',
            decision: 'blocked',
          }),
        ],
      ),
    );
    assert.deepEqual(artifactByHash(report, hashA).blockers, [
      'catalog-review-required',
      'distribution-pending',
    ]);
    assert.deepEqual(artifactByHash(report, hashB).blockers, ['distribution-blocked']);
  });

  it('detects runtime and size mismatches', () => {
    const incompatibleRuntime: InventoryRuntime = {
      minecraftVersion: '1.21.1',
      loader: 'neoforge',
      loaderVersion: '21.1.1',
    };
    const report = reconcileCatalog(
      plan(
        [
          inventory(
            'server-current',
            'server',
            [inventoryEntry('drift.jar', hashA, { sizeBytes: 2_048 })],
            incompatibleRuntime,
          ),
        ],
        [catalogEntry('drift-mod', 'drift.jar', hashA, { sizeBytes: 1_024 })],
      ),
    );
    assert.deepEqual(artifactByHash(report, hashA).blockers, [
      'runtime-mismatch',
      'size-mismatch',
    ]);
  });

  it('blocks filename collisions between different content hashes', () => {
    const report = reconcileCatalog(
      plan(
        [
          inventory('client-current', 'client', [inventoryEntry('Same.jar', hashA)]),
          inventory('server-current', 'server', [inventoryEntry('same.jar', hashB)]),
        ],
        [
          catalogEntry('client-copy', 'Same.jar', hashA, { side: 'client' }),
          catalogEntry('server-copy', 'same.jar', hashB, { side: 'server' }),
        ],
      ),
    );
    assert.ok(artifactByHash(report, hashA).blockers.includes('filename-collision'));
    assert.ok(artifactByHash(report, hashB).blockers.includes('filename-collision'));
  });

  it('rejects invalid snapshots and duplicate input identities', () => {
    const invalid = inventory('client-current', 'client', [inventoryEntry('safe.jar', hashA)]);
    const unsafe = {
      ...invalid,
      entries: [{ ...invalid.entries[0], path: '../safe.jar' }],
    } as InventorySnapshot;
    assert.throws(
      () => reconcileCatalog(plan([unsafe], [])),
      (error) => error instanceof CatalogReconciliationError && error.code === 'invalid-inventory',
    );
    assert.throws(
      () => reconcileCatalog(plan([invalid, invalid], [])),
      (error) =>
        error instanceof CatalogReconciliationError && error.code === 'duplicate-inventory-id',
    );
    const catalog = catalogEntry('duplicate-mod', 'safe.jar', hashA);
    assert.throws(
      () => reconcileCatalog(plan([invalid], [catalog, catalog])),
      (error) =>
        error instanceof CatalogReconciliationError && error.code === 'duplicate-catalog-id',
    );
  });

  it('returns a deeply immutable report without filesystem or network inputs', () => {
    const report = reconcileCatalog(
      plan(
        [inventory('client-current', 'client', [inventoryEntry('example.jar', hashA)])],
        [catalogEntry('example-mod', 'example.jar', hashA, { side: 'client' })],
      ),
    );
    assert.equal(Object.isFrozen(report), true);
    assert.equal(Object.isFrozen(report.inputs), true);
    assert.equal(Object.isFrozen(report.artifacts), true);
    assert.equal(Object.isFrozen(report.artifacts[0]?.observations), true);
  });
});

describe('classifyCatalogEntry', () => {
  it('creates an immutable reviewed classification with optimistic concurrency', () => {
    const entry = catalogEntry('pending-mod', 'pending.jar', hashA, {
      side: 'unknown',
      decision: 'pending',
      reviewState: 'detected',
    });
    const result = classifyCatalogEntry({
      revisionId: 'review-20260803',
      actorId: reviewerId,
      reasonCode: 'manual-license-review',
      reviewedAt: '2026-08-03T13:00:00Z',
      expectedEntrySha256: hashCatalogEntry(entry),
      entry,
      changes: {
        side: 'client',
        distribution: {
          decision: 'allowed',
          licenseExpression: 'MIT',
          evidenceReference: 'https://example.invalid/license',
          reviewedBy: reviewerId,
          reviewedAt: '2026-08-03T13:00:00Z',
        },
        reviewState: 'reviewed',
      },
    });

    assert.equal(result.entry.side, 'client');
    assert.equal(result.entry.distribution.decision, 'allowed');
    assert.deepEqual(result.revision.changedFields, ['distribution', 'reviewState', 'side']);
    assert.notEqual(result.revision.previousEntrySha256, result.revision.currentEntrySha256);
    assert.equal(Object.isFrozen(result.entry), true);
    assert.equal(Object.isFrozen(result.revision.changedFields), true);
  });

  it('rejects a stale expected hash, empty changes and reviewed unknown state', () => {
    const entry = catalogEntry('pending-mod', 'pending.jar', hashA, {
      side: 'unknown',
      decision: 'pending',
      reviewState: 'detected',
    });
    const base = {
      revisionId: 'review-20260803',
      actorId: reviewerId,
      reasonCode: 'manual-review',
      reviewedAt: '2026-08-03T13:00:00Z',
      expectedEntrySha256: hashCatalogEntry(entry),
      entry,
    } as const;
    assert.throws(
      () => classifyCatalogEntry({ ...base, expectedEntrySha256: hashB, changes: { side: 'client' } }),
      (error) =>
        error instanceof CatalogClassificationError && error.code === 'concurrent-modification',
    );
    assert.throws(
      () => classifyCatalogEntry({ ...base, changes: {} }),
      (error) => error instanceof CatalogClassificationError && error.code === 'invalid-changes',
    );
    assert.throws(
      () => classifyCatalogEntry({ ...base, changes: { reviewState: 'reviewed' } }),
      (error) => error instanceof CatalogClassificationError && error.code === 'invalid-transition',
    );
  });

  it('rejects no-op decisions and extra plan fields', () => {
    const entry = catalogEntry('client-mod', 'client.jar', hashA, { side: 'client' });
    const plan = {
      revisionId: 'review-20260803',
      actorId: reviewerId,
      reasonCode: 'manual-review',
      reviewedAt: '2026-08-03T13:00:00Z',
      expectedEntrySha256: hashCatalogEntry(entry),
      entry,
      changes: { side: 'client' as const },
    };
    assert.throws(
      () => classifyCatalogEntry(plan),
      (error) => error instanceof CatalogClassificationError && error.code === 'no-change',
    );
    assert.throws(
      () => classifyCatalogEntry({ ...plan, unsafe: true } as never),
      (error) => error instanceof CatalogClassificationError && error.code === 'invalid-plan',
    );
  });
});

describe('analyzeCatalogDependencies', () => {
  const analysisPlan = (
    catalog: readonly ModCatalogEntry[],
    conflicts: readonly {
      readonly constraintId: string;
      readonly leftId: string;
      readonly rightId: string;
      readonly evidenceReference: string;
    }[] = [],
  ) => ({
    analysisId: 'analysis-20260803',
    generatedAt: '2026-08-03T14:00:00Z',
    catalog,
    conflicts,
  });

  it('finds missing required and optional dependencies without guessing ranges', () => {
    const report = analyzeCatalogDependencies(
      analysisPlan([
        catalogEntry('root-mod', 'root.jar', hashA, {
          dependencies: [
            { id: 'required-missing', required: true },
            { id: 'optional-missing', required: false },
          ],
        }),
      ]),
    );
    assert.deepEqual(
      report.issues.map((issue) => issue.code),
      ['missing-optional-dependency', 'missing-required-dependency'],
    );
    assert.equal(report.summary.blockerCount, 1);
    assert.equal(report.summary.warningCount, 1);
  });

  it('detects required cycles, self dependencies, runtime drift and unverified ranges', () => {
    const otherRuntime: InventoryRuntime = {
      minecraftVersion: '1.21.1',
      loader: 'neoforge',
      loaderVersion: '21.1.1',
    };
    const report = analyzeCatalogDependencies(
      analysisPlan([
        catalogEntry('alpha-mod', 'alpha.jar', hashA, {
          dependencies: [
            { id: 'beta-mod', required: true, versionRange: '^1.0.0' },
            { id: 'alpha-mod', required: true },
          ],
        }),
        catalogEntry('beta-mod', 'beta.jar', hashB, {
          runtime: otherRuntime,
          dependencies: [{ id: 'alpha-mod', required: true }],
        }),
      ]),
    );
    const codes = new Set(report.issues.map((issue) => issue.code));
    assert.ok(codes.has('required-dependency-cycle'));
    assert.ok(codes.has('self-dependency'));
    assert.ok(codes.has('runtime-mismatch'));
    assert.ok(codes.has('unverified-version-range'));
  });

  it('detects logical/content duplicates, filename collisions and reviewed conflicts', () => {
    const report = analyzeCatalogDependencies(
      analysisPlan(
        [
          catalogEntry('duplicate-id', 'first.jar', hashA),
          catalogEntry('duplicate-id', 'second.jar', hashB),
          catalogEntry('same-content', 'third.jar', hashA),
          catalogEntry('filename-owner', 'FIRST.jar', hashC),
        ],
        [
          {
            constraintId: 'incompatible-duplicate-owner',
            leftId: 'same-content',
            rightId: 'filename-owner',
            evidenceReference: 'review:42',
          },
        ],
      ),
    );
    const codes = new Set(report.issues.map((issue) => issue.code));
    assert.ok(codes.has('duplicate-catalog-id'));
    assert.ok(codes.has('duplicate-content'));
    assert.ok(codes.has('filename-collision'));
    assert.ok(codes.has('explicit-conflict'));
  });

  it('is deterministic and rejects duplicate conflict identities', () => {
    const alpha = catalogEntry('alpha-mod', 'alpha.jar', hashA, {
      dependencies: [{ id: 'missing-mod', required: true }],
    });
    const beta = catalogEntry('beta-mod', 'beta.jar', hashB);
    const first = analyzeCatalogDependencies(analysisPlan([alpha, beta]));
    const second = analyzeCatalogDependencies(analysisPlan([beta, alpha]));
    assert.deepEqual(second, first);

    const conflict = {
      constraintId: 'same-constraint',
      leftId: 'alpha-mod',
      rightId: 'beta-mod',
      evidenceReference: 'review:1',
    };
    assert.throws(
      () => analyzeCatalogDependencies(analysisPlan([alpha, beta], [conflict, conflict])),
      (error) =>
        error instanceof CatalogDependencyAnalysisError && error.code === 'invalid-conflict',
    );
  });
});

describe('Maven version requirements', () => {
  it('evaluates the shared sanitized range corpus conservatively', () => {
    for (const testCase of compatibilityFixture.versionRangeCases) {
      assert.equal(
        evaluateMavenVersionRange(testCase.version, testCase.range),
        testCase.expected,
        `${testCase.version} against ${testCase.range}`,
      );
    }
  });

  it('checks supported Maven ranges in the legacy catalog analyzer', () => {
    const matching = analyzeCatalogDependencies(
      {
        analysisId: 'matching-range',
        generatedAt: '2026-08-04T12:00:00Z',
        catalog: [
          catalogEntry('root-mod', 'root.jar', hashA, {
            dependencies: [{ id: 'library', required: true, versionRange: '[1.0,2.0)' }],
          }),
          catalogEntry('library', 'library.jar', hashB, { version: '1.5.0' }),
        ],
        conflicts: [],
      },
    );
    assert.ok(!matching.issues.some((issue) => issue.code.includes('version')));

    const mismatching = analyzeCatalogDependencies(
      {
        analysisId: 'mismatching-range',
        generatedAt: '2026-08-04T12:00:00Z',
        catalog: [
          catalogEntry('root-mod', 'root.jar', hashA, {
            dependencies: [{ id: 'library', required: true, versionRange: '[2.0,)' }],
          }),
          catalogEntry('library', 'library.jar', hashB, { version: '1.5.0' }),
        ],
        conflicts: [],
      },
    );
    assert.ok(mismatching.issues.some((issue) => issue.code === 'dependency-version-mismatch'));
  });
});

describe('analyzeContextualCompatibility', () => {
  it('locks the named Phase 7.0 regressions, JarJar, side and loader behavior', () => {
    const report = analyzeContextualCompatibility(compatibilityFixture.analysisPlan);
    for (const [componentId, expectedStatus] of Object.entries(
      compatibilityFixture.expectations.componentStatus,
    )) {
      assert.equal(
        report.components.find((component) => component.componentId === componentId)?.status,
        expectedStatus,
        componentId,
      );
    }
    for (const [componentId, requiredCodes] of Object.entries(
      compatibilityFixture.expectations.requiredFindingCodes,
    )) {
      const actualCodes = new Set(
        report.findings
          .filter((finding) => finding.componentIds.includes(componentId))
          .map((finding) => finding.code),
      );
      for (const code of requiredCodes) assert.ok(actualCodes.has(code as never), `${componentId}:${code}`);
    }
    for (const [componentId, forbiddenCodes] of Object.entries(
      compatibilityFixture.expectations.forbiddenFindingCodes,
    )) {
      const actualCodes = new Set(
        report.findings
          .filter((finding) => finding.componentIds.includes(componentId))
          .map((finding) => finding.code),
      );
      for (const code of forbiddenCodes) assert.ok(!actualCodes.has(code as never), `${componentId}:${code}`);
    }
    assert.equal(
      report.components.find((component) => component.componentId === 'cumulus-menus')?.kind,
      'embedded-library',
    );
  });

  it('is deterministic and rejects an unversioned plan shape', () => {
    const first = analyzeContextualCompatibility(compatibilityFixture.analysisPlan);
    const reversed: ModCompatibilityAnalysisPlan = {
      ...compatibilityFixture.analysisPlan,
      contexts: [...compatibilityFixture.analysisPlan.contexts].reverse(),
      components: [...compatibilityFixture.analysisPlan.components]
        .reverse()
        .map((component) => ({
          ...component,
          occurrences: [...component.occurrences].reverse(),
          dependencies: [...component.dependencies].reverse(),
        })),
    };
    assert.deepEqual(analyzeContextualCompatibility(reversed), first);
    assert.throws(
      () =>
        analyzeContextualCompatibility({
          ...compatibilityFixture.analysisPlan,
          unsafe: true,
        } as never),
      (error) =>
        error instanceof ContextualCompatibilityAnalysisError && error.code === 'invalid-plan',
    );
  });
});
