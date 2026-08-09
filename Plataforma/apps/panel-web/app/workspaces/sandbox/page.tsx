'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  OUTCOME_LABELS,
  OUTCOME_TONE,
  type SandboxRunView,
  type StagedChangeSummary,
} from '../../../lib/sandbox-client';
import {
  discardStaged,
  listSandboxRuns,
  PanelApiError,
  readSandboxRun,
  readSession,
  readStagedChanges,
  startSandboxRun,
  type PanelSession,
} from '../../../lib/workspace-client';
import { PanelShell, stepsFor } from '../../components/shell';

/**
 * Testing a change on a disposable copy, and reading what happened.
 *
 * The boot spawns a real JVM against a sandbox composed from the minimum
 * files, and the original world is never copied or touched — which is the only
 * reason pointing this at somebody's real server is acceptable. That property
 * belongs to the engine; this screen states it and does not re-decide it.
 *
 * Four distinctions it keeps, all of them the engine's:
 *
 * **Running is not failing.** While a boot is in flight there is no outcome,
 * and the screen shows progress rather than a verdict it does not have.
 *
 * **Timed out is not failed.** The window closed while the server was still
 * loading. That is an unknown, and it is coloured as one.
 *
 * **Refused is not "did not boot".** A missing EULA acceptance or no Java the
 * runner could find means it never started, and the named cause is what tells
 * an operator what to change.
 *
 * **A disposal failure sits beside the result, never on top of it.** On the
 * first real run, cleanup replaced the boot result entirely, so the answer to
 * "did the server start" was an error about a directory.
 */

const POLL_MS = 3_000;

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  return `${(ms / 1_000).toFixed(1)} s`;
}

