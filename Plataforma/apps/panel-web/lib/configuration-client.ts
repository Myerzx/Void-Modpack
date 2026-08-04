import type {
  ConfigurationResourceStateView,
  ConfigurationRevisionView,
  ConfigurationSchemaView,
} from './configuration-view';

/**
 * Typed client for the authorized configuration endpoints.
 *
 * The panel only ever names a registered resourceId and reviewed field names.
 * It never sends a path, a root or a schema, and it always carries the CSRF
 * token and the expected hash/state version it read.
 */

export interface ConfigurationApiFailure {
  readonly status: number;
  readonly code?: string;
}

export class ConfigurationApiError extends Error {
  public readonly status: number;
  public readonly code: string | undefined;

  public constructor(failure: ConfigurationApiFailure) {
    super(`configuration-api:${failure.status}`);
    this.name = 'ConfigurationApiError';
    this.status = failure.status;
    this.code = failure.code;
  }
}

export interface ConfigurationSession {
  readonly baseUrl: string;
  readonly serverId: string;
  readonly csrfToken: string;
}

export interface ConfigurationApplyInput {
  readonly resourceId: string;
  readonly expectedCurrentSha256: string;
  readonly expectedStateVersion: number;
  readonly idempotencyKey: string;
  readonly reasonCode: string;
  readonly changes: readonly { readonly name: string; readonly value: boolean | number | string }[];
}

export interface ConfigurationRollbackInput {
  readonly resourceId: string;
  readonly targetRevisionId: string;
  readonly expectedCurrentSha256: string;
  readonly expectedStateVersion: number;
  readonly idempotencyKey: string;
  readonly reasonCode: string;
}

export interface ConfigurationAcceptanceView {
  readonly jobId: string;
  readonly revisionId: string;
  readonly operation: 'update' | 'rollback';
  readonly status: string;
  readonly replayed: boolean;
}

type Fetcher = typeof fetch;

async function request<T>(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetcher(url, { credentials: 'include', ...init });
  if (!response.ok) {
    let code: string | undefined;
    try {
      const body = (await response.json()) as { error?: { code?: string } };
      code = body.error?.code;
    } catch {
      code = undefined;
    }
    throw new ConfigurationApiError({ status: response.status, ...(code === undefined ? {} : { code }) });
  }
  return (await response.json()) as T;
}

function resourceUrl(session: ConfigurationSession, resourceId: string, suffix = ''): string {
  return `${session.baseUrl}/api/v1/servers/${session.serverId}/configuration/resources/${resourceId}${suffix}`;
}

export function createConfigurationClient(session: ConfigurationSession, fetcher: Fetcher = fetch) {
  const mutationHeaders = {
    'content-type': 'application/json',
    'x-csrf-token': session.csrfToken,
  };

  return {
    async listSchemas(): Promise<readonly ConfigurationSchemaView[]> {
      const catalog = await request<{ schemas: readonly ConfigurationSchemaView[] }>(
        fetcher,
        `${session.baseUrl}/api/v1/servers/${session.serverId}/configuration/schemas`,
        { method: 'GET' },
      );
      return catalog.schemas;
    },

    async readResource(resourceId: string): Promise<ConfigurationResourceStateView> {
      return request<ConfigurationResourceStateView>(fetcher, resourceUrl(session, resourceId), {
        method: 'GET',
      });
    },

    async listRevisions(resourceId: string): Promise<readonly ConfigurationRevisionView[]> {
      const page = await request<{ revisions: readonly ConfigurationRevisionView[] }>(
        fetcher,
        resourceUrl(session, resourceId, '/revisions'),
        { method: 'GET' },
      );
      return page.revisions;
    },

    async validate(
      resourceId: string,
      changes: readonly { readonly name: string; readonly value: boolean | number | string }[],
    ): Promise<{
      readonly applied: false;
      readonly valid: boolean;
      readonly restartRequired: boolean;
      readonly issues: readonly { readonly field: string; readonly code: string }[];
      readonly changedFields: readonly string[] | null;
    }> {
      return request(fetcher, resourceUrl(session, resourceId, '/validate'), {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({ schemaVersion: 1, changes }),
      });
    },

    async apply(input: ConfigurationApplyInput): Promise<ConfigurationAcceptanceView> {
      return request<ConfigurationAcceptanceView>(
        fetcher,
        resourceUrl(session, input.resourceId, '/apply'),
        {
          method: 'POST',
          headers: mutationHeaders,
          body: JSON.stringify({
            schemaVersion: 1,
            expectedCurrentSha256: input.expectedCurrentSha256,
            expectedStateVersion: input.expectedStateVersion,
            idempotencyKey: input.idempotencyKey,
            reasonCode: input.reasonCode,
            changes: input.changes,
          }),
        },
      );
    },

    async rollback(input: ConfigurationRollbackInput): Promise<ConfigurationAcceptanceView> {
      return request<ConfigurationAcceptanceView>(
        fetcher,
        resourceUrl(session, input.resourceId, '/rollback'),
        {
          method: 'POST',
          headers: mutationHeaders,
          body: JSON.stringify({
            schemaVersion: 1,
            targetRevisionId: input.targetRevisionId,
            expectedCurrentSha256: input.expectedCurrentSha256,
            expectedStateVersion: input.expectedStateVersion,
            idempotencyKey: input.idempotencyKey,
            reasonCode: input.reasonCode,
          }),
        },
      );
    },
  };
}

export type ConfigurationClient = ReturnType<typeof createConfigurationClient>;
