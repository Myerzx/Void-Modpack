'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { PanelSessionClient, type PanelFetch } from '../../lib/panel-session';
import { actionView, type PanelSession } from '../../lib/panel-shell';
import {
  buildDashboardView,
  buildInstanceSelectorView,
  buildOperationsView,
  type OperationPageInput,
  type ProcessStateReading,
  type ServerInstance,
} from '../../lib/panel-views';

/**
 * Server area: a real instance selector, a dashboard whose every tile states
 * where it came from, and the operations recorded for the selected instance.
 *
 * Nothing on this page mutates. The dangerous controls are rendered from the
 * shared action policy, which keeps them disabled until the phase that can
 * actually carry them out has landed.
 */

const panelFetch: PanelFetch = async (path, init) =>
  fetch(path, {
    method: init.method,
    credentials: 'include',
    ...(init.headers === undefined ? {} : { headers: init.headers }),
    ...(init.body === undefined ? {} : { body: init.body }),
  });

const DANGEROUS = ['server.start', 'server.stop', 'server.restart'] as const;

/** What each control says and which action it asks the agent to run. */
const CONTROL_LABELS: Readonly<Record<string, { label: string; action: string }>> = {
  'server.start': { label: 'Iniciar', action: 'start' },
  'server.stop': { label: 'Parar', action: 'stop' },
  'server.restart': { label: 'Reiniciar', action: 'restart' },
};

