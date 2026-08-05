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
  /**
   * Which loss the revision was taken against. A restorer needs to know
   * whether the file still exists at `filePath`: after a replacement it does
   * and holds different bytes, after a move it lives elsewhere, and after a
   * delete it is gone entirely.
   */
  readonly state:
    | 'prepared-before-replacement'
    | 'preserved-before-move'
    | 'preserved-before-delete';
  readonly previousSha256: string;
  /**
   * What will exist at `filePath` once the step lands — `null` when nothing
   * will, which is what distinguishes a delete from every other revision.
   */
  readonly intendedSha256: string | null;
  readonly previousSizeBytes: number;
  readonly intendedSizeBytes: number | null;
  readonly previousPayload: 'previous.bin';
  /** Where the bytes went, for a move. Absent for every other state. */
  readonly movedToPath?: string;
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
  /** A mutation found its destination occupied; nothing is ever overwritten. */
  | 'destination-exists'
  /** The two sides are too large to align within the bounded diff budget. */
  | 'diff-too-large'
  | 'unknown-revision'
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

/**
 * The mutation set for Phase 10.2.
 *
 * Every destructive step preserves the bytes it is about to lose as an
 * immutable revision first, and no step ever overwrites an existing entry: a
 * destination that already exists is a conflict, never a silent replacement.
 * A mutation stays inside one authorized root — crossing roots would let a
 * policy on one be escaped through another.
 */
export interface CreateAuthorizedFilePlan {
  readonly rootId: string;
  readonly filePath: string;
  readonly actorId: string;
  readonly reasonCode: string;
  readonly changedAt: string;
  readonly content: string;
}

export interface MoveAuthorizedFilePlan {
  readonly rootId: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly revisionId: string;
  readonly actorId: string;
  readonly reasonCode: string;
  readonly changedAt: string;
  readonly expectedSha256: string;
}

export interface CopyAuthorizedFilePlan {
  readonly rootId: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly actorId: string;
  readonly reasonCode: string;
  readonly changedAt: string;
  readonly expectedSha256: string;
}

export interface DeleteAuthorizedFilePlan {
  readonly rootId: string;
  readonly filePath: string;
  readonly revisionId: string;
  readonly actorId: string;
  readonly reasonCode: string;
  readonly changedAt: string;
  readonly expectedSha256: string;
}

export interface DiffAuthorizedFilePlan {
  readonly rootId: string;
  readonly filePath: string;
  /**
   * What the current file is compared against: a preserved revision, or text
   * the caller is about to save. Proposed text is diffed but never stored, so a
   * review can happen before anything is written.
   */
  readonly against:
    | { readonly type: 'revision'; readonly revisionId: string }
    | { readonly type: 'proposed'; readonly content: string };
}

export interface RestoreAuthorizedFilePlan {
  readonly rootId: string;
  readonly revisionId: string;
  readonly actorId: string;
  readonly reasonCode: string;
  readonly changedAt: string;
}

export interface AuthorizedFileMutationReceipt {
  readonly operation: 'create' | 'move' | 'copy' | 'delete' | 'restore';
  readonly rootId: string;
  readonly filePath: string;
  readonly destinationPath: string | null;
  readonly sha256: string | null;
  /** Present only when the step preserved bytes it was about to lose. */
  readonly revisionReference: string | null;
}
