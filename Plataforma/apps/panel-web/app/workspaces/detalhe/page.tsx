'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import {
  EDIT_LEVEL_LABELS,
  formatBytes,
  PanelApiError,
  readInventory,
  readMod,
  readMods,
  readSession,
  type InventorySummary,
  type ModDetail,
  type ModSummary,
  type UndeclaredArchive,
} from '../../../lib/workspace-client';
import { PanelShell, stepsFor } from '../../components/shell';

/**
 * What the scan found: the inventory, the mods, and one mod up close.
 *
 * Three things this screen deliberately shows that a prettier one would hide.
 *
 * **What was excluded, and why.** A world, a log, a whitelist and a
 * `server.properties` are refused on purpose. An inventory that quietly
 * omitted them would be indistinguishable from one that failed to find them,
 * so the counts are on the page.
 *
 * **Archives that declared nothing.** Six jars in a real 181-jar pack declare
 * no mod. Dropping them would make the list disagree with the folder.
 *
 * **The rule that matched a configuration file.** Nothing in a jar says where
 * its configuration lives, so these are conventions. The rule travels with the
 * path so a reader can judge it rather than trust it.
 */

function DetailView() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [inventory, setInventory] = useState<InventorySummary | null | 'loading'>('loading');
  const [mods, setMods] = useState<readonly ModSummary[]>([]);
  const [undeclared, setUndeclared] = useState<readonly UndeclaredArchive[]>([]);
  const [selected, setSelected] = useState<ModDetail | null>(null);
  const [filter, setFilter] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id');
    setWorkspaceId(id);
  }, []);

  useEffect(() => {
    if (workspaceId === null) return;
    let cancelled = false;
    void (async () => {
      const session = await readSession().catch(() => null);
      if (cancelled) return;
      if (session === null) {
        window.location.href = '/entrar';
        return;
      }
      try {
        const [inventoryResult, modsResult] = await Promise.all([
          readInventory(workspaceId),
          readMods(workspaceId),
        ]);
        if (cancelled) return;
        setInventory(inventoryResult.inventory);
        setMods(modsResult.mods);
        setUndeclared(modsResult.undeclared);
      } catch (error) {
        if (cancelled) return;
        setFailure(error instanceof PanelApiError ? error.message : 'Falha ao ler o inventário.');
        setInventory(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const openMod = useCallback(
    async (modId: string) => {
      if (workspaceId === null) return;
      try {
        const result = await readMod(workspaceId, modId);
        setSelected(result.mod);
      } catch (error) {
        setFailure(error instanceof PanelApiError ? error.message : 'Falha ao abrir o mod.');
      }
    },
    [workspaceId],
  );

  if (workspaceId === null) {
    return (
      <PanelShell title="Inventário" steps={stepsFor(null, 'inventario')}>
        <p className="muted">Nenhum workspace informado.</p>
      </PanelShell>
    );
  }

  if (inventory === 'loading') {
    return (
      <PanelShell title="Inventário" steps={stepsFor(workspaceId, 'inventario')}>
        <p className="muted">Lendo inventário…</p>
      </PanelShell>
    );
  }

  const visible =
    filter.trim() === ''
      ? mods
      : mods.filter((mod) =>
          `${mod.modId} ${mod.displayName ?? ''} ${mod.archivePath}`
            .toLowerCase()
            .includes(filter.trim().toLowerCase()),
        );

  return (
    <PanelShell
      title="Inventário"
      steps={stepsFor(workspaceId, 'inventario')}
      subtitle="O que a varredura leu, o que ela recusou de propósito, e cada mod com as configurações que ele provavelmente possui."
    >

      {failure === null ? null : <p className="banner banner-danger">{failure}</p>}

      {inventory === null ? (
        <p className="banner banner-warning">
          Este workspace ainda não foi inventariado. Volte e use “Inventariar”.
        </p>
      ) : (
        <>
          <section className="stat-strip">
            <div>
              <span className="stat-value">{inventory.totals.files.toLocaleString('pt-BR')}</span>
              <span className="stat-label">arquivos lidos</span>
            </div>
            <div>
              <span className="stat-value">
                {inventory.totals.mods.toLocaleString('pt-BR')}
                <small> / {inventory.totals.modArchives.toLocaleString('pt-BR')}</small>
              </span>
              <span className="stat-label">mods declarados / arquivos de mod</span>
            </div>
            <div>
              <span className="stat-value">{formatBytes(inventory.totals.bytes)}</span>
              <span className="stat-label">conteúdo</span>
            </div>
            <div>
              <span className="stat-value">{inventory.totals.undeclaredArchives}</span>
              <span className="stat-label">sem declaração</span>
            </div>
          </section>

          <p className="subtle">
            Varrido em {new Date(inventory.scannedAt).toLocaleString('pt-BR')} ·{' '}
            <code>{inventory.inventorySha256.slice(0, 16)}</code>
          </p>

          <section className="split">
            <article className="card">
              <h2>Por papel</h2>
              <ul className="bar-list">
                {inventory.filesByRole.map(([role, count]) => (
                  <li key={role}>
                    <span>{role}</span>
                    <strong>{count.toLocaleString('pt-BR')}</strong>
                  </li>
                ))}
              </ul>
            </article>

            <article className="card">
              <h2>Deliberadamente não lido</h2>
              <p className="muted">
                Mundo, logs, listas de acesso e o runtime do Forge são recusados de propósito.
                Um inventário que omitisse isso em silêncio não daria para distinguir de um que
                falhou.
              </p>
              <ul className="bar-list">
                {inventory.exclusionsByReason.map(([reason, count]) => (
                  <li key={reason}>
                    <span>{reason}</span>
                    <strong>{count.toLocaleString('pt-BR')}</strong>
                  </li>
                ))}
              </ul>
            </article>
          </section>

          <section className="card">
            <header className="card-head">
              <h2>Mods</h2>
              <input
                className="filter"
                placeholder="Filtrar por id, nome ou arquivo"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </header>

            <table className="table">
              <thead>
                <tr>
                  <th>Mod</th>
                  <th>Versão</th>
                  <th>Nível de edição</th>
                  <th>Configurações</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((mod) => (
                  <tr key={`${mod.modId}:${mod.archivePath}`} onClick={() => void openMod(mod.modId)}>
                    <td>
                      <strong>{mod.displayName ?? mod.modId}</strong>
                      <span className="subtle"> {mod.modId}</span>
                    </td>
                    <td>{mod.version ?? <span className="subtle">não declarada</span>}</td>
                    <td>
                      <span className={`level level-${mod.editLevel.toLowerCase()}`}>
                        {EDIT_LEVEL_LABELS[mod.editLevel] ?? mod.editLevel}
                      </span>
                    </td>
                    <td>{mod.configurationCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visible.length === 0 ? <p className="muted">Nenhum mod corresponde ao filtro.</p> : null}
          </section>

          {undeclared.length === 0 ? null : (
            <section className="card">
              <h2>Arquivos que não declararam mod</h2>
              <p className="muted">
                Registrados em vez de descartados: um jar na pasta de mods que não declara nada é
                um fato sobre a instalação.
              </p>
              <ul className="plain-list">
                {undeclared.map((archive) => (
                  <li key={archive.path}>
                    <code>{archive.path}</code> <span className="tag">{archive.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {selected === null ? null : (
        <aside className="drawer" role="dialog" aria-label={selected.modId}>
          <header className="drawer-head">
            <div>
              <h2>{selected.displayName ?? selected.modId}</h2>
              <p className="subtle">
                {selected.modId} · {selected.loader} · {selected.version ?? 'versão não declarada'}
              </p>
            </div>
            <button className="secondary" type="button" onClick={() => setSelected(null)}>
              Fechar
            </button>
          </header>

          <p>
            <span className={`level level-${selected.editLevel.toLowerCase()}`}>
              {EDIT_LEVEL_LABELS[selected.editLevel] ?? selected.editLevel}
            </span>{' '}
            <span className="subtle">{selected.editLevelReason}</span>
          </p>

          <h3>Configurações detectadas</h3>
          {selected.configurationCandidates.length === 0 ? (
            <p className="muted">
              Nenhuma. Pode ser que só existam depois que o mod rodar uma vez.
            </p>
          ) : (
            <ul className="plain-list">
              {selected.configurationCandidates.map((candidate) => (
                <li key={candidate.path} className="candidate">
                  <div>
                    <code>{candidate.path}</code>
                    {/* The rule is shown because these are conventions, not
                        declarations: nothing in a jar says where its config
                        lives, so a reader judges it rather than trusting it. */}
                    <span className="tag">{candidate.rule}</span>
                  </div>
                  <a
                    className="secondary"
                    href={`/workspaces/configuracao?id=${workspaceId}&path=${encodeURIComponent(candidate.path)}`}
                  >
                    Abrir
                  </a>
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}
    </PanelShell>
  );
}

export default function WorkspaceDetailPage() {
  return (
    <Suspense fallback={<main className="page"><p className="muted">Carregando…</p></main>}>
      <DetailView />
    </Suspense>
  );
}
