import { Type, type Static } from '@sinclair/typebox';
import { ContractSchemaVersion, Sha256Schema } from './common.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

/**
 * Public contracts for the Phase 10.2 authorized file operations.
 *
 * A request names a root by its **identifier**, never by a directory. Nothing
 * here carries an absolute path, a drive letter, a UNC prefix or a traversal
 * segment, so no request can reach outside the roots the deployment declared —
 * a caller cannot name a place the policy did not already approve.
 *
 * Uploads and downloads ride on the same shapes as any other read or write:
 * bounded UTF-8 text with a stated hash. There is no execution surface, no
 * archive expansion and no content type that would let a byte stream be
 * interpreted as anything other than text.
 */

/**
 * A path relative to an authorized root.
 *
 * The pattern refuses backslashes and colons outright rather than trying to
 * normalise them. That single choice is what stops `C:\...`, `\\server\share`
 * and an NTFS alternate data stream (`file.properties:$DATA`) from ever being
 * expressible, on any platform — including the one where they mean nothing and
 * would otherwise pass review.
 */
export const AuthorizedRelativePathSchema = Type.String({
  minLength: 1,
  maxLength: 1_024,
  pattern: '^(?!.*(?:^|/)\\.\\.?(?:/|$))[^\\\\:\\u0000-\\u001f\\u007f]+$',
});

/** The same, but allowed to name the root itself. */
export const AuthorizedDirectoryPathSchema = Type.Union([
  Type.Literal(''),
  AuthorizedRelativePathSchema,
]);

export const AuthorizedRootIdSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z][a-z0-9._-]{0,63}$',
});

export const AuthorizedRevisionIdSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z][a-z0-9._-]{0,63}$',
});

export const AuthorizedFileReasonCodeSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z][a-z0-9._-]{0,63}$',
});

/**
 * Text content, bounded at the contract before any service sees it.
 *
 * Control characters other than tab and newline are refused: a configuration
 * file has no use for them, and they are how a value smuggles a terminal escape
 * into whatever later renders the file.
 */
export const AuthorizedFileContentSchema = Type.String({
  maxLength: 1_048_576,
  pattern: '^[^\\u0000-\\u0008\\u000b-\\u001f\\u007f]*$',
});

export const CreateAuthorizedFileRequestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    rootId: AuthorizedRootIdSchema,
    filePath: AuthorizedRelativePathSchema,
    reasonCode: AuthorizedFileReasonCodeSchema,
    content: AuthorizedFileContentSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/create-authorized-file-request.schema.json',
    additionalProperties: false,
  },
);

/**
 * A move or a rename. There is only one request, because a rename is the case
 * where both paths share a parent and nothing about the guards differs.
 *
 * `revisionId` is required: a move is destructive at the source, so the bytes
 * are preserved before the file stops existing where it was.
 */
export const MoveAuthorizedFileRequestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    rootId: AuthorizedRootIdSchema,
    sourcePath: AuthorizedRelativePathSchema,
    destinationPath: AuthorizedRelativePathSchema,
    revisionId: AuthorizedRevisionIdSchema,
    reasonCode: AuthorizedFileReasonCodeSchema,
    /** What the caller believes is there. A mismatch is refused, not merged. */
    expectedSha256: Sha256Schema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/move-authorized-file-request.schema.json',
    additionalProperties: false,
  },
);

export const CopyAuthorizedFileRequestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    rootId: AuthorizedRootIdSchema,
    sourcePath: AuthorizedRelativePathSchema,
    destinationPath: AuthorizedRelativePathSchema,
    reasonCode: AuthorizedFileReasonCodeSchema,
    expectedSha256: Sha256Schema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/copy-authorized-file-request.schema.json',
    additionalProperties: false,
  },
);

/**
 * A deletion.
 *
 * `acknowledgesDataLoss` has to be stated, with no default, for the same reason
 * force kill does: a delete is the only mutation here whose subject stops
 * existing, and a client that did not mean it should not be able to reach it by
 * omitting a field.
 */
export const DeleteAuthorizedFileRequestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    rootId: AuthorizedRootIdSchema,
    filePath: AuthorizedRelativePathSchema,
    revisionId: AuthorizedRevisionIdSchema,
    reasonCode: AuthorizedFileReasonCodeSchema,
    expectedSha256: Sha256Schema,
    acknowledgesDataLoss: Type.Literal(true),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/delete-authorized-file-request.schema.json',
    additionalProperties: false,
  },
);

export const RestoreAuthorizedFileRequestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    rootId: AuthorizedRootIdSchema,
    revisionId: AuthorizedRevisionIdSchema,
    reasonCode: AuthorizedFileReasonCodeSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/restore-authorized-file-request.schema.json',
    additionalProperties: false,
  },
);

/**
 * What the current file is compared against.
 *
 * Proposed text is diffed and never stored, so a change can be reviewed before
 * anything is written.
 */
export const AuthorizedFileDiffRequestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    rootId: AuthorizedRootIdSchema,
    filePath: AuthorizedRelativePathSchema,
    against: Type.Union([
      Type.Object(
        { type: Type.Literal('revision'), revisionId: AuthorizedRevisionIdSchema },
        { additionalProperties: false },
      ),
      Type.Object(
        { type: Type.Literal('proposed'), content: AuthorizedFileContentSchema },
        { additionalProperties: false },
      ),
    ]),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/authorized-file-diff-request.schema.json',
    additionalProperties: false,
  },
);

/**
 * One line of a rendered diff.
 *
 * `redacted` is part of the contract rather than a rendering detail: a reviewer
 * has to be able to tell "this line is unchanged" from "this line changed in a
 * way you are not being shown".
 */
export const AuthorizedFileDiffLineSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal('unchanged'),
      Type.Literal('added'),
      Type.Literal('removed'),
    ]),
    previousLineNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    currentLineNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    text: Type.String({ maxLength: 2_048 }),
    redacted: Type.Boolean(),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const AuthorizedFileDiffResponseSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    rootId: AuthorizedRootIdSchema,
    filePath: AuthorizedRelativePathSchema,
    previousLabel: Type.String({ minLength: 1, maxLength: 128 }),
    currentLabel: Type.String({ minLength: 1, maxLength: 128 }),
    lines: Type.Array(AuthorizedFileDiffLineSchema, { maxItems: 5_000 }),
    addedCount: Type.Integer({ minimum: 0 }),
    removedCount: Type.Integer({ minimum: 0 }),
    /** True when a *changed* line was masked. See `redacted` above. */
    containsRedactedChange: Type.Boolean(),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/authorized-file-diff-response.schema.json',
    additionalProperties: false,
  },
);

export const AuthorizedFileMutationReceiptSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    operation: Type.Union([
      Type.Literal('create'),
      Type.Literal('move'),
      Type.Literal('copy'),
      Type.Literal('delete'),
      Type.Literal('restore'),
    ]),
    rootId: AuthorizedRootIdSchema,
    filePath: AuthorizedRelativePathSchema,
    destinationPath: Type.Union([AuthorizedRelativePathSchema, Type.Null()]),
    sha256: Type.Union([Sha256Schema, Type.Null()]),
    /** Where the preserved bytes live, when the step preserved any. */
    revisionReference: Type.Union([
      Type.String({ minLength: 1, maxLength: 256 }),
      Type.Null(),
    ]),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/authorized-file-mutation-receipt.schema.json',
    additionalProperties: false,
  },
);

export type AuthorizedRelativePath = Static<typeof AuthorizedRelativePathSchema>;
export type CreateAuthorizedFileRequestContract = Static<typeof CreateAuthorizedFileRequestSchema>;
export type MoveAuthorizedFileRequestContract = Static<typeof MoveAuthorizedFileRequestSchema>;
export type CopyAuthorizedFileRequestContract = Static<typeof CopyAuthorizedFileRequestSchema>;
export type DeleteAuthorizedFileRequestContract = Static<typeof DeleteAuthorizedFileRequestSchema>;
export type RestoreAuthorizedFileRequestContract = Static<
  typeof RestoreAuthorizedFileRequestSchema
>;
export type AuthorizedFileDiffRequestContract = Static<typeof AuthorizedFileDiffRequestSchema>;
export type AuthorizedFileDiffResponseContract = Static<typeof AuthorizedFileDiffResponseSchema>;
export type AuthorizedFileMutationReceiptContract = Static<
  typeof AuthorizedFileMutationReceiptSchema
>;

/**
 * Semantics the shape alone cannot express.
 *
 * A path that survives the pattern can still be one no filesystem should be
 * asked about: a segment that is empty, that is only dots, that ends in a dot
 * or a space (which Windows silently strips, turning `x.properties.` into
 * `x.properties` and defeating an extension check), or that names a reserved
 * device. These are refused here rather than in one service, so every route
 * that accepts a path gets the same answer.
 */
