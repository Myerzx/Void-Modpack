import { Type, type Static } from '@sinclair/typebox';

import {
  ContractSchemaVersion,
  IsoDateTimeSchema,
  Sha256Schema,
  UuidSchema,
} from './common.js';
import { validateContract, type ContractValidationResult } from './validation.js';

/**
 * Public request accepted by the control plane before any agent work exists.
 *
 * The caller pins the immutable analysis and inventory it reviewed. The server
 * instance comes from the route, while the linked workspace is resolved by the
 * control plane; neither a root nor any other filesystem coordinate is public.
 */
export const DatapackLoadOrderObservationRequestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    analysisId: Sha256Schema,
    expectedInventorySha256: Sha256Schema,
    idempotencyKey: Type.String({
      minLength: 16,
      maxLength: 128,
      pattern: '^[A-Za-z0-9._:-]+$',
    }),
    reasonCode: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9._-]{0,63}$' }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/datapack-load-order-observation-request.schema.json',
    additionalProperties: false,
  },
);

/** The durable queue receipt returned to a panel or another API client. */
export const DatapackLoadOrderObservationAcceptanceSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    jobId: UuidSchema,
    serverInstanceId: UuidSchema,
    workspaceId: UuidSchema,
    analysisId: Sha256Schema,
    inventorySha256: Sha256Schema,
    status: Type.Union([
      Type.Literal('queued'),
      Type.Literal('running'),
      Type.Literal('succeeded'),
      Type.Literal('failed'),
    ]),
    idempotencyKey: Type.String({
      minLength: 16,
      maxLength: 128,
      pattern: '^[A-Za-z0-9._:-]+$',
    }),
    replayed: Type.Boolean(),
    correlationId: UuidSchema,
    acceptedAt: IsoDateTimeSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/datapack-load-order-observation-acceptance.schema.json',
    additionalProperties: false,
  },
);

/**
 * The complete command accepted by the datapack-order agent capability.
 *
 * It contains identities only. In particular, no path, filename, world name,
 * bytes or extensible parameters cross the work boundary. The agent resolves
 * the registered root and the literal world metadata location locally.
 */
export const DatapackLoadOrderObservationCommandSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    serverInstanceId: UuidSchema,
    workspaceId: UuidSchema,
    analysisId: Sha256Schema,
    inventorySha256: Sha256Schema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/datapack-load-order-observation-command.schema.json',
    additionalProperties: false,
  },
);

/** A sanitized receipt: identities and counts, never filesystem evidence. */
export const DatapackLoadOrderObservationResultSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    workspaceId: UuidSchema,
    analysisId: Sha256Schema,
    inventorySha256: Sha256Schema,
    observationId: Sha256Schema,
    evidenceSha256: Sha256Schema,
    datapackCount: Type.Integer({ minimum: 1, maximum: 4_096 }),
    outcome: Type.Union([Type.Literal('observed'), Type.Literal('replayed')]),
    completedAt: IsoDateTimeSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/datapack-load-order-observation-result.schema.json',
    additionalProperties: false,
  },
);

export type DatapackLoadOrderObservationCommand = Static<
  typeof DatapackLoadOrderObservationCommandSchema
>;
export type DatapackLoadOrderObservationResult = Static<
  typeof DatapackLoadOrderObservationResultSchema
>;
export type DatapackLoadOrderObservationRequest = Static<
  typeof DatapackLoadOrderObservationRequestSchema
>;
export type DatapackLoadOrderObservationAcceptance = Static<
  typeof DatapackLoadOrderObservationAcceptanceSchema
>;

export function validateDatapackLoadOrderObservationRequest(
  value: unknown,
): ContractValidationResult<DatapackLoadOrderObservationRequest> {
  return validateContract(DatapackLoadOrderObservationRequestSchema, value);
}

export function validateDatapackLoadOrderObservationAcceptance(
  value: unknown,
): ContractValidationResult<DatapackLoadOrderObservationAcceptance> {
  return validateContract(DatapackLoadOrderObservationAcceptanceSchema, value);
}

export function validateDatapackLoadOrderObservationCommand(
  value: unknown,
): ContractValidationResult<DatapackLoadOrderObservationCommand> {
  return validateContract(DatapackLoadOrderObservationCommandSchema, value);
}

export function validateDatapackLoadOrderObservationResult(
  value: unknown,
): ContractValidationResult<DatapackLoadOrderObservationResult> {
  return validateContract(DatapackLoadOrderObservationResultSchema, value);
}
