'use client';

import { useEffect, useMemo, useState } from 'react';

import {
  readEcosystemGraph,
  type EcosystemEvidence,
  type EcosystemGraphDirection,
  type EcosystemGraphTraversal,
} from '../../../lib/ecosystem-client';

interface GraphFilters {
  readonly direction: EcosystemGraphDirection;
  readonly depth: number;
  readonly includeStructural: boolean;
  readonly relationshipType: string;
  readonly entityType: string;
}

const DEFAULT_FILTERS: GraphFilters = {
  direction: 'both',
  depth: 1,
  includeStructural: false,
  relationshipType: '',
  entityType: '',
};

const DIRECTION_LABELS: Readonly<Record<EcosystemGraphDirection, string>> = {
  both: 'Ambas',
  outgoing: 'Saindo do nó',
  incoming: 'Chegando ao nó',
};

function entityKey(reference: { readonly type: string; readonly id: string }): string {
  return `${reference.type}\u0000${reference.id}`;
}

export function GraphExplorer(props: { readonly workspaceId: string; readonly modId: string }) {
  const [draft, setDraft] = useState<GraphFilters>(DEFAULT_FILTERS);
  const [filters, setFilters] = useState<GraphFilters>(DEFAULT_FILTERS);
  const [graph, setGraph] = useState<EcosystemGraphTraversal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void readEcosystemGraph({
      workspaceId: props.workspaceId,
      modId: props.modId,
      direction: filters.direction,
      depth: filters.depth,
      includeStructural: filters.includeStructural,
      relationshipType: filters.relationshipType,
      entityType: filters.entityType,
    }).then((result) => {
      if (active) setGraph(result);
    }).catch((reason) => {
      const message = reason instanceof Error ? reason.message : 'Não foi possível carregar o subgrafo.';
      if (active) setError(`${message} O último resultado válido, quando existente, foi mantido.`);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [filters, props.modId, props.workspaceId]);

  const entities = useMemo(
    () => new Map(graph?.entities.map((entity) => [entityKey(entity), entity]) ?? []),
    [graph],
  );
  const evidence = useMemo(
    () => new Map(graph?.evidence.map((entry) => [entry.evidenceId, entry]) ?? []),
    [graph],
  );

  const reset = (): void => {
    setDraft(DEFAULT_FILTERS);
    setFilters(DEFAULT_FILTERS);
  };

  return <section className="card graph-explorer">
    <div className="card-head">
      <div>
        <span className="eyebrow">Projeção limitada do snapshot</span>
        <h2>Subgrafo do mod</h2>
        <p className="subtle">Explore relações sob demanda; arestas estruturais permanecem ocultas até serem solicitadas.</p>
      </div>
      <span className="tag">{graph?.relationships.length ?? 0} arestas</span>
    </div>

    <form className="graph-toolbar" onSubmit={(event) => { event.preventDefault(); setFilters(draft); }}>
      <label className="field"><span>Direção</span><select value={draft.direction} onChange={(event) => setDraft((current) => ({ ...current, direction: event.target.value as EcosystemGraphDirection }))}>{(Object.keys(DIRECTION_LABELS) as EcosystemGraphDirection[]).map((direction) => <option value={direction} key={direction}>{DIRECTION_LABELS[direction]}</option>)}</select></label>
      <label className="field"><span>Profundidade</span><select value={draft.depth} onChange={(event) => setDraft((current) => ({ ...current, depth: Number(event.target.value) }))}><option value={1}>1 salto</option><option value={2}>2 saltos</option><option value={3}>3 saltos</option></select></label>
      <label className="field"><span>Escopo</span><select value={draft.includeStructural ? 'all' : 'functional'} onChange={(event) => setDraft((current) => ({ ...current, includeStructural: event.target.value === 'all' }))}><option value="functional">Funcionais</option><option value="all">Todas as relações</option></select></label>
      <label className="field"><span>Tipo de relação</span><select value={draft.relationshipType} onChange={(event) => setDraft((current) => ({ ...current, relationshipType: event.target.value }))}><option value="">Todos do escopo</option>{graph?.availableRelationshipTypes.map((type) => <option value={type} key={type}>{type}</option>)}</select></label>
      <label className="field"><span>Tipo de nó adjacente</span><select value={draft.entityType} onChange={(event) => setDraft((current) => ({ ...current, entityType: event.target.value }))}><option value="">Todos</option>{graph?.availableEntityTypes.map((type) => <option value={type} key={type}>{type}</option>)}</select></label>
      <button className="primary" type="submit" disabled={loading}>{loading ? 'Carregando…' : 'Aplicar filtros'}</button>
      <button className="secondary" type="button" onClick={reset} disabled={loading}>Limpar</button>
    </form>

    {error.length > 0 ? <p className="banner banner-danger" role="alert">{error}</p> : null}
    {loading && graph === null ? <p className="muted" aria-live="polite">Carregando subgrafo…</p> : null}
    {graph === null ? null : <>
      <div className="graph-summary" aria-live="polite">
        <span><strong>{graph.entities.length}</strong> nós</span>
        <span><strong>{graph.relationships.length}</strong> arestas</span>
        <span><strong>{graph.depthReached}</strong> profundidade alcançada</span>
        <span><strong>{graph.unresolvedReferences.length}</strong> referências ausentes</span>
      </div>

      {graph.truncated.entities || graph.truncated.relationships ? <p className="banner banner-danger">O resultado atingiu o limite seguro de {graph.maxEntities} nós ou {graph.maxRelationships} arestas. Reduza a profundidade ou aplique um filtro mais específico.</p> : null}
      {graph.unresolvedReferences.length > 0 ? <details className="graph-unresolved"><summary>{graph.unresolvedReferences.length} referência(s) declarada(s) não existem neste inventário</summary><ul className="evidence-list">{graph.unresolvedReferences.map((reference) => <li key={entityKey(reference)}><strong>{reference.type}</strong><code>{reference.id}</code><span>{reference.relationshipIds.length} aresta(s) mantêm esta referência.</span></li>)}</ul></details> : null}

      <div className="graph-results">
        <div className="graph-nodes">
          <div className="graph-section-head"><div><span className="eyebrow">Entidades</span><h3>Nós alcançados</h3></div><span className="tag">máx. {graph.maxEntities}</span></div>
          <div className="table-scroll"><table className="table graph-node-table"><thead><tr><th>Entidade</th><th>Tipo</th><th>Salto</th><th>Evidências</th></tr></thead><tbody>{graph.entities.map((entity) => <tr key={entityKey(entity)}><td><strong>{entity.label}</strong><small>{entity.id}</small></td><td><span className="tag">{entity.type}</span></td><td>{entity.depth}</td><td>{entity.evidenceIds.length}</td></tr>)}</tbody></table></div>
        </div>

        <div className="graph-edges">
          <div className="graph-section-head"><div><span className="eyebrow">Relações</span><h3>Arestas alcançadas</h3></div><span className="tag">máx. {graph.maxRelationships}</span></div>
          {graph.relationships.length === 0 ? <p className="muted">Nenhuma aresta corresponde aos filtros aplicados.</p> : <div className="relationship-list">{graph.relationships.map((relationship) => {
            const from = entities.get(entityKey(relationship.from));
            const to = entities.get(entityKey(relationship.to));
            const relationEvidence = relationship.evidenceIds.map((id) => evidence.get(id)).filter((entry): entry is EcosystemEvidence => entry !== undefined);
            return <article key={relationship.relationshipId}><div className="relation-flow"><div className="graph-endpoint"><strong>{from?.label ?? relationship.from.id}</strong><code>{relationship.from.type}:{relationship.from.id}</code></div><span>{relationship.type}</span><div className="graph-endpoint is-target"><strong>{to?.label ?? relationship.to.id}</strong><code>{relationship.to.type}:{relationship.to.id}</code></div></div><p>{relationship.reason}</p><div className="config-meta"><span>{relationship.status}</span><span>confiança {relationship.confidence}</span><span>{relationship.evidenceIds.length} evidência(s)</span></div>{relationEvidence.length > 0 ? <details className="relationship-evidence"><summary>Inspecionar evidências</summary><ul className="evidence-list">{relationEvidence.map((entry) => <li key={entry.evidenceId}><strong>{entry.source}</strong><code>{entry.sourcePath}</code><span>{entry.detail}</span></li>)}</ul></details> : null}</article>;
          })}</div>}
        </div>
      </div>
    </>}
  </section>;
}
