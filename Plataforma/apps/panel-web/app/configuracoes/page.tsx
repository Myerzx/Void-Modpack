'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createConfigurationClient,
  ConfigurationApiError,
  type ConfigurationClient,
} from '../../lib/configuration-client';
import {
  buildConfigurationScreen,
  changeEntriesFor,
  computeSafeDiff,
  displayValue,
  screenStateForError,
  type ConfigurationDraft,
  type ConfigurationResourceStateView,
  type ConfigurationRevisionView,
  type ConfigurationScreenState,
  type ConfigurationSchemaView,
} from '../../lib/configuration-view';

/**
 * The configuration screen is the only panel area backed by the real Control
 * API. Every other area remains a declared fixture, so nothing here is
 * presented as live unless it came from the API.
 *
 * Restart is displayed as metadata only: this screen has no control that
 * starts, stops or restarts Minecraft.
 */

const RESOURCE_ID = 'openloader-advanced-options';
const REASON_CODE = 'operator-request';

function idempotencyKey(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

interface PanelSession {
  readonly serverId: string;
  readonly csrfToken: string;
  readonly permissions: readonly string[];
}

export default function ConfigurationPage() {
  const [session, setSession] = useState<PanelSession | undefined>(undefined);
  const [schema, setSchema] = useState<ConfigurationSchemaView | undefined>(undefined);
  const [state, setState] = useState<ConfigurationResourceStateView | undefined>(undefined);
  const [revisions, setRevisions] = useState<readonly ConfigurationRevisionView[]>([]);
  const [draft, setDraft] = useState<ConfigurationDraft>({});
  const [screen, setScreen] = useState<ConfigurationScreenState>({ kind: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const client: ConfigurationClient | undefined = useMemo(
    () =>
      session === undefined
        ? undefined
        : createConfigurationClient({
            baseUrl: '',
            serverId: session.serverId,
            csrfToken: session.csrfToken,
          }),
    [session],
  );

  const load = useCallback(
    async (activeClient: ConfigurationClient, activeSession: PanelSession) => {
      const schemas = await activeClient.listSchemas();
      const selected = schemas.find((candidate) => candidate.resourceId === RESOURCE_ID);
      if (selected === undefined || !selected.registered) {
        setSchema(selected);
        setState(undefined);
        setScreen(
          buildConfigurationScreen({
            schema: selected,
            state: undefined,
            revisions: [],
            permissions: activeSession.permissions,
          }),
        );
        return;
      }
      const [resourceState, revisionPage] = await Promise.all([
        activeClient.readResource(RESOURCE_ID),
        activeClient.listRevisions(RESOURCE_ID),
      ]);
      setSchema(selected);
      setState(resourceState);
      setRevisions(revisionPage);
      setDraft(
        Object.fromEntries(
          resourceState.values.flatMap((value) =>
            value.redacted ? [] : ([[value.name, value.value]] as const),
          ),
        ),
      );
      setScreen(
        buildConfigurationScreen({
          schema: selected,
          state: resourceState,
          revisions: revisionPage,
          permissions: activeSession.permissions,
        }),
      );
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (client === undefined || session === undefined) return;
    try {
      await load(client, session);
    } catch (error) {
      setScreen(
        error instanceof ConfigurationApiError
          ? screenStateForError(error.status, error.code)
          : screenStateForError(0),
      );
    }
  }, [client, load, session]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/v1/auth/session', { credentials: 'include' });
        if (!response.ok) {
          if (!cancelled) setScreen(screenStateForError(response.status));
          return;
        }
        const body = (await response.json()) as {
          permissions?: readonly string[];
          serverId?: string;
          csrfToken?: string;
        };
        if (cancelled) return;
        if (typeof body.serverId !== 'string' || typeof body.csrfToken !== 'string') {
          // Without an instance and a CSRF token there is nothing safe to show.
          setScreen(screenStateForError(403));
          return;
        }
        setSession({
          serverId: body.serverId,
          csrfToken: body.csrfToken,
          permissions: body.permissions ?? [],
        });
      } catch {
        if (!cancelled) setScreen(screenStateForError(0));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const diff = useMemo(
    () => (schema !== undefined && state !== undefined ? computeSafeDiff(schema, state, draft) : undefined),
    [draft, schema, state],
  );

  async function runValidation() {
    if (client === undefined || diff === undefined) return;
    setPending(true);
    setNotice(null);
    try {
      const result = await client.validate(RESOURCE_ID, changeEntriesFor(diff));
      setNotice(
        result.valid
          ? `Validação concluída sem aplicar. ${result.restartRequired ? 'Exigirá reinício.' : ''}`
          : `Alterações inválidas: ${result.issues.map((issue) => `${issue.field} (${issue.code})`).join(', ')}`,
      );
    } catch (error) {
      if (error instanceof ConfigurationApiError) setScreen(screenStateForError(error.status, error.code));
    } finally {
      setPending(false);
    }
  }

  async function runApply() {
    if (client === undefined || diff === undefined || state === undefined) return;
    setPending(true);
    setNotice(null);
    try {
      const acceptance = await client.apply({
        resourceId: RESOURCE_ID,
        expectedCurrentSha256: state.currentSha256,
        expectedStateVersion: state.stateVersion,
        idempotencyKey: idempotencyKey('configuration-apply'),
        reasonCode: REASON_CODE,
        changes: changeEntriesFor(diff),
      });
      setNotice(
        `Operação ${acceptance.replayed ? 'já registrada' : 'enfileirada'}: revisão ${acceptance.revisionId}.`,
      );
      await refresh();
    } catch (error) {
      if (error instanceof ConfigurationApiError) setScreen(screenStateForError(error.status, error.code));
    } finally {
      setPending(false);
    }
  }

  async function runRollback(targetRevisionId: string) {
    if (client === undefined || state === undefined) return;
    setPending(true);
    setNotice(null);
    try {
      const acceptance = await client.rollback({
        resourceId: RESOURCE_ID,
        targetRevisionId,
        expectedCurrentSha256: state.currentSha256,
        expectedStateVersion: state.stateVersion,
        idempotencyKey: idempotencyKey('configuration-rollback'),
        reasonCode: REASON_CODE,
      });
      setNotice(`Rollback enfileirado: revisão ${acceptance.revisionId}.`);
      await refresh();
    } catch (error) {
      if (error instanceof ConfigurationApiError) setScreen(screenStateForError(error.status, error.code));
    } finally {
      setPending(false);
    }
  }

  if (screen.kind === 'loading') {
    return (
      <main className="content" aria-busy="true">
        <p>Carregando configurações autorizadas…</p>
      </main>
    );
  }

  if (screen.kind !== 'ready') {
    return (
      <main className="content">
        <section className="panel" role={screen.kind === 'error' ? 'alert' : undefined}>
          <h1>Configurações</h1>
          <p>{screen.message}</p>
          {screen.kind === 'conflict' ? (
            <button type="button" onClick={() => void refresh()}>
              Recarregar
            </button>
          ) : null}
        </section>
      </main>
    );
  }

  const readOnly = !screen.capabilities.canApply || screen.busyNotice !== null;

  return (
    <main className="content">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Operação / Configurações</span>
          <h1>OpenLoader — opções avançadas</h1>
          <p>
            Schema revisado {screen.schema.definitionVersion} · modo {screen.schema.applyMode}
          </p>
        </div>
      </div>

      {screen.restartNotice === null ? null : (
        <section className="panel-note">
          <p>{screen.restartNotice}</p>
        </section>
      )}
      {screen.valuesNotice === null ? null : (
        <section className="panel-note">
          <p>{screen.valuesNotice}</p>
        </section>
      )}
      {screen.busyNotice === null ? null : (
        <section className="panel-note" role="status">
          <p>{screen.busyNotice}</p>
        </section>
      )}
      {notice === null ? null : (
        <section className="panel-note" role="status">
          <p>{notice}</p>
        </section>
      )}

      <section className="panel" aria-label="Valores atuais">
        <h2>Valores atuais</h2>
        <dl className="server-facts">
          {screen.state.values.map((value) => (
            <div key={value.name}>
              <dt>{value.name}</dt>
              <dd>{displayValue(value)}</dd>
            </div>
          ))}
        </dl>
        <p>
          Revisão aplicada: {screen.state.lastAppliedRevisionId ?? 'nenhuma'} · estado{' '}
          {screen.state.status}
        </p>
      </section>

      {screen.editableFields.length === 0 ? null : (
        <section className="panel" aria-label="Editar configuração">
          <h2>Alterar</h2>
          {screen.editableFields.map((field) =>
            field.type === 'boolean' ? (
              <label key={field.name}>
                <input
                  type="checkbox"
                  checked={draft[field.name] === true}
                  disabled={readOnly || pending}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [field.name]: event.target.checked }))
                  }
                />
                <span>
                  {field.name}
                  {field.restartRequired ? ' · exige reinício' : ''}
                </span>
              </label>
            ) : null,
          )}
        </section>
      )}

      {diff === undefined || !diff.hasChanges ? null : (
        <section className="panel" aria-label="Alterações pendentes">
          <h2>Diferenças</h2>
          <ul>
            {diff.entries.map((entry) => (
              <li key={entry.name}>
                {entry.name}: {String(entry.from)} → {String(entry.to)}
                {entry.restartRequired ? ' · exige reinício' : ''}
              </li>
            ))}
          </ul>
          {diff.undiffableFields.length === 0 ? null : (
            <p>
              Sem valor legível para comparar: {diff.undiffableFields.join(', ')}. Esses campos não
              serão enviados.
            </p>
          )}
          <div>
            {screen.capabilities.canValidate ? (
              <button type="button" disabled={pending} onClick={() => void runValidation()}>
                Validar sem aplicar
              </button>
            ) : null}
            {screen.capabilities.canApply ? (
              <button type="button" disabled={readOnly || pending} onClick={() => void runApply()}>
                Aplicar
              </button>
            ) : null}
          </div>
        </section>
      )}

      <section className="panel" aria-label="Histórico de revisões">
        <h2>Revisões</h2>
        {screen.revisions.length === 0 ? (
          <p>Nenhuma revisão registrada para esta configuração.</p>
        ) : (
          <ol>
            {screen.revisions.map((entry) => (
              <li key={entry.revisionId}>
                <strong>{entry.revisionId}</strong> · {entry.operation} · {entry.status}
                {entry.failureCode === null ? '' : ` · ${entry.failureCode}`}
                {screen.capabilities.canRollback && entry.rollbackEligible ? (
                  <button
                    type="button"
                    disabled={pending || screen.busyNotice !== null}
                    onClick={() => void runRollback(entry.revisionId)}
                  >
                    Reverter para esta revisão
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
