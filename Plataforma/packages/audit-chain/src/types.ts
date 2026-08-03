import type { AuditChainExportManifest, AuditEvent } from '@voidfall/contracts';

export type AuditChainErrorCode =
  | 'invalid-options'
  | 'invalid-partition'
  | 'invalid-sequence'
  | 'invalid-hash'
  | 'invalid-event'
  | 'producer-owned-integrity'
  | 'duplicate-event'
  | 'partition-limit-exceeded'
  | 'record-limit-exceeded'
  | 'partition-not-found'
  | 'empty-export'
  | 'invalid-export-range';

export class AuditChainError extends Error {
  public readonly code: AuditChainErrorCode;

  public constructor(code: AuditChainErrorCode) {
    super(`audit-chain:${code}`);
    this.name = 'AuditChainError';
    this.code = code;
  }
}

export interface AuditChainRecord {
  readonly partitionId: string;
  readonly sequence: number;
  readonly event: AuditEvent;
}

export type AuditChainVerificationIssueCode =
  | 'partition-mismatch'
  | 'sequence-gap'
  | 'missing-integrity'
  | 'previous-hash-mismatch'
  | 'event-hash-mismatch'
  | 'invalid-event'
  | 'duplicate-event';

export interface AuditChainVerificationIssue {
  readonly sequence: number;
  readonly code: AuditChainVerificationIssueCode;
}

export type AuditChainVerificationResult =
  | {
      readonly valid: true;
      readonly partitionId: string | null;
      readonly recordCount: number;
      readonly finalHash: string | null;
      readonly issues: readonly [];
    }
  | {
      readonly valid: false;
      readonly partitionId: string | null;
      readonly recordCount: number;
      readonly finalHash: string | null;
      readonly issues: readonly AuditChainVerificationIssue[];
    };

export interface AuditChainOptions {
  readonly maximumPartitions: number;
  readonly maximumRecordsPerPartition: number;
}

export interface AuditExportRequest {
  readonly exportId: string;
  readonly generatedAt: string;
  readonly firstSequence?: number;
  readonly lastSequence?: number;
}

export interface AuditExportArtifact {
  readonly manifest: AuditChainExportManifest;
  readonly content: string;
}
