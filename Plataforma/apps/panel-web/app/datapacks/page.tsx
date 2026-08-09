'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { modsSteps, PanelShell } from '../components/shell';
import { listEcosystemDatapacks, type EcosystemDatapackSummary } from '../../lib/ecosystem-client';
import { listWorkspaces, readSession, type WorkspaceSummary } from '../../lib/workspace-client';

export default function DatapacksPage() {
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [packs, setPacks] = useState<readonly EcosystemDatapackSummary[]>([]);
  const [quality, setQuality] = useState('loading');
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const load = useCallback(async (target: string) => {
    setQuality('loading');
    try {
      const result = await listEcosystemDatapacks(target);
      setPacks(result.datapacks);
      setQuality(result.dataQuality);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível carregar os datapacks.');
      setQuality('error');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const [session, listing] = await Promise.all([readSession(), listWorkspaces()]);
      if (session === null) {
        setError('Entre no painel para ver os datapacks.');
        setQuality('error');
        return;
      }
      const servers = listing.workspaces.filter((workspace) => workspace.kind === 'server');
      setWorkspaces(servers);
      const requested = new URL(globalThis.location.href).searchParams.get('workspace');
      const selected = servers.find((workspace) => workspace.workspaceId === requested) ?? servers[0];
      if (selected === undefined) {
        setQuality('empty');
        return;
      }
      setWorkspaceId(selected.workspaceId);
      await load(selected.workspaceId);
    })().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Não foi possível abrir a área de datapacks.');
      setQuality('error');
    });
  }, [load]);

  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('pt-BR');
    return query.length === 0 ? packs : packs.filter((pack) =>
      `${pack.name} ${pack.loader} ${pack.namespaces.join(' ')} ${pack.relatedModIds.join(' ')}`.toLocaleLowerCase('pt-BR').includes(query),
    );
  }, [packs, search]);
  const resourceCount = packs.reduce((sum, pack) => sum + pack.resourceCount, 0);
  const overrideCount = packs.reduce((sum, pack) => sum + pack.overrideCount, 0);
  const reviewedCount = packs.reduce((sum, pack) => sum + pack.reviewedResourceCount, 0);
  const semanticFieldCount = packs.reduce((sum, pack) => sum + pack.semanticFieldCount, 0);
  const conflictCount = packs.reduce((sum, pack) => sum + pack.conflictCount, 0);

  return (
    <PanelShell
      title="Datapacks"
      category="datapacks"
      steps={modsSteps('datapacks', workspaceId || undefined)}
      subtitle="Conteúdo carregado pelo servidor, classificado por namespace, sistema e efeito."
      actions={workspaces.length === 0 ? undefined : <label className="compact-select"><span>Servidor</span><select value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); void load(event.target.value); }}>{workspaces.map((workspace) => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.displayName}</option>)}</select></label>}
    >
      {error.length > 0 ? <p className="banner banner-danger">{error}</p> : null}
      {quality === 'loading' ? <section className="card"><h2>Carregando snapshot</h2></section> : null}
      {quality !== 'stored' && quality !== 'loading' && quality !== 'error' ? <section className="card empty-state"><h2>Análise necessária</h2><p className="muted">Os datapacks só aparecem depois que o inventário semântico for persistido.</p><a className="secondary" href={`/mods?workspace=${encodeURIComponent(workspaceId)}`}>Abrir análise de Mods</a></section> : null}
      {quality === 'stored' ? <>
        <section className="stat-strip"><div><strong className="stat-value">{packs.length}</strong><span className="stat-label">datapacks</span></div><div><strong className="stat-value">{resourceCount}</strong><span className="stat-label">recursos</span></div><div><strong className="stat-value">{reviewedCount}</strong><span className="stat-label">recursos com schema</span></div><div><strong className="stat-value">{semanticFieldCount}</strong><span className="stat-label">campos semânticos</span></div><div><strong className="stat-value">{conflictCount}</strong><span className="stat-label">conflitos</span></div><div><strong className="stat-value">{overrideCount}</strong><span className="stat-label">overrides comprovados</span></div></section>
        {conflictCount > 0 ? <section className="banner banner-warning"><strong>{conflictCount} colisão(ões) detectada(s).</strong> A ordem efetiva não foi inferida; abra o mod relacionado para inspecionar as evidências.</section> : null}
        <section className="card"><label className="field"><span>Pesquisar datapack, namespace ou mod relacionado</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label></section>
        <section className="card-grid">{visible.map((pack) => <article className="card datapack-card" key={pack.datapackId}><div className="card-head"><div><span className="eyebrow">{pack.loader}</span><h2>{pack.name}</h2></div><span className="tag">{pack.resourceCount} recursos</span></div><code>{pack.rootPath}</code><div className="datapack-effects"><span><strong>{pack.overrideCount}</strong> overrides</span><span><strong>{pack.reviewedResourceCount}</strong> revisados</span><span><strong>{pack.conflictCount}</strong> conflitos</span></div><div className="chip-list">{pack.namespaces.map((namespace) => <span className="tag" key={namespace}>{namespace}</span>)}</div><div><span className="eyebrow">Tipos principais</span><ul className="bar-list">{pack.resourceTypes.slice(0, 6).map(([type, count]) => <li key={type}><span>{type}</span><strong>{count}</strong></li>)}</ul></div><p className="subtle">{pack.semanticFieldCount} campos semânticos · mods relacionados: {pack.relatedModIds.length === 0 ? 'não determinados' : pack.relatedModIds.join(', ')}</p></article>)}</section>
      </> : null}
    </PanelShell>
  );
}
