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
   * Decides whether a root may be registered.
   *
   * Injected because "which directories may this panel read?" is an operator
   * policy, not something a route should invent. Returning a reason rather
   * than a boolean means a refusal can say what was wrong without echoing the
   * path back.
   */
  readonly rootPolicy?: (rootPath: string) => Promise<string | null>;
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
      if (dependencies.rootPolicy !== undefined) {
        const refusal = await dependencies.rootPolicy(request.body.rootPath);
        if (refusal !== null) {
          await dependencies.audit({
            request,
            actor: actorOf(request),
            action: 'workspace.register',
            workspaceId: request.body.slug,
            outcome: 'denied',
            reason: refusal,
          });
          // The reason names what was wrong; it never echoes the path back.
          throw apiError(400, 'WORKSPACE_ROOT_REFUSED', refusal);
        }
      }

      let workspace;
      try {
        workspace = await repositories.workspaces.register({
          slug: request.body.slug,
          displayName: request.body.displayName,
          rootPath: request.body.rootPath,
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
