/**
 * Typed client for the workspace endpoints.
 *
 * The panel integration track's first rule, and the reason this file is thin:
 * nothing here re-derives anything the engine already decided. The API returns
 * an inventory the scanner produced; this maps it to what a screen renders and
 * stops. No edit level is inferred, no mod is classified, no total is
 * recomputed — a second answer would be a second thing to keep true.
 */

export type WorkspaceKind = 'server' | 'client-profile';

export interface WorkspaceSummary {
  readonly workspaceId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly kind: WorkspaceKind;
  readonly createdAt: string;
  readonly lastScan: {
    readonly inventoryId: string;
    readonly inventorySha256: string;
    readonly scannedAt: string;
    readonly totalFiles: number;
    readonly totalMods: number;
    readonly totalBytes: number;
  } | null;
}

export interface WorkspaceListing {
  readonly workspaces: readonly WorkspaceSummary[];
  /** Whether this instance has a scanner wired at all. */
  readonly capabilities: { readonly canRegister: boolean; readonly canScan: boolean };
}

export interface InventorySummary {
  readonly inventoryId: string;
  readonly inventorySha256: string;
  readonly scannedAt: string;
  readonly totals: {
    readonly files: number;
    readonly bytes: number;
    readonly mods: number;
    readonly modArchives: number;
    readonly undeclaredArchives: number;
  };
  readonly filesByRole: readonly (readonly [string, number])[];
  readonly exclusionsByReason: readonly (readonly [string, number])[];
}

export interface ModSummary {
  readonly modId: string;
  readonly displayName: string | null;
  readonly version: string | null;
  readonly loader: string;
  readonly archivePath: string;
  readonly editLevel: string;
  readonly editLevelReason: string;
  readonly configurationCount: number;
}

export interface ModDetail extends Omit<ModSummary, 'configurationCount'> {
  readonly configurationCandidates: readonly { readonly path: string; readonly rule: string }[];
}

export interface UndeclaredArchive {
  readonly path: string;
  readonly reason: string;
}

export class PanelApiError extends Error {
  public readonly status: number;
  public readonly code: string | null;

  public constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'PanelApiError';
    this.status = status;
    this.code = code;
  }
}

interface ApiErrorBody {
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

async function request<T>(
  path: string,
  init: {
    readonly method?: 'GET' | 'POST' | 'DELETE';
    readonly body?: unknown;
    readonly csrfToken?: string;
  } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  // Every write carries the token the session handed back. A screen that
  // reloaded now has one, which it did not before this track opened.
  if (init.csrfToken !== undefined) headers['x-csrf-token'] = init.csrfToken;

  const response = await fetch(path, {
    method,
    credentials: 'include',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  if (!response.ok) {
    let code: string | null = null;
    let message = `A requisição falhou (${String(response.status)}).`;
    try {
      const body = (await response.json()) as ApiErrorBody;
      if (typeof body.error?.code === 'string') code = body.error.code;
      if (typeof body.error?.message === 'string') message = body.error.message;
    } catch {
      // A response without a JSON body is still a failure worth reporting; the
      // default message says what happened without inventing a cause.
    }
    throw new PanelApiError(response.status, code, message);
  }
  return (await response.json()) as T;
}

export interface PanelSession {
  readonly user: { readonly id: string; readonly displayName: string };
  readonly permissions: readonly string[];
  readonly csrfToken: string | null;
}

export async function readSession(): Promise<PanelSession | null> {
  try {
    return await request<PanelSession>('/api/v1/auth/session');
  } catch (error) {
    // Not being signed in is an ordinary outcome, not a failure.
    if (error instanceof PanelApiError && (error.status === 401 || error.status === 403)) return null;
    throw error;
  }
}

export async function signIn(email: string, password: string): Promise<PanelSession> {
  const result = await request<{ user: PanelSession['user']; csrfToken: string }>(
    '/api/v1/auth/login',
    { method: 'POST', body: { email, password } },
  );
  // The login response has no permission list; the session endpoint is the one
  // that reports what this user may do, so it is asked rather than assumed.
  const session = await readSession();
  return session ?? { user: result.user, permissions: [], csrfToken: result.csrfToken };
}

export async function signOut(csrfToken: string): Promise<void> {
  await request('/api/v1/auth/logout', { method: 'POST', csrfToken });
}

export async function listWorkspaces(): Promise<WorkspaceListing> {
  return request<WorkspaceListing>('/api/v1/workspaces');
}

export async function registerWorkspace(input: {
  readonly slug: string;
  readonly displayName: string;
  readonly rootPath: string;
  readonly kind: WorkspaceKind;
  readonly csrfToken: string;
}): Promise<WorkspaceSummary> {
  const { csrfToken, ...body } = input;
  return request<WorkspaceSummary>('/api/v1/workspaces', { method: 'POST', body, csrfToken });
}

export async function scanWorkspace(
  workspaceId: string,
  csrfToken: string,
): Promise<WorkspaceSummary['lastScan']> {
  return request('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/scans', {
    method: 'POST',
    csrfToken,
  });
}

export async function readInventory(
  workspaceId: string,
): Promise<{ dataQuality: string; inventory: InventorySummary | null }> {
  return request('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/inventory');
}

export async function readMods(workspaceId: string): Promise<{
  readonly dataQuality: string;
  readonly mods: readonly ModSummary[];
  readonly undeclared: readonly UndeclaredArchive[];
}> {
  return request('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/mods');
}

export async function readMod(workspaceId: string, modId: string): Promise<{ mod: ModDetail }> {
  return request(
    '/api/v1/workspaces/' +
      encodeURIComponent(workspaceId) +
      '/mods/' +
      encodeURIComponent(modId),
  );
}

/** Human wording for an edit level, kept next to the level it explains. */
export const EDIT_LEVEL_LABELS: Readonly<Record<string, string>> = {
  FULLY_MANAGED: 'Esquema revisado',
  STRUCTURED: 'Estrutura editável',
  RAW_EDITABLE: 'Texto bruto',
  UNSUPPORTED: 'Sem mutação segura',
  RUNTIME_ONLY: 'Só existe após rodar',
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit] as string}`;
}

/* --- Configuration: read, validate, stage, diff ------------------------- */

export interface FormField {
  readonly path: string;
  readonly type: string;
  readonly value: boolean | number | string | readonly (boolean | number | string)[];
  readonly constraints: readonly (
    | { readonly kind: 'range'; readonly minimum: number | null; readonly maximum: number | null; readonly source: string }
    | { readonly kind: 'allowed-values'; readonly values: readonly string[]; readonly source: string }
  )[];
  readonly documentation: readonly string[];
  readonly line: number;
}

export interface InferredFormView {
  readonly format: string;
  readonly complete: boolean;
  readonly issues: readonly { readonly line: number; readonly code: string }[];
  readonly fields: readonly FormField[];
}

export type FieldDecision =
  | { readonly path: string; readonly accepted: true; readonly checkedAgainstDeclaredBounds: boolean }
  | { readonly path: string; readonly accepted: false; readonly code: string };

export interface DiffLineView {
  readonly kind: 'context' | 'removed' | 'added';
  readonly line: number;
  readonly text: string;
}

export async function readConfigurationForm(
  workspaceId: string,
  path: string,
): Promise<{ readonly dataQuality: string; readonly form: InferredFormView | null }> {
  return request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/configuration?path=${encodeURIComponent(path)}`,
  );
}