export default function ServerPage() {
  const [session, setSession] = useState<PanelSession | undefined>(undefined);
  const [signedOut, setSignedOut] = useState(false);
  const [instances, setInstances] = useState<readonly ServerInstance[] | undefined>(undefined);
  const [instanceStatus, setInstanceStatus] = useState<number | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [processState, setProcessState] = useState<ProcessStateReading | undefined>(undefined);
  const [operations, setOperations] = useState<OperationPageInput | undefined>(undefined);
  const [operationStatus, setOperationStatus] = useState<number | undefined>(undefined);
  const [controlBusy, setControlBusy] = useState<string | null>(null);
  const [controlFailure, setControlFailure] = useState<string | null>(null);

  useEffect(() => {
    const client = new PanelSessionClient(panelFetch);
    void client.current().then((outcome) => {
      if (outcome.kind === 'authenticated') setSession(outcome.session);
      else setSignedOut(true);
    });
  }, []);

  useEffect(() => {
    if (session === undefined) return;
    void (async () => {
      const response = await panelFetch('/api/v1/servers', { method: 'GET' });
      if (!response.ok) {
        setInstanceStatus(response.status);
        return;
      }
      const body = (await response.json()) as { readonly servers: readonly ServerInstance[] };
      setInstances(body.servers);
    })();
  }, [session]);

  const selector = useMemo(
    () =>
      session === undefined
        ? undefined
        : buildInstanceSelectorView({
            session,
            ...(instances === undefined ? {} : { instances }),
            selectedId,
            ...(instanceStatus === undefined ? {} : { status: instanceStatus }),
          }),
    [session, instances, selectedId, instanceStatus],
  );

  const activeId = selector?.selectedId ?? null;

  useEffect(() => {
    if (session === undefined || activeId === null) return;
    void (async () => {
      const [stateResponse, operationsResponse] = await Promise.all([
        panelFetch(`/api/v1/servers/${activeId}/process-state`, { method: 'GET' }),
        panelFetch(`/api/v1/servers/${activeId}/operations?limit=20`, { method: 'GET' }),
      ]);
      if (stateResponse.ok) setProcessState((await stateResponse.json()) as ProcessStateReading);
      if (operationsResponse.ok) {
        setOperations((await operationsResponse.json()) as OperationPageInput);
      } else {
        setOperationStatus(operationsResponse.status);
      }
    })();
  }, [session, activeId]);

  /**
   * Asks the agent to run a lifecycle action.
   *
   * The panel does not touch a process. It records a durable operation, the
   * agent claims it, and the result settles the operation — which is the only
   * reason these controls could be turned on at all. A second call while one
   * is in flight is refused by the API, and the refusal is shown rather than
   * retried.
   */
  const control = useCallback(
    async (actionId: string) => {
      if (session === undefined || activeId === null) return;
      const mapped = CONTROL_LABELS[actionId];
      if (mapped === undefined) return;
      setControlBusy(actionId);
      setControlFailure(null);
      try {
        const response = await panelFetch(`/api/v1/servers/${activeId}/process/control`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
          body: JSON.stringify({
            schemaVersion: 1,
            action: mapped.action,
            // Long enough to satisfy the contract, and distinct per press so a
            // deliberate second attempt is a second operation.
            idempotencyKey: `painel-${mapped.action}-${String(Date.now())}`,
            reasonCode: 'panel-control',
            timeoutSeconds: 600,
          }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as
            | { readonly error?: { readonly message?: string } }
            | null;
          setControlFailure(body?.error?.message ?? `Falhou (HTTP ${String(response.status)}).`);
        }
      } finally {
        setControlBusy(null);
      }
    },
    [activeId, session],
  );

  const dashboard = useMemo(() => {
    if (session === undefined) return undefined;
    const instance = instances?.find((candidate) => candidate.id === activeId);
    return buildDashboardView({
      session,
      ...(instance === undefined ? {} : { instance }),
      ...(processState === undefined ? {} : { processState }),
      ...(operations === undefined ? {} : { openOperations: operations.total }),
    });
  }, [session, instances, activeId, processState, operations]);

  const operationsView = useMemo(
    () =>
      session === undefined
        ? undefined
        : buildOperationsView({
            session,
            ...(operations === undefined ? {} : { page: operations }),
            ...(operationStatus === undefined ? {} : { status: operationStatus }),
          }),
    [session, operations, operationStatus],
  );

  const select = useCallback((id: string) => setSelectedId(id), []);

  if (signedOut) {
    return (
      <main className="panel">
        <p>Sua sessão terminou. Entre novamente para continuar.</p>
      </main>
    );
  }
  if (session === undefined || selector === undefined) {
    return <main className="panel"><p>Carregando…</p></main>;
  }

  return (
    <main className="panel">
      <h1>Servidor</h1>

      <section aria-label="Instância">
        {selector.screen.showsContent ? (
          <select value={selector.selectedId ?? ''} onChange={(event) => select(event.target.value)}>
            {selector.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label} — {option.environment} — {option.runtimeLabel}
              </option>
            ))}
          </select>
        ) : (
          <p>
            <strong>{selector.screen.title}</strong> {selector.screen.detail}
          </p>
        )}
        <small>{selector.provenance.label}</small>
      </section>

      <section aria-label="Painel da instância">
        {dashboard?.screen.showsContent === true ? (
          <>
            <ul>
              {dashboard.tiles.map((tile) => (
                <li key={tile.id}>
                  <strong>{tile.label}:</strong> {tile.value}
                  <small>
                    {tile.provenance.label}
                    {tile.provenance.observedAt === null ? '' : ` · ${tile.provenance.observedAt}`}
                  </small>
                </li>
              ))}
            </ul>
            <p>
              Ainda como fixture de demonstração: {dashboard.fixtureAreas.join(', ')}.
            </p>
          </>
        ) : (
          <p>
            <strong>{dashboard?.screen.title}</strong> {dashboard?.screen.detail}
          </p>
        )}
      </section>

      <section aria-label="Operações">
        {operationsView?.screen.showsContent === true ? (
          <table>
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Estado</th>
                <th>Recibo</th>
                <th>Correlação</th>
              </tr>
            </thead>
            <tbody>
              {operationsView.rows.map((row) => (
                <tr key={row.operationId}>
                  <td>{row.kind}</td>
                  <td>{row.status}</td>
                  <td>{row.receiptOutcome ?? '—'}</td>
                  <td>{row.correlationId.slice(0, 8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>
            <strong>{operationsView?.screen.title}</strong> {operationsView?.screen.detail}
          </p>
        )}
      </section>

      {/* Rendered from the shared policy: an action without permission is not
          rendered at all, and one whose phase has not landed stays disabled. */}
      <section aria-label="Ações de processo">
        {controlFailure === null ? null : <p className="banner banner-danger">{controlFailure}</p>}
        {DANGEROUS.map((id) => actionView(session, id))
          .filter((action) => action.visible)
          .map((action) => (
            <button
              key={action.id}
              className="primary"
              type="button"
              disabled={!action.enabled || controlBusy !== null || activeId === null}
              title={action.reason}
              onClick={() => void control(action.id)}
            >
              {controlBusy === action.id
                ? 'Enviando…'
                : (CONTROL_LABELS[action.id]?.label ?? action.id)}
            </button>
          ))}
      </section>
    </main>
  );
}
