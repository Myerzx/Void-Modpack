import { Type, type Static } from '@sinclair/typebox';
import {
  Base64UrlSchema,
  ContractSchemaVersion,
  IsoDateTimeSchema,
  SignatureSchema,
  UuidSchema,
} from './common.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

export const ForgeBuildRequestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    protocolVersion: Type.Literal(1),
    kind: Type.Literal('modpack.build.request'),
    requestId: UuidSchema,
    correlationId: UuidSchema,
    playerUuid: UuidSchema,
    serverInstanceId: UuidSchema,
    permission: Type.Literal('modpack.build.request'),
    nonce: Base64UrlSchema,
    issuedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    signature: SignatureSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/forge-build-request.schema.json',
    additionalProperties: false,
  },
);

export type ForgeBuildRequest = Static<typeof ForgeBuildRequestSchema>;

export function validateForgeBuildRequest(value: unknown): ContractValidationResult<ForgeBuildRequest> {
  const result = validateContract(ForgeBuildRequestSchema, value);
  if (!result.success) return result;

  const issues: ContractValidationIssue[] = [];
  const issuedAt = Date.parse(result.value.issuedAt);
  const expiresAt = Date.parse(result.value.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 120_000) {
    issues.push(
      semanticIssue('/expiresAt', 'Forge build requests must expire within two minutes of issuance'),
    );
  }
  return appendSemanticIssues(result, issues);
}
