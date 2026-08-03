import { Type, type Static } from '@sinclair/typebox';
import {
  ContractSchemaVersion,
  FileNameSchema,
  IsoDateTimeSchema,
  RelativePathSchema,
  SemanticVersionSchema,
  Sha256Schema,
  SlugSchema,
  UuidSchema,
} from './common.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

export const ModCatalogEntrySchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    id: SlugSchema,
    logicalName: Type.String({ minLength: 1, maxLength: 160 }),
    filename: FileNameSchema,
    path: RelativePathSchema,
    kind: Type.Union([
      Type.Literal('mod'),
      Type.Literal('library'),
      Type.Literal('config'),
      Type.Literal('resource-pack'),
      Type.Literal('shader-pack'),
      Type.Literal('script'),
      Type.Literal('datapack'),
      Type.Literal('patch'),
      Type.Literal('other'),
    ]),
    side: Type.Union([
      Type.Literal('unknown'),
      Type.Literal('client'),
      Type.Literal('server'),
      Type.Literal('both'),
    ]),
    requirement: Type.Union([
      Type.Literal('required'),
      Type.Literal('optional'),
      Type.Literal('library'),
    ]),
    version: Type.Optional(SemanticVersionSchema),
    sizeBytes: Type.Integer({ minimum: 1 }),
    sha256: Sha256Schema,
    runtime: Type.Object(
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
    ),
    source: Type.Object(
      {
        provider: Type.Union([
          Type.Literal('curseforge'),
          Type.Literal('modrinth'),
          Type.Literal('github'),
          Type.Literal('manual-reviewed'),
        ]),
        projectId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        fileId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        sourceUrl: Type.Optional(Type.String({ format: 'uri', maxLength: 2_048 })),
      },
      { additionalProperties: false },
    ),
    distribution: Type.Object(
      {
        decision: Type.Union([
          Type.Literal('pending'),
          Type.Literal('allowed'),
          Type.Literal('blocked'),
        ]),
        licenseExpression: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
        evidenceReference: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
        reviewedBy: Type.Optional(UuidSchema),
        reviewedAt: Type.Optional(IsoDateTimeSchema),
      },
      { additionalProperties: false },
    ),
    reviewState: Type.Union([
      Type.Literal('detected'),
      Type.Literal('reviewed'),
      Type.Literal('quarantined'),
    ]),
    dependencies: Type.Array(
      Type.Object(
        {
          id: SlugSchema,
          versionRange: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          required: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      { maxItems: 512 },
    ),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/mod-catalog-entry.schema.json',
    additionalProperties: false,
  },
);

export type ModCatalogEntry = Static<typeof ModCatalogEntrySchema>;

export function validateModCatalogEntry(value: unknown): ContractValidationResult<ModCatalogEntry> {
  const result = validateContract(ModCatalogEntrySchema, value);

  if (!result.success) {
    return result;
  }

  const entry = result.value;
  const issues: ContractValidationIssue[] = [];
  const actualFilename = entry.path.split('/').at(-1);

  if (actualFilename !== entry.filename) {
    issues.push(semanticIssue('/path', 'path basename must match filename'));
  }

  if (
    entry.distribution.decision === 'allowed' &&
    (entry.distribution.licenseExpression === undefined ||
      entry.distribution.evidenceReference === undefined ||
      entry.distribution.reviewedBy === undefined ||
      entry.distribution.reviewedAt === undefined)
  ) {
    issues.push(
      semanticIssue(
        '/distribution',
        'an allowed distribution requires license, evidence, reviewer and review timestamp',
      ),
    );
  }

  return appendSemanticIssues(result, issues);
}

export function canPublishInStable(entry: ModCatalogEntry): boolean {
  return (
    entry.side !== 'unknown' &&
    entry.side !== 'server' &&
    entry.distribution.decision === 'allowed' &&
    entry.reviewState === 'reviewed'
  );
}
