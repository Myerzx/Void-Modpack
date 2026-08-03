import { Type, type Static } from '@sinclair/typebox';
import {
  ContractSchemaVersion,
  IsoDateTimeSchema,
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

export const AuditChainExportManifestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    exportId: UuidSchema,
    algorithm: Type.Literal('sha256-chain-v1'),
    partitionId: SlugSchema,
    generatedAt: IsoDateTimeSchema,
    firstSequence: Type.Integer({ minimum: 1 }),
    lastSequence: Type.Integer({ minimum: 1 }),
    recordCount: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    previousHash: Type.Union([Sha256Schema, Type.Null()]),
    finalHash: Sha256Schema,
    contentSha256: Sha256Schema,
    mediaType: Type.Literal('application/x-ndjson'),
    encoding: Type.Literal('utf-8'),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/audit-chain-export-manifest.schema.json',
    additionalProperties: false,
  },
);

export type AuditChainExportManifest = Static<typeof AuditChainExportManifestSchema>;

export function validateAuditChainExportManifest(
  value: unknown,
): ContractValidationResult<AuditChainExportManifest> {
  const result = validateContract(AuditChainExportManifestSchema, value);
  if (!result.success) return result;

  const manifest = result.value;
  const issues: ContractValidationIssue[] = [];
  if (manifest.lastSequence < manifest.firstSequence) {
    issues.push(semanticIssue('/lastSequence', 'last sequence cannot precede first sequence'));
  }
  if (manifest.lastSequence - manifest.firstSequence + 1 !== manifest.recordCount) {
    issues.push(semanticIssue('/recordCount', 'record count must match the contiguous sequence range'));
  }
  return appendSemanticIssues(result, issues);
}
