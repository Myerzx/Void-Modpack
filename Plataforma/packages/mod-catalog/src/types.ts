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
