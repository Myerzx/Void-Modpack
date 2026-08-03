import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  InventoryEntry,
  InventoryRuntime,
  InventoryScope,
  InventorySnapshot,
  ModCatalogEntry,
} from '@voidfall/contracts';

import {
  CatalogReconciliationError,
  reconcileCatalog,
  type CatalogReconciliationPlan,
} from '../src/index.js';

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
    readonly sizeBytes?: number;
    readonly decision?: ModCatalogEntry['distribution']['decision'];
    readonly reviewState?: ModCatalogEntry['reviewState'];
    readonly runtime?: InventoryRuntime;
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
    sizeBytes: options.sizeBytes ?? 1_024,
    sha256,
    runtime: options.runtime ?? targetRuntime,
    source: {
      provider: 'manual-reviewed',
      sourceUrl: `https://example.invalid/${id}`,
    },
    distribution,
    reviewState: options.reviewState ?? 'reviewed',
    dependencies: [],
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
