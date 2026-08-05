'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { PanelSessionClient, type PanelFetch } from '../../lib/panel-session';
import type { PanelSession } from '../../lib/panel-shell';
import { buildAuditView } from '../../lib/panel-views';

/**
 * Audit area, backed by the bounded Control API listing.
 *
 * Paging is server-side and bounded there: this screen cannot ask for an
 * unbounded scan of the chain, and a correlation filter is how one request is
 * followed across the operation, the job and the audit trail.
 */

const panelFetch: PanelFetch = async (path, init) =>
  fetch(path, {
    method: init.method,
    credentials: 'include',
    ...(init.headers === undefined ? {} : { headers: init.headers }),
    ...(init.body === undefined ? {} : { body: init.body }),
  });

const PAGE_SIZE = 50;

interface AuditPage {
  readonly events: readonly {
    readonly id: string;
    readonly occurredAt: string;
    readonly action: string;
    readonly outcome: string;
    readonly actor: { readonly type: string; readonly id: string };
    readonly correlationId: string;
  }[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export default function AuditPage() {
  const [session, setSession] = useState<PanelSession | undefined>(undefined);
  const [signedOut, setSignedOut] = useState(false);
  const [page, setPage] = useState<AuditPage | undefined>(undefined);
  const [status, setStatus] = useState<number | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const [correlationId, setCorrelationId] = useState('');

  useEffect(() => {
    const client = new PanelSessionClient(panelFetch);
    void client.current().then((outcome) => {
      if (outcome.kind === 'authenticated') setSession(outcome.session);
      else setSignedOut(true);
    });
  }, []);

  const load = useCallback(async () => {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (/^[0-9a-f-]{36}$/iu.test(correlationId)) query.set('correlationId', correlationId);
    const response = await panelFetch(`/api/v1/audit/page?${query.toString()}`, { method: 'GET' });
    if (!response.ok) {
      setStatus(response.status);
      setPage(undefined);
      return;
    }
    setStatus(undefined);
    setPage((await response.json()) as AuditPage);
  }, [offset, correlationId]);

  useEffect(() => {
    if (session === undefined) return;
    void load();
  }, [session, load]);

  const view = useMemo(
    () =>
      session === undefined
        ? undefined
        : buildAuditView({
            session,
            ...(page === undefined ? {} : { page }),
            ...(status === undefined ? {} : { status }),
          }),
    [session, page, status],
  );

  if (signedOut) {
    return (
      <main className="panel">
        <p>Sua sessão terminou. Entre novamente para continuar.</p>
      </main>
    );
  }
  if (view === undefined) return <main className="panel"><p>Carregando…</p></main>;

  return (
    <main className="panel">
      <h1>Auditoria</h1>

      <section aria-label="Filtros">
        <input
          type="search"
          placeholder="Filtrar por correlação"
          value={correlationId}
          onChange={(event) => {
            setOffset(0);
            setCorrelationId(event.target.value);
          }}
        />
      </section>

      {view.screen.showsContent ? (
        <>
          <table>
            <thead>
              <tr>
                <th>Quando</th>
                <th>Ação</th>
                <th>Resultado</th>
                <th>Ator</th>
                <th>Correlação</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.occurredAt}</td>
                  <td>{row.action}</td>
                  <td>{row.outcome}</td>
                  <td>{row.actorLabel}</td>
                  <td>{row.correlationId.slice(0, 8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            {view.offset + view.rows.length} de {view.total}
          </p>
          <button
            type="button"
            disabled={view.offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Anterior
          </button>
          <button
            type="button"
            disabled={view.offset + view.rows.length >= view.total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Próxima
          </button>
        </>
      ) : (
        <p>
          <strong>{view.screen.title}</strong> {view.screen.detail}
        </p>
      )}
    </main>
  );
}
