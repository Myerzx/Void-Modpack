export interface AuthorizedFileRootDefinition {
  readonly rootId: string;
  readonly rootPath: string;
  readonly readableExtensions: readonly string[];
  readonly writableExtensions: readonly string[];
  readonly maximumFileBytes: number;
}

export interface AuthorizedFileServiceOptions {
  readonly revisionRoot: string;
  readonly roots: readonly AuthorizedFileRootDefinition[];
}

export interface ListAuthorizedDirectoryPlan {
  readonly rootId: string;
  readonly directoryPath: string;
  readonly maximumEntries: number;
}

export interface AuthorizedDirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly type: 'directory' | 'file';
  readonly sizeBytes?: number;
}

export interface AuthorizedDirectorySnapshot {
  readonly rootId: string;
  readonly directoryPath: string;
  readonly entries: readonly AuthorizedDirectoryEntry[];
}

export interface ReadAuthorizedFilePlan {
  readonly rootId: string;
  readonly filePath: string;
}

export interface AuthorizedFileSnapshot {
  readonly rootId: string;
  readonly filePath: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly content: string;
}

export interface ReplaceAuthorizedFilePlan {
  readonly rootId: string;
  readonly filePath: string;
  readonly revisionId: string;
  readonly actorId: string;
  readonly reasonCode: string;
  readonly changedAt: string;
  readonly expectedSha256: string;
  readonly content: string;
}

export interface AuthorizedFileRevisionManifest {
  readonly format: 'voidfall-authorized-file-revision';
  readonly schemaVersion: 1;
  readonly revisionId: string;
  readonly rootId: string;
  readonly filePath: string;
  readonly actorId: string;
  readonly reasonCode: string;
  readonly changedAt: string;
  readonly state: 'prepared-before-replacement';
  readonly previousSha256: string;
  readonly intendedSha256: string;
  readonly previousSizeBytes: number;
  readonly intendedSizeBytes: number;
  readonly previousPayload: 'previous.bin';
}

export interface ReplaceAuthorizedFileReceipt {
  readonly revisionId: string;
  readonly rootId: string;
  readonly filePath: string;
  readonly previousSha256: string;
  readonly currentSha256: string;
  readonly manifestSha256: string;
  readonly revisionReference: string;
}

export type AuthorizedFileOperationStage =
  | 'definition'
  | 'plan'
  | 'preflight'
  | 'read'
  | 'revision'
  | 'replace'
  | 'verify'
  | 'cleanup';

export type AuthorizedFileOperationErrorCode =
  | 'invalid-definition'
  | 'invalid-plan'
  | 'unknown-root'
  | 'unsafe-path'
  | 'unsupported-extension'
  | 'unsupported-entry'
  | 'entry-limit-exceeded'
  | 'content-too-large'
  | 'invalid-text-content'
  | 'concurrent-modification'
  | 'operation-in-progress'
  | 'no-change'
  | 'revision-conflict'
  | 'replacement-failed'
  | 'verification-failed'
  | 'recovery-failed'
  | 'cleanup-failed';

export class AuthorizedFileOperationError extends Error {
  public readonly code: AuthorizedFileOperationErrorCode;
  public readonly stage: AuthorizedFileOperationStage;

  public constructor(code: AuthorizedFileOperationErrorCode, stage: AuthorizedFileOperationStage) {
    super(`authorized-file:${code}:${stage}`);
    this.name = 'AuthorizedFileOperationError';
    this.code = code;
    this.stage = stage;
  }
}
