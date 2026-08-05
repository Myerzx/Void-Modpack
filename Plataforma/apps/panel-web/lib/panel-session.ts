import type { PanelSession } from './panel-shell';

/**
 * Session handling against the real Control API.
 *
 * The panel never stores a credential: the session cookie is opaque, HTTP-only
 * and set by the API, so this module only carries the CSRF token and the
 * permission set the API reported. Losing the session is a normal outcome, not
 * an error — the caller is told to sign in again rather than shown a failure.
 */

export type SessionOutcome =
  | { readonly kind: 'authenticated'; readonly session: PanelSession }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'locked-out' }
  | { readonly kind: 'error'; readonly status: number };

export interface PanelHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type PanelFetch = (
  path: string,
  init: {
    readonly method: 'GET' | 'POST';
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) => Promise<PanelHttpResponse>;

interface SessionPayload {
  readonly csrfToken?: unknown;
  readonly user?: { readonly id?: unknown; readonly displayName?: unknown };
  readonly permissions?: unknown;
}

function readSession(payload: unknown): PanelSession | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const document = payload as SessionPayload;
  const permissions = Array.isArray(document.permissions)
    ? document.permissions.filter((value): value is string => typeof value === 'string')
    : undefined;
  const id = document.user?.id;
  const displayName = document.user?.displayName;
  if (
    typeof document.csrfToken !== 'string' ||
    typeof id !== 'string' ||
    typeof displayName !== 'string' ||
    permissions === undefined
  ) {
    return undefined;
  }
  return { userId: id, displayName, permissions, csrfToken: document.csrfToken };
}

export class PanelSessionClient {
  readonly #fetch: PanelFetch;

  public constructor(fetchImplementation: PanelFetch) {
    this.#fetch = fetchImplementation;
  }

  public async signIn(email: string, password: string): Promise<SessionOutcome> {
    const response = await this.#fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (response.status === 401) return { kind: 'unauthenticated' };
    // The API rate-limits repeated attempts; that is a lockout, not a failure
    // of the panel, and the difference matters to whoever is signing in.
    if (response.status === 429) return { kind: 'locked-out' };
    if (!response.ok) return { kind: 'error', status: response.status };

    const session = readSession(await response.json());
    if (session === undefined) return { kind: 'error', status: response.status };
    return { kind: 'authenticated', session };
  }

  /** Re-reads the current session, so a reload does not need a fresh sign-in. */
  public async current(): Promise<SessionOutcome> {
    const response = await this.#fetch('/api/v1/auth/session', { method: 'GET' });
    if (response.status === 401) return { kind: 'unauthenticated' };
    if (!response.ok) return { kind: 'error', status: response.status };
    const session = readSession(await response.json());
    if (session === undefined) return { kind: 'error', status: response.status };
    return { kind: 'authenticated', session };
  }

  /**
   * Ends the session. A logout that the API refuses still leaves the panel
   * signed out locally: keeping a session the server rejected would be worse
   * than dropping one it might still honour.
   */
  public async signOut(session: PanelSession): Promise<void> {
    await this.#fetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': session.csrfToken },
    }).catch(() => undefined);
  }
}
