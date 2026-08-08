import { Type, type Static } from '@sinclair/typebox';
import type { ActorRef } from '@voidfall/contracts';
import { WorkspaceError, type Repositories } from '@voidfall/database';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * The first slice of the panel integration track.
 *
 * The engine already knows how to read an imported workspace; until now the
 * only way to see the result was a CLI. These routes put that behind the API
 * without moving any of the work into it: scanning stays in
 * `@voidfall/workspace-inventory`, and this module registers a workspace,
 * calls the scanner, stores what it produced and hands it back unchanged.
 *
 * Two rules it does not bend:
 *
 * **A screen never sends a path.** The root is registered once, by an operator
 * with `workspace.manage`, and every later request names the workspace by id.
 * Nothing returned to a browser carries a host path — not in a document, not
 * in an error. That is the same rule the authorized-file core follows.
 *
 * **Scanning is read-only, structurally.** `scanWorkspace` never opens a file
 * for writing. Pointing this at somebody's real server is safe by
 * construction, which is the only reason importing a live installation is
 * allowed at all.
 */

export type WorkspacePermission = 'workspace.view' | 'workspace.manage';

/** Runs the inventory. Injected so this module never imports a scanner. */
export interface WorkspaceScanner {
  build(options: { readonly root: string }): Promise<{
    readonly inventorySha256: string;
    readonly totals: {
      readonly files: number;
      readonly bytes: number;
      readonly mods: number;
    };
  }>;
}

/**
 * Reads, validates and stages a configuration file.
 *
 * Injected for the same reason the scanner is: this module must not import an
 * inference engine or a rewriter. Every decision here — which fields exist,
 * what a mod declared, whether a value is acceptable, how a line is rewritten
 * — already has an owner, and a second one would let the panel disagree with
 * whatever actually writes the file.
 */
export interface WorkspaceConfigurationService {
  /** `null` for a file whose format nothing here can represent. */
  formatOf(path: string): 'toml' | 'json' | null;
  readForm(input: {
    readonly workspaceRoot: string;
    readonly path: string;
  }): Promise<{
    readonly format: string;
    readonly complete: boolean;
    readonly issues: readonly { readonly line: number; readonly code: string }[];
    readonly fields: readonly {
      readonly path: string;
      readonly type: string;
      readonly value: unknown;
      readonly constraints: readonly unknown[];
      readonly documentation: readonly string[];
      readonly line: number;
    }[];
  } | null>;
  validate(input: {
    readonly workspaceRoot: string;
    readonly path: string;
    readonly changes: readonly { readonly path: string; readonly value: unknown }[];
  }): Promise<
    | readonly (
        | { readonly path: string; readonly accepted: true; readonly checkedAgainstDeclaredBounds: boolean }
        | { readonly path: string; readonly accepted: false; readonly code: string }
      )[]
    | null
  >;
  stage(input: {
    readonly workspaceId: string;
    readonly workspaceRoot: string;
    readonly path: string;
    readonly changes: readonly { readonly path: string; readonly value: unknown }[];
  }): Promise<{
    readonly path: string;
    readonly baseSha256: string;
    readonly stagedSha256: string;
    readonly changes: readonly unknown[];
    readonly diff: readonly { readonly kind: string; readonly line: number; readonly text: string }[];
  }>;
  readStaged(input: {
    readonly workspaceId: string;
    readonly workspaceRoot: string;
    readonly path: string;
  }): Promise<{ readonly diff: readonly unknown[] } | null>;
  discard(input: {
    readonly workspaceId: string;
    readonly workspaceRoot: string;
    readonly path: string;
  }): Promise<void>;
}

/**
 * Starts a disposable sandbox boot and reports back as it goes.
 *
 * Fire-and-report rather than a promise the route awaits: a boot spawns a JVM
 * and takes minutes, which is not a request. Injected like everything else, so
 * this module never imports a process runner and a test can arrange an outcome
 * without a JVM.
 */
/**
 * What a configuration field can hold.
 *
 * Named once here rather than spelled `unknown` at each boundary: the value
 * crossed the request schema on the way in, so the type it has is a fact
 * worth keeping rather than something to re-narrow at every hop.
 */