export async function validateConfiguration(input: {
  readonly workspaceId: string;
  readonly path: string;
  readonly changes: readonly { readonly path: string; readonly value: unknown }[];
  readonly csrfToken: string;
}): Promise<{ readonly acceptable: boolean; readonly decisions: readonly FieldDecision[] }> {
  return request(`/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}/configuration/validate`, {
    method: 'POST',
    body: { path: input.path, changes: input.changes },
    csrfToken: input.csrfToken,
  });
}

export async function stageConfiguration(input: {
  readonly workspaceId: string;
  readonly path: string;
  readonly changes: readonly { readonly path: string; readonly value: unknown }[];
  readonly csrfToken: string;
}): Promise<{
  readonly baseSha256: string;
  readonly stagedSha256: string;
  readonly appliedToWorkspace: boolean;
  readonly diff: readonly DiffLineView[];
}> {
  return request(`/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}/configuration/staging`, {
    method: 'POST',
    body: { path: input.path, changes: input.changes },
    csrfToken: input.csrfToken,
  });
}

export async function readStagedDiff(
  workspaceId: string,
  path: string,
): Promise<{ readonly dataQuality: string; readonly diff: readonly DiffLineView[] }> {
  return request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/configuration/staging?path=${encodeURIComponent(path)}`,
  );
}

/** Describes a rejection in the operator's language, never in the engine's. */
export const REJECTION_LABELS: Readonly<Record<string, string>> = {
  'wrong-type': 'Tipo incompatível com o campo.',
  'out-of-declared-range': 'Fora do intervalo que o mod declarou.',
  'not-an-allowed-value': 'Não está entre os valores que o mod aceita.',
  'not-an-integer': 'Este campo aceita apenas números inteiros.',
  'mixed-list': 'A lista misturou tipos diferentes.',
  'unknown-field': 'Campo não existe neste arquivo.',
};

/* --- Staged changes and sandbox runs ------------------------------------ */

import type { SandboxRunView, StagedChangeSummary } from './sandbox-client';

export async function readStagedChanges(
  workspaceId: string,
): Promise<{ readonly staged: readonly StagedChangeSummary[] }> {
  return request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/staged`);
}

export async function discardStaged(
  workspaceId: string,
  path: string,
  csrfToken: string,
): Promise<void> {
  await request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/configuration/staging?path=${encodeURIComponent(path)}`,
    { method: 'DELETE', csrfToken },
  ).catch((error: unknown) => {
    // 204 has no body, so the JSON parse fails on success. A discard that
    // actually failed still arrives as a PanelApiError from the status check.
    if (error instanceof PanelApiError) throw error;
  });
}

export async function startSandboxRun(
  workspaceId: string,
  csrfToken: string,
): Promise<{ readonly runId: string; readonly testedChanges: boolean }> {
  return request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/sandbox-runs`, {
    method: 'POST',
    csrfToken,
  });
}

export async function listSandboxRuns(workspaceId: string): Promise<{
  readonly available: boolean;
  readonly runs: readonly SandboxRunView[];
}> {
  return request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/sandbox-runs`);
}

export async function readSandboxRun(
  workspaceId: string,
  runId: string,
): Promise<{ readonly run: SandboxRunView }> {
  return request(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/sandbox-runs/${encodeURIComponent(runId)}`,
  );
}
