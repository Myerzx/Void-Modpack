import {
  validateAuditChainExportManifest,
  validateAuditEvent,
  type AuditEvent,
} from '@voidfall/contracts';
import { canonicalJson, immutable, sha256 } from './canonical.js';
import {
  AuditChainError,
  type AuditChainOptions,
  type AuditChainRecord,
  type AuditChainVerificationIssue,
  type AuditChainVerificationResult,
  type AuditExportArtifact,
  type AuditExportRequest,
} from './types.js';

const PARTITION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function assertPartition(value: string): void {
  if (value.length < 2 || value.length > 64 || !PARTITION.test(value)) {
    throw new AuditChainError('invalid-partition');
  }
}

function assertSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new AuditChainError('invalid-sequence');
}

function canonicalTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new AuditChainError('invalid-event');
  return parsed.toISOString();
}

function eventWithoutIntegrity(event: AuditEvent): Omit<AuditEvent, 'integrity'> {
  const { integrity: _integrity, ...payload } = event;
  return payload;
}

export function computeAuditEventHash(input: {
  readonly partitionId: string;
  readonly sequence: number;
  readonly previousHash: string | null;
  readonly event: AuditEvent;
}): string {
  assertPartition(input.partitionId);
  assertSequence(input.sequence);
  if (input.previousHash !== null && !SHA256.test(input.previousHash)) {
    throw new AuditChainError('invalid-hash');
  }
  return sha256(
    canonicalJson({
      algorithm: 'sha256-chain-v1',
      partitionId: input.partitionId,
      sequence: input.sequence,
      previousHash: input.previousHash,
      event: eventWithoutIntegrity(input.event),
    }),
  );
}

export function chainAuditEvent(input: {
  readonly partitionId: string;
  readonly sequence: number;
  readonly previousHash: string | null;
  readonly event: AuditEvent;
}): AuditChainRecord {
  assertPartition(input.partitionId);
  assertSequence(input.sequence);
  if (input.event.integrity !== undefined) {
    throw new AuditChainError('producer-owned-integrity');
  }
  const validation = validateAuditEvent(input.event);
  if (!validation.success) throw new AuditChainError('invalid-event');
  const eventHash = computeAuditEventHash({ ...input, event: validation.value });
  return immutable({
    partitionId: input.partitionId,
    sequence: input.sequence,
    event: {
      ...validation.value,
      integrity: { previousHash: input.previousHash, eventHash },
    },
  });
}

export function verifyAuditChain(records: readonly AuditChainRecord[]): AuditChainVerificationResult {
  if (records.length === 0) {
    return { valid: true, partitionId: null, recordCount: 0, finalHash: null, issues: [] };
  }
  const first = records[0];
  if (first === undefined) {
    return { valid: true, partitionId: null, recordCount: 0, finalHash: null, issues: [] };
  }
  const partitionId = first.partitionId;
  const issues: AuditChainVerificationIssue[] = [];
  const eventIds = new Set<string>();
  let expectedSequence = first.sequence;
  let expectedPreviousHash = first.event.integrity?.previousHash ?? null;
  let finalHash: string | null = null;

  for (const record of records) {
    if (record.partitionId !== partitionId) {
      issues.push({ sequence: record.sequence, code: 'partition-mismatch' });
    }
    if (record.sequence !== expectedSequence) {
      issues.push({ sequence: record.sequence, code: 'sequence-gap' });
    }
    const validation = validateAuditEvent(record.event);
    if (!validation.success) issues.push({ sequence: record.sequence, code: 'invalid-event' });
    if (eventIds.has(record.event.id)) {
      issues.push({ sequence: record.sequence, code: 'duplicate-event' });
    }
    eventIds.add(record.event.id);
    const integrity = record.event.integrity;
    if (integrity === undefined) {
      issues.push({ sequence: record.sequence, code: 'missing-integrity' });
      finalHash = null;
    } else {
      if (integrity.previousHash !== expectedPreviousHash) {
        issues.push({ sequence: record.sequence, code: 'previous-hash-mismatch' });
      }
      let expectedHash: string | undefined;
      try {
        expectedHash = computeAuditEventHash({
          partitionId: record.partitionId,
          sequence: record.sequence,
          previousHash: integrity.previousHash,
          event: record.event,
        });
      } catch {
        expectedHash = undefined;
      }
      if (expectedHash === undefined || integrity.eventHash !== expectedHash) {
        issues.push({ sequence: record.sequence, code: 'event-hash-mismatch' });
      }
      expectedPreviousHash = integrity.eventHash;
      finalHash = integrity.eventHash;
    }
    expectedSequence = record.sequence + 1;
  }

  return issues.length === 0
    ? { valid: true, partitionId, recordCount: records.length, finalHash, issues: [] }
    : { valid: false, partitionId, recordCount: records.length, finalHash, issues: immutable(issues) };
}

