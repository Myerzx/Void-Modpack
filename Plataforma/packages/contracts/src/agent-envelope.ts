import { Type, type Static } from '@sinclair/typebox';
import {
  ContractSchemaVersion,
  IsoDateTimeSchema,
  JsonObjectSchema,
  Sha256Schema,
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

export const AgentHeartbeatPayloadSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('online'), Type.Literal('degraded')]),
    observedAt: IsoDateTimeSchema,
    protocolVersion: ContractSchemaVersion,
    softwareVersion: Type.String({ minLength: 1, maxLength: 64 }),
    capabilities: Type.Array(
      Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9]+(?:[.-][a-z0-9]+)*$' }),
      { maxItems: 64, uniqueItems: true },
    ),
  },
  { additionalProperties: false },
);

export type AgentHeartbeatPayload = Static<typeof AgentHeartbeatPayloadSchema>;

export const AgentEnvelopeSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    messageId: UuidSchema,
    correlationId: UuidSchema,
    agentId: UuidSchema,
    serverInstanceId: UuidSchema,
    kind: Type.Union([
      Type.Literal('heartbeat'),
      Type.Literal('job.lease-request'),
      Type.Literal('job.event'),
      Type.Literal('inventory.snapshot'),
      Type.Literal('telemetry.sample'),
    ]),
    issuedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    nonce: Type.String({
      minLength: 32,
      maxLength: 128,
      pattern: '^[A-Za-z0-9_-]+$',
    }),
    payloadHash: Sha256Schema,
    payload: Type.Object(
      {
        schemaVersion: Type.Integer({ minimum: 1, maximum: 65_535 }),
        data: JsonObjectSchema,
      },
      { additionalProperties: false },
    ),
    signature: SignatureSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/agent-envelope.schema.json',
    additionalProperties: false,
  },
);

export type AgentEnvelope = Static<typeof AgentEnvelopeSchema>;

export function validateAgentEnvelope(value: unknown): ContractValidationResult<AgentEnvelope> {
  const result = validateContract(AgentEnvelopeSchema, value);

  if (!result.success) {
    return result;
  }

  const issues: ContractValidationIssue[] = [];

  if (Date.parse(result.value.expiresAt) <= Date.parse(result.value.issuedAt)) {
    issues.push(semanticIssue('/expiresAt', 'expiresAt must be after issuedAt'));
  }

  return appendSemanticIssues(result, issues);
}

export function validateAgentHeartbeatPayload(
  value: unknown,
): ContractValidationResult<AgentHeartbeatPayload> {
  return validateContract(AgentHeartbeatPayloadSchema, value);
}
