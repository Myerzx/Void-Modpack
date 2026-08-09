'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { PanelShell, modsSteps } from '../components/shell';
import {
  listEcosystemMods,
  runEcosystemAnalysis,
  type EcosystemModSummary,
} from '../../lib/ecosystem-client';
import {
  listWorkspaces,
  readSession,
  type PanelSession,
  type WorkspaceSummary,
} from '../../lib/workspace-client';

type ViewState = 'loading' | 'ready' | 'not-analyzed' | 'never-scanned' | 'empty' | 'error';

const STATUS_LABEL: Readonly<Record<string, string>> = {
  complete: 'Completa',
  partial: 'Parcial',
  unavailable: 'Indisponível',
};

export default function ModsPage() {
  const [session, setSession] = useState<PanelSession | null>(null);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [mods, setMods] = useState<readonly EcosystemModSummary[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | undefined>();
  const [state, setState] = useState<ViewState>('loading');
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [side, setSide] = useState('all');
  const [status, setStatus] = useState('all');
  const [analyzing, setAnalyzing] = useState(false);

  const loadMods = useCallback(async (target: string) => {
    setState('loading');
    setMessage('');
    try {
      const result = await listEcosystemMods(target);
      setMods(result.mods);
      setGeneratedAt(result.generatedAt);
      if (result.dataQuality === 'stored') setState(result.mods.length === 0 ? 'empty' : 'ready');
      else if (result.dataQuality === 'never-scanned') setState('never-scanned');
      else setState('not-analyzed');
    } catch (error) {
      setState('error');
      setMessage(error instanceof Error ? error.message : 'Não foi possível carregar os mods.');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [current, listing] = await Promise.all([readSession(), listWorkspaces()]);
        setSession(current);
        if (current === null) {
          setState('error');
          setMessage('Entre no painel para gerenciar os mods instalados.');
          return;
        }
        const servers = listing.workspaces.filter((workspace) => workspace.kind === 'server');
        setWorkspaces(servers);
        const requested = new URL(globalThis.location.href).searchParams.get('workspace');
        const selected = servers.find((workspace) => workspace.workspaceId === requested) ?? servers[0];
        if (selected === undefined) {
          setState('empty');
          return;
        }
        setWorkspaceId(selected.workspaceId);
        await loadMods(selected.workspaceId);
      } catch (error) {
        setState('error');
        setMessage(error instanceof Error ? error.message : 'Não foi possível abrir a área de mods.');
      }
    })();
  }, [loadMods]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('pt-BR');
    return mods.filter((mod) => {
      if (side !== 'all' && mod.side !== side) return false;
      if (status !== 'all' && mod.analysisStatus !== status) return false;
      return query.length === 0 || `${mod.displayName ?? ''} ${mod.modId} ${mod.version ?? ''}`.toLocaleLowerCase('pt-BR').includes(query);
    });
  }, [mods, search, side, status]);

  const totals = useMemo(() => mods.reduce(
    (sum, mod) => ({
      configurations: sum.configurations + mod.configurationCount,
      datapacks: sum.datapacks + mod.datapackCount,
      relations: sum.relations + mod.dependencyCount + mod.integrationCount,
      problems: sum.problems + mod.problemCount,
    }),
    { configurations: 0, datapacks: 0, relations: 0, problems: 0 },
  ), [mods]);

  const analyze = useCallback(async () => {
    if (session?.csrfToken === null || session?.csrfToken === undefined || workspaceId.length === 0) return;
    setAnalyzing(true);
    setMessage('');
    try {
      await runEcosystemAnalysis(workspaceId, session.csrfToken);
      await loadMods(workspaceId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'A análise não pôde ser concluída.');
    } finally {
      setAnalyzing(false);
    }
  }, [loadMods, session, workspaceId]);

  const selectedWorkspace = workspaces.find((workspace) => workspace.workspaceId === workspaceId);

  return (
    <PanelShell
      title="Mods"
      category="mods"
      steps={modsSteps('all', workspaceId || undefined)}
      subtitle={generatedAt === undefined
        ? 'Inventário semântico dos mods instalados, suas configurações e relações comprovadas.'
        : `Análise persistida em ${new Date(generatedAt).toLocaleString('pt-BR')}.`}
      actions={workspaces.length === 0 ? undefined : (
        <label className="compact-select">
          <span>Servidor</span>
          <select
            value={workspaceId}
            onChange={(event) => {
              const target = event.target.value;
              setWorkspaceId(target);
              globalThis.history.replaceState(null, '', `/mods?workspace=${encodeURIComponent(target)}`);
              void loadMods(target);
            }}
          >
            {workspaces.map((workspace) => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.displayName}</option>)}
          </select>
        </label>
      )}
    >
      {message.length > 0 ? <p className="banner banner-danger" role="alert">{message}</p> : null}

      {state === 'loading' ? <section className="card"><h2>Analisando contexto</h2><p className="muted">Carregando o último snapshot persistido.</p></section> : null}
      {state === 'empty' && workspaces.length === 0 ? (
        <section className="card empty-state"><h2>Nenhum servidor importado</h2><p className="muted">Importe um workspace de servidor para inventariar os mods reais.</p><a className="secondary" href="/workspaces">Abrir Arquivos</a></section>
      ) : null}
      {state === 'never-scanned' ? (
        <section className="card empty-state"><h2>Inventário necessário</h2><p className="muted">Este servidor ainda não foi varrido. O painel não vai presumir o que existe no diretório.</p><a className="secondary" href={`/workspaces/detalhe?id=${encodeURIComponent(workspaceId)}`}>Abrir inventário</a></section>
      ) : null}
      {state === 'not-analyzed' ? (
        <section className="card analysis-callout">
          <div><span className="eyebrow">Snapshot ausente ou desatualizado</span><h2>Executar análise profunda</h2><p className="muted">A operação lê o inventário atual, normaliza configurações, datapacks e evidências e guarda o resultado pelo hash.</p></div>
          {session?.permissions.includes('workspace.manage') === true ? <button className="primary" type="button" disabled={analyzing} onClick={() => void analyze()}>{analyzing ? 'Analisando…' : 'Analisar agora'}</button> : null}
        </section>
      ) : null}

      {state === 'ready' || (state === 'empty' && workspaces.length > 0) ? (
        <>
          <section className="stat-strip" aria-label="Resumo da análise">
            <div><strong className="stat-value">{mods.length}</strong><span className="stat-label">mods identificados</span></div>
            <div><strong className="stat-value">{totals.configurations}</strong><span className="stat-label">configurações reais</span></div>
            <div><strong className="stat-value">{totals.datapacks}</strong><span className="stat-label">datapacks relacionados</span></div>
            <div><strong className="stat-value">{totals.relations}</strong><span className="stat-label">relações rastreáveis</span></div>
            <div><strong className={`stat-value${totals.problems > 0 ? ' text-warning' : ''}`}>{totals.problems}</strong><span className="stat-label">problemas</span></div>
          </section>

          <section className="card mods-toolbar" aria-label="Filtros de mods">
            <label className="field field-wide"><span>Pesquisar</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nome, mod id ou versão" /></label>
            <label className="field"><span>Lado</span><select value={side} onChange={(event) => setSide(event.target.value)}><option value="all">Todos</option><option value="server">Servidor</option><option value="client">Cliente</option><option value="both">Ambos</option><option value="unknown">Desconhecido</option></select></label>
            <label className="field"><span>Análise</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">Todos</option><option value="complete">Completa</option><option value="partial">Parcial</option><option value="unavailable">Indisponível</option></select></label>
          </section>

          <section className="card mods-table-card">
            <div className="card-head"><div><h2>Mods instalados</h2><p className="subtle">{filtered.length} de {mods.length} itens</p></div><span className="tag">{selectedWorkspace?.displayName ?? 'Servidor'}</span></div>
            {filtered.length === 0 ? <p className="muted">Nenhum mod corresponde aos filtros.</p> : (
              <div className="table-scroll"><table className="table ecosystem-table"><thead><tr><th>Mod</th><th>Lado</th><th>Config.</th><th>Sistemas</th><th>Datapacks</th><th>Relações</th><th>Análise</th></tr></thead><tbody>
                {filtered.map((mod) => (
                  <tr key={mod.modId}>
                    <td><a className="mod-link" href={`/mods/detalhe?workspace=${encodeURIComponent(workspaceId)}&mod=${encodeURIComponent(mod.modId)}&tab=geral`}><strong>{mod.displayName ?? mod.modId}</strong><span>{mod.modId} · {mod.version ?? 'versão desconhecida'}</span></a></td>
                    <td><span className="tag">{mod.side}</span></td>
                    <td>{mod.configurationCount}</td><td>{mod.systemCount}</td><td>{mod.datapackCount}</td>
                    <td>{mod.dependencyCount + mod.integrationCount}</td>
                    <td><span className={`analysis-status is-${mod.analysisStatus}`}>{STATUS_LABEL[mod.analysisStatus] ?? mod.analysisStatus}</span>{mod.problemCount > 0 ? <small className="problem-count">{mod.problemCount} problema(s)</small> : null}</td>
                  </tr>
                ))}
              </tbody></table></div>
            )}
          </section>
        </>
      ) : null}
    </PanelShell>
  );
}
