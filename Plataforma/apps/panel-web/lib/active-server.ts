import type { ServerInstance } from './panel-views';
import { panelRequest, readSession } from './workspace-client';

const ACTIVE_SERVER_STORAGE_KEY = 'voidfall.activeServerId';

export interface OperationalSession {
  readonly serverId: string;
  readonly csrfToken: string;
  readonly permissions: readonly string[];
}

export type OperationalContext =
  | {
      readonly kind: 'ready';
      readonly session: OperationalSession;
      readonly servers: readonly ServerInstance[];
    }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'no-server' }
  | { readonly kind: 'csrf-unavailable' };

function storedServerId(): string | null {
  try {
    return globalThis.localStorage?.getItem(ACTIVE_SERVER_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Selects a persisted instance only while it still exists, then falls back deterministically. */
export function chooseActiveServerId(
  servers: readonly Pick<ServerInstance, 'id'>[],
  preferredId: string | null = storedServerId(),
): string | null {
  if (preferredId !== null && servers.some((server) => server.id === preferredId)) {
    return preferredId;
  }
  return servers[0]?.id ?? null;
}

export function rememberActiveServerId(serverId: string): void {
  try {
    globalThis.localStorage?.setItem(ACTIVE_SERVER_STORAGE_KEY, serverId);
  } catch {
    // Storage may be disabled. The current screen still keeps the selection.
  }
}

/**
 * Resolves the authenticated session and active ServerInstance in one place.
 * No credential is persisted; only the non-secret instance id is remembered.
 */
export async function readOperationalContext(): Promise<OperationalContext> {
  const auth = await readSession();
  if (auth === null) return { kind: 'signed-out' };
  if (typeof auth.csrfToken !== 'string') return { kind: 'csrf-unavailable' };
  const listing = await panelRequest<{ readonly servers: readonly ServerInstance[] }>(
    '/api/v1/servers',
  );
  const serverId = chooseActiveServerId(listing.servers);
  if (serverId === null) return { kind: 'no-server' };
  rememberActiveServerId(serverId);
  return {
    kind: 'ready',
    servers: listing.servers,
    session: {
      serverId,
      csrfToken: auth.csrfToken,
      permissions: auth.permissions,
    },
  };
}
