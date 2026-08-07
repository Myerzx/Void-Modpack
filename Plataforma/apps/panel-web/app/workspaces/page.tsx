'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  formatBytes,
  listWorkspaces,
  PanelApiError,
  readSession,
  registerWorkspace,
  scanWorkspace,
  type PanelSession,
  type WorkspaceListing,
  type WorkspaceSummary,
} from '../../lib/workspace-client';

/**
 * Importing a server, and seeing what came back.
 *
 * The first step of the product's main path, and the first one this panel can
 * actually do. The path is typed once, here, and never again: every later
 * screen names the workspace by id, so nothing downstream has to decide
 * whether a path is allowed.
 *
 * A workspace that has never been scanned says so and offers the button. That
 * is a state, not an error, and showing it as one would be the panel inventing
 * a problem the engine did not report.
 */

export default function WorkspacesPage() {
  const [session, setSession] = useState<PanelSession | null | 'loading'>('loading');
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({
    slug: '',
    displayName: '',
    rootPath: '',
    kind: 'server' as WorkspaceSummary['kind'],
  });

  const refresh = useCallback(async () => {
    try {
      setListing(await listWorkspaces());
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof PanelApiError ? error.message : 'Falha ao listar workspaces.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const current = await readSession().catch(() => null);
      if (cancelled) return;
      if (current === null) {
        window.location.href = '/entrar';
        return;
      }
      setSession(current);
      await refresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const csrfToken = session !== null && session !== 'loading' ? session.csrfToken : null;

  const submitRegistration = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (csrfToken === null) return;
      setBusy('register');
      setFailure(null);
      try {
        await registerWorkspace({ ...form, csrfToken });
        setForm({ slug: '', displayName: '', rootPath: '', kind: 'server' });
        await refresh();
      } catch (error) {
        setFailure(
          error instanceof PanelApiError ? error.message : 'Não foi possível registrar.',
        );
      } finally {
        setBusy(null);
      }
    },
    [csrfToken, form, refresh],
  );

  const runScan = useCallback(
    async (workspaceId: string) => {
      if (csrfToken === null) return;
      setBusy(workspaceId);
      setFailure(null);
      try {
        await scanWorkspace(workspaceId, csrfToken);
        await refresh();
      } catch (error) {
        setFailure(error instanceof PanelApiError ? error.message : 'A varredura falhou.');
      } finally {
        setBusy(null);
      }
    },
    [csrfToken, refresh],
  );

  if (session === 'loading') {
    return (
      <main className="page">
        <p className="muted">Carregando…</p>
      </main>
    );
  }

  const canManage = session?.permissions.includes('workspace.manage') === true;
  const scannerReady = listing?.capabilities.canScan === true;

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <h1>Workspaces</h1>
          <p className="muted">
            Um servidor ou perfil de cliente importado. A leitura é somente leitura: nada é
            escrito dentro do diretório registrado.
          </p>
        </div>
      </header>

      {failure === null ? null : <p className="banner banner-danger">{failure}</p>}

      {scannerReady ? null : (
        <p className="banner banner-warning">
          Esta instância da API não tem um scanner configurado, então registrar e varrer estão
          indisponíveis. Isso é uma configuração ausente, não um erro.
        </p>
      )}

      <section className="card-grid">
        {listing === null ? (
          <p className="muted">Carregando workspaces…</p>
        ) : listing.workspaces.length === 0 ? (
          <p className="muted">Nenhum workspace registrado ainda.</p>
        ) : (
          listing.workspaces.map((workspace) => (
            <article key={workspace.workspaceId} className="card">
              <header className="card-head">
                <h2>{workspace.displayName}</h2>
                <span className="tag">
                  {workspace.kind === 'server' ? 'Servidor' : 'Perfil de cliente'}
                </span>
              </header>

              {workspace.lastScan === null ? (
                <p className="muted">
                  Nunca inventariado. Nada foi lido deste diretório ainda.
                </p>
              ) : (
                <dl className="stat-row">
                  <div>
                    <dt>Arquivos</dt>
                    <dd>{workspace.lastScan.totalFiles.toLocaleString('pt-BR')}</dd>
                  </div>
                  <div>
                    <dt>Mods declarados</dt>
                    <dd>{workspace.lastScan.totalMods.toLocaleString('pt-BR')}</dd>
                  </div>
                  <div>
                    <dt>Tamanho</dt>
                    <dd>{formatBytes(workspace.lastScan.totalBytes)}</dd>
                  </div>
                </dl>
              )}

              <footer className="card-foot">
                {workspace.lastScan === null ? null : (
                  <a className="secondary" href={`/workspaces/detalhe?id=${workspace.workspaceId}`}>
                    Abrir inventário
                  </a>
                )}
                {canManage && scannerReady ? (
                  <button
                    className="primary"
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void runScan(workspace.workspaceId)}
                  >
                    {busy === workspace.workspaceId
                      ? 'Lendo…'
                      : workspace.lastScan === null
                        ? 'Inventariar'
                        : 'Reinventariar'}
                  </button>
                ) : null}
              </footer>

              {workspace.lastScan === null ? null : (
                <p className="subtle">
                  {new Date(workspace.lastScan.scannedAt).toLocaleString('pt-BR')} ·{' '}
                  <code>{workspace.lastScan.inventorySha256.slice(0, 12)}</code>
                </p>
              )}
            </article>
          ))
        )}
      </section>

      {canManage && scannerReady ? (
        <section className="card">
          <h2>Importar um servidor</h2>
          <p className="muted">
            O caminho é digitado uma vez e fica no servidor. Nenhuma tela envia caminho depois
            disso.
          </p>
          <form className="form-grid" onSubmit={submitRegistration}>
            <label className="field">
              <span>Identificador</span>
              <input
                required
                pattern="[a-z0-9][a-z0-9-]*"
                placeholder="servidor-principal"
                value={form.slug}
                onChange={(event) => setForm({ ...form, slug: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Nome</span>
              <input
                required
                placeholder="Servidor principal"
                value={form.displayName}
                onChange={(event) => setForm({ ...form, displayName: event.target.value })}
              />
            </label>
            <label className="field field-wide">
              <span>Caminho absoluto no host da API</span>
              <input
                required
                placeholder="H:\\void pasta\\Servidor\\workspace\\server-original"
                value={form.rootPath}
                onChange={(event) => setForm({ ...form, rootPath: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Tipo</span>
              <select
                value={form.kind}
                onChange={(event) =>
                  setForm({ ...form, kind: event.target.value as WorkspaceSummary['kind'] })
                }
              >
                <option value="server">Servidor</option>
                <option value="client-profile">Perfil de cliente</option>
              </select>
            </label>
            <button className="primary" type="submit" disabled={busy !== null}>
              {busy === 'register' ? 'Registrando…' : 'Registrar'}
            </button>
          </form>
        </section>
      ) : null}
    </main>
  );
}
