'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  archiveUrl,
  buildRelease,
  formatBytes,
  listReleases,
  listWorkspaces,
  PanelApiError,
  readReleasePreview,
  readSession,
  type PanelSession,
  type ReleasePreview,
  type ReleaseView,
  type WorkspaceSummary,
} from '../../../lib/workspace-client';
import { PanelShell, stepsFor } from '../../components/shell';

/**
 * Producing a release, and being told what may leave the machine.
 *
 * The distinction this screen exists to keep visible: **building and
 * distributing are different questions.** An operator may always build for
 * their own machine. Handing the result to somebody needs a reviewed licence
 * for every archive in it — and today nothing is reviewed, so the screen says
 * so with counts instead of hiding a disabled button.
 *
 * The side split comes from comparing against a registered client profile. If
 * there is none, every mod is server-side *by observation*, because the server
 * is the only place any of them was seen. That is the honest result of having
 * nothing to compare against, and the screen says it rather than pretending
 * the split was made.
 */

const POLL_MS = 2_000;

function ReleaseView_() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [session, setSession] = useState<PanelSession | null>(null);
  const [preview, setPreview] = useState<ReleasePreview | null | 'loading'>('loading');
  const [releases, setReleases] = useState<readonly ReleaseView[]>([]);
  const [available, setAvailable] = useState(true);
  const [profiles, setProfiles] = useState<readonly WorkspaceSummary[]>([]);
  const [version, setVersion] = useState('');
  const [intent, setIntent] = useState<'local-use' | 'distribution'>('local-use');
  const [clientWorkspaceId, setClientWorkspaceId] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setWorkspaceId(new URLSearchParams(window.location.search).get('id'));
  }, []);

  const refresh = useCallback(async (id: string) => {
    const result = await listReleases(id);
    setReleases(result.releases);
    setAvailable(result.available);
    return result.releases;
  }, []);

  useEffect(() => {
    if (workspaceId === null) return;
    let cancelled = false;

    const tick = async (): Promise<void> => {
      const current = await refresh(workspaceId).catch(() => [] as readonly ReleaseView[]);
      if (cancelled) return;
      // Polled only while a build is in flight. A finished release is evidence
      // and does not change again.
      if (current.some((release) => release.status === 'building')) {
        timer.current = setTimeout(() => void tick(), POLL_MS);
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
      try {
        const [previewResult, listing] = await Promise.all([
          readReleasePreview(workspaceId),
          listWorkspaces(),
        ]);
        if (cancelled) return;
        setPreview(previewResult);
        setProfiles(listing.workspaces.filter((entry) => entry.kind === 'client-profile'));
      } catch (error) {
        if (cancelled) return;
        setPreview(null);
        setFailure(error instanceof PanelApiError ? error.message : 'Falha ao ler a prévia.');
      }
      await tick();
    })();

    return () => {
      cancelled = true;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [refresh, workspaceId]);

  const build = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (workspaceId === null || session?.csrfToken == null) return;
      setBusy(true);
      setFailure(null);
      try {
        await buildRelease({
          workspaceId,
          version: version.trim(),
          intent,
          ...(clientWorkspaceId === '' ? {} : { clientWorkspaceId }),
          csrfToken: session.csrfToken,
        });
        setVersion('');
        const poll = async (): Promise<void> => {
          const current = await refresh(workspaceId);
          if (current.some((release) => release.status === 'building')) {
            timer.current = setTimeout(() => void poll(), POLL_MS);
          }
        };
        await poll();
      } catch (error) {
        setFailure(error instanceof PanelApiError ? error.message : 'Não foi possível gerar.');
      } finally {
        setBusy(false);
      }
    },
    [clientWorkspaceId, intent, refresh, session, version, workspaceId],
  );

  if (workspaceId === null) {
    return (
      <PanelShell title="Release" category="files" steps={stepsFor(null, 'release')}>
        <p className="muted">Nenhum workspace informado.</p>
      </PanelShell>
    );
  }

  const building = releases.some((release) => release.status === 'building');

  return (
    <PanelShell
      category="files"
      title="Release"
      steps={stepsFor(workspaceId, 'release')}
      subtitle="Pacote de servidor, pacote de cliente, manifesto com digests e changelog, a partir do último inventário."
    >
      {failure === null ? null : <p className="banner banner-danger">{failure}</p>}

      {available ? null : (
        <p className="banner banner-warning">
          A construção de release não está configurada nesta instância.
        </p>
      )}

      {preview === 'loading' ? (
        <p className="muted">Lendo a prévia…</p>
      ) : preview === null ? null : (
        <>
          <section className="stat-strip">
            <div>
              <span className="stat-value">{preview.diff.totals.modsAdded}</span>
              <span className="stat-label">mods adicionados</span>
            </div>
            <div>
              <span className="stat-value">{preview.diff.totals.modsRemoved}</span>
              <span className="stat-label">removidos</span>
            </div>
            <div>
              <span className="stat-value">{preview.diff.totals.modsUpdated}</span>
              <span className="stat-label">atualizados</span>
            </div>
            <div>
              <span className="stat-value">{preview.diff.totals.filesChanged}</span>
              <span className="stat-label">arquivos mudaram</span>
            </div>
          </section>

          {preview.previousInventoryId === null ? (
            <p className="banner banner-warning">
              Não há inventário anterior para comparar: esta é a primeira leitura deste workspace,
              então tudo conta como adicionado.
            </p>
          ) : null}

          <section className="split">
            <article className="card">
              <h2>Pode ser distribuído?</h2>
              {preview.distribution.distributable ? (
                <p className="config-verdict ok">
                  Todos os arquivos têm licença revisada.
                </p>
              ) : (
                <>
                  <p className="muted">
                    <strong>Não.</strong> Construir para a sua própria máquina é sempre permitido —
                    restaurar o seu servidor no seu host é backup, não distribuição. Entregar a
                    alguém exige licença revisada de cada arquivo.
                  </p>
                  <ul className="bar-list">
                    {preview.distribution.blocksByReason.map(([reason, count]) => (
                      <li key={reason}>
                        <span>{reason}</span>
                        <strong>{count.toLocaleString('pt-BR')}</strong>
                      </li>
                    ))}
                  </ul>
                  <p className="subtle">{preview.distribution.curseForge.refusal}</p>
                </>
              )}
            </article>

            <article className="card">
              <h2>Changelog</h2>
              <p className="muted">
                Escrito a partir do diff por digest. Nenhuma linha diz o que uma mudança faz —
                isso exigiria saber o que os mods significam.
              </p>
              <pre className="diff">{preview.changelogMarkdown}</pre>
            </article>
          </section>
        </>
      )}

      {session?.permissions.includes('workspace.manage') === true && available ? (
        <section className="card">
          <h2>Gerar release</h2>
          <form className="form-grid" onSubmit={build}>
            <label className="field">
              <span>Versão</span>
              <input
                required
                pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                placeholder="1.0.0"
                value={version}
                onChange={(event) => setVersion(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Para quem</span>
              <select
                value={intent}
                onChange={(event) =>
                  setIntent(event.target.value as 'local-use' | 'distribution')
                }
              >
                <option value="local-use">Uso próprio</option>
                <option value="distribution">Distribuição</option>
              </select>
            </label>
            <label className="field field-wide">
              <span>Perfil de cliente para o corte por lado</span>
              <select
                value={clientWorkspaceId}
                onChange={(event) => setClientWorkspaceId(event.target.value)}
              >
                <option value="">
                  Nenhum — todo mod fica no servidor, por observação
                </option>
                {profiles.map((profile) => (
                  <option key={profile.workspaceId} value={profile.workspaceId}>
                    {profile.displayName}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary" type="submit" disabled={busy || building}>
              {building ? 'Construindo…' : 'Gerar'}
            </button>
          </form>
          {intent === 'distribution' && preview !== null && preview !== 'loading' && !preview.distribution.distributable ? (
            <p className="config-verdict bad">
              Com licença pendente, a construção para distribuição será recusada antes de escrever
              qualquer coisa.
            </p>
          ) : null}
        </section>
      ) : null}

      {releases.map((release) => (
        <section key={release.releaseId} className="card">
          <header className="card-head">
            <h2>
              {release.version}{' '}
              <span className="tag">
                {release.status === 'building'
                  ? 'construindo'
                  : release.status === 'refused'
                    ? 'recusada'
                    : release.intent === 'distribution'
                      ? 'distribuição'
                      : 'uso próprio'}
              </span>
            </h2>
            <span className="subtle">{new Date(release.startedAt).toLocaleString('pt-BR')}</span>
          </header>

          {release.status === 'building' ? (
            <p className="muted">Empacotando. Um servidor de um gigabyte leva algum tempo.</p>
          ) : null}

          {release.status === 'refused' ? (
            <p className="banner banner-warning">{release.refusal}</p>
          ) : null}

          {release.status === 'ready' && release.packages !== null ? (
            <>
              {release.plan?.sides === undefined ? null : (
                <p className="subtle">
                  {Object.entries(release.plan.sides)
                    .map(([side, count]) => `${String(count)} ${side}`)
                    .join(' · ')}
                </p>
              )}
              <ul className="plain-list">
                {Object.entries(release.packages).map(([side, archive]) => (
                  <li key={side} className="candidate">
                    <div>
                      <code>{archive.fileName}</code>
                      <span className="tag">{formatBytes(archive.bytes)}</span>
                      <span className="tag">{archive.entries.toLocaleString('pt-BR')} entradas</span>
                      {archive.excluded === 0 ? null : (
                        <span className="tag">{archive.excluded} excluídos</span>
                      )}
                    </div>
                    <a
                      className="secondary"
                      href={archiveUrl(workspaceId, release.releaseId, side as 'server' | 'client')}
                    >
                      Baixar
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ))}
    </PanelShell>
  );
}

export default function ReleasePage() {
  return (
    <Suspense
      fallback={
        <main className="page">
          <p className="muted">Carregando…</p>
        </main>
      }
    >
      <ReleaseView_ />
    </Suspense>
  );
}
