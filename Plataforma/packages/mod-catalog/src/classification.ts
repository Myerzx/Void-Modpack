import {
  IsoDateTimeSchema,
  Sha256Schema,
  SlugSchema,
  UuidSchema,
  validateContract,
  validateModCatalogEntry,
  type ModCatalogEntry,
} from '@voidfall/contracts';

import { canonicalClone, canonicalSha256, freezeDeep } from './canonical.js';
import {
  CatalogClassificationError,
  type CatalogClassificationChanges,
  type CatalogClassificationField,
  type CatalogClassificationPlan,
  type CatalogClassificationResult,
} from './types.js';

const CHANGE_FIELDS = new Set<CatalogClassificationField>([
  'side',
  'requirement',
  'distribution',
  'reviewState',
]);

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareOrdinal);
  const wanted = [...expected].sort(compareOrdinal);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validScalar(schema: Parameters<typeof validateContract>[0], value: unknown): boolean {
  return validateContract(schema, value).success;
}

function validateChanges(value: unknown): CatalogClassificationChanges {
  if (!isRecord(value)) throw new CatalogClassificationError('invalid-changes');
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !CHANGE_FIELDS.has(key as CatalogClassificationField))) {
    throw new CatalogClassificationError('invalid-changes');
  }
  return value as CatalogClassificationChanges;
}

export function hashCatalogEntry(entry: ModCatalogEntry): string {
  const result = validateModCatalogEntry(entry);
  if (!result.success) throw new CatalogClassificationError('invalid-entry');
  return canonicalSha256(result.value);
}

export function classifyCatalogEntry(input: CatalogClassificationPlan): CatalogClassificationResult {
  if (
    !isRecord(input) ||
    !exactKeys(input, [
      'revisionId',
      'actorId',
      'reasonCode',
      'reviewedAt',
      'expectedEntrySha256',
      'entry',
      'changes',
    ]) ||
    !validScalar(SlugSchema, input.revisionId) ||
    !validScalar(UuidSchema, input.actorId) ||
    !validScalar(SlugSchema, input.reasonCode) ||
    !validScalar(IsoDateTimeSchema, input.reviewedAt) ||
    !validScalar(Sha256Schema, input.expectedEntrySha256)
  ) {
    throw new CatalogClassificationError('invalid-plan');
  }

  const currentResult = validateModCatalogEntry(input.entry);
  if (!currentResult.success) throw new CatalogClassificationError('invalid-entry');
  const changes = validateChanges(input.changes);
  const previous = canonicalClone(currentResult.value);
  const previousHash = canonicalSha256(previous);
  if (previousHash !== input.expectedEntrySha256) {
    throw new CatalogClassificationError('concurrent-modification');
  }

  const candidate: ModCatalogEntry = {
    ...previous,
    ...(changes.side !== undefined ? { side: changes.side } : {}),
    ...(changes.requirement !== undefined ? { requirement: changes.requirement } : {}),
    ...(changes.distribution !== undefined
      ? { distribution: canonicalClone(changes.distribution) }
      : {}),
    ...(changes.reviewState !== undefined ? { reviewState: changes.reviewState } : {}),
  };
  const candidateResult = validateModCatalogEntry(candidate);
  if (!candidateResult.success) throw new CatalogClassificationError('invalid-changes');
  if (
    candidateResult.value.reviewState === 'reviewed' &&
    (candidateResult.value.side === 'unknown' ||
      candidateResult.value.distribution.decision === 'pending')
  ) {
    throw new CatalogClassificationError('invalid-transition');
  }

  const currentHash = canonicalSha256(candidateResult.value);
  if (currentHash === previousHash) throw new CatalogClassificationError('no-change');
  const changedFields = (Object.keys(changes) as CatalogClassificationField[])
    .filter(
      (field) =>
        canonicalSha256(previous[field]) !== canonicalSha256(candidateResult.value[field]),
    )
    .sort(compareOrdinal);
  if (changedFields.length === 0) throw new CatalogClassificationError('no-change');

  return freezeDeep({
    entry: canonicalClone(candidateResult.value),
    revision: {
      schemaVersion: 1,
      revisionId: input.revisionId,
      catalogEntryId: candidateResult.value.id,
      actorId: input.actorId,
      reasonCode: input.reasonCode,
      reviewedAt: input.reviewedAt,
      previousEntrySha256: previousHash,
      currentEntrySha256: currentHash,
      changedFields,
    },
  });
}
