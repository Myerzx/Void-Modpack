import { Type, type Static } from '@sinclair/typebox';
import {
  ContractSchemaVersion,
  FileNameSchema,
  IsoDateTimeSchema,
  RelativePathSchema,
  Sha256Schema,
  SlugSchema,
} from './common.js';
import {
  InventoryEntryStateSchema,
  InventoryRuntimeSchema,
  InventoryScopeSchema,
  InventorySourceTypeSchema,
} from './inventory-snapshot.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

export const CatalogMatchStateSchema = Type.Union([
  Type.Literal('cataloged'),
  Type.Literal('untracked'),
  Type.Literal('ambiguous'),
]);

export const SuggestedSideSchema = Type.Union([
  Type.Literal('unknown'),
  Type.Literal('client'),
  Type.Literal('server'),
  Type.Literal('both'),
]);

export const ReconciliationBlockerSchema = Type.Union([
  Type.Literal('missing-catalog-entry'),
  Type.Literal('ambiguous-catalog-match'),
  Type.Literal('missing-inventory-evidence'),
  Type.Literal('inactive-only'),
  Type.Literal('unknown-side'),
  Type.Literal('side-conflict'),
  Type.Literal('distribution-pending'),
  Type.Literal('distribution-blocked'),
  Type.Literal('catalog-review-required'),
  Type.Literal('runtime-mismatch'),
  Type.Literal('filename-collision'),
  Type.Literal('size-mismatch'),
]);

export const CatalogObservationSchema = Type.Object(
  {
    inventoryId: SlugSchema,
    sourceId: SlugSchema,
    scope: InventoryScopeSchema,
    path: RelativePathSchema,
    filename: FileNameSchema,
    state: InventoryEntryStateSchema,
    sizeBytes: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const ReconciledArtifactSchema = Type.Object(
  {
    artifactId: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    sha256: Sha256Schema,
    matchState: CatalogMatchStateSchema,
    catalogEntryIds: Type.Array(SlugSchema, { maxItems: 64 }),
    filenames: Type.Array(FileNameSchema, { minItems: 1, maxItems: 1_024 }),
    suggestedSide: SuggestedSideSchema,
    observations: Type.Array(CatalogObservationSchema, { maxItems: 100_000 }),
    blockers: Type.Array(ReconciliationBlockerSchema, { maxItems: 12 }),
  },
  { additionalProperties: false },
);

export const CatalogReconciliationReportSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    reconciliationId: SlugSchema,
    generatedAt: IsoDateTimeSchema,
    targetRuntime: InventoryRuntimeSchema,
    catalogEntryCount: Type.Integer({ minimum: 0, maximum: 100_000 }),
    inputs: Type.Array(
      Type.Object(
        {
          inventoryId: SlugSchema,
          sourceId: SlugSchema,
          scope: InventoryScopeSchema,
          type: InventorySourceTypeSchema,
          observedAt: IsoDateTimeSchema,
          entryCount: Type.Integer({ minimum: 0, maximum: 100_000 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 128 },
    ),
    artifacts: Type.Array(ReconciledArtifactSchema, { maxItems: 200_000 }),
    summary: Type.Object(
      {
        totalArtifacts: Type.Integer({ minimum: 0 }),
        catalogedArtifacts: Type.Integer({ minimum: 0 }),
        untrackedArtifacts: Type.Integer({ minimum: 0 }),
        ambiguousArtifacts: Type.Integer({ minimum: 0 }),
        blockedArtifacts: Type.Integer({ minimum: 0 }),
        unblockedArtifacts: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/catalog-reconciliation-report.schema.json',
    additionalProperties: false,
  },
);

export type CatalogMatchState = Static<typeof CatalogMatchStateSchema>;
export type SuggestedSide = Static<typeof SuggestedSideSchema>;
export type ReconciliationBlocker = Static<typeof ReconciliationBlockerSchema>;
export type CatalogObservation = Static<typeof CatalogObservationSchema>;
export type ReconciledArtifact = Static<typeof ReconciledArtifactSchema>;
export type CatalogReconciliationReport = Static<typeof CatalogReconciliationReportSchema>;

function isStrictlySortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined || previous >= current) {
      return false;
    }
  }
  return true;
}

function observationKey(observation: CatalogObservation): string {
  return [
    observation.inventoryId,
    observation.path.normalize('NFC').toLocaleLowerCase('en-US'),
    observation.filename,
  ].join('\u0000');
}

export function validateCatalogReconciliationReport(
  value: unknown,
): ContractValidationResult<CatalogReconciliationReport> {
  const result = validateContract(CatalogReconciliationReportSchema, value);

  if (!result.success) {
    return result;
  }

  const report = result.value;
  const issues: ContractValidationIssue[] = [];
  const inputIds = report.inputs.map((input) => input.inventoryId);
  const artifactIds = report.artifacts.map((artifact) => artifact.artifactId);

  if (!isStrictlySortedUnique(inputIds)) {
    issues.push(semanticIssue('/inputs', 'inputs must be unique and sorted by inventoryId'));
  }
  if (!isStrictlySortedUnique(artifactIds)) {
    issues.push(semanticIssue('/artifacts', 'artifacts must be unique and sorted by artifactId'));
  }

  for (const [index, artifact] of report.artifacts.entries()) {
    if (artifact.artifactId !== `sha256:${artifact.sha256}`) {
      issues.push(
        semanticIssue(
          `/artifacts/${index}/artifactId`,
          'artifactId must be derived from SHA-256',
        ),
      );
    }
    if (!isStrictlySortedUnique(artifact.catalogEntryIds)) {
      issues.push(
        semanticIssue(
          `/artifacts/${index}/catalogEntryIds`,
          'catalog entry IDs must be unique and sorted',
        ),
      );
    }
    if (!isStrictlySortedUnique(artifact.filenames)) {
      issues.push(
        semanticIssue(`/artifacts/${index}/filenames`, 'filenames must be unique and sorted'),
      );
    }
    if (!isStrictlySortedUnique(artifact.blockers)) {
      issues.push(
        semanticIssue(`/artifacts/${index}/blockers`, 'blockers must be unique and sorted'),
      );
    }
    const observationKeys = artifact.observations.map(observationKey);
    if (!isStrictlySortedUnique(observationKeys)) {
      issues.push(
        semanticIssue(
          `/artifacts/${index}/observations`,
          'observations must be unique and sorted canonically',
        ),
      );
    }
  }

  const expectedSummary = {
    totalArtifacts: report.artifacts.length,
    catalogedArtifacts: report.artifacts.filter(
      (artifact) => artifact.matchState === 'cataloged',
    ).length,
    untrackedArtifacts: report.artifacts.filter(
      (artifact) => artifact.matchState === 'untracked',
    ).length,
    ambiguousArtifacts: report.artifacts.filter(
      (artifact) => artifact.matchState === 'ambiguous',
    ).length,
    blockedArtifacts: report.artifacts.filter((artifact) => artifact.blockers.length > 0).length,
    unblockedArtifacts: report.artifacts.filter((artifact) => artifact.blockers.length === 0).length,
  };

  if (JSON.stringify(report.summary) !== JSON.stringify(expectedSummary)) {
    issues.push(semanticIssue('/summary', 'summary must match the artifact collection'));
  }

  return appendSemanticIssues(result, issues);
}
