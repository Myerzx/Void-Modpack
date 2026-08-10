'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { modSteps, PanelShell } from '../../components/shell';
import { GraphExplorer } from './graph-explorer';
import {
  listEcosystemDatapackResources,
  readEcosystemMod,
  type EcosystemConfiguration,
  type EcosystemDatapackResource,
  type EcosystemEvidence,
  type EcosystemModDetail,
} from '../../../lib/ecosystem-client';
import {
  readSession,
  stageConfiguration,
  validateConfiguration,
  type PanelSession,
} from '../../../lib/workspace-client';

const TABS = new Set(['geral', 'configuracoes', 'sistemas', 'integracoes', 'datapacks', 'arquivos', 'grafo']);
const STRUCTURAL = new Set(['OWNS', 'DEFINED_IN', 'USES', 'PROVEN_BY']);

const RELATION_LABELS: Readonly<Record<string, string>> = {
  REQUIRES: 'Requer', OPTIONAL_DEPENDENCY: 'Dependência opcional', LOADS_AFTER: 'Carrega depois',
  CONFIGURES: 'Configura', INTEGRATES_WITH: 'Integra com', COMPATIBILITY: 'Compatibilidade',
  READS_REGISTRY_FROM: 'Lê registry de', EXTENDS: 'Estende', OVERRIDES: 'Sobrescreve',
  DATAPACK_EXTENDS: 'Datapack estende', MODIFIES_GAMEPLAY_OF: 'Modifica gameplay de',
};