export function createAuditExport(
  records: readonly AuditChainRecord[],
  request: AuditExportRequest,
): AuditExportArtifact {
  if (records.length === 0) throw new AuditChainError('empty-export');
  if (!UUID.test(request.exportId)) throw new AuditChainError('invalid-event');
  const generatedAt = canonicalTimestamp(request.generatedAt);
  const verification = verifyAuditChain(records);
  if (!verification.valid) throw new AuditChainError('invalid-event');
  const first = records[0];
  const last = records.at(-1);
  if (first === undefined || last === undefined || last.event.integrity === undefined) {
    throw new AuditChainError('empty-export');
  }
  const content = records
    .map((record) => canonicalJson({ schemaVersion: 1, ...record }))
    .join('\n') + '\n';
  const manifest = {
    schemaVersion: 1 as const,
    exportId: request.exportId,
    algorithm: 'sha256-chain-v1' as const,
    partitionId: first.partitionId,
    generatedAt,
    firstSequence: first.sequence,
    lastSequence: last.sequence,
    recordCount: records.length,
    previousHash: first.event.integrity?.previousHash ?? null,
    finalHash: last.event.integrity.eventHash,
    contentSha256: sha256(content),
    mediaType: 'application/x-ndjson' as const,
    encoding: 'utf-8' as const,
  };
  const validation = validateAuditChainExportManifest(manifest);
  if (!validation.success) throw new AuditChainError('invalid-event');
  return immutable({ manifest: validation.value, content });
}

export class InMemoryAuditChain {
  readonly #options: AuditChainOptions;
  readonly #partitions = new Map<string, readonly AuditChainRecord[]>();
  readonly #eventIds = new Set<string>();

  public constructor(options: AuditChainOptions) {
    if (
      !Number.isSafeInteger(options.maximumPartitions) ||
      options.maximumPartitions < 1 ||
      options.maximumPartitions > 10_000 ||
      !Number.isSafeInteger(options.maximumRecordsPerPartition) ||
      options.maximumRecordsPerPartition < 1 ||
      options.maximumRecordsPerPartition > 1_000_000
    ) {
      throw new AuditChainError('invalid-options');
    }
    this.#options = immutable(options);
  }

  public append(partitionId: string, event: AuditEvent): AuditChainRecord {
    assertPartition(partitionId);
    if (this.#eventIds.has(event.id)) throw new AuditChainError('duplicate-event');
    const current = this.#partitions.get(partitionId) ?? [];
    if (current.length === 0 && !this.#partitions.has(partitionId)) {
      if (this.#partitions.size >= this.#options.maximumPartitions) {
        throw new AuditChainError('partition-limit-exceeded');
      }
    }
    if (current.length >= this.#options.maximumRecordsPerPartition) {
      throw new AuditChainError('record-limit-exceeded');
    }
    const last = current.at(-1);
    const record = chainAuditEvent({
      partitionId,
      sequence: current.length + 1,
      previousHash: last?.event.integrity?.eventHash ?? null,
      event,
    });
    this.#partitions.set(partitionId, immutable([...current, record]));
    this.#eventIds.add(record.event.id);
    return immutable(record);
  }

  public list(partitionId: string): readonly AuditChainRecord[] {
    assertPartition(partitionId);
    return immutable(this.#partitions.get(partitionId) ?? []);
  }

  public verify(partitionId: string): AuditChainVerificationResult {
    assertPartition(partitionId);
    return verifyAuditChain(this.#partitions.get(partitionId) ?? []);
  }

  public export(partitionId: string, request: AuditExportRequest): AuditExportArtifact {
    assertPartition(partitionId);
    const records = this.#partitions.get(partitionId);
    if (records === undefined) throw new AuditChainError('partition-not-found');
    const firstSequence = request.firstSequence ?? records[0]?.sequence;
    const lastSequence = request.lastSequence ?? records.at(-1)?.sequence;
    if (
      firstSequence === undefined ||
      lastSequence === undefined ||
      !Number.isSafeInteger(firstSequence) ||
      !Number.isSafeInteger(lastSequence) ||
      firstSequence < 1 ||
      lastSequence < firstSequence
    ) {
      throw new AuditChainError('invalid-export-range');
    }
    const selected = records.filter(
      (record) => record.sequence >= firstSequence && record.sequence <= lastSequence,
    );
    if (
      selected.length !== lastSequence - firstSequence + 1 ||
      selected[0]?.sequence !== firstSequence ||
      selected.at(-1)?.sequence !== lastSequence
    ) {
      throw new AuditChainError('invalid-export-range');
    }
    return createAuditExport(selected, request);
  }
}
