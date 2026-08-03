import {
  IsoDateTimeSchema,
  InventoryRuntimeSchema,
  SlugSchema,
  validateCatalogReconciliationReport,
  validateContract,
  validateInventorySnapshot,
  validateModCatalogEntry,
  type CatalogObservation,
  type CatalogReconciliationReport,
  type InventoryRuntime,
  type InventorySnapshot,
  type ModCatalogEntry,
  type ReconciledArtifact,
  type ReconciliationBlocker,
  type SuggestedSide,
} from '@voidfall/contracts';

import {
  CatalogReconciliationError,
  type CatalogReconciliationPlan,
} from './types.js';

const MAXIMUM_INVENTORIES = 128;
const MAXIMUM_CATALOG_ENTRIES = 100_000;

interface ArtifactAccumulator {
  readonly sha256: string;
  readonly observations: CatalogObservation[];
  readonly catalogEntries: ModCatalogEntry[];
  readonly filenames: Set<string>;
  runtimeMismatch: boolean;
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedFilename(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareOrdinal);
  const wanted = [...expected].sort(compareOrdinal);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function formatIssues(
  issues: readonly { readonly path: string; readonly keyword: string; readonly message: string }[],
): readonly string[] {
  return issues.map((issue) => `${issue.path}:${issue.keyword}:${issue.message}`);
}

function runtimeMatches(left: InventoryRuntime, right: InventoryRuntime): boolean {
  return (
    left.minecraftVersion === right.minecraftVersion &&
    left.loader === right.loader &&
    left.loaderVersion === right.loaderVersion
  );
}

function validatePlan(plan: CatalogReconciliationPlan): {
  readonly reconciliationId: string;
  readonly generatedAt: string;
  readonly targetRuntime: InventoryRuntime;
  readonly inventories: readonly InventorySnapshot[];
  readonly catalog: readonly ModCatalogEntry[];
} {
  if (
    !isRecord(plan) ||
    !exactKeys(plan, [
      'reconciliationId',
      'generatedAt',
      'targetRuntime',
      'inventories',
      'catalog',
    ]) ||
    !Array.isArray(plan.inventories) ||
    !Array.isArray(plan.catalog) ||
    plan.inventories.length > MAXIMUM_INVENTORIES ||
    plan.catalog.length > MAXIMUM_CATALOG_ENTRIES
  ) {
    throw new CatalogReconciliationError('invalid-plan', 'plan');
  }

  const idResult = validateContract(SlugSchema, plan.reconciliationId);
  const timestampResult = validateContract(IsoDateTimeSchema, plan.generatedAt);
  const runtimeResult = validateContract(InventoryRuntimeSchema, plan.targetRuntime);
  if (!idResult.success || !timestampResult.success || !runtimeResult.success) {
    throw new CatalogReconciliationError('invalid-plan', 'plan', [
      ...(!idResult.success ? formatIssues(idResult.issues) : []),
      ...(!timestampResult.success ? formatIssues(timestampResult.issues) : []),
      ...(!runtimeResult.success ? formatIssues(runtimeResult.issues) : []),
    ]);
  }

  const inventoryIds = new Set<string>();
  for (const inventory of plan.inventories) {
    const result = validateInventorySnapshot(inventory);
    if (!result.success) {
      throw new CatalogReconciliationError(
        'invalid-inventory',
        'inventory',
        formatIssues(result.issues),
      );
    }
    if (inventoryIds.has(result.value.inventoryId)) {
      throw new CatalogReconciliationError('duplicate-inventory-id', 'inventory');
    }
    inventoryIds.add(result.value.inventoryId);
  }

  const catalogIds = new Set<string>();
  for (const entry of plan.catalog) {
    const result = validateModCatalogEntry(entry);
    if (!result.success) {
      throw new CatalogReconciliationError(
        'invalid-catalog-entry',
        'catalog',
        formatIssues(result.issues),
      );
    }
    if (catalogIds.has(result.value.id)) {
      throw new CatalogReconciliationError('duplicate-catalog-id', 'catalog');
    }
    catalogIds.add(result.value.id);
  }

  return {
    reconciliationId: idResult.value,
    generatedAt: timestampResult.value,
    targetRuntime: runtimeResult.value,
    inventories: plan.inventories,
    catalog: plan.catalog,
  };
}

function getAccumulator(
  artifacts: Map<string, ArtifactAccumulator>,
  sha256: string,
): ArtifactAccumulator {
  const current = artifacts.get(sha256);
  if (current !== undefined) {
    return current;
  }
  const created: ArtifactAccumulator = {
    sha256,
    observations: [],
    catalogEntries: [],
    filenames: new Set<string>(),
    runtimeMismatch: false,
  };
  artifacts.set(sha256, created);
  return created;
}

function suggestedSide(observations: readonly CatalogObservation[]): SuggestedSide {
  const activeScopes = new Set(
    observations
      .filter((observation) => observation.state === 'active')
      .map((observation) => observation.scope),
  );
  if (activeScopes.has('client') && activeScopes.has('server')) return 'both';
  if (activeScopes.has('client')) return 'client';
  if (activeScopes.has('server')) return 'server';
  return 'unknown';
}

function sidesConflict(reviewed: ModCatalogEntry['side'], suggested: SuggestedSide): boolean {
  if (suggested === 'unknown' || reviewed === 'unknown' || reviewed === 'both') return false;
  if (reviewed === 'client') return suggested === 'server' || suggested === 'both';
  return suggested === 'client' || suggested === 'both';
}

function addCatalogBlockers(
  blockers: Set<ReconciliationBlocker>,
  entries: readonly ModCatalogEntry[],
): void {
  for (const entry of entries) {
    if (entry.side === 'unknown') blockers.add('unknown-side');
    if (entry.distribution.decision === 'pending') blockers.add('distribution-pending');
    if (entry.distribution.decision === 'blocked') blockers.add('distribution-blocked');
    if (entry.reviewState !== 'reviewed') blockers.add('catalog-review-required');
  }
}

function observationKey(observation: CatalogObservation): string {
  return [
    observation.inventoryId,
    observation.path.normalize('NFC').toLocaleLowerCase('en-US'),
    observation.filename,
  ].join('\u0000');
}

function buildArtifact(
  accumulator: ArtifactAccumulator,
  collidingHashes: ReadonlySet<string>,
): ReconciledArtifact {
  const catalogEntryIds = accumulator.catalogEntries
    .map((entry) => entry.id)
    .sort(compareOrdinal);
  const filenames = [...accumulator.filenames].sort(compareOrdinal);
  const observations = [...accumulator.observations].sort((left, right) =>
    compareOrdinal(observationKey(left), observationKey(right)),
  );
  const side = suggestedSide(observations);
  const blockers = new Set<ReconciliationBlocker>();

  const matchState =
    catalogEntryIds.length === 0
      ? 'untracked'
      : catalogEntryIds.length === 1
        ? 'cataloged'
        : 'ambiguous';

  if (matchState === 'untracked') blockers.add('missing-catalog-entry');
  if (matchState === 'ambiguous') blockers.add('ambiguous-catalog-match');
  if (observations.length === 0) blockers.add('missing-inventory-evidence');
  if (observations.length > 0 && observations.every((item) => item.state !== 'active')) {
    blockers.add('inactive-only');
  }
  if (accumulator.runtimeMismatch) blockers.add('runtime-mismatch');
  if (collidingHashes.has(accumulator.sha256)) blockers.add('filename-collision');

  const sizes = new Set(observations.map((observation) => observation.sizeBytes));
  for (const entry of accumulator.catalogEntries) sizes.add(entry.sizeBytes);
  if (sizes.size > 1) blockers.add('size-mismatch');

  addCatalogBlockers(blockers, accumulator.catalogEntries);
  if (
    accumulator.catalogEntries.length === 1 &&
    accumulator.catalogEntries[0] !== undefined &&
    sidesConflict(accumulator.catalogEntries[0].side, side)
  ) {
    blockers.add('side-conflict');
  }

  return {
    artifactId: `sha256:${accumulator.sha256}`,
    sha256: accumulator.sha256,
    matchState,
    catalogEntryIds,
    filenames,
    suggestedSide: side,
    observations,
    blockers: [...blockers].sort(compareOrdinal),
  };
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

export function reconcileCatalog(input: CatalogReconciliationPlan): CatalogReconciliationReport {
  const plan = validatePlan(input);
  const artifacts = new Map<string, ArtifactAccumulator>();
  const hashesByFilename = new Map<string, Set<string>>();

  const registerFilename = (filename: string, sha256: string): void => {
    const key = normalizedFilename(filename);
    const hashes = hashesByFilename.get(key) ?? new Set<string>();
    hashes.add(sha256);
    hashesByFilename.set(key, hashes);
  };

  for (const inventory of plan.inventories) {
    const inventoryRuntimeMismatch = !runtimeMatches(inventory.runtime, plan.targetRuntime);
    for (const entry of inventory.entries) {
      const accumulator = getAccumulator(artifacts, entry.sha256);
      accumulator.filenames.add(entry.filename);
      accumulator.runtimeMismatch ||= inventoryRuntimeMismatch;
      accumulator.observations.push({
        inventoryId: inventory.inventoryId,
        sourceId: inventory.source.sourceId,
        scope: inventory.source.scope,
        path: entry.path,
        filename: entry.filename,
        state: entry.state,
        sizeBytes: entry.sizeBytes,
      });
      registerFilename(entry.filename, entry.sha256);
    }
  }

  for (const entry of plan.catalog) {
    const accumulator = getAccumulator(artifacts, entry.sha256);
    accumulator.catalogEntries.push(entry);
    accumulator.filenames.add(entry.filename);
    accumulator.runtimeMismatch ||= !runtimeMatches(entry.runtime, plan.targetRuntime);
    registerFilename(entry.filename, entry.sha256);
  }

  const collidingHashes = new Set<string>();
  for (const hashes of hashesByFilename.values()) {
    if (hashes.size > 1) {
      for (const hash of hashes) collidingHashes.add(hash);
    }
  }

  const reconciledArtifacts = [...artifacts.values()]
    .map((artifact) => buildArtifact(artifact, collidingHashes))
    .sort((left, right) => compareOrdinal(left.artifactId, right.artifactId));
  const inputs = plan.inventories
    .map((inventory) => ({
      inventoryId: inventory.inventoryId,
      sourceId: inventory.source.sourceId,
      scope: inventory.source.scope,
      type: inventory.source.type,
      observedAt: inventory.observedAt,
      entryCount: inventory.entries.length,
    }))
    .sort((left, right) => compareOrdinal(left.inventoryId, right.inventoryId));

  const report: CatalogReconciliationReport = {
    schemaVersion: 1,
    reconciliationId: plan.reconciliationId,
    generatedAt: plan.generatedAt,
    targetRuntime: { ...plan.targetRuntime },
    catalogEntryCount: plan.catalog.length,
    inputs,
    artifacts: reconciledArtifacts,
    summary: {
      totalArtifacts: reconciledArtifacts.length,
      catalogedArtifacts: reconciledArtifacts.filter(
        (artifact) => artifact.matchState === 'cataloged',
      ).length,
      untrackedArtifacts: reconciledArtifacts.filter(
        (artifact) => artifact.matchState === 'untracked',
      ).length,
      ambiguousArtifacts: reconciledArtifacts.filter(
        (artifact) => artifact.matchState === 'ambiguous',
      ).length,
      blockedArtifacts: reconciledArtifacts.filter((artifact) => artifact.blockers.length > 0)
        .length,
      unblockedArtifacts: reconciledArtifacts.filter((artifact) => artifact.blockers.length === 0)
        .length,
    },
  };

  const result = validateCatalogReconciliationReport(report);
  if (!result.success) {
    throw new CatalogReconciliationError('invalid-report', 'report', formatIssues(result.issues));
  }
  return freezeDeep(result.value);
}