function displayValue(value: EcosystemConfiguration['currentValue']): string {
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function ConfigInput(props: {
  readonly configuration: EcosystemConfiguration;
  readonly value: EcosystemConfiguration['currentValue'];
  readonly onChange: (value: EcosystemConfiguration['currentValue']) => void;
}) {
  const config = props.configuration;
  if (!config.editable || Array.isArray(config.currentValue)) {
    return <code className="config-readonly">{displayValue(config.currentValue)}</code>;
  }
  if (config.type === 'boolean') {
    return <label className="toggle-control"><input type="checkbox" checked={Boolean(props.value)} onChange={(event) => props.onChange(event.target.checked)} /><span aria-hidden="true" /><em>{Boolean(props.value) ? 'Ativado' : 'Desativado'}</em></label>;
  }
  if (config.allowedValues.length > 0 || config.type === 'enum') {
    return <select value={String(props.value)} onChange={(event) => props.onChange(event.target.value)}>{config.allowedValues.map((value) => <option key={value} value={value}>{value}</option>)}</select>;
  }
  if (config.type === 'number' || config.type === 'integer') {
    const range = config.constraints.find((constraint) => constraint.kind === 'range');
    return <input type="number" value={Number(props.value)} min={range?.minimum ?? undefined} max={range?.maximum ?? undefined} step={config.type === 'integer' ? 1 : 'any'} onChange={(event) => props.onChange(Number(event.target.value))} />;
  }
  return <input type="text" value={String(props.value)} onChange={(event) => props.onChange(event.target.value)} />;
}

export default function ModDetailPage() {
  const [workspaceId, setWorkspaceId] = useState('');
  const [modId, setModId] = useState('');
  const [tab, setTab] = useState('configuracoes');
  const [session, setSession] = useState<PanelSession | null>(null);
  const [detail, setDetail] = useState<EcosystemModDetail | null>(null);
  const [selected, setSelected] = useState<EcosystemConfiguration | null>(null);
  const [selectedResource, setSelectedResource] = useState<EcosystemDatapackResource | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, EcosystemConfiguration['currentValue']>>>({});
  const [configurationQuery, setConfigurationQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [resourceQueryDraft, setResourceQueryDraft] = useState('');
  const [resourceQuery, setResourceQuery] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [resourceEffect, setResourceEffect] = useState('');
  const [resourceMode, setResourceMode] = useState<'all' | 'reviewed' | 'conflicts'>('all');
  const [resourcePage, setResourcePage] = useState<Awaited<ReturnType<typeof listEcosystemDatapackResources>> | null>(null);
  const [resourceLoading, setResourceLoading] = useState(false);
  const [resourceError, setResourceError] = useState('');
  const [staging, setStaging] = useState<string | null>(null);
  const [stageResult, setStageResult] = useState<Readonly<Record<string, string>>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      const url = new URL(globalThis.location.href);
      const workspace = url.searchParams.get('workspace') ?? '';
      const mod = url.searchParams.get('mod') ?? '';
      const requestedTab = url.searchParams.get('tab') ?? 'configuracoes';
      setWorkspaceId(workspace);
      setModId(mod);
      setTab(TABS.has(requestedTab) ? requestedTab : 'configuracoes');
      setSourceFilter(url.searchParams.get('source') ?? '');
      if (workspace.length === 0 || mod.length === 0) {
        setError('Workspace ou mod não informado.');
        return;
      }
      try {
        const [current, result] = await Promise.all([readSession(), readEcosystemMod(workspace, mod)]);
        setSession(current);
        setDetail(result);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Não foi possível abrir o mod.');
      }
    })();
  }, []);

  useEffect(() => {
    if (detail === null || tab !== 'datapacks' || workspaceId.length === 0 || modId.length === 0) return;
    let active = true;
    setResourceLoading(true);
    setResourceError('');
    void listEcosystemDatapackResources({
      workspaceId,
      modId,
      limit: 100,
      query: resourceQuery,
      resourceType,
      effect: resourceEffect,
      ...(resourceMode === 'reviewed' ? { reviewed: true } : {}),
      ...(resourceMode === 'conflicts' ? { conflicts: true } : {}),
    }).then((result) => {
      if (active) setResourcePage(result);
    }).catch((reason) => {
      if (active) setResourceError(reason instanceof Error ? reason.message : 'Não foi possível carregar os recursos.');
    }).finally(() => {
      if (active) setResourceLoading(false);
    });
    return () => { active = false; };
  }, [detail, modId, resourceEffect, resourceMode, resourceQuery, resourceType, tab, workspaceId]);

  const evidence = useMemo(() => new Map(detail?.evidence.map((entry) => [entry.evidenceId, entry]) ?? []), [detail]);
  const systems = useMemo(() => new Map(detail?.systems.map((system) => [system.systemId, system]) ?? []), [detail]);
  const visibleConfigurations = useMemo(() => {
    const query = configurationQuery.trim().toLocaleLowerCase('pt-BR');
    return (detail?.configurations ?? []).filter((configuration) => {
      if (sourceFilter.length > 0 && configuration.source.datapackResourceId !== sourceFilter) return false;
      if (query.length === 0) return true;
      return `${configuration.name} ${configuration.source.path} ${configuration.source.file} ${configuration.description ?? ''}`
        .toLocaleLowerCase('pt-BR')
        .includes(query);
    });
  }, [configurationQuery, detail, sourceFilter]);
  const configurationsBySystem = useMemo(() => {
    const groups = new Map<string, EcosystemConfiguration[]>();
    for (const configuration of visibleConfigurations) {
      const entries = groups.get(configuration.systemId) ?? [];
      entries.push(configuration);
      groups.set(configuration.systemId, entries);
    }
    for (const entries of groups.values()) {
      entries.sort((left, right) =>
        left.source.file.localeCompare(right.source.file, 'en-US') ||
        left.source.path.localeCompare(right.source.path, 'en-US'),
      );
    }
    return groups;
  }, [visibleConfigurations]);
  const sourceFiles = useMemo(() => [...new Set(detail?.configurations.map((entry) => entry.source.file) ?? [])].sort(), [detail]);
  const functionalRelationships = useMemo(() => detail?.relationships.filter((relationship) => !STRUCTURAL.has(relationship.type)) ?? [], [detail]);
  const resourceTypes = useMemo(() => [...new Set(detail?.datapackResourceSummary.map((entry) => entry.resourceType) ?? [])].sort(), [detail]);
  const datapacksById = useMemo(() => new Map(detail?.datapacks.map((datapack) => [datapack.datapackId, datapack]) ?? []), [detail]);
  const sourceFilterLabel = useMemo(() => detail?.configurations.find((configuration) =>
    configuration.source.datapackResourceId === sourceFilter)?.source.file ?? null, [detail, sourceFilter]);
  const provenDefaults = useMemo(
    () => detail?.configurations.filter((configuration) => configuration.defaultValue !== null).length ?? 0,
    [detail],
  );

  const stageFile = useCallback(async (file: string) => {
    if (detail === null || session?.csrfToken === null || session?.csrfToken === undefined) return;
    const changes = detail.configurations
      .filter((configuration) => configuration.source.file === file && drafts[configuration.configurationId] !== undefined)
      .map((configuration) => ({ path: configuration.source.path, value: drafts[configuration.configurationId] }));
    if (changes.length === 0) return;
    setStaging(file);
    setStageResult((current) => ({ ...current, [file]: '' }));
    try {
      const validation = await validateConfiguration({ workspaceId, path: file, changes, csrfToken: session.csrfToken });
      if (!validation.acceptable) {
        setStageResult((current) => ({ ...current, [file]: 'A validação recusou uma ou mais alterações.' }));
        return;
      }
      const staged = await stageConfiguration({ workspaceId, path: file, changes, csrfToken: session.csrfToken });
      setStageResult((current) => ({ ...current, [file]: `${changes.length} alteração(ões) preparada(s); ${staged.diff.length} linha(s) no diff. Nada foi aplicado ao servidor.` }));
    } catch (reason) {
      setStageResult((current) => ({ ...current, [file]: reason instanceof Error ? reason.message : 'Não foi possível preparar as alterações.' }));
    } finally {
      setStaging(null);
    }
  }, [detail, drafts, session, workspaceId]);

  if (detail === null) {
    return <PanelShell title="Mod" category="mods" steps={workspaceId && modId ? modSteps(workspaceId, modId, tab) : []}>{error.length > 0 ? <p className="banner banner-danger">{error}</p> : <section className="card"><h2>Carregando análise</h2><p className="muted">Consultando o snapshot persistido.</p></section>}</PanelShell>;
  }

  const modName = detail.mod.displayName ?? detail.mod.modId;

  return (
    <PanelShell
      title={modName}
      category="mods"
      steps={modSteps(workspaceId, modId, tab)}
      subtitle={<span><code>{detail.mod.modId}</code> · {detail.mod.version ?? 'versão desconhecida'} · análise {detail.mod.analysisStatus}</span>}
      actions={<a className="secondary" href={`/mods?workspace=${encodeURIComponent(workspaceId)}`}>Voltar aos mods</a>}
    >
      {error.length > 0 ? <p className="banner banner-danger" role="alert">{error}</p> : null}

      {tab === 'geral' ? (
        <>
          <section className="stat-strip"><div><strong className="stat-value">{detail.configurations.length}</strong><span className="stat-label">configurações</span></div><div><strong className="stat-value">{provenDefaults}</strong><span className="stat-label">padrões comprovados</span></div><div><strong className="stat-value">{detail.systems.length}</strong><span className="stat-label">sistemas</span></div><div><strong className="stat-value">{detail.datapacks.length}</strong><span className="stat-label">datapacks relacionados</span></div><div><strong className="stat-value">{functionalRelationships.length}</strong><span className="stat-label">relações funcionais</span></div></section>
          <section className="split"><article className="card"><span className="eyebrow">Identidade instalada</span><h2>{modName}</h2><dl className="detail-grid"><div><dt>Mod id</dt><dd>{detail.mod.modId}</dd></div><div><dt>Versão</dt><dd>{detail.mod.version ?? 'Desconhecida'}</dd></div><div><dt>Loader</dt><dd>{detail.mod.loader}</dd></div><div><dt>Lado</dt><dd>{detail.mod.side}</dd></div><div><dt>Nível de edição</dt><dd>{detail.mod.editLevel}</dd></div><div><dt>Snapshot</dt><dd><code>{detail.analysisId.slice(0, 16)}</code></dd></div></dl></article><article className="card"><span className="eyebrow">Qualidade</span><h2>Sem adivinhação silenciosa</h2><p className="muted">Valores padrão e necessidade de restart permanecem desconhecidos quando nenhuma fonte os prova. Cada item expõe status, confiança e evidência.</p>{detail.issues.length === 0 ? <p className="banner banner-positive">Nenhum problema ligado diretamente a este mod.</p> : <ul className="evidence-list">{detail.issues.map((issue) => <li key={issue.issueId}><strong>{issue.code}</strong><span>{issue.detail}</span></li>)}</ul>}</article></section>
        </>
      ) : null}

      {tab === 'configuracoes' ? (
        <><section className="card configuration-toolbar"><label className="field"><span>Pesquisar configurações</span><input value={configurationQuery} onChange={(event) => setConfigurationQuery(event.target.value)} placeholder="nome, chave, arquivo ou descrição" /></label><div className="configuration-scope"><span className="eyebrow">Escopo atual</span><strong>{visibleConfigurations.length} de {detail.configurations.length}</strong>{sourceFilterLabel === null ? <small>Todos os arquivos e recursos revisados</small> : <small><code>{sourceFilterLabel}</code></small>}</div>{sourceFilter.length > 0 ? <button className="secondary" type="button" onClick={() => setSourceFilter('')}>Mostrar todas</button> : null}</section><section className="config-workbench">
          <aside className="system-index card"><span className="eyebrow">Sistemas</span><strong>{visibleConfigurations.length} configurações</strong><small>{visibleConfigurations.filter((configuration) => configuration.defaultValue !== null).length} com padrão comprovado</small><nav>{detail.systems.filter((system) => (configurationsBySystem.get(system.systemId)?.length ?? 0) > 0).map((system) => <a key={system.systemId} href={`#${system.systemId}`}>{system.title}<span>{configurationsBySystem.get(system.systemId)?.length ?? 0}</span></a>)}</nav></aside>
          <div className="system-groups">
            {detail.systems.filter((system) => (configurationsBySystem.get(system.systemId)?.length ?? 0) > 0).map((system) => {
              const configurations = configurationsBySystem.get(system.systemId) ?? [];
              const files = [...new Set(configurations.map((entry) => entry.source.file))];
              return <section className="card config-system" id={system.systemId} key={system.systemId}><div className="card-head"><div><span className="eyebrow">{system.status} · confiança {system.confidence}</span><h2>{system.title}</h2></div><span className="tag">{configurations.length} campos</span></div>
                <div className="semantic-config-list">{configurations.map((configuration) => {
                  const value = drafts[configuration.configurationId] ?? configuration.currentValue;
                  const changed = drafts[configuration.configurationId] !== undefined;
                  return <article className={`semantic-config${changed ? ' is-changed' : ''}`} key={configuration.configurationId}><button className="config-title" type="button" onClick={() => setSelected(configuration)}><strong>{configuration.name}</strong><code>{configuration.source.path}</code></button><div className="config-control"><ConfigInput configuration={configuration} value={value} onChange={(next) => setDrafts((current) => ({ ...current, [configuration.configurationId]: next }))} />{changed ? <button className="text-button" type="button" onClick={() => setDrafts((current) => { const next = { ...current }; delete next[configuration.configurationId]; return next; })}>Desfazer</button> : null}</div><p>{configuration.description ?? 'Sem descrição declarada; a chave e a origem continuam disponíveis.'}</p><div className="config-meta"><span>{configuration.source.kind === 'datapack-resource' ? 'datapack revisado' : 'config'}</span><span>{configuration.type}</span><span>{configuration.side}</span><span>{configuration.status}</span><span>confiança {configuration.confidence}</span><span>{configuration.defaultValue === null ? 'padrão não comprovado' : `padrão ${displayValue(configuration.defaultValue)}`}</span><button type="button" onClick={() => setSelected(configuration)}>Ver origem</button></div></article>;
                })}</div>
                {files.map((file) => { const count = configurations.filter((entry) => entry.source.file === file && drafts[entry.configurationId] !== undefined).length; return count === 0 ? null : <div className="staging-row" key={file}><div><strong>{count} alteração(ões) em {file}</strong><span>{stageResult[file] || 'Será criado apenas um estágio revisável; o runtime não será alterado.'}</span></div>{session?.permissions.includes('workspace.manage') === true ? <button className="primary" type="button" disabled={staging === file} onClick={() => void stageFile(file)}>{staging === file ? 'Validando…' : 'Validar e preparar'}</button> : null}</div>; })}
              </section>;
            })}
          </div>
        </section></>
      ) : null}

      {tab === 'sistemas' ? <section className="card-grid">{detail.systems.map((system) => <article className="card" key={system.systemId}><div className="card-head"><h2>{system.title}</h2><span className="tag">{system.status}</span></div><p className="muted">Agrupamento semântico produzido pela regra registrada na evidência.</p><dl className="stat-row"><div><dt>Configurações</dt><dd>{system.configurationIds.length}</dd></div><div><dt>Recursos</dt><dd>{system.datapackResourceIds.length}</dd></div><div><dt>Confiança</dt><dd>{system.confidence}</dd></div></dl><a className="secondary" href={`${modSteps(workspaceId, modId, 'configuracoes')[1]?.href ?? ''}#${system.systemId}`}>Abrir configurações</a></article>)}</section> : null}

      {tab === 'integracoes' ? <section className="card"><div className="card-head"><div><h2>Relações comprovadas</h2><p className="subtle">A direção da seta é preservada do modelo normalizado.</p></div><span className="tag">{functionalRelationships.length} relações</span></div>{functionalRelationships.length === 0 ? <p className="muted">Nenhuma relação funcional foi comprovada nesta análise.</p> : <div className="relationship-list">{functionalRelationships.map((relationship) => { const relationEvidence = relationship.evidenceIds.map((id) => evidence.get(id)).filter((entry): entry is EcosystemEvidence => entry !== undefined); return <article key={relationship.relationshipId}><div className="relation-flow"><code>{relationship.from.id}</code><span>{RELATION_LABELS[relationship.type] ?? relationship.type}</span><code>{relationship.to.id}</code></div><p>{relationship.reason}</p><div className="config-meta"><span>{relationship.status}</span><span>confiança {relationship.confidence}</span><span>{relationship.evidenceIds.length} evidência(s)</span></div>{relationEvidence.length > 0 ? <details className="relationship-evidence"><summary>Inspecionar evidências</summary><ul className="evidence-list">{relationEvidence.map((entry) => <li key={entry.evidenceId}><strong>{entry.source}</strong><code>{entry.sourcePath}</code><span>{entry.detail}</span></li>)}</ul></details> : null}</article>; })}</div>}</section> : null}

      {tab === 'datapacks' ? <>
        <section className="stat-strip">
          <div><strong className="stat-value">{detail.datapacks.length}</strong><span className="stat-label">packs relacionados</span></div>
          <div><strong className="stat-value">{detail.datapackResourceSummary.reduce((sum, group) => sum + group.count, 0)}</strong><span className="stat-label">recursos classificados</span></div>
          <div><strong className="stat-value">{detail.datapackResourceSummary.reduce((sum, group) => sum + group.reviewedCount, 0)}</strong><span className="stat-label">recursos com schema</span></div>
          <div><strong className="stat-value">{detail.datapackResourceSummary.reduce((sum, group) => sum + group.semanticFieldCount, 0)}</strong><span className="stat-label">campos semânticos</span></div>
          <div><strong className="stat-value">{detail.datapackConflicts.length}</strong><span className="stat-label">conflitos detectados</span></div>
        </section>

        {detail.datapackConflicts.length > 0 ? <section className="card conflict-panel"><div className="card-head"><div><span className="eyebrow">Atenção operacional</span><h2>Recursos fornecidos por mais de um datapack</h2></div><span className="tag text-warning">{detail.datapackConflicts.length} conflito(s)</span></div><p className="muted">A ordem efetiva não foi comprovada. Recursos conflitantes ficam fora do editor semântico até a colisão ser resolvida.</p><ul className="evidence-list">{detail.datapackConflicts.map((conflict) => <li key={conflict.conflictId}><code>{conflict.coordinate}</code><span>{conflict.kind === 'divergent-content' ? 'Conteúdo divergente' : 'Conteúdo idêntico'} · {conflict.resourceIds.length} recursos · resolução {conflict.resolution}</span></li>)}</ul></section> : null}

        <section className="card datapack-resource-browser">
          <div className="card-head"><div><span className="eyebrow">Inventário persistido</span><h2>Recursos do mod</h2><p className="subtle">Pesquise e filtre sem carregar os milhares de recursos em uma única tela.</p></div><span className="tag">{resourcePage?.total ?? 0} resultado(s)</span></div>
          <form className="resource-toolbar" onSubmit={(event) => { event.preventDefault(); setResourceQuery(resourceQueryDraft); }}>
            <label className="field resource-search"><span>Pesquisar</span><input value={resourceQueryDraft} onChange={(event) => setResourceQueryDraft(event.target.value)} placeholder="nome, namespace ou arquivo" /></label>
            <label className="field"><span>Tipo</span><select value={resourceType} onChange={(event) => setResourceType(event.target.value)}><option value="">Todos</option>{resourceTypes.map((type) => <option value={type} key={type}>{type}</option>)}</select></label>
            <label className="field"><span>Efeito</span><select value={resourceEffect} onChange={(event) => setResourceEffect(event.target.value)}><option value="">Todos</option><option value="overrides">Overrides</option><option value="extends">Extensões</option><option value="unknown">Desconhecido</option></select></label>
            <label className="field"><span>Leitura</span><select value={resourceMode} onChange={(event) => setResourceMode(event.target.value as 'all' | 'reviewed' | 'conflicts')}><option value="all">Todos</option><option value="reviewed">Com schema</option><option value="conflicts">Com conflito</option></select></label>
            <button className="primary" type="submit">Buscar</button>
            <button className="secondary" type="button" onClick={() => { setResourceQueryDraft(''); setResourceQuery(''); setResourceType(''); setResourceEffect(''); setResourceMode('all'); }}>Limpar</button>
          </form>
          {resourceError.length > 0 ? <p className="banner banner-danger" role="alert">{resourceError}</p> : null}
          {resourceLoading ? <p className="muted">Carregando recursos…</p> : null}
          {!resourceLoading && resourcePage?.resources.length === 0 ? <p className="muted">Nenhum recurso corresponde aos filtros.</p> : null}
          {resourcePage !== null && resourcePage.resources.length > 0 ? <div className="table-scroll"><table className="table datapack-resource-table"><thead><tr><th>Recurso</th><th>Datapack</th><th>Efeito</th><th>Leitura segura</th><th>Conflitos</th><th>Ações</th></tr></thead><tbody>{resourcePage.resources.map((resource) => {
            const pack = datapacksById.get(resource.datapackId);
            const defaults = resource.semanticFields.filter((field) => field.defaultValue !== null).length;
            const canConfigure = resource.reviewedSchema !== null && resource.conflictIds.length === 0 && resource.semanticFields.some((field) => field.editable);
            return <tr key={resource.resourceId}><td><button className="resource-link" type="button" onClick={() => setSelectedResource(resource)}><strong>{resource.resourcePath}</strong><span>{resource.namespace} · {resource.resourceType}</span></button></td><td><strong>{pack?.name ?? resource.datapackId}</strong><small>{pack?.loader ?? 'loader desconhecido'}</small></td><td><span className="tag">{resource.effect}</span></td><td>{resource.reviewedSchema === null ? <span className="subtle">Técnica / somente leitura</span> : <div className="schema-cell"><strong>{resource.reviewedSchema.title}</strong><span>{resource.semanticFields.length} campos · {defaults} defaults</span><small>{resource.reviewedSchema.schemaId}@{resource.reviewedSchema.schemaVersion}</small></div>}</td><td>{resource.conflictIds.length === 0 ? <span className="analysis-status is-complete">livre</span> : <span className="analysis-status is-partial">{resource.conflictIds.length}</span>}</td><td><div className="resource-actions"><button className="text-button" type="button" onClick={() => setSelectedResource(resource)}>Inspecionar</button>{canConfigure ? <a href={`/mods/detalhe?workspace=${encodeURIComponent(workspaceId)}&mod=${encodeURIComponent(modId)}&tab=configuracoes&source=${encodeURIComponent(resource.resourceId)}#${encodeURIComponent(resource.systemId ?? '')}`}>Configurar</a> : null}</div></td></tr>;
          })}</tbody></table></div> : null}
          {resourcePage !== null && resourcePage.total > resourcePage.resources.length ? <p className="pagination-note">Mostrando os primeiros {resourcePage.resources.length} de {resourcePage.total}. Refine a busca para chegar ao recurso desejado.</p> : null}
        </section>

        <section className="split datapack-summary-grid"><div className="card"><h2>Datapacks</h2><ul className="evidence-list">{detail.datapacks.map((datapack) => <li key={datapack.datapackId}><strong>{datapack.name}</strong><span>{datapack.loader} · {datapack.resourceIds.length} recursos · {datapack.conflictIds.length} conflitos</span><code>{datapack.rootPath}</code></li>)}</ul></div><div className="card"><h2>Tipos com maior impacto</h2><div className="table-scroll"><table className="table"><thead><tr><th>Namespace / tipo</th><th>Efeito</th><th>Recursos</th><th>Campos</th></tr></thead><tbody>{detail.datapackResourceSummary.slice(0, 20).map((group) => <tr key={`${group.namespace}:${group.resourceType}:${group.effect}`}><td><code>{group.namespace}</code><small>{group.resourceType}</small></td><td>{group.effect}</td><td>{group.count}</td><td>{group.semanticFieldCount}</td></tr>)}</tbody></table></div></div></section>
      </> : null}

      {tab === 'arquivos' ? <section className="split"><article className="card"><h2>Artefato</h2><code>{detail.mod.archivePath}</code><p className="subtle">SHA-256 {detail.mod.archiveSha256}</p></article><article className="card"><h2>Arquivos de configuração</h2><ul className="evidence-list">{sourceFiles.map((file) => <li key={file}><code>{file}</code><span>{detail.configurations.filter((entry) => entry.source.file === file).length} campos interpretados</span></li>)}</ul></article><article className="card"><h2>Raízes de datapacks</h2><ul className="evidence-list">{detail.datapacks.map((pack) => <li key={pack.datapackId}><code>{pack.rootPath}</code><span>{pack.loader}</span></li>)}</ul></article></section> : null}

      {tab === 'grafo' ? <GraphExplorer workspaceId={workspaceId} modId={modId} /> : null}

      {selected === null ? null : <aside className="drawer trace-drawer" aria-label="Origem técnica da configuração"><div className="drawer-head"><div><span className="eyebrow">Rastreabilidade</span><h2>{selected.name}</h2></div><button className="secondary" type="button" onClick={() => setSelected(null)}>Fechar</button></div><dl className="detail-grid"><div><dt>Origem</dt><dd>{selected.source.kind === 'datapack-resource' ? 'Recurso de datapack revisado' : 'Arquivo de configuração'}</dd></div><div><dt>Mod</dt><dd>{selected.modId}</dd></div><div><dt>Sistema</dt><dd>{systems.get(selected.systemId)?.title ?? selected.systemId}</dd></div><div><dt>Arquivo</dt><dd><code>{selected.source.file}</code></dd></div><div><dt>Chave</dt><dd><code>{selected.source.path}</code></dd></div><div><dt>Linha</dt><dd>{selected.source.line === 0 ? 'JSON estruturado' : selected.source.line}</dd></div><div><dt>Parser</dt><dd>{selected.source.parser}</dd></div><div><dt>Padrão</dt><dd>{selected.defaultValue === null ? 'Não comprovado' : displayValue(selected.defaultValue)}</dd></div><div><dt>Restart</dt><dd>{selected.restartRequired === null ? 'Não comprovado' : selected.restartRequired ? 'Necessário' : 'Não necessário'}</dd></div></dl><h3>Evidências</h3><ul className="evidence-list">{selected.evidenceIds.map((id) => evidence.get(id)).filter((entry): entry is EcosystemEvidence => entry !== undefined).map((entry) => <li key={entry.evidenceId}><strong>{entry.source}</strong><code>{entry.sourcePath}</code><span>{entry.detail}</span><small>{entry.status} · confiança {entry.confidence}</small></li>)}</ul></aside>}
      {selectedResource === null ? null : <aside className="drawer trace-drawer resource-drawer" aria-label="Detalhes técnicos do recurso de datapack"><div className="drawer-head"><div><span className="eyebrow">Recurso de datapack</span><h2>{selectedResource.resourcePath}</h2></div><button className="secondary" type="button" onClick={() => setSelectedResource(null)}>Fechar</button></div><dl className="detail-grid"><div><dt>Coordenada</dt><dd><code>{selectedResource.namespace}:{selectedResource.resourceType}/{selectedResource.resourcePath}</code></dd></div><div><dt>Efeito</dt><dd>{selectedResource.effect}</dd></div><div><dt>Datapack</dt><dd>{datapacksById.get(selectedResource.datapackId)?.name ?? selectedResource.datapackId}</dd></div><div><dt>Sistema</dt><dd>{systems.get(selectedResource.systemId ?? '')?.title ?? 'Não classificado'}</dd></div><div><dt>Arquivo</dt><dd><code>{selectedResource.sourceFile}</code></dd></div><div><dt>SHA-256</dt><dd><code>{selectedResource.sha256}</code></dd></div><div><dt>Schema</dt><dd>{selectedResource.reviewedSchema === null ? 'Não revisado' : `${selectedResource.reviewedSchema.schemaId}@${selectedResource.reviewedSchema.schemaVersion}`}</dd></div><div><dt>Hash do schema</dt><dd>{selectedResource.reviewedSchema === null ? '—' : <code>{selectedResource.reviewedSchema.schemaSha256}</code>}</dd></div><div><dt>Parser</dt><dd>{selectedResource.reviewedSchema?.parserId ?? 'Classificação técnica por path'}</dd></div></dl>{selectedResource.reviewedSchema === null ? null : <p className="banner banner-neutral">O schema comprova forma, tipos e pares mínimo/máximo. Limites de domínio não declarados continuam desconhecidos e não são inventados pelo painel.</p>}{selectedResource.conflictIds.length > 0 ? <p className="banner banner-danger">Este recurso participa de {selectedResource.conflictIds.length} conflito(s); edição semântica bloqueada.</p> : null}{selectedResource.semanticFields.length > 0 ? <><div className="drawer-section-head"><h3>Campos interpretados</h3><span className="tag">{selectedResource.semanticFields.length}</span></div><div className="table-scroll"><table className="table semantic-field-table"><thead><tr><th>Campo</th><th>Atual</th><th>Default</th><th>Edição</th></tr></thead><tbody>{selectedResource.semanticFields.map((field) => <tr key={field.configurationId}><td><code>{field.path}</code></td><td>{String(field.currentValue)}</td><td>{field.defaultValue === null ? '—' : String(field.defaultValue)}</td><td>{field.editable ? 'permitida' : 'somente leitura'}</td></tr>)}</tbody></table></div>{selectedResource.conflictIds.length === 0 && selectedResource.semanticFields.some((field) => field.editable) ? <a className="primary-link drawer-primary-action" href={`/mods/detalhe?workspace=${encodeURIComponent(workspaceId)}&mod=${encodeURIComponent(modId)}&tab=configuracoes&source=${encodeURIComponent(selectedResource.resourceId)}#${encodeURIComponent(selectedResource.systemId ?? '')}`}>Abrir configurações deste recurso</a> : null}</> : <p className="muted">O conteúdo continua rastreável tecnicamente, mas ainda não possui schema seguro para formulário.</p>}<h3>Evidências</h3><ul className="evidence-list">{selectedResource.evidenceIds.map((id) => evidence.get(id)).filter((entry): entry is EcosystemEvidence => entry !== undefined).map((entry) => <li key={entry.evidenceId}><strong>{entry.source}</strong><code>{entry.sourcePath}</code><span>{entry.detail}</span></li>)}</ul></aside>}
    </PanelShell>
  );
}