const RESERVED_SEGMENTS = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

export function authorizedPathIssues(
  path: string,
  pointer: string,
): readonly ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = [];
  if (path === '') return issues;
  // Normalisation is checked, not applied: two paths that look identical but
  // normalise differently would otherwise be two files whose names a reviewer
  // cannot tell apart.
  if (path !== path.normalize('NFC')) {
    issues.push(semanticIssue(pointer, 'a path must be Unicode NFC'));
  }
  for (const segment of path.split('/')) {
    if (segment.length === 0 || segment.length > 255) {
      issues.push(semanticIssue(pointer, 'a path segment must be between 1 and 255 characters'));
      break;
    }
    if (/^\.+$/u.test(segment)) {
      issues.push(semanticIssue(pointer, 'a path segment of dots names a directory, not a file'));
      break;
    }
    if (segment.endsWith('.') || segment.endsWith(' ') || segment.startsWith(' ')) {
      // Windows strips a trailing dot or space, so `x.properties.` would open
      // `x.properties` — an extension check would pass on a name that resolves
      // to a different file.
      issues.push(semanticIssue(pointer, 'a path segment may not begin or end in a dot or space'));
      break;
    }
    const base = segment.split('.')[0] ?? '';
    if (RESERVED_SEGMENTS.has(base.toLowerCase())) {
      issues.push(semanticIssue(pointer, 'a path segment may not name a reserved device'));
      break;
    }
  }
  return issues;
}

function withPathIssues<T>(
  result: ContractValidationResult<T>,
  read: (value: T) => readonly (readonly [string, string])[],
): ContractValidationResult<T> {
  if (!result.success) return result;
  const issues: ContractValidationIssue[] = [];
  for (const [pointer, value] of read(result.value)) {
    issues.push(...authorizedPathIssues(value, pointer));
  }
  return appendSemanticIssues(result, issues);
}

/**
 * A move or copy onto its own source has nothing to do, and a move would still
 * take a revision — leaving a history entry recording a change that never
 * happened.
 */
function refuseSelfDestination<T extends { readonly sourcePath: string; readonly destinationPath: string }>(
  result: ContractValidationResult<T>,
): ContractValidationResult<T> {
  if (!result.success || result.value.sourcePath !== result.value.destinationPath) return result;
  return appendSemanticIssues(result, [
    semanticIssue('/destinationPath', 'a destination must differ from its source'),
  ]);
}

export function validateCreateAuthorizedFileRequest(
  value: unknown,
): ContractValidationResult<CreateAuthorizedFileRequestContract> {
  return withPathIssues(validateContract(CreateAuthorizedFileRequestSchema, value), (request) => [
    ['/filePath', request.filePath],
  ]);
}

export function validateMoveAuthorizedFileRequest(
  value: unknown,
): ContractValidationResult<MoveAuthorizedFileRequestContract> {
  return refuseSelfDestination(
    withPathIssues(validateContract(MoveAuthorizedFileRequestSchema, value), (request) => [
      ['/sourcePath', request.sourcePath],
      ['/destinationPath', request.destinationPath],
    ]),
  );
}

export function validateCopyAuthorizedFileRequest(
  value: unknown,
): ContractValidationResult<CopyAuthorizedFileRequestContract> {
  return refuseSelfDestination(
    withPathIssues(validateContract(CopyAuthorizedFileRequestSchema, value), (request) => [
      ['/sourcePath', request.sourcePath],
      ['/destinationPath', request.destinationPath],
    ]),
  );
}

export function validateDeleteAuthorizedFileRequest(
  value: unknown,
): ContractValidationResult<DeleteAuthorizedFileRequestContract> {
  return withPathIssues(validateContract(DeleteAuthorizedFileRequestSchema, value), (request) => [
    ['/filePath', request.filePath],
  ]);
}

export function validateRestoreAuthorizedFileRequest(
  value: unknown,
): ContractValidationResult<RestoreAuthorizedFileRequestContract> {
  return validateContract(RestoreAuthorizedFileRequestSchema, value);
}

export function validateAuthorizedFileDiffRequest(
  value: unknown,
): ContractValidationResult<AuthorizedFileDiffRequestContract> {
  return withPathIssues(validateContract(AuthorizedFileDiffRequestSchema, value), (request) => [
    ['/filePath', request.filePath],
  ]);
}
