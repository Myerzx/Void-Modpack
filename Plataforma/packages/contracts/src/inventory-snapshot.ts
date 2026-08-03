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
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

export const InventoryScopeSchema = Type.Union([
  Type.Literal('client'),
  Type.Literal('server'),
]);

export const InventorySourceTypeSchema = Type.Union([
  Type.Literal('launcher-export'),
  Type.Literal('server-export'),
  Type.Literal('release-manifest'),
  Type.Literal('reviewed-import'),
]);

export const InventoryRuntimeSchema = Type.Object(
  {
    minecraftVersion: Type.String({ minLength: 1, maxLength: 32 }),
    loader: Type.Union([
      Type.Literal('forge'),
      Type.Literal('neoforge'),
      Type.Literal('fabric'),
      Type.Literal('quilt'),
      Type.Literal('vanilla'),
    ]),
    loaderVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  { additionalProperties: false },
);

export const InventoryFileKindSchema = Type.Union([
  Type.Literal('mod'),
  Type.Literal('library'),
  Type.Literal('config'),
  Type.Literal('resource-pack'),
  Type.Literal('shader-pack'),
  Type.Literal('script'),
  Type.Literal('datapack'),
  Type.Literal('patch'),
  Type.Literal('other'),
]);

export const InventoryEntryStateSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('disabled'),
  Type.Literal('unknown'),
]);

export const InventoryEntrySchema = Type.Object(
  {
    path: RelativePathSchema,
    filename: FileNameSchema,
    kind: InventoryFileKindSchema,
    state: InventoryEntryStateSchema,
    sizeBytes: Type.Integer({ minimum: 1 }),
    sha256: Sha256Schema,
  },
  { additionalProperties: false },
);

export const InventorySnapshotSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    inventoryId: SlugSchema,
    observedAt: IsoDateTimeSchema,
    source: Type.Object(
      {
        sourceId: SlugSchema,
        scope: InventoryScopeSchema,
        type: InventorySourceTypeSchema,
      },
      { additionalProperties: false },
    ),
    runtime: InventoryRuntimeSchema,
    entries: Type.Array(InventoryEntrySchema, { maxItems: 100_000 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/inventory-snapshot.schema.json',
    additionalProperties: false,
  },
);

export type InventoryScope = Static<typeof InventoryScopeSchema>;
export type InventorySourceType = Static<typeof InventorySourceTypeSchema>;
export type InventoryRuntime = Static<typeof InventoryRuntimeSchema>;
export type InventoryFileKind = Static<typeof InventoryFileKindSchema>;
export type InventoryEntryState = Static<typeof InventoryEntryStateSchema>;
export type InventoryEntry = Static<typeof InventoryEntrySchema>;
export type InventorySnapshot = Static<typeof InventorySnapshotSchema>;

function normalizedPath(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

export function validateInventorySnapshot(
  value: unknown,
): ContractValidationResult<InventorySnapshot> {
  const result = validateContract(InventorySnapshotSchema, value);

  if (!result.success) {
    return result;
  }

  const snapshot = result.value;
  const issues: ContractValidationIssue[] = [];
  let previousPath: string | undefined;

  for (const [index, entry] of snapshot.entries.entries()) {
    if (entry.path.split('/').at(-1) !== entry.filename) {
      issues.push(semanticIssue(`/entries/${index}/path`, 'path basename must match filename'));
    }

    const currentPath = normalizedPath(entry.path);
    if (previousPath !== undefined && previousPath >= currentPath) {
      issues.push(
        semanticIssue(
          '/entries',
          'entries must have unique paths in strict cross-platform canonical order',
        ),
      );
      break;
    }
    previousPath = currentPath;
  }

  if (
    (snapshot.source.type === 'launcher-export' ||
      snapshot.source.type === 'release-manifest') &&
    snapshot.source.scope !== 'client'
  ) {
    issues.push(
      semanticIssue('/source/scope', `${snapshot.source.type} requires client scope`),
    );
  }

  if (snapshot.source.type === 'server-export' && snapshot.source.scope !== 'server') {
    issues.push(semanticIssue('/source/scope', 'server-export requires server scope'));
  }

  return appendSemanticIssues(result, issues);
}
