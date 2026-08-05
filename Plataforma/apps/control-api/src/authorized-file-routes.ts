import { Type, type Static } from '@sinclair/typebox';
import {
  validateAuthorizedFileDiffRequest,
  validateCopyAuthorizedFileRequest,
  validateCreateAuthorizedFileRequest,
  validateDeleteAuthorizedFileRequest,
  validateMoveAuthorizedFileRequest,
  validateRestoreAuthorizedFileRequest,
  type ActorRef,
  type AuthorizedFileDiffResponseContract,
  type AuthorizedFileMutationReceiptContract,
} from '@voidfall/contracts';
import {
  AuthorizedFileOperationError,
  type AuthorizedDirectorySnapshot,
  type AuthorizedFileService,
  type AuthorizedFileSnapshot,
} from '@voidfall/authorized-files';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Authorized file endpoints for Phase 10.2.
 *
 * Discovery, review and mutation happen only inside roots the deployment
 * declared. A request names a root by identifier and a path relative to it;
 * nothing here accepts a directory, a drive, a URL or an archive, and no
 * response carries an absolute path — a caller can neither reach outside the
 * policy nor learn the host layout by reading an error.
 *
 * "Upload" and "download" are the create and read routes: bounded UTF-8 text
 * with a stated hash. There is deliberately no binary transfer and no route
 * that runs anything, so nothing that arrives here can become executable.
 *
 * Without a configured service the whole surface reports itself unavailable
 * rather than falling back to some implied root. Deny-by-default is the same
 * posture the configuration routes take.
 */

export type AuthorizedFilePermission =
  | 'files.view'
  | 'files.edit'
  | 'files.upload'
  | 'files.delete';

export interface AuthorizedFileRouteDependencies {
  readonly clock: () => Date;
  readonly authenticate: (request: FastifyRequest) => Promise<void>;
  readonly requirePermission: (
    permission: AuthorizedFilePermission,
  ) => (request: FastifyRequest) => Promise<void>;
  readonly requireCsrf: (request: FastifyRequest) => Promise<void>;
  readonly apiError: (statusCode: number, code: string, message: string) => Error;
  readonly audit: (input: {
    readonly request: FastifyRequest;
    readonly actor: ActorRef;
    readonly action: string;
    readonly rootId: string;
    readonly outcome: 'succeeded' | 'failed' | 'denied';
    readonly reason?: string;
  }) => Promise<void>;
  /**
   * Optional. Absent means no root was authorized for this deployment, and
   * every route says so instead of guessing one.
   */
  readonly authorizedFiles?: AuthorizedFileService;
}

const RootId = Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9._-]{0,63}$' });
const RevisionId = RootId;
const ReasonCode = RootId;
const Sha256 = Type.String({ pattern: '^[a-f0-9]{64}$' });

/**
 * A relative path as it arrives over HTTP.
 *
 * Backslash and colon are refused by the pattern, so `C:\...`, a UNC prefix and
 * an NTFS alternate data stream cannot be spelled at all. The contract layer
 * re-checks the same path for the cases a pattern cannot express, and the
 * service re-checks it against the filesystem — three independent refusals,
 * because this is the parameter an attacker actually controls.
 */
const RelativePath = Type.String({
  minLength: 1,
  maxLength: 1_024,
  pattern: '^(?!.*(?:^|/)\\.\\.?(?:/|$))[^\\\\:\\u0000-\\u001f\\u007f]+$',
});

const DirectoryPath = Type.String({
  maxLength: 1_024,
  pattern: '^(?!.*(?:^|/)\\.\\.?(?:/|$))[^\\\\:\\u0000-\\u001f\\u007f]*$',
});

const FileContent = Type.String({
  maxLength: 1_048_576,
  pattern: '^[^\\u0000-\\u0008\\u000b-\\u001f\\u007f]*$',
});

const RootParamsSchema = Type.Object({ rootId: RootId }, { additionalProperties: false });

const ListQuerySchema = Type.Object(
  {
    // Query values arrive as strings and this API validates without coercion,
    // so a bound is declared as digits and converted explicitly below.
    path: Type.Optional(DirectoryPath),
    limit: Type.Optional(Type.String({ pattern: '^[0-9]{1,4}$' })),
  },
  { additionalProperties: false },
);

