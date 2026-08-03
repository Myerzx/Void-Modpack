import { BackupOperationError, type BackupLimits } from './types.js';

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const BACKUP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{6,62}[a-z0-9])$/u;
const LOGICAL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;

export function failPlan(): never {
  throw new BackupOperationError('invalid-plan', 'plan');
}

export function validateBackupId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !BACKUP_ID_PATTERN.test(value)) failPlan();
}

export function validateIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) failPlan();
}

export function validateLogicalName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !LOGICAL_NAME_PATTERN.test(value)) failPlan();
}

export function validateServerRelease(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !RELEASE_PATTERN.test(value)) failPlan();
}

export function parseCanonicalTimestamp(value: unknown): Date {
  if (typeof value !== 'string') failPlan();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) failPlan();
  return parsed;
}

export function clockTimestamp(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) failPlan();
  return value.toISOString();
}

function validateBoundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    failPlan();
  }
  return value;
}

export function resolveLimits(
  defaults: BackupLimits,
  overrides: Partial<BackupLimits> | undefined,
): BackupLimits {
  if (overrides !== undefined) {
    const allowed = new Set([
      'maximumFiles',
      'maximumTotalBytes',
      'maximumFileBytes',
      'maximumDepth',
      'minimumFreeBytesAfterCopy',
    ]);
    if (Object.keys(overrides).some((key) => !allowed.has(key))) failPlan();
  }

  const limits = {
    maximumFiles: validateBoundedInteger(
      overrides?.maximumFiles ?? defaults.maximumFiles,
      1,
      1_000_000,
    ),
    maximumTotalBytes: validateBoundedInteger(
      overrides?.maximumTotalBytes ?? defaults.maximumTotalBytes,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maximumFileBytes: validateBoundedInteger(
      overrides?.maximumFileBytes ?? defaults.maximumFileBytes,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maximumDepth: validateBoundedInteger(
      overrides?.maximumDepth ?? defaults.maximumDepth,
      1,
      256,
    ),
    minimumFreeBytesAfterCopy: validateBoundedInteger(
      overrides?.minimumFreeBytesAfterCopy ?? defaults.minimumFreeBytesAfterCopy,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  } satisfies BackupLimits;

  if (limits.maximumFileBytes > limits.maximumTotalBytes) failPlan();
  return Object.freeze(limits);
}