export type ConfigurationValue =
  | string
  | number
  | boolean
  | readonly (string | number | boolean)[];

export interface SandboxLauncher {
  launch(input: {
    readonly workspaceRoot: string;
    /** Empty when the run tests what is installed rather than a change. */
    readonly changeSets: readonly {
      readonly path: string;
      readonly changes: readonly { readonly path: string; readonly value: ConfigurationValue }[];
    }[];
    onProgress(message: string): Promise<void>;
    onFinished(result: {
      readonly outcome: string;
      readonly durationMs: number;
      readonly evidence: unknown;
    }): Promise<void>;
    onRefused(refusal: string): Promise<void>;
  }): void;
}

export interface WorkspaceRouteDependencies {
  readonly repositories: Repositories;
  readonly clock: () => Date;
  readonly authenticate: (request: FastifyRequest) => Promise<void>;
  readonly requirePermission: (
    permission: WorkspacePermission,
  ) => (request: FastifyRequest) => Promise<void>;
  readonly requireCsrf: (request: FastifyRequest) => Promise<void>;
  readonly audit: (input: {
    readonly request: FastifyRequest;
    readonly actor: ActorRef;
    readonly action: string;
    readonly workspaceId: string;
    readonly outcome: 'succeeded' | 'failed' | 'denied';
    readonly reason?: string;
  }) => Promise<void>;
  readonly apiError: (statusCode: number, code: string, message: string) => Error;
  /**
   * Optional. Without it registration and scanning are refused rather than
   * accepted into a place nobody configured — the same deny-by-default the
   * artifact upload route already uses.
   */
  readonly scanner?: WorkspaceScanner;
  /**
   * Decides whether a root may be registered, and returns the form to store.
   *
   * Injected because "which directories may this panel read?" is operator
   * policy, not something a route should invent. It returns the canonical path
   * rather than approving the one it was given: demanding that the operator
   * type an already-normalised path refused valid input and explained nothing.
   */
  readonly rootPolicy?: (
    rootPath: string,
  ) => Promise<{ readonly rootPath: string } | { readonly refusal: string }>;
  /**
   * Optional, deny-by-default. Without it the configuration routes report
   * themselves unavailable rather than staging into a place nobody configured.
   */
  readonly configuration?: WorkspaceConfigurationService;
  /**
   * Optional, deny-by-default. Without it the sandbox routes report themselves
   * unavailable rather than pretending a boot was queued that nothing will run.
   */
  readonly sandbox?: SandboxLauncher;
}

const RegisterWorkspaceSchema = Type.Object(
  {
    slug: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,62}$' }),
    displayName: Type.String({ minLength: 1, maxLength: 120 }),
    rootPath: Type.String({ minLength: 2, maxLength: 4096 }),
    kind: Type.Union([Type.Literal('server'), Type.Literal('client-profile')]),
  },
  { additionalProperties: false },
);

type RegisterWorkspaceBody = Static<typeof RegisterWorkspaceSchema>;

const ConfigurationChangeSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 1_024 }),
    changes: Type.Array(
      Type.Object(
        {
          /** Dotted field path, exactly as the inferred form reports it. */
          path: Type.String({ minLength: 1, maxLength: 512 }),
          value: Type.Union([
            Type.String({ maxLength: 4_096 }),
            Type.Number(),
            Type.Boolean(),
            Type.Array(
              Type.Union([Type.String({ maxLength: 1_024 }), Type.Number(), Type.Boolean()]),
              { maxItems: 512 },
            ),
          ]),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 256 },
    ),
  },
  { additionalProperties: false },
);

interface InventoryDocument {
  readonly files: readonly { readonly path: string; readonly role: string; readonly sizeBytes: number }[];
  readonly mods: readonly {
    readonly modId: string;
    readonly displayName: string | null;
    readonly version: string | null;
    readonly loader: string;
    readonly archivePath: string;
    readonly editLevel: string;
    readonly editLevelReason: string;
    readonly configurationCandidates: readonly { readonly path: string; readonly rule: string }[];
  }[];
  readonly undeclaredArchives: readonly { readonly path: string; readonly reason: string }[];
  readonly exclusions: readonly { readonly path: string; readonly reason: string }[];
}