function SandboxView() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [session, setSession] = useState<PanelSession | null>(null);
  const [staged, setStaged] = useState<readonly StagedChangeSummary[]>([]);
  const [runs, setRuns] = useState<readonly SandboxRunView[]>([]);
  const [available, setAvailable] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setWorkspaceId(new URLSearchParams(window.location.search).get('id'));
  }, []);

  const refresh = useCallback(async (id: string) => {
    const [stagedResult, runsResult] = await Promise.all([
      readStagedChanges(id),
      listSandboxRuns(id),
    ]);
    setStaged(stagedResult.staged);
    setRuns(runsResult.runs);
    setAvailable(runsResult.available);
    return runsResult.runs;
  }, []);

  useEffect(() => {
    if (workspaceId === null) return;
    let cancelled = false;

    const tick = async (): Promise<void> => {
      try {
        const current = await refresh(workspaceId);
        if (cancelled) return;
        // Polled only while something is actually in flight. A finished run is
        // evidence and does not change again.
        if (current.some((run) => run.status === 'running')) {
          timer.current = setTimeout(() => void tick(), POLL_MS);
        }
      } catch (error) {
        if (!cancelled) {
          setFailure(error instanceof PanelApiError ? error.message : 'Falha ao ler as execuções.');
        }
      }
    };

    void (async () => {
      const current = await readSession().catch(() => null);
      if (cancelled) return;
      if (current === null) {
        window.location.href = '/entrar';
        return;
      }
      setSession(current);
      await tick();
    })();

    return () => {
      cancelled = true;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [refresh, workspaceId]);

  const start = useCallback(async () => {
    if (workspaceId === null || session?.csrfToken == null) return;
    setBusy(true);
    setFailure(null);
    try {
      const started = await startSandboxRun(workspaceId, session.csrfToken);
      const poll = async (): Promise<void> => {
        const result = await readSandboxRun(workspaceId, started.runId);
        setRuns((current) => [
          result.run,
          ...current.filter((run) => run.runId !== result.run.runId),
        ]);
        if (result.run.status === 'running') timer.current = setTimeout(() => void poll(), POLL_MS);
      };
      await poll();
    } catch (error) {
      setFailure(error instanceof PanelApiError ? error.message : 'Não foi possível iniciar.');
    } finally {
      setBusy(false);
    }
  }, [session, workspaceId]);

  const discard = useCallback(
    async (path: string) => {
      if (workspaceId === null || session?.csrfToken == null) return;
      setBusy(true);
      try {
        await discardStaged(workspaceId, path, session.csrfToken);
        await refresh(workspaceId);
      } catch (error) {
        setFailure(error instanceof PanelApiError ? error.message : 'Não foi possível descartar.');
      } finally {
        setBusy(false);
      }
    },
    [refresh, session, workspaceId],
  );

  if (workspaceId === null) {
    return (
      <PanelShell title="Sandbox" category="files" steps={stepsFor(null, 'sandbox')}>
        <p className="muted">Nenhum workspace informado.</p>
      </PanelShell>
    );
  }

  const running = runs.find((run) => run.status === 'running');

  return (
    <PanelShell
      category="files"
      title="Sandbox"
      steps={stepsFor(workspaceId, 'sandbox')}
      subtitle="Um boot numa cópia descartável, montada a partir dos arquivos mínimos. O mundo original nunca é copiado nem tocado."
    >

      {failure === null ? null : <p className="banner banner-danger">{failure}</p>}

      {available ? null : (
        <p className="banner banner-warning">
          A execução em sandbox não está configurada nesta instância.
        </p>
      )}

      <section className="card">
        <header className="card-head">
          <h2>Mudanças preparadas</h2>
          <span className="tag">{staged.length}</span>
        </header>
        <p className="muted">
          Um boot com estas mudanças roda numa cópia descartável, montada a partir dos arquivos
          mínimos. O mundo original nunca é copiado nem tocado.
        </p>
        {staged.length === 0 ? (
          <p className="muted">
            Nada preparado. O boot vai testar o que já está instalado, não uma mudança.
          </p>
        ) : (
          <ul className="plain-list">
            {staged.map((entry) => (
              <li key={entry.path}>
                <code>{entry.path}</code>
                <span className="tag">{entry.changes.length} campo(s)</span>
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => void discard(entry.path)}
                >
                  Descartar
                </button>
              </li>
            ))}
          </ul>
        )}
        <footer className="card-foot">
          <button
            className="primary"
            type="button"
            disabled={busy || !available || running !== undefined}
            onClick={() => void start()}
          >
            {running === undefined ? 'Executar sandbox' : 'Execução em andamento…'}
          </button>
        </footer>
      </section>

      {runs.map((run) => (
        <section key={run.runId} className="card">
          <header className="card-head">
            <h2>
              {run.status === 'running'
                ? 'Executando'
                : run.status === 'refused'
                  ? 'Não iniciou'
                  : (OUTCOME_LABELS[run.outcome ?? ''] ?? run.outcome)}
            </h2>
            <span className="subtle">
              {new Date(run.startedAt).toLocaleString('pt-BR')} · {formatDuration(run.durationMs)}
              {run.testedChanges ? ' · testou mudanças preparadas' : ' · testou o que está instalado'}
            </span>
          </header>

          {run.status === 'refused' ? (
            <p className={`banner banner-warning`}>
              O runner não chegou a iniciar: <code>{run.refusal}</code>. Isso nomeia o que faltou,
              e não é o mesmo que o servidor ter falhado ao subir.
            </p>
          ) : null}

          {run.status === 'running' ? (
            <>
              <p className="muted">
                Sem resultado ainda. Não saber ainda é um estado próprio — não é falha.
              </p>
              <pre className="diff">
                {run.progress.map((line, index) => (
                  <span key={`${String(index)}`} className="diff-context">
                    {line}
                    {'\n'}
                  </span>
                ))}
              </pre>
            </>
          ) : null}

          {run.status === 'finished' && run.evidence !== null ? (
            <>
              <p>
                <span className={`level level-${OUTCOME_TONE[run.outcome ?? ''] ?? 'neutral'}`}>
                  {OUTCOME_LABELS[run.outcome ?? ''] ?? run.outcome}
                </span>
                {run.evidence.java === undefined ? null : (
                  <span className="subtle">
                    {' '}
                    Java {run.evidence.java.version} via {run.evidence.java.source} ·{' '}
                    {run.evidence.filesCopied} arquivos · {run.evidence.mebibytesCopied} MiB
                  </span>
                )}
              </p>

              {run.evidence.disposed === false ? (
                // Beside the result, never on top of it: cleanup once replaced
                // the boot outcome with an error about a directory.
                <p className="banner banner-warning">
                  A cópia descartável não pôde ser apagada: <code>{run.evidence.disposalError}</code>.
                  O resultado do boot acima continua valendo.
                </p>
              ) : null}

              {(run.evidence.generatedFiles ?? []).length === 0 ? null : (
                <>
                  <h3>Arquivos que só existem depois de rodar</h3>
                  <ul className="plain-list">
                    {(run.evidence.generatedFiles ?? []).map((file) => (
                      <li key={file}>
                        <code>{file}</code>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {(run.evidence.changes ?? []).length === 0 ? null : (
                <>
                  <h3>O que aconteceu com a mudança</h3>
                  <ul className="plain-list">
                    {(run.evidence.changes ?? []).map((change) => (
                      <li key={change.path}>
                        <code>{change.path}</code>
                        <span className="tag">
                          {change.valuesHeld === null
                            ? 'não foi possível reler'
                            : change.valuesHeld
                              ? 'valores mantidos'
                              : 'o servidor reescreveu'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {(run.evidence.tail ?? []).length === 0 ? null : (
                <>
                  <h3>Log (final)</h3>
                  <pre className="diff">
                    {(run.evidence.tail ?? []).map((line, index) => (
                      <span key={`${String(index)}`} className="diff-context">
                        {line}
                        {'\n'}
                      </span>
                    ))}
                  </pre>
                </>
              )}
            </>
          ) : null}
        </section>
      ))}
    </PanelShell>
  );
}

export default function SandboxPage() {
  return (
    <Suspense
      fallback={
        <main className="page">
          <p className="muted">Carregando…</p>
        </main>
      }
    >
      <SandboxView />
    </Suspense>
  );
}
