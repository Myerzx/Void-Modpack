import { Type, type Static } from '@sinclair/typebox';

import {
  ContractSchemaVersion,
  IsoDateTimeSchema,
  Sha256Schema,
  UuidSchema,
} from './common.js';
import { validateContract, type ContractValidationResult } from './validation.js';

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
