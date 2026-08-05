'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
} from '../../lib/artifact-view';

/**
 * The mod review screen.
 *
 * It is backed by the real Control API: the list, the incompatibility drawer
 * and the dependency graph all come from stored reports, never from a fixture.
 * When a report does not exist yet the screen says so instead of inventing one.
 *
 * There is deliberately no install control. Approving an artifact changes its
 * review state and nothing else.
 */

interface PanelSession {
  readonly serverId: string;
  readonly csrfToken: string;
  readonly permissions: readonly string[];
}

const install = buildInstallActionView();

export default function ModsPage() {
  const [session, setSession] = useState<PanelSession | undefined>(undefined);
  const [page, setPage] = useState<ArtifactSubmissionPage | undefined>(undefined);
  const [detail, setDetail] = useState<ArtifactSubmissionDetail | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState<IssueSeverityFilter>('all');
  const [graphOpen, setGraphOpen] = useState(false);
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>('idle');
  const [uploadSent, setUploadSent] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);

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
    const stored = globalThis.sessionStorage?.getItem('voidfall.session');
    if (stored === null || stored === undefined) return;
    const parsed = JSON.parse(stored) as PanelSession;
    setSession(parsed);
    void refresh(parsed);
  }, [refresh]);

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
      setDetail((await response.json()) as ArtifactSubmissionDetail);
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

  if (session === undefined) {
    return <main className="panel"><p>Entre no painel para revisar artefatos.</p></main>;
  }
  if (!session.permissions.includes('mods.view')) {
    return <main className="panel"><p>Sua sessão não tem permissão para ver artefatos.</p></main>;
  }

  return (
    <main className="panel">
      <h1>Mods em revisão</h1>
      {error !== undefined ? <p role="alert">{error}</p> : null}

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

          {/* The install action is absent by construction in this phase. */}
          {install.present ? null : <p>{install.reason}</p>}
        </aside>
      ) : null}
    </main>
  );
}