const ReadQuerySchema = Type.Object({ path: RelativePath }, { additionalProperties: false });

const CreateBodySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    rootId: RootId,
    filePath: RelativePath,
    reasonCode: ReasonCode,
    content: FileContent,
  },
  { additionalProperties: false },
);

const MoveBodySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    rootId: RootId,
    sourcePath: RelativePath,
    destinationPath: RelativePath,
    revisionId: RevisionId,
    reasonCode: ReasonCode,
    expectedSha256: Sha256,
  },
  { additionalProperties: false },
);

const CopyBodySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    rootId: RootId,
    sourcePath: RelativePath,
    destinationPath: RelativePath,
    reasonCode: ReasonCode,
    expectedSha256: Sha256,
  },
  { additionalProperties: false },
);

const DeleteBodySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    rootId: RootId,
    filePath: RelativePath,
    revisionId: RevisionId,
    reasonCode: ReasonCode,
    expectedSha256: Sha256,
    // No default: a deletion has to be said out loud, like a force kill.
    acknowledgesDataLoss: Type.Literal(true),
  },
  { additionalProperties: false },
);

const RestoreBodySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    rootId: RootId,
    revisionId: RevisionId,
    reasonCode: ReasonCode,
  },
  { additionalProperties: false },
);

const DiffBodySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    rootId: RootId,
    filePath: RelativePath,
    against: Type.Union([
      Type.Object(
        { type: Type.Literal('revision'), revisionId: RevisionId },
        { additionalProperties: false },
      ),
      Type.Object(
        { type: Type.Literal('proposed'), content: FileContent },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

type RootParams = Static<typeof RootParamsSchema>;
type ListQuery = Static<typeof ListQuerySchema>;
type ReadQuery = Static<typeof ReadQuerySchema>;
type CreateBody = Static<typeof CreateBodySchema>;
type MoveBody = Static<typeof MoveBodySchema>;
type CopyBody = Static<typeof CopyBodySchema>;
type DeleteBody = Static<typeof DeleteBodySchema>;
type RestoreBody = Static<typeof RestoreBodySchema>;
type DiffBody = Static<typeof DiffBodySchema>;

const DEFAULT_ENTRY_LIMIT = 500;
const MAXIMUM_ENTRY_LIMIT = 2_000;
const MAXIMUM_DIFF_LINES = 5_000;

/**
 * Maps a service refusal onto a status.
 *
 * The service message is never forwarded. Its codes are safe by construction,
 * but a route that forwarded them once would forward whatever a later code
 * happens to contain — so the mapping is explicit and the text is fixed.
 */
function statusForFileError(code: AuthorizedFileOperationError['code']): {
  readonly status: number;
  readonly apiCode: string;
  readonly message: string;
} {
  switch (code) {
    case 'unknown-root':
      return { status: 404, apiCode: 'FILE_ROOT_UNKNOWN', message: 'Raiz de arquivos desconhecida.' };
    case 'unknown-revision':
      return { status: 404, apiCode: 'FILE_REVISION_UNKNOWN', message: 'Revisão desconhecida.' };
    case 'unsafe-path':
      // Deliberately indistinguishable from "not found": telling a caller that
      // a path they may not reach *exists* is itself a disclosure.
      return { status: 404, apiCode: 'FILE_NOT_FOUND', message: 'Arquivo não encontrado.' };
    case 'unsupported-extension':
      return {
        status: 403,
        apiCode: 'FILE_EXTENSION_NOT_ALLOWED',
        message: 'Extensão não permitida nesta raiz.',
      };
    case 'unsupported-entry':
      return {
        status: 409,
        apiCode: 'FILE_ENTRY_UNSUPPORTED',
        message: 'A entrada não é um arquivo de texto simples.',
      };
    case 'destination-exists':
      return { status: 409, apiCode: 'FILE_DESTINATION_EXISTS', message: 'O destino já existe.' };
    case 'concurrent-modification':
      return {
        status: 409,
        apiCode: 'FILE_CONCURRENT_MODIFICATION',
        message: 'O arquivo mudou desde a leitura.',
      };
    case 'operation-in-progress':
      return {
        status: 409,
        apiCode: 'FILE_OPERATION_IN_PROGRESS',
        message: 'Já existe uma operação em andamento para este arquivo.',
      };
    case 'revision-conflict':
      return {
        status: 409,
        apiCode: 'FILE_REVISION_CONFLICT',
        message: 'A revisão informada já existe.',
      };
    case 'no-change':
      return { status: 409, apiCode: 'FILE_NO_CHANGE', message: 'A solicitação não muda nada.' };
    case 'content-too-large':
      return { status: 413, apiCode: 'FILE_TOO_LARGE', message: 'Conteúdo acima do limite.' };
    case 'entry-limit-exceeded':
      return {
        status: 413,
        apiCode: 'FILE_DIRECTORY_TOO_LARGE',
        message: 'Diretório com entradas demais.',
      };
    case 'diff-too-large':
      return {
        status: 413,
        apiCode: 'FILE_DIFF_TOO_LARGE',
        message: 'Diferença grande demais para ser exibida.',
      };
    case 'invalid-text-content':
      return {
        status: 415,
        apiCode: 'FILE_NOT_TEXT',
        message: 'O arquivo não é texto UTF-8 válido.',
      };
    case 'invalid-plan':
    case 'invalid-definition':
      return { status: 400, apiCode: 'FILE_REQUEST_INVALID', message: 'Solicitação inválida.' };
    default:
      // replacement-failed, verification-failed, recovery-failed, cleanup-failed
      return {
        status: 500,
        apiCode: 'FILE_OPERATION_FAILED',
        message: 'Não foi possível concluir a operação.',
      };
  }
}

export function registerAuthorizedFileRoutes(
  app: FastifyInstance,
  dependencies: AuthorizedFileRouteDependencies,
): void {
  const { clock, authenticate, requirePermission, requireCsrf, apiError, audit } = dependencies;

  function panelActor(request: FastifyRequest): ActorRef {
    const auth = request.authContext;
    if (auth === undefined) throw apiError(401, 'AUTH_REQUIRED', 'Autenticação necessária.');
    return { type: 'panel-user', id: auth.user.id };
  }

  function service(): AuthorizedFileService {
    const configured = dependencies.authorizedFiles;
    if (configured === undefined) {
      throw apiError(
        503,
        'FILE_ACCESS_UNAVAILABLE',
        'Acesso a arquivos não está habilitado nesta instalação.',
      );
    }
    return configured;
  }

  /** Runs a service call, converting its refusal into an HTTP answer. */
  async function attempt<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof AuthorizedFileOperationError)) throw error;
      const mapped = statusForFileError(error.code);
      throw apiError(mapped.status, mapped.apiCode, mapped.message);
    }
  }

  /**
   * Records what was attempted, including what it was attempted on.
   *
   * The path goes in `reason` rather than in the resource identifier, which the
   * audit contract bounds at 128 characters — an audit entry that could not say
   * which file was deleted would not be an audit entry.
   */
  function auditReason(reasonCode: string, ...paths: readonly string[]): string {
    return `${reasonCode} ${paths.join(' -> ')}`.slice(0, 1_000);
  }

  /**
   * Runs a mutation and records it either way.
   *
   * A refusal is audited too: an operator being repeatedly denied a path is
   * exactly the pattern the log exists to make visible.
   */
  async function mutate(
    request: FastifyRequest,
    input: {
      readonly action: string;
      readonly rootId: string;
      readonly reason: string;
      readonly run: () => Promise<AuthorizedFileMutationReceiptContract>;
    },
  ): Promise<AuthorizedFileMutationReceiptContract> {
    const actor = panelActor(request);
    try {
      const receipt = await attempt(input.run);
      await audit({
        request,
        actor,
        action: input.action,
        rootId: input.rootId,
        outcome: 'succeeded',
        reason: input.reason,
      });
      return receipt;
    } catch (error) {
      await audit({
        request,
        actor,
        action: input.action,
        rootId: input.rootId,
        outcome: 'failed',
        reason: input.reason,
      });
      throw error;
    }
  }

  app.get<{ Params: RootParams; Querystring: ListQuery }>(
    '/api/v1/files/roots/:rootId/entries',
    {
      schema: { params: RootParamsSchema, querystring: ListQuerySchema },
      preHandler: [authenticate, requirePermission('files.view')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request): Promise<AuthorizedDirectorySnapshot> => {
      const raw = request.query.limit;
      const requested = raw === undefined ? DEFAULT_ENTRY_LIMIT : Number.parseInt(raw, 10);
      if (!Number.isSafeInteger(requested) || requested < 1 || requested > MAXIMUM_ENTRY_LIMIT) {
        throw apiError(400, 'FILE_REQUEST_INVALID', 'Solicitação inválida.');
      }
      return attempt(() =>
        service().list({
          rootId: request.params.rootId,
          directoryPath: request.query.path ?? '',
          maximumEntries: requested,
        }),
      );
    },
  );

  /**
   * The download. It is a bounded UTF-8 read, not a byte stream: the response
   * is JSON with a hash, so nothing here can be saved and run.
   */
  app.get<{ Params: RootParams; Querystring: ReadQuery }>(
    '/api/v1/files/roots/:rootId/content',
    {
      schema: { params: RootParamsSchema, querystring: ReadQuerySchema },
      preHandler: [authenticate, requirePermission('files.view')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request): Promise<AuthorizedFileSnapshot> =>
      attempt(() =>
        service().read({ rootId: request.params.rootId, filePath: request.query.path }),
      ),
  );

  app.post<{ Body: DiffBody }>(
    '/api/v1/files/diff',
    {
      schema: { body: DiffBodySchema },
      preHandler: [authenticate, requireCsrf, requirePermission('files.view')],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request): Promise<AuthorizedFileDiffResponseContract> => {
      if (!validateAuthorizedFileDiffRequest(request.body).success) {
        throw apiError(400, 'FILE_REQUEST_INVALID', 'Solicitação inválida.');
      }
      const snapshot = await attempt(() =>
        service().diff({
          rootId: request.body.rootId,
          filePath: request.body.filePath,
          against: request.body.against,
        }),
      );
      if (snapshot.diff.lines.length > MAXIMUM_DIFF_LINES) {
        throw apiError(413, 'FILE_DIFF_TOO_LARGE', 'Diferença grande demais para ser exibida.');
      }
      return {
        schemaVersion: 1,
        rootId: snapshot.rootId,
        filePath: snapshot.filePath,
        previousLabel: snapshot.previousLabel,
        currentLabel: snapshot.currentLabel,
        lines: snapshot.diff.lines.map((line) => ({
          type: line.type,
          previousLineNumber: line.previousLineNumber,
          currentLineNumber: line.currentLineNumber,
          text: line.text,
          redacted: line.redacted,
          truncated: line.truncated,
        })),
        addedCount: snapshot.diff.addedCount,
        removedCount: snapshot.diff.removedCount,
        containsRedactedChange: snapshot.diff.containsRedactedChange,
      } satisfies AuthorizedFileDiffResponseContract;
    },
  );

  /** The upload. Bounded text, created exclusively, never overwriting. */
  app.post<{ Body: CreateBody }>(
    '/api/v1/files',
    {
      schema: { body: CreateBodySchema },
      preHandler: [authenticate, requireCsrf, requirePermission('files.upload')],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply): Promise<AuthorizedFileMutationReceiptContract> => {
      if (!validateCreateAuthorizedFileRequest(request.body).success) {
        throw apiError(400, 'FILE_REQUEST_INVALID', 'Solicitação inválida.');
      }
      const body = request.body;
      const receipt = await mutate(request, {
        action: 'file.created',
        rootId: body.rootId,
        reason: auditReason(body.reasonCode, body.filePath),
        run: async () => {
          const result = await service().create({
            rootId: body.rootId,
            filePath: body.filePath,
            actorId: panelActor(request).id,
            reasonCode: body.reasonCode,
            changedAt: clock().toISOString(),
            content: body.content,
          });
          return { schemaVersion: 1, ...result } satisfies AuthorizedFileMutationReceiptContract;
        },
      });
      reply.code(201);
      return receipt;
    },
  );

  app.post<{ Body: MoveBody }>(
    '/api/v1/files/move',
    {
      schema: { body: MoveBodySchema },
      preHandler: [authenticate, requireCsrf, requirePermission('files.edit')],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request): Promise<AuthorizedFileMutationReceiptContract> => {
      if (!validateMoveAuthorizedFileRequest(request.body).success) {
        throw apiError(400, 'FILE_REQUEST_INVALID', 'Solicitação inválida.');
      }
      const body = request.body;
      return mutate(request, {
        action: 'file.moved',
        rootId: body.rootId,
        reason: auditReason(body.reasonCode, body.sourcePath, body.destinationPath),
        run: async () => {
          const result = await service().move({
            rootId: body.rootId,
            sourcePath: body.sourcePath,
            destinationPath: body.destinationPath,
            revisionId: body.revisionId,
            actorId: panelActor(request).id,
            reasonCode: body.reasonCode,
            changedAt: clock().toISOString(),
            expectedSha256: body.expectedSha256,
          });
          return { schemaVersion: 1, ...result } satisfies AuthorizedFileMutationReceiptContract;
        },
      });
    },
  );

  app.post<{ Body: CopyBody }>(
    '/api/v1/files/copy',
    {
      schema: { body: CopyBodySchema },
      preHandler: [authenticate, requireCsrf, requirePermission('files.edit')],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request): Promise<AuthorizedFileMutationReceiptContract> => {
      if (!validateCopyAuthorizedFileRequest(request.body).success) {
        throw apiError(400, 'FILE_REQUEST_INVALID', 'Solicitação inválida.');
      }
      const body = request.body;
      return mutate(request, {
        action: 'file.copied',
        rootId: body.rootId,
        reason: auditReason(body.reasonCode, body.sourcePath, body.destinationPath),
        run: async () => {
          const result = await service().copy({
            rootId: body.rootId,
            sourcePath: body.sourcePath,
            destinationPath: body.destinationPath,
            actorId: panelActor(request).id,
            reasonCode: body.reasonCode,
            changedAt: clock().toISOString(),
            expectedSha256: body.expectedSha256,
          });
          return { schemaVersion: 1, ...result } satisfies AuthorizedFileMutationReceiptContract;
        },
      });
    },
  );

  /**
   * Deletion has its own permission, which `files.edit` does not imply. Being
   * allowed to change a file is not being allowed to make it stop existing.
   */
  app.post<{ Body: DeleteBody }>(
    '/api/v1/files/delete',
    {
      schema: { body: DeleteBodySchema },
      preHandler: [authenticate, requireCsrf, requirePermission('files.delete')],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request): Promise<AuthorizedFileMutationReceiptContract> => {
      if (!validateDeleteAuthorizedFileRequest(request.body).success) {
        throw apiError(400, 'FILE_REQUEST_INVALID', 'Solicitação inválida.');
      }
      const body = request.body;
      return mutate(request, {
        action: 'file.deleted',
        rootId: body.rootId,
        reason: auditReason(body.reasonCode, body.filePath),
        run: async () => {
          const result = await service().delete({
            rootId: body.rootId,
            filePath: body.filePath,
            revisionId: body.revisionId,
            actorId: panelActor(request).id,
            reasonCode: body.reasonCode,
            changedAt: clock().toISOString(),
            expectedSha256: body.expectedSha256,
          });
          return { schemaVersion: 1, ...result } satisfies AuthorizedFileMutationReceiptContract;
        },
      });
    },
  );

  /**
   * Restoration writes back bytes the caller never sees, so it needs the
   * authority to change a file — `files.edit` — and not the authority to read
   * whatever the revision holds.
   */
  app.post<{ Body: RestoreBody }>(
    '/api/v1/files/restore',
    {
      schema: { body: RestoreBodySchema },
      preHandler: [authenticate, requireCsrf, requirePermission('files.edit')],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request): Promise<AuthorizedFileMutationReceiptContract> => {
      if (!validateRestoreAuthorizedFileRequest(request.body).success) {
        throw apiError(400, 'FILE_REQUEST_INVALID', 'Solicitação inválida.');
      }
      const body = request.body;
      return mutate(request, {
        action: 'file.restored',
        rootId: body.rootId,
        reason: auditReason(body.reasonCode, body.revisionId),
        run: async () => {
          const result = await service().restore({
            rootId: body.rootId,
            revisionId: body.revisionId,
            actorId: panelActor(request).id,
            reasonCode: body.reasonCode,
            changedAt: clock().toISOString(),
          });
          return { schemaVersion: 1, ...result } satisfies AuthorizedFileMutationReceiptContract;
        },
      });
    },
  );
}
