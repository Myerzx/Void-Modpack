export const VOIDFALL_QUARANTINE_MANIFEST_FORMAT = 'voidfall-quarantine-artifact' as const;
export const VOIDFALL_QUARANTINE_MANIFEST_SCHEMA_VERSION = 1 as const;

export type QuarantineExtension = '.jar' | '.zip';
export type QuarantineArtifactKind =
  | 'mod'
  | 'resource-pack'
  | 'shader-pack'
  | 'datapack'
  | 'other';

export interface ArtifactQuarantineOptions {
  readonly quarantineRoot: string;
  readonly allowedExtensions: readonly QuarantineExtension[];
  readonly maximumArtifactBytes: number;
}

export interface QuarantineArtifactPlan {
  readonly quarantineId: string;
  readonly filename: string;
  readonly kind: QuarantineArtifactKind;
  readonly receivedAt: string;
  readonly declaredSizeBytes: number;
  readonly expectedSha256: string;
}

export interface QuarantineArtifactManifest {
  readonly format: typeof VOIDFALL_QUARANTINE_MANIFEST_FORMAT;
  readonly schemaVersion: typeof VOIDFALL_QUARANTINE_MANIFEST_SCHEMA_VERSION;
  readonly quarantineId: string;
  readonly filename: string;
  readonly kind: QuarantineArtifactKind;
  readonly receivedAt: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly payload: 'payload.bin';
  readonly validation: {
    readonly status: 'quarantined';
    readonly strategy: 'zip-signature-v1';
  };
}

export interface QuarantineArtifactReceipt {
  readonly quarantineId: string;
  readonly storageReference: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly manifestSha256: string;
  readonly status: 'quarantined';
}

export type QuarantineOperationStage =
  | 'options'
  | 'plan'
  | 'layout'
  | 'stream'
  | 'validate'
  | 'manifest'
  | 'publish'
  | 'cleanup';

export type QuarantineOperationErrorCode =
  | 'invalid-options'
  | 'invalid-plan'
  | 'unsafe-root'
  | 'artifact-conflict'
  | 'content-too-large'
  | 'size-mismatch'
  | 'hash-mismatch'
  | 'invalid-container-signature'
  | 'invalid-chunk'
  | 'storage-failure'
  | 'cleanup-failed';

export class QuarantineOperationError extends Error {
  public readonly code: QuarantineOperationErrorCode;
  public readonly stage: QuarantineOperationStage;

  public constructor(code: QuarantineOperationErrorCode, stage: QuarantineOperationStage) {
    super(`artifact-quarantine:${code}:${stage}`);
    this.name = 'QuarantineOperationError';
    this.code = code;
    this.stage = stage;
  }
}
