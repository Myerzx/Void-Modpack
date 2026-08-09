'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { modSteps, PanelShell } from '../../components/shell';
import {
  readEcosystemMod,
  type EcosystemConfiguration,
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
  const [drafts, setDrafts] = useState<Readonly<Record<string, EcosystemConfiguration['currentValue']>>>({});
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

  const evidence = useMemo(() => new Map(detail?.evidence.map((entry) => [entry.evidenceId, entry]) ?? []), [detail]);
  const systems = useMemo(() => new Map(detail?.systems.map((system) => [system.systemId, system]) ?? []), [detail]);
  const configurationsBySystem = useMemo(() => {
    const groups = new Map<string, EcosystemConfiguration[]>();
    for (const configuration of detail?.configurations ?? []) {
      const entries = groups.get(configuration.systemId) ?? [];
      entries.push(configuration);
      groups.set(configuration.systemId, entries);
    }
    return groups;
  }, [detail]);
  const sourceFiles = useMemo(() => [...new Set(detail?.configurations.map((entry) => entry.source.file) ?? [])].sort(), [detail]);
  const functionalRelationships = useMemo(() => detail?.relationships.filter((relationship) => !STRUCTURAL.has(relationship.type)) ?? [], [detail]);
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
        <section className="config-workbench">
          <aside className="system-index card"><span className="eyebrow">Sistemas</span><strong>{detail.configurations.length} configurações</strong><small>{provenDefaults} com padrão comprovado</small><nav>{detail.systems.filter((system) => (configurationsBySystem.get(system.systemId)?.length ?? 0) > 0).map((system) => <a key={system.systemId} href={`#${system.systemId}`}>{system.title}<span>{configurationsBySystem.get(system.systemId)?.length ?? 0}</span></a>)}</nav></aside>
          <div className="system-groups">
            {detail.systems.filter((system) => (configurationsBySystem.get(system.systemId)?.length ?? 0) > 0).map((system) => {
              const configurations = configurationsBySystem.get(system.systemId) ?? [];
              const files = [...new Set(configurations.map((entry) => entry.source.file))];
              return <section className="card config-system" id={system.systemId} key={system.systemId}><div className="card-head"><div><span className="eyebrow">{system.status} · confiança {system.confidence}</span><h2>{system.title}</h2></div><span className="tag">{configurations.length} campos</span></div>
                <div className="semantic-config-list">{configurations.map((configuration) => {
                  const value = drafts[configuration.configurationId] ?? configuration.currentValue;
                  const changed = drafts[configuration.configurationId] !== undefined;
                  return <article className={`semantic-config${changed ? ' is-changed' : ''}`} key={configuration.configurationId}><button className="config-title" type="button" onClick={() => setSelected(configuration)}><strong>{configuration.name}</strong><code>{configuration.source.path}</code></button><div className="config-control"><ConfigInput configuration={configuration} value={value} onChange={(next) => setDrafts((current) => ({ ...current, [configuration.configurationId]: next }))} />{changed ? <button className="text-button" type="button" onClick={() => setDrafts((current) => { const next = { ...current }; delete next[configuration.configurationId]; return next; })}>Desfazer</button> : null}</div><p>{configuration.description ?? 'Sem descrição declarada; a chave e a origem continuam disponíveis.'}</p><div className="config-meta"><span>{configuration.type}</span><span>{configuration.side}</span><span>{configuration.status}</span><span>confiança {configuration.confidence}</span><span>{configuration.defaultValue === null ? 'padrão não comprovado' : `padrão ${displayValue(configuration.defaultValue)}`}</span><button type="button" onClick={() => setSelected(configuration)}>Ver origem</button></div></article>;
                })}</div>
                {files.map((file) => { const count = configurations.filter((entry) => entry.source.file === file && drafts[entry.configurationId] !== undefined).length; return count === 0 ? null : <div className="staging-row" key={file}><div><strong>{count} alteração(ões) em {file}</strong><span>{stageResult[file] || 'Será criado apenas um estágio revisável; o runtime não será alterado.'}</span></div>{session?.permissions.includes('workspace.manage') === true ? <button className="primary" type="button" disabled={staging === file} onClick={() => void stageFile(file)}>{staging === file ? 'Validando…' : 'Validar e preparar'}</button> : null}</div>; })}
              </section>;
            })}
          </div>
        </section>
      ) : null}

      {tab === 'sistemas' ? <section className="card-grid">{detail.systems.map((system) => <article className="card" key={system.systemId}><div className="card-head"><h2>{system.title}</h2><span className="tag">{system.status}</span></div><p className="muted">Agrupamento semântico produzido pela regra registrada na evidência.</p><dl className="stat-row"><div><dt>Configurações</dt><dd>{system.configurationIds.length}</dd></div><div><dt>Recursos</dt><dd>{system.datapackResourceIds.length}</dd></div><div><dt>Confiança</dt><dd>{system.confidence}</dd></div></dl><a className="secondary" href={`${modSteps(workspaceId, modId, 'configuracoes')[1]?.href ?? ''}#${system.systemId}`}>Abrir configurações</a></article>)}</section> : null}

      {tab === 'integracoes' ? <section className="card"><div className="card-head"><div><h2>Relações comprovadas</h2><p className="subtle">A direção da seta é preservada do modelo normalizado.</p></div><span className="tag">{functionalRelationships.length} relações</span></div>{functionalRelationships.length === 0 ? <p className="muted">Nenhuma relação funcional foi comprovada nesta análise.</p> : <div className="relationship-list">{functionalRelationships.map((relationship) => { const relationEvidence = relationship.evidenceIds.map((id) => evidence.get(id)).filter((entry): entry is EcosystemEvidence => entry !== undefined); return <article key={relationship.relationshipId}><div className="relation-flow"><code>{relationship.from.id}</code><span>{RELATION_LABELS[relationship.type] ?? relationship.type}</span><code>{relationship.to.id}</code></div><p>{relationship.reason}</p><div className="config-meta"><span>{relationship.status}</span><span>confiança {relationship.confidence}</span><span>{relationship.evidenceIds.length} evidência(s)</span></div>{relationEvidence.length > 0 ? <details className="relationship-evidence"><summary>Inspecionar evidências</summary><ul className="evidence-list">{relationEvidence.map((entry) => <li key={entry.evidenceId}><strong>{entry.source}</strong><code>{entry.sourcePath}</code><span>{entry.detail}</span></li>)}</ul></details> : null}</article>; })}</div>}</section> : null}

      {tab === 'datapacks' ? <><section className="stat-strip"><div><strong className="stat-value">{detail.datapacks.length}</strong><span className="stat-label">packs relacionados</span></div><div><strong className="stat-value">{detail.datapackResourceSummary.reduce((sum, group) => sum + group.count, 0)}</strong><span className="stat-label">recursos classificados</span></div><div><strong className="stat-value">{detail.datapackResourceSummary.filter((group) => group.effect === 'overrides').reduce((sum, group) => sum + group.count, 0)}</strong><span className="stat-label">overrides comprovados</span></div></section><section className="split"><div className="card"><h2>Datapacks</h2><ul className="evidence-list">{detail.datapacks.map((datapack) => <li key={datapack.datapackId}><strong>{datapack.name}</strong><span>{datapack.loader} · {datapack.resourceIds.length} recursos</span><code>{datapack.rootPath}</code></li>)}</ul></div><div className="card"><h2>Recursos por tipo</h2><div className="table-scroll"><table className="table"><thead><tr><th>Namespace</th><th>Tipo</th><th>Efeito</th><th>Qtd.</th></tr></thead><tbody>{detail.datapackResourceSummary.map((group) => <tr key={`${group.namespace}:${group.resourceType}:${group.effect}`}><td><code>{group.namespace}</code></td><td>{group.resourceType}</td><td>{group.effect}</td><td>{group.count}</td></tr>)}</tbody></table></div></div></section></> : null}

      {tab === 'arquivos' ? <section className="split"><article className="card"><h2>Artefato</h2><code>{detail.mod.archivePath}</code><p className="subtle">SHA-256 {detail.mod.archiveSha256}</p></article><article className="card"><h2>Arquivos de configuração</h2><ul className="evidence-list">{sourceFiles.map((file) => <li key={file}><code>{file}</code><span>{detail.configurations.filter((entry) => entry.source.file === file).length} campos interpretados</span></li>)}</ul></article><article className="card"><h2>Raízes de datapacks</h2><ul className="evidence-list">{detail.datapacks.map((pack) => <li key={pack.datapackId}><code>{pack.rootPath}</code><span>{pack.loader}</span></li>)}</ul></article></section> : null}

      {tab === 'grafo' ? <section className="card"><div className="card-head"><div><h2>Subgrafo do mod</h2><p className="subtle">Entidades e arestas deste snapshot; cada aresta mantém evidências.</p></div><span className="tag">{detail.relationships.length} arestas</span></div><div className="relationship-list">{detail.relationships.map((relationship) => <article key={relationship.relationshipId}><div className="relation-flow"><code>{relationship.from.type}:{relationship.from.id}</code><span>{relationship.type}</span><code>{relationship.to.type}:{relationship.to.id}</code></div><p>{relationship.reason}</p></article>)}</div></section> : null}

      {selected === null ? null : <aside className="drawer trace-drawer" aria-label="Origem técnica da configuração"><div className="drawer-head"><div><span className="eyebrow">Rastreabilidade</span><h2>{selected.name}</h2></div><button className="secondary" type="button" onClick={() => setSelected(null)}>Fechar</button></div><dl className="detail-grid"><div><dt>Mod</dt><dd>{selected.modId}</dd></div><div><dt>Sistema</dt><dd>{systems.get(selected.systemId)?.title ?? selected.systemId}</dd></div><div><dt>Arquivo</dt><dd><code>{selected.source.file}</code></dd></div><div><dt>Chave</dt><dd><code>{selected.source.path}</code></dd></div><div><dt>Linha</dt><dd>{selected.source.line}</dd></div><div><dt>Parser</dt><dd>{selected.source.parser}</dd></div><div><dt>Padrão</dt><dd>{selected.defaultValue === null ? 'Não comprovado' : displayValue(selected.defaultValue)}</dd></div><div><dt>Restart</dt><dd>{selected.restartRequired === null ? 'Não comprovado' : selected.restartRequired ? 'Necessário' : 'Não necessário'}</dd></div></dl><h3>Evidências</h3><ul className="evidence-list">{selected.evidenceIds.map((id) => evidence.get(id)).filter((entry): entry is EcosystemEvidence => entry !== undefined).map((entry) => <li key={entry.evidenceId}><strong>{entry.source}</strong><code>{entry.sourcePath}</code><span>{entry.detail}</span><small>{entry.status} · confiança {entry.confidence}</small></li>)}</ul></aside>}
    </PanelShell>
  );
}
