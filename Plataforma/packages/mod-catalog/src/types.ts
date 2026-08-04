import type {
  CatalogReconciliationReport,
  InventoryRuntime,
  InventorySnapshot,
  ModCatalogEntry,
} from '@voidfall/contracts';

export interface CatalogReconciliationPlan {
  readonly reconciliationId: string;
  readonly generatedAt: string;
  readonly targetRuntime: InventoryRuntime;
  readonly inventories: readonly InventorySnapshot[];
  readonly catalog: readonly ModCatalogEntry[];
}

export type CatalogReconciliationErrorCode =
  | 'invalid-plan'
  | 'invalid-inventory'
  | 'invalid-catalog-entry'
  | 'duplicate-inventory-id'
  | 'duplicate-catalog-id'
  | 'invalid-report';

export type CatalogReconciliationStage = 'plan' | 'inventory' | 'catalog' | 'report';

export class CatalogReconciliationError extends Error {
  public readonly code: CatalogReconciliationErrorCode;
  public readonly stage: CatalogReconciliationStage;
  public readonly issues: readonly string[];

  public constructor(
    code: CatalogReconciliationErrorCode,
    stage: CatalogReconciliationStage,
    issues: readonly string[] = [],
  ) {
    super(`${code}:${stage}`);
    this.name = 'CatalogReconciliationError';
    this.code = code;
    this.stage = stage;
    this.issues = Object.freeze([...issues]);
  }
}

export type ReconcileCatalog = (
  plan: CatalogReconciliationPlan,
) => CatalogReconciliationReport;

export type CatalogClassificationField =
  | 'side'
  | 'requirement'
  | 'distribution'
  | 'reviewState';

export interface CatalogClassificationChanges {
  readonly side?: ModCatalogEntry['side'];
  readonly requirement?: ModCatalogEntry['requirement'];
  readonly distribution?: ModCatalogEntry['distribution'];
  readonly reviewState?: ModCatalogEntry['reviewState'];
}

export interface CatalogClassificationPlan {
  readonly revisionId: string;
  readonly actorId: string;
  readonly reasonCode: string;
  readonly reviewedAt: string;
  readonly expectedEntrySha256: string;
  readonly entry: ModCatalogEntry;
  readonly changes: CatalogClassificationChanges;
}

export interface CatalogClassificationRevision {
  readonly schemaVersion: 1;
  readonly revisionId: string;
  readonly catalogEntryId: string;
  readonly actorId: string;
  readonly reasonCode: string;
  readonly reviewedAt: string;
  readonly previousEntrySha256: string;
  readonly currentEntrySha256: string;
  readonly changedFields: readonly CatalogClassificationField[];
}

export interface CatalogClassificationResult {
  readonly entry: ModCatalogEntry;
  readonly revision: CatalogClassificationRevision;
}

export type CatalogClassificationErrorCode =
  | 'invalid-plan'
  | 'invalid-entry'
  | 'invalid-changes'
  | 'concurrent-modification'
  | 'invalid-transition'
  | 'no-change';

export class CatalogClassificationError extends Error {
  public readonly code: CatalogClassificationErrorCode;

  public constructor(code: CatalogClassificationErrorCode) {
    super(`catalog-classification:${code}`);
    this.name = 'CatalogClassificationError';
    this.code = code;
  }
}

export interface CatalogConflictConstraint {
  readonly constraintId: string;
  readonly leftId: string;
  readonly rightId: string;
  readonly evidenceReference: string;
}

export interface CatalogDependencyAnalysisPlan {
  readonly analysisId: string;
  readonly generatedAt: string;
  readonly catalog: readonly ModCatalogEntry[];
  readonly conflicts: readonly CatalogConflictConstraint[];
}

export type CatalogAnalysisIssueCode =
  | 'duplicate-catalog-id'
  | 'duplicate-content'
  | 'filename-collision'
  | 'missing-required-dependency'
  | 'missing-optional-dependency'
  | 'self-dependency'
  | 'required-dependency-cycle'
  | 'dependency-version-mismatch'
  | 'unverified-version-range'
  | 'runtime-mismatch'
  | 'explicit-conflict';

export interface CatalogAnalysisIssue {
  readonly code: CatalogAnalysisIssueCode;
  readonly severity: 'blocker' | 'warning';
  readonly entryIds: readonly string[];
  readonly reference?: string;
}

export interface CatalogDependencyAnalysisReport {
  readonly schemaVersion: 1;
  readonly analysisId: string;
  readonly generatedAt: string;
  readonly catalogEntryCount: number;
  readonly issues: readonly CatalogAnalysisIssue[];
  readonly summary: {
    readonly blockerCount: number;
    readonly warningCount: number;
    readonly affectedEntryCount: number;
  };
}

export type CatalogDependencyAnalysisErrorCode =
  | 'invalid-plan'
  | 'invalid-catalog-entry'
  | 'invalid-conflict';

export class CatalogDependencyAnalysisError extends Error {
  public readonly code: CatalogDependencyAnalysisErrorCode;

  public constructor(code: CatalogDependencyAnalysisErrorCode) {
    super(`catalog-dependency-analysis:${code}`);
    this.name = 'CatalogDependencyAnalysisError';
    this.code = code;
  }
}

export type ContextualCompatibilityAnalysisErrorCode = 'invalid-plan' | 'invalid-report';

export class ContextualCompatibilityAnalysisError extends Error {
  public readonly code: ContextualCompatibilityAnalysisErrorCode;
  public readonly issues: readonly string[];

  public constructor(
    code: ContextualCompatibilityAnalysisErrorCode,
    issues: readonly string[] = [],
  ) {
    super(`contextual-compatibility-analysis:${code}`);
    this.name = 'ContextualCompatibilityAnalysisError';
    this.code = code;
    this.issues = Object.freeze([...issues]);
  }
}