function asDocument(value: unknown): InventoryDocument {
  return value as InventoryDocument;
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  dependencies: WorkspaceRouteDependencies,
): void {
  const { repositories, authenticate, requirePermission, requireCsrf, apiError } = dependencies;

  const actorOf = (request: FastifyRequest): ActorRef => ({
    type: 'panel-user',
    id: request.authContext?.user.id ?? 'unknown',
  });

  /** Loads a workspace by id, refusing rather than leaking that it exists. */
  const workspaceOf = async (workspaceId: string) => {
    const workspace = await repositories.workspaces.findById(workspaceId);
    if (workspace === undefined) {
      throw apiError(404, 'WORKSPACE_NOT_FOUND', 'Workspace não encontrado.');
    }
    return workspace;
  };

  app.get(
    '/api/v1/workspaces',
    { preHandler: [authenticate, requirePermission('workspace.view')] },
    async () => ({
      dataQuality: 'stored',
      // Registration and scanning both need a configured scanner. Saying so
      // lets a screen explain itself instead of failing at the button.
      capabilities: {
        canRegister: dependencies.scanner !== undefined,
        canScan: dependencies.scanner !== undefined,
      },
      workspaces: await repositories.workspaces.listPublic(),
    }),
  );

  app.post<{ Body: RegisterWorkspaceBody }>(
    '/api/v1/workspaces',
    {
      schema: { body: RegisterWorkspaceSchema },
      preHandler: [authenticate, requirePermission('workspace.manage'), requireCsrf],
    },
    async (request, reply) => {
      if (dependencies.scanner === undefined) {
        throw apiError(
          503,
          'WORKSPACE_SCANNER_UNAVAILABLE',
          'Nenhum scanner de workspace está configurado nesta instância.',
        );
      }
      // Stored canonical when a policy is wired, so the registry cannot
      // disagree with what is actually read later.
      let rootPath = request.body.rootPath;
      if (dependencies.rootPolicy !== undefined) {
        const decision = await dependencies.rootPolicy(rootPath);
        if ('refusal' in decision) {
          await dependencies.audit({
            request,
            actor: actorOf(request),
            action: 'workspace.register',
            workspaceId: request.body.slug,
            outcome: 'denied',
            reason: decision.refusal,
          });
          // The reason names what was wrong; it never echoes the path back.
          throw apiError(400, 'WORKSPACE_ROOT_REFUSED', decision.refusal);
        }
        rootPath = decision.rootPath;
      }

      let workspace;
      try {
        workspace = await repositories.workspaces.register({
          slug: request.body.slug,
          displayName: request.body.displayName,
          rootPath,
          kind: request.body.kind,
          createdBy: actorOf(request),
        });
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === 'slug-taken') {
          throw apiError(409, 'WORKSPACE_SLUG_TAKEN', 'Já existe um workspace com esse slug.');
        }
        throw error;
      }

      await dependencies.audit({
        request,
        actor: actorOf(request),
        action: 'workspace.register',
        workspaceId: workspace.workspaceId,
        outcome: 'succeeded',
      });

      return reply.code(201).send({
        workspaceId: workspace.workspaceId,
        slug: workspace.slug,
        displayName: workspace.displayName,
        kind: workspace.kind,
        createdAt: workspace.createdAt,
        lastScan: null,
      });
    },
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/api/v1/workspaces/:workspaceId/scans',
    {
      preHandler: [authenticate, requirePermission('workspace.manage'), requireCsrf],
    },
    async (request, reply) => {
      const scanner = dependencies.scanner;
      if (scanner === undefined) {
        throw apiError(
          503,
          'WORKSPACE_SCANNER_UNAVAILABLE',
          'Nenhum scanner de workspace está configurado nesta instância.',
        );
      }
      const workspace = await workspaceOf(request.params.workspaceId);

      let inventory;
      try {
        inventory = await scanner.build({ root: workspace.rootPath });
      } catch (error) {
        await dependencies.audit({
          request,
          actor: actorOf(request),
          action: 'workspace.scan',
          workspaceId: workspace.workspaceId,
          outcome: 'failed',
          reason: error instanceof Error ? error.name : 'unknown',
        });
        // A root that moved or became unreadable is an operator's problem, and
        // the message says which without repeating the path.
        throw apiError(
          422,
          'WORKSPACE_UNREADABLE',
          'O diretório registrado não pôde ser lido. Verifique se ele ainda existe.',
        );
      }

      const stored = await repositories.workspaces.recordScan({
        workspaceId: workspace.workspaceId,
        inventorySha256: inventory.inventorySha256,
        totalFiles: inventory.totals.files,
        totalBytes: inventory.totals.bytes,
        totalMods: inventory.totals.mods,
        document: inventory,
        scannedBy: actorOf(request),
        scannedAt: dependencies.clock(),
      });

      await dependencies.audit({
        request,
        actor: actorOf(request),
        action: 'workspace.scan',
        workspaceId: workspace.workspaceId,
        outcome: 'succeeded',
      });

      return reply.code(201).send({
        inventoryId: stored.inventoryId,
        inventorySha256: stored.inventorySha256,
        scannedAt: stored.scannedAt,
        totalFiles: stored.totalFiles,
        totalMods: stored.totalMods,
        totalBytes: stored.totalBytes,
      });
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/workspaces/:workspaceId/inventory',
    { preHandler: [authenticate, requirePermission('workspace.view')] },
    async (request) => {
      await workspaceOf(request.params.workspaceId);
      const stored = await repositories.workspaces.latestInventory(request.params.workspaceId);
      if (stored === undefined) {
        // Never scanned is a state, not an error. The screen shows a button.
        return { dataQuality: 'never-scanned', inventory: null };
      }
      const document = asDocument(stored.document);
      const roles = new Map<string, number>();
      for (const file of document.files) {
        roles.set(file.role, (roles.get(file.role) ?? 0) + 1);
      }
      const exclusions = new Map<string, number>();
      for (const exclusion of document.exclusions) {
        exclusions.set(exclusion.reason, (exclusions.get(exclusion.reason) ?? 0) + 1);
      }

      return {
        dataQuality: 'stored',
        inventory: {
          inventoryId: stored.inventoryId,
          inventorySha256: stored.inventorySha256,
          scannedAt: stored.scannedAt,
          totals: {
            files: stored.totalFiles,
            bytes: stored.totalBytes,
            mods: stored.totalMods,
            modArchives: document.files.filter((file) => file.role === 'mod-archive').length,
            undeclaredArchives: document.undeclaredArchives.length,
          },
          filesByRole: [...roles].sort(([left], [right]) => left.localeCompare(right, 'en-US')),
          // Excluded is recorded, not skipped: a screen that hid this would be
          // indistinguishable from one whose scan silently missed things.
          exclusionsByReason: [...exclusions].sort(([left], [right]) =>
            left.localeCompare(right, 'en-US'),
          ),
        },
      };
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/workspaces/:workspaceId/mods',
    { preHandler: [authenticate, requirePermission('workspace.view')] },
    async (request) => {
      await workspaceOf(request.params.workspaceId);
      const stored = await repositories.workspaces.latestInventory(request.params.workspaceId);
      if (stored === undefined) return { dataQuality: 'never-scanned', mods: [], undeclared: [] };

      const document = asDocument(stored.document);
      return {
        dataQuality: 'stored',
        inventoryId: stored.inventoryId,
        mods: document.mods.map((mod) => ({
          modId: mod.modId,
          displayName: mod.displayName,
          version: mod.version,
          loader: mod.loader,
          archivePath: mod.archivePath,
          editLevel: mod.editLevel,
          editLevelReason: mod.editLevelReason,
          configurationCount: mod.configurationCandidates.length,
        })),
        // Archives that declared nothing are part of the answer. Dropping them
        // would make the list disagree with the folder.
        undeclared: document.undeclaredArchives,
      };
    },
  );

  app.get<{ Params: { workspaceId: string; modId: string } }>(
    '/api/v1/workspaces/:workspaceId/mods/:modId',
    { preHandler: [authenticate, requirePermission('workspace.view')] },
    async (request) => {
      await workspaceOf(request.params.workspaceId);
      const stored = await repositories.workspaces.latestInventory(request.params.workspaceId);
      if (stored === undefined) {
        throw apiError(404, 'INVENTORY_NOT_FOUND', 'Este workspace ainda não foi inventariado.');
      }
      const document = asDocument(stored.document);
      const mod = document.mods.find((entry) => entry.modId === request.params.modId);
      if (mod === undefined) {
        throw apiError(404, 'MOD_NOT_FOUND', 'Mod não encontrado neste inventário.');
      }
      return {
        dataQuality: 'stored',
        inventoryId: stored.inventoryId,
        mod: {
          ...mod,
          // The rule that matched travels with the path, so a reader can judge
          // a convention rather than trust it.
          configurationCandidates: mod.configurationCandidates,
        },
      };
    },
  );

  /**
   * Resolves a configuration path the panel named.
   *
   * The panel may only name a path the **scan already found**. That keeps the
   * project's rule intact in a place where a relative path does travel: the
   * screen is choosing from what the engine reported, not describing a file.
   * A path that is not in the inventory is refused before anything opens it,
   * so traversal never becomes a question about string handling.
   */
  const configurationPathOf = async (workspaceId: string, path: string): Promise<string> => {
    const stored = await repositories.workspaces.latestInventory(workspaceId);
    if (stored === undefined) {
      throw apiError(404, 'INVENTORY_NOT_FOUND', 'Este workspace ainda não foi inventariado.');
    }
    const document = asDocument(stored.document);
    const known =
      document.files.some((file) => file.path === path) ||
      document.mods.some((mod) =>
        mod.configurationCandidates.some((candidate) => candidate.path === path),
      );
    if (!known) {
      throw apiError(404, 'CONFIGURATION_NOT_IN_INVENTORY', 'Arquivo não está no inventário.');
    }
    return path;
  };

  const configurationOrRefuse = (): WorkspaceConfigurationService => {
    if (dependencies.configuration === undefined) {
      throw apiError(
        503,
        'CONFIGURATION_UNAVAILABLE',
        'A edição de configuração não está configurada nesta instância.',
      );
    }
    return dependencies.configuration;
  };

  app.get<{ Params: { workspaceId: string }; Querystring: { path?: string } }>(
    '/api/v1/workspaces/:workspaceId/configuration',
    { preHandler: [authenticate, requirePermission('workspace.view')] },
    async (request) => {
      const configuration = configurationOrRefuse();
      const workspace = await workspaceOf(request.params.workspaceId);
      const path = request.query.path;
      if (path === undefined || path.length === 0) {
        throw apiError(400, 'PATH_REQUIRED', 'Informe o arquivo de configuração.');
      }
      await configurationPathOf(workspace.workspaceId, path);

      const form = await configuration.readForm({ workspaceRoot: workspace.rootPath, path });
      if (form === null) {
        // Located and not representable is an ordinary outcome, not a failure.
        // The file stays editable as raw text elsewhere; this route says only
        // that no form can be built for it.
        return { dataQuality: 'unsupported-format', path, form: null };
      }
      return { dataQuality: 'stored', path, form };
    },
  );

  app.post<{
    Params: { workspaceId: string };
    Body: { path: string; changes: readonly { path: string; value: unknown }[] };
  }>(
    '/api/v1/workspaces/:workspaceId/configuration/validate',
    {
      schema: { body: ConfigurationChangeSchema },
      preHandler: [authenticate, requirePermission('workspace.view'), requireCsrf],
    },
    async (request) => {
      const configuration = configurationOrRefuse();
      const workspace = await workspaceOf(request.params.workspaceId);
      await configurationPathOf(workspace.workspaceId, request.body.path);

      const decisions = await configuration.validate({
        workspaceRoot: workspace.rootPath,
        path: request.body.path,
        changes: request.body.changes,
      });
      if (decisions === null) {
        throw apiError(422, 'UNSUPPORTED_FORMAT', 'Esse formato não tem formulário inferido.');
      }
      return {
        path: request.body.path,
        decisions,
        acceptable: decisions.every((decision) => decision.accepted),
      };
    },
  );

  app.post<{
    Params: { workspaceId: string };
    Body: { path: string; changes: readonly { path: string; value: unknown }[] };
  }>(
    '/api/v1/workspaces/:workspaceId/configuration/staging',
    {
      schema: { body: ConfigurationChangeSchema },
      preHandler: [authenticate, requirePermission('workspace.manage'), requireCsrf],
    },
    async (request, reply) => {
      const configuration = configurationOrRefuse();
      const workspace = await workspaceOf(request.params.workspaceId);
      await configurationPathOf(workspace.workspaceId, request.body.path);

      let staged;
      try {
        staged = await configuration.stage({
          workspaceId: workspace.workspaceId,
          workspaceRoot: workspace.rootPath,
          path: request.body.path,
          changes: request.body.changes,
        });
      } catch (error) {
        // The staging engine refuses with a named code — an unknown field, a
        // rejected value, a form that could not represent the whole file. It
        // is passed through rather than flattened, because each one tells the
        // operator something different about what to do next.
        const code =
          typeof (error as { code?: unknown }).code === 'string'
            ? ((error as { code: string }).code)
            : 'staging-refused';
        await dependencies.audit({
          request,
          actor: actorOf(request),
          action: 'workspace.configuration.stage',
          workspaceId: workspace.workspaceId,
          outcome: 'failed',
          reason: code,
        });
        throw apiError(422, `STAGING_${code.toUpperCase().replaceAll('-', '_')}`, code);
      }

      // Recorded durably, so a reload does not lose which fields produced the
      // diff — and so a sandbox boot can be handed the change itself rather
      // than a rewritten file it would have to read back and guess at.
      await repositories.workspaceStaging.put({
        workspaceId: workspace.workspaceId,
        path: request.body.path,
        changes: request.body.changes,
        baseSha256: staged.baseSha256,
        stagedSha256: staged.stagedSha256,
        stagedBy: actorOf(request),
      });

      await dependencies.audit({
        request,
        actor: actorOf(request),
        action: 'workspace.configuration.stage',
        workspaceId: workspace.workspaceId,
        outcome: 'succeeded',
      });
      // Nothing in the workspace was written. Staging is the whole point: the
      // one destructive step still has no owner anywhere in this repository.
      return reply.code(201).send({ ...staged, appliedToWorkspace: false });
    },
  );

  app.get<{ Params: { workspaceId: string }; Querystring: { path?: string } }>(
    '/api/v1/workspaces/:workspaceId/configuration/staging',
    { preHandler: [authenticate, requirePermission('workspace.view')] },
    async (request) => {
      const configuration = configurationOrRefuse();
      const workspace = await workspaceOf(request.params.workspaceId);
      const path = request.query.path;
      if (path === undefined || path.length === 0) {
        throw apiError(400, 'PATH_REQUIRED', 'Informe o arquivo de configuração.');
      }
      await configurationPathOf(workspace.workspaceId, path);
      const staged = await configuration.readStaged({
        workspaceId: workspace.workspaceId,
        workspaceRoot: workspace.rootPath,
        path,
      });
      return staged === null
        ? { dataQuality: 'not-staged', path, diff: [] }
        : { dataQuality: 'stored', path, diff: staged.diff };
    },
  );

  app.delete<{ Params: { workspaceId: string }; Querystring: { path?: string } }>(
    '/api/v1/workspaces/:workspaceId/configuration/staging',
    { preHandler: [authenticate, requirePermission('workspace.manage'), requireCsrf] },
    async (request, reply) => {
      const configuration = configurationOrRefuse();
      const workspace = await workspaceOf(request.params.workspaceId);
      const path = request.query.path;
      if (path === undefined || path.length === 0) {
        throw apiError(400, 'PATH_REQUIRED', 'Informe o arquivo de configuração.');
      }
      await configurationPathOf(workspace.workspaceId, path);
      // Discarding before apply deletes a file this service wrote. Nothing in
      // the workspace is touched, because nothing in it ever was.
      await configuration.discard({
        workspaceId: workspace.workspaceId,
        workspaceRoot: workspace.rootPath,
        path,
      });
      await repositories.workspaceStaging.remove(workspace.workspaceId, path);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/workspaces/:workspaceId/staged',
    { preHandler: [authenticate, requirePermission('workspace.view')] },
    async (request) => {
      await workspaceOf(request.params.workspaceId);
      return {
        dataQuality: 'stored',
        staged: await repositories.workspaceStaging.list(request.params.workspaceId),
      };
    },
  );

  app.post<{ Params: { workspaceId: string }; Body?: { testStagedChanges?: boolean } }>(
    '/api/v1/workspaces/:workspaceId/sandbox-runs',
    { preHandler: [authenticate, requirePermission('workspace.manage'), requireCsrf] },
    async (request, reply) => {
      if (dependencies.sandbox === undefined) {
        throw apiError(
          503,
          'SANDBOX_UNAVAILABLE',
          'A execução em sandbox não está configurada nesta instância.',
        );
      }
      const workspace = await workspaceOf(request.params.workspaceId);

      if (await repositories.sandboxRuns.hasRunning(workspace.workspaceId)) {
        // One JVM at a time per workspace. Two sandboxes composed from the same
        // server contend for the same files and the same port, and the second
        // fails in a way that reads like the change under test.
        throw apiError(409, 'SANDBOX_ALREADY_RUNNING', 'Já existe uma execução em andamento.');
      }

      const testStaged = request.body?.testStagedChanges !== false;
      const staged = testStaged
        ? await repositories.workspaceStaging.list(workspace.workspaceId)
        : [];
      // The stored changes went through the request schema before they were
      // written, so the JSONB round-trip is the only thing that lost the type.
      const changeSets = staged.map((entry) => ({
        path: entry.path,
        changes: entry.changes as readonly { readonly path: string; readonly value: ConfigurationValue }[],
      }));

      const run = await repositories.sandboxRuns.start({
        workspaceId: workspace.workspaceId,
        testedChanges: changeSets.length > 0,
        startedBy: actorOf(request),
      });

      dependencies.sandbox.launch({
        workspaceRoot: workspace.rootPath,
        changeSets,
        onProgress: async (message) => {
          await repositories.sandboxRuns.appendProgress(run.runId, message);
        },
        onFinished: async (result) => {
          await repositories.sandboxRuns.finish({ runId: run.runId, ...result });
        },
        onRefused: async (refusal) => {
          await repositories.sandboxRuns.refuse(run.runId, refusal);
        },
      });

      await dependencies.audit({
        request,
        actor: actorOf(request),
        action: 'workspace.sandbox.start',
        workspaceId: workspace.workspaceId,
        outcome: 'succeeded',
      });

      // Answered immediately. A boot takes minutes and is read back by id.
      return reply.code(202).send({ runId: run.runId, status: run.status, testedChanges: run.testedChanges });
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/workspaces/:workspaceId/sandbox-runs',
    { preHandler: [authenticate, requirePermission('workspace.view')] },
    async (request) => {
      await workspaceOf(request.params.workspaceId);
      return {
        dataQuality: 'stored',
        available: dependencies.sandbox !== undefined,
        runs: await repositories.sandboxRuns.list(request.params.workspaceId),
      };
    },
  );

  app.get<{ Params: { workspaceId: string; runId: string } }>(
    '/api/v1/workspaces/:workspaceId/sandbox-runs/:runId',
    { preHandler: [authenticate, requirePermission('workspace.view')] },
    async (request) => {
      await workspaceOf(request.params.workspaceId);
      const run = await repositories.sandboxRuns.findById(request.params.runId);
      if (run === undefined || run.workspaceId !== request.params.workspaceId) {
        throw apiError(404, 'SANDBOX_RUN_NOT_FOUND', 'Execução não encontrada.');
      }
      return { dataQuality: 'stored', run };
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/workspaces/:workspaceId/scans',
    { preHandler: [authenticate, requirePermission('workspace.view')] },
    async (request) => {
      await workspaceOf(request.params.workspaceId);
      return {
        dataQuality: 'stored',
        scans: await repositories.workspaces.scanHistory(request.params.workspaceId),
      };
    },
  );
}
