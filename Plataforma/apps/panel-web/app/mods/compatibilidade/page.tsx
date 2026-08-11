'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { modsSteps, PanelShell } from '../../components/shell';
import {
  readOperationalContext,
  rememberActiveServerId,
} from '../../../lib/active-server';
import type { ServerInstance } from '../../../lib/panel-views';
import {
  buildArtifactListView,
  buildDependencyGraphView,
  buildIncompatibilityDrawerView,
  buildInstallActionView,
  buildUploadProgressView,
  type ArtifactSubmissionDetail,
  type ArtifactSubmissionPage,
  type IssueSeverityFilter,
  type UploadPhase,
} from '../../../lib/artifact-view';

/**
 * The mod review screen.
 *
 * It is backed by the real Control API: the list, the incompatibility drawer
 * and the dependency graph all come from stored reports, never from a fixture.
 * When a report does not exist yet the screen says so instead of inventing one.
 *
 * Approval and installation stay separate: only the durable offline agent
 * operation promotes the reviewed bytes into the server.
 */

interface PanelSession {
  readonly serverId: string;
  readonly csrfToken: string;
  readonly permissions: readonly string[];
}

export default function ModsPage() {
  const [session, setSession] = useState<PanelSession | undefined>(undefined);
  const [servers, setServers] = useState<readonly ServerInstance[]>([]);
  const [sessionState, setSessionState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [page, setPage] = useState<ArtifactSubmissionPage | undefined>(undefined);
  const [detail, setDetail] = useState<ArtifactSubmissionDetail | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState<IssueSeverityFilter>('all');
  const [graphOpen, setGraphOpen] = useState(false);
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>('idle');
  const [uploadSent, setUploadSent] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [reviewSide, setReviewSide] = useState<'server' | 'both'>('server');
  const [actionBusy, setActionBusy] = useState<'approve' | 'reject' | 'install' | undefined>();

  const refresh = useCallback(async (current: PanelSession) => {
    const response = await fetch(`/api/v1/servers/${current.serverId}/artifacts`, {
      credentials: 'include',
    });
    if (!response.ok) {
      setError('Não foi possível carregar os artefatos.');
      return;
    }
    setPage((await response.json()) as ArtifactSubmissionPage);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void readOperationalContext()
      .then((context) => {
        if (cancelled) return;
        if (context.kind !== 'ready') {
          setSessionState('unavailable');
          return;
        }
        setServers(context.servers);
        setSession(context.session);
        setSessionState('ready');
        void refresh(context.session);
      })
      .catch(() => {
        if (!cancelled) setSessionState('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const selectServer = useCallback(
    (serverId: string) => {
      if (session === undefined) return;
      rememberActiveServerId(serverId);
      const selected = { ...session, serverId };
      setSession(selected);
      setDetail(undefined);
      setPage(undefined);
      void refresh(selected);
    },
    [refresh, session],
  );

  const list = useMemo(
    () => (page === undefined ? undefined : buildArtifactListView({ page, search })),
    [page, search],
  );
  const drawer = useMemo(
    () => (detail === undefined ? undefined : buildIncompatibilityDrawerView(detail, severity)),
    [detail, severity],
  );
  const graph = useMemo(
    () => (detail === undefined || !graphOpen ? undefined : buildDependencyGraphView(detail)),
    [detail, graphOpen],
  );
  const progress = buildUploadProgressView({
    phase: uploadPhase,
    sentBytes: uploadSent,
    totalBytes: uploadTotal,
  });

  const openDetail = useCallback(
    async (submissionId: string) => {
      if (session === undefined) return;
      setGraphOpen(false);
      const response = await fetch(
        `/api/v1/servers/${session.serverId}/artifacts/${submissionId}`,
        { credentials: 'include' },
      );
      if (!response.ok) {
        setError('Não foi possível carregar a análise deste artefato.');
        return;
      }
      const selected = (await response.json()) as ArtifactSubmissionDetail;
      setDetail(selected);
      setReviewSide(selected.submission.reviewedSide === 'both' ? 'both' : 'server');
    },
    [session],
  );

  const upload = useCallback(
    async (file: File) => {
      if (session === undefined) return;
      setError(undefined);
      setUploadPhase('hashing');
      setUploadTotal(file.size);
      setUploadSent(0);

      const bytes = new Uint8Array(await file.arrayBuffer());
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      const sha256 = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');

      setUploadPhase('uploading');
      const response = await fetch(`/api/v1/servers/${session.serverId}/artifacts`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/octet-stream',
          'x-csrf-token': session.csrfToken,
          'x-artifact-filename': file.name,
          'x-artifact-sha256': sha256,
        },
        body: bytes,
      });
      setUploadSent(file.size);

      if (!response.ok) {
        setUploadPhase('failed');
        setError('O envio foi recusado.');
        return;
      }
      // Quarantine and analysis are separate durable steps.
      setUploadPhase('quarantined');
      await refresh(session);
      setUploadPhase('analyzing');
    },
    [refresh, session],
  );

  const decide = useCallback(
    async (decision: 'approve' | 'reject') => {
      if (session === undefined || detail === undefined) return;
      setActionBusy(decision);
      setError(undefined);
      setNotice(undefined);
      try {
        const response = await fetch(
          `/api/v1/servers/${session.serverId}/artifacts/${detail.submission.submissionId}/decision`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
            body: JSON.stringify({
              schemaVersion: 1,
              decision,
              reasonCode: decision === 'approve' ? 'operator-approved' : 'operator-rejected',
              analyzedSha256: detail.submission.sha256,
              expectedVersion: detail.submission.version,
              ...(decision === 'approve' ? { reviewedSide: reviewSide } : {}),
            }),
          },
        );
        if (!response.ok) throw new Error('A decisão foi recusada; recarregue a análise.');
        setNotice(decision === 'approve' ? 'Artefato aprovado para instalação.' : 'Artefato rejeitado.');
        await Promise.all([refresh(session), openDetail(detail.submission.submissionId)]);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Não foi possível registrar a decisão.');
      } finally {
        setActionBusy(undefined);
      }
    },
    [detail, openDetail, refresh, reviewSide, session],
  );

  const installAction = useMemo(
    () =>
      detail === undefined
        ? undefined
        : buildInstallActionView(detail, session?.permissions.includes('mods.manage') === true),
    [detail, session],
  );

  const installArtifact = useCallback(async () => {
    if (session === undefined || detail === undefined || installAction?.enabled !== true) return;
    setActionBusy('install');
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetch(
        `/api/v1/servers/${session.serverId}/artifacts/${detail.submission.submissionId}/install`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
          body: JSON.stringify({
            schemaVersion: 1,
            analyzedSha256: detail.submission.sha256,
            expectedVersion: detail.submission.version,
            idempotencyKey: `panel-artifact-install-${detail.submission.submissionId}-${String(detail.submission.version)}`,
            reasonCode: 'operator-install-approved',
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? 'A instalação exige o servidor offline e sem outra operação em andamento.'
            : 'A instalação foi recusada pelo servidor.',
        );
      }
      setNotice('Instalação aceita. O agente está promovendo o mod aprovado para o servidor.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível instalar o artefato.');
    } finally {
      setActionBusy(undefined);
    }
  }, [detail, installAction, session]);

  if (sessionState === 'loading') {
    return <PanelShell title="Compatibilidade" category="mods" steps={modsSteps('compatibility')}><section className="card"><p>Carregando artefatos…</p></section></PanelShell>;
  }
  if (session === undefined) {
    return <PanelShell title="Compatibilidade" category="mods" steps={modsSteps('compatibility')}><section className="card"><p>Entre no painel para revisar artefatos.</p></section></PanelShell>;
  }
  if (!session.permissions.includes('mods.view')) {
    return <PanelShell title="Compatibilidade" category="mods" steps={modsSteps('compatibility')}><section className="card"><p>Sua sessão não tem permissão para ver artefatos.</p></section></PanelShell>;
  }

  return (
    <PanelShell
      title="Compatibilidade"
      category="mods"
      steps={modsSteps('compatibility')}
      subtitle="Quarentena, inspeção e revisão de artefatos antes da instalação."
      actions={
        servers.length > 0 ? (
          <label className="compact-select server-instance-select">
            <span>Instância ativa</span>
            <select value={session.serverId} onChange={(event) => selectServer(event.target.value)}>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>{server.displayName}</option>
              ))}
            </select>
          </label>
        ) : undefined
      }
    >
      <main className="card artifact-review">
      <h1>Mods em revisão</h1>
      {error !== undefined ? <p className="banner banner-danger" role="alert">{error}</p> : null}
      {notice !== undefined ? <p className="banner banner-neutral" role="status">{notice}</p> : null}

      {session.permissions.includes('mods.manage') ? (
        <section aria-label="Envio de artefato">
          <input
            type="file"
            accept=".jar,.zip"
            disabled={progress.busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void upload(file);
            }}
          />
          <p>{progress.label}</p>
          <progress max={100} value={progress.percent} />
        </section>
      ) : null}

      <section aria-label="Lista de mods">
        <input
          type="search"
          placeholder="Buscar por arquivo, mod id ou hash"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {list === undefined ? (
          <p>Carregando…</p>
        ) : list.items.length === 0 ? (
          <p>
            {list.emptyReason === 'no-submissions'
              ? 'Nenhum artefato foi enviado ainda.'
              : 'Nenhum artefato corresponde à busca.'}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Arquivo</th>
                <th>Lado</th>
                <th>Versão</th>
                <th>Estado</th>
                <th>Problemas</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((item) => (
                <tr key={item.submissionId}>
                  <td>
                    <button type="button" onClick={() => void openDetail(item.submissionId)}>
                      {item.filename}
                    </button>
                    <span>{item.shortSha256}</span>
                  </td>
                  <td>{item.sideLabel}</td>
                  <td>{item.versionLabel}</td>
                  <td>
                    {item.stateLabel}
                    {item.unverified ? ' (não comprovado)' : ''}
                  </td>
                  <td>
                    {item.blockerCount} / {item.warningCount} / {item.informationCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {detail !== undefined && drawer !== undefined ? (
        <aside aria-label="Incompatibilidades">
          <h2>{detail.submission.filename}</h2>
          <div role="group" aria-label="Filtro por severidade">
            {(['all', 'blocker', 'warning', 'information'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={severity === option}
                onClick={() => setSeverity(option)}
              >
                {option === 'all'
                  ? `Todas (${drawer.counts.blocker + drawer.counts.warning + drawer.counts.information})`
                  : option === 'blocker'
                    ? `Bloqueios (${drawer.counts.blocker})`
                    : option === 'warning'
                      ? `Avisos (${drawer.counts.warning})`
                      : `Informações (${drawer.counts.information})`}
              </button>
            ))}
          </div>

          {drawer.rows.length === 0 ? (
            <p>{drawer.emptyLabel}</p>
          ) : (
            <ul>
              {drawer.rows.map((row) => (
                <li key={`${row.code}:${row.reason}:${row.detail ?? ''}`}>
                  <strong>
                    {row.severityLabel} · {row.determinacyLabel}
                  </strong>
                  <code>{row.code}</code>
                  <p>{row.explanation}</p>
                  {row.detail !== null ? <p>{row.detail}</p> : null}
                  {row.evidence.length > 0 ? <p>Evidência: {row.evidence.join(', ')}</p> : null}
                  <p>Ação recomendada: {row.recommendedAction}</p>
                </li>
              ))}
            </ul>
          )}

          <button type="button" onClick={() => setGraphOpen((open) => !open)}>
            {graphOpen ? 'Ocultar dependências' : 'Ver dependências'}
          </button>
          {graph !== undefined ? (
            graph.available ? (
              <ul aria-label="Grafo de dependências">
                {graph.edges.map((edge) => (
                  <li key={`${edge.from}->${edge.to}`}>
                    {edge.from} → {edge.to}
                    {edge.mandatory ? ' (obrigatória)' : ' (opcional)'}
                    {edge.versionRange === null ? '' : ` ${edge.versionRange}`}
                  </li>
                ))}
              </ul>
            ) : (
              <p>O artefato ainda não foi inspecionado.</p>
            )
          ) : null}

          <section className="artifact-actions" aria-label="Decisão e instalação">
            {detail.submission.state === 'reviewable' && session.permissions.includes('mods.classify') ? (
              <>
                <label className="compact-select">
                  <span>Aprovar para</span>
                  <select value={reviewSide} onChange={(event) => setReviewSide(event.target.value as 'server' | 'both')}>
                    <option value="server">Servidor</option>
                    <option value="both">Cliente e servidor</option>
                  </select>
                </label>
                <button className="primary" type="button" disabled={actionBusy !== undefined} onClick={() => void decide('approve')}>
                  {actionBusy === 'approve' ? 'Aprovando…' : 'Aprovar artefato'}
                </button>
              </>
            ) : null}
            {(detail.submission.state === 'reviewable' || detail.submission.state === 'blocked') && session.permissions.includes('mods.classify') ? (
              <button className="secondary" type="button" disabled={actionBusy !== undefined} onClick={() => void decide('reject')}>
                {actionBusy === 'reject' ? 'Rejeitando…' : 'Rejeitar'}
              </button>
            ) : null}
            {installAction?.present === true ? (
              <button
                className="primary"
                type="button"
                disabled={!installAction.enabled || actionBusy !== undefined}
                title={installAction.reason}
                onClick={() => void installArtifact()}
              >
                {actionBusy === 'install' ? 'Instalando…' : 'Instalar no servidor'}
              </button>
            ) : null}
            {installAction !== undefined && !installAction.enabled ? <p className="muted">{installAction.reason}</p> : null}
          </section>
        </aside>
      ) : null}
      </main>
    </PanelShell>
  );
}
