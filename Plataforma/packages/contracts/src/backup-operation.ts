import { Type, type Static } from '@sinclair/typebox';
import { ContractSchemaVersion, IsoDateTimeSchema, Sha256Schema, UuidSchema } from './common.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationResult,
} from './validation.js';

/**
 * Public contracts for the Phase 10.3 backup and restore operations.
 *
 * A request names a scope and a reason. It never names a directory, a
 * repository, a storage endpoint or a credential: where backups live is trusted
 * local configuration on the agent's host, exactly as launch configuration is.
 *
 * Restore is not the inverse of backup as far as authority goes. Taking a copy
 * is safe; putting one back destroys whatever the world has become since. It is
 * therefore a separate request, a separate permission, a separate operation kind
 * and a separate agent capability — and it requires the server to have been
 * stopped first, by an operation that actually succeeded.
 */

export const BackupScopeSchema = Type.Union([
  Type.Literal('world'),
  Type.Literal('configurations'),
  Type.Literal('complete'),
]);

export const BackupReasonCodeSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z][a-z0-9._-]{0,63}$',
});

export const BackupIdempotencyKeySchema = Type.String({
  minLength: 16,
  maxLength: 128,
  pattern: '^[A-Za-z0-9._:-]+$',
});

export const BackupIdSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z][a-z0-9._-]{0,63}$',
});

export const CreateBackupRequestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    backupId: BackupIdSchema,
    scope: BackupScopeSchema,
    idempotencyKey: BackupIdempotencyKeySchema,
    reasonCode: BackupReasonCodeSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/create-backup-request.schema.json',
    additionalProperties: false,
  },
);

/**
 * A restore.
 *
 * `acknowledgesDataLoss` has no default, like force kill and like deletion:
 * restoring discards everything that happened since the backup was taken, and
 * a client that did not mean it must not reach it by omitting a field.
 *
 * `afterStopOperationId` names the graceful stop this restore follows. The
 * route re-checks that it exists, belongs to the same server and actually
 * succeeded, so a restore can never run against a world a server still has
 * open — which is how a restore corrupts both the old world and the new one.
 */
export const RestoreBackupRequestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    backupId: BackupIdSchema,
    idempotencyKey: BackupIdempotencyKeySchema,
    reasonCode: BackupReasonCodeSchema,
    acknowledgesDataLoss: Type.Literal(true),
    afterStopOperationId: UuidSchema,
    /**
     * Whether the agent should start the server after the swap and observe it
     * reach `online` before reporting success. A restore that is never booted
     * is a restore nobody has verified.
     */
    verificationBoot: Type.Boolean(),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/restore-backup-request.schema.json',
    additionalProperties: false,
  },
);

/**
 * A non-destructive recovery rehearsal.
 *
 * It restores into a new private root, composes the Forge runtime around that
 * copy, boots it on loopback and stops it. No acknowledgement of data loss is
 * present because this request has no authority to replace the active world.
 */
export const VerifyBackupRestoreRequestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    backupId: BackupIdSchema,
    idempotencyKey: BackupIdempotencyKeySchema,
    reasonCode: BackupReasonCodeSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/verify-backup-restore-request.schema.json',
    additionalProperties: false,
  },
);

/** What the control plane knows about a stored backup. */
export const BackupRecordSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    backupId: BackupIdSchema,
    serverInstanceId: UuidSchema,
    scope: BackupScopeSchema,
    status: Type.Union([
      Type.Literal('creating'),
      Type.Literal('available'),
      Type.Literal('failed'),
      Type.Literal('pruned'),
    ]),
    createdAt: IsoDateTimeSchema,
    completedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
    sizeBytes: Type.Union([
      Type.Integer({ minimum: 0, maximum: 9_007_199_254_740_991 }),
      Type.Null(),
    ]),
    fileCount: Type.Union([Type.Integer({ minimum: 0, maximum: 100_000_000 }), Type.Null()]),
    manifestSha256: Type.Union([Sha256Schema, Type.Null()]),
    /**
     * Which keys sealed and encrypted it, by identifier only. Enough to tell a
     * repository sealed under a rotated key from one that fails verification,
     * without the response carrying key material.
     */
    sealKeyId: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    encryptionKeyId: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    reasonCode: BackupReasonCodeSchema,
    failureCode: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/backup-record.schema.json',
    additionalProperties: false,
  },
);

export const BackupPageSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    serverInstanceId: UuidSchema,
    backups: Type.Array(BackupRecordSchema, { maxItems: 200 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/backup-page.schema.json',
    additionalProperties: false,
  },
);

export type BackupScopeContract = Static<typeof BackupScopeSchema>;
export type CreateBackupRequestContract = Static<typeof CreateBackupRequestSchema>;
export type RestoreBackupRequestContract = Static<typeof RestoreBackupRequestSchema>;
export type VerifyBackupRestoreRequestContract = Static<typeof VerifyBackupRestoreRequestSchema>;
export type BackupRecordContract = Static<typeof BackupRecordSchema>;
export type BackupPageContract = Static<typeof BackupPageSchema>;

export function validateCreateBackupRequest(
  value: unknown,
): ContractValidationResult<CreateBackupRequestContract> {
  return validateContract(CreateBackupRequestSchema, value);
}

export function validateRestoreBackupRequest(
  value: unknown,
): ContractValidationResult<RestoreBackupRequestContract> {
  return validateContract(RestoreBackupRequestSchema, value);
}

export function validateVerifyBackupRestoreRequest(
  value: unknown,
): ContractValidationResult<VerifyBackupRestoreRequestContract> {
  return validateContract(VerifyBackupRestoreRequestSchema, value);
}

export function validateBackupRecord(
  value: unknown,
): ContractValidationResult<BackupRecordContract> {
  const result = validateContract(BackupRecordSchema, value);
  if (!result.success) return result;
  const record = result.value;
  // An available backup has been measured and sealed. Reporting one as
  // available while its totals are unknown would let the panel offer a restore
  // from something nobody verified.
  if (
    record.status === 'available' &&
    (record.manifestSha256 === null ||
      record.sizeBytes === null ||
      record.fileCount === null ||
      record.sealKeyId === null ||
      record.completedAt === null)
  ) {
    return appendSemanticIssues(result, [
      semanticIssue('/status', 'an available backup must carry its totals and seal'),
    ]);
  }
  if (record.status === 'failed' && record.failureCode === null) {
    return appendSemanticIssues(result, [
      semanticIssue('/failureCode', 'a failed backup must name its failure'),
    ]);
  }
  if (record.status !== 'failed' && record.failureCode !== null) {
    return appendSemanticIssues(result, [
      semanticIssue('/failureCode', 'only a failed backup carries a failure'),
    ]);
  }
  return result;
}
