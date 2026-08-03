# Graph Report - .  (2026-08-03)

## Corpus Check
- Corpus is ~23,441 words - fits in a single context window. You may not need a graph.

## Summary
- 116 nodes · 122 edges · 24 communities (22 shown, 2 thin omitted)
- Extraction: 87% EXTRACTED · 13% INFERRED · 0% AMBIGUOUS · INFERRED: 16 edges (avg confidence: 0.94)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Plataforma Operação e Segurança
- Pacote CurseForge Canônico
- Modelo Manifesto CurseForge
- Governança Cliente Servidor
- Portabilidade do Launcher
- Arquitetura da Plataforma
- Exportação do Servidor
- Gates de Release
- Documentação do Servidor
- Persistência Automática Graphify
- Operação do Graphify
- Licenciamento de Ativos
- Documentação do Launcher

## God Nodes (most connected - your core abstractions)
1. `Handoff da plataforma` - 11 edges
2. `Planejamento da plataforma` - 11 edges
3. `Platform Control Architecture` - 8 edges
4. `Documentação do servidor` - 7 edges
5. `main()` - 6 edges
6. `Server Agent Guide` - 5 edges
7. `Canonical CurseForge Pack Source` - 4 edges
8. `Blocked Modrinth Export` - 4 edges
9. `Gate de audit para alpha` - 4 edges
10. `VoidFall Repository` - 4 edges

## Surprising Connections (you probably didn't know these)
- `Phase 1 Platform Governance` --references--> `Server Agent Guide`  [EXTRACTED]
  Plataforma/AGENTS.md → Servidor/AGENTS.md
- `Management Platform Phase 1` --references--> `Platform Control Architecture`  [EXTRACTED]
  Plataforma/README.md → docs/plataforma/ARCHITECTURE.md
- `VoidFall Repository` --conceptually_related_to--> `ADR-005 Reviewed Canonical Client Catalog`  [INFERRED]
  README.md → docs/plataforma/DECISIONS/ADR-005-fonte-canonica-do-cliente.md
- `Dedicated Server Promotion Gate` --conceptually_related_to--> `ADR-005 Reviewed Canonical Client Catalog`  [INFERRED]
  Servidor/pack/README.md → docs/plataforma/DECISIONS/ADR-005-fonte-canonica-do-cliente.md
- `VoidFall Repository Operating Guide` --references--> `Agent Scope and Minimum Handoff`  [EXTRACTED]
  AGENTS.md → docs/agentes/escopos.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Graph Auto-Save Layers** — docs_graphify_readme_file_change_watcher, docs_graphify_readme_git_graph_hooks, docs_graphify_readme_windows_logon_task [EXTRACTED 1.00]
- **Gate de pre-release do launcher** — docs_launcher_readme_bloqueio_pre_release, docs_launcher_auditoria_gate_alpha, docs_launcher_releases_smoke_tests_obrigatorios [EXTRACTED 1.00]
- **Platform Phase 1 Planning Artifacts** — plataforma_agents_phase_1_platform_governance, plataforma_readme_management_platform_phase_1, docs_plataforma_architecture_platform_control_architecture, docs_plataforma_changelog_phase_1_documentation_release [EXTRACTED 1.00]
- **Five Initial Platform Architecture Decisions** — docs_plataforma_decisions_adr_001_linguagens_e_limites_typescript_control_plane_java_forge_bridge, docs_plataforma_decisions_adr_002_comunicacao_com_agente_outbound_authenticated_agent, docs_plataforma_decisions_adr_003_manifesto_e_publicacao_signed_immutable_release_manifest, docs_plataforma_decisions_adr_004_persistencia_e_fila_postgresql_durable_job_queue, docs_plataforma_decisions_adr_005_fonte_canonica_do_cliente_reviewed_canonical_client_catalog [EXTRACTED 1.00]
- **Dedicated Server Publication Boundaries** — servidor_agents_server_agent_guide, servidor_pack_readme_dedicated_server_promotion_gate, servidor_source_readme_project_owned_source_gate [INFERRED 0.95]

## Communities (24 total, 2 thin omitted)

### Community 0 - "Plataforma Operação e Segurança"
Cohesion: 0.32
Nodes (12): Registros de decisão arquitetural, Implantação e operação, Handoff da plataforma, Protocolo do launcher, Logs, auditoria e métricas, Build do modpack, Permissões, Contexto do projeto (+4 more)

### Community 1 - "Pacote CurseForge Canônico"
Cohesion: 0.18
Nodes (12): Canonical CurseForge Pack Source, Provider-Resolved CurseForge Assets, Reviewed Portable Overrides, Sanitized Manifest, Blocked Modrinth Export, Cross-Launcher mrpack Import Validation, Curated Addon Mapping, Valid mrpack Index (+4 more)

### Community 2 - "Modelo Manifesto CurseForge"
Cohesion: 0.18
Nodes (10): author, files, manifestType, manifestVersion, minecraft, modLoaders, version, name (+2 more)

### Community 3 - "Governança Cliente Servidor"
Cohesion: 0.33
Nodes (10): VoidFall Repository Operating Guide, Agent Scope and Minimum Handoff, ADR-005 Reviewed Canonical Client Catalog, Evidence and Release Documentation Boundary, VoidFall Repository, Server Agent Guide, Dedicated Server Promotion Gate, The Casket of Reveries 2.0.26 Server (+2 more)

### Community 4 - "Portabilidade do Launcher"
Cohesion: 0.20
Nodes (10): Fonte canonica Launcher/pack, Isolamento futuro do servidor, Perfil original imutavel, Pipeline do launcher, Distribuicao por project/file IDs, Gate de arquivos acima de 95 MB, Quarentena de CtE Resources, CurseForge como primeiro artefato (+2 more)

### Community 5 - "Arquitetura da Plataforma"
Cohesion: 0.29
Nodes (10): Versioned Platform API Contracts, Platform Control Architecture, Phase 1 Documentation Release, PostgreSQL Transactional Platform Model, ADR-001 TypeScript Control Plane and Java Forge Bridge, ADR-002 Outbound Authenticated Server Agent, ADR-003 Signed Immutable Release Manifest, ADR-004 PostgreSQL Durable Job Queue (+2 more)

### Community 6 - "Exportação do Servidor"
Cohesion: 0.44
Nodes (8): Path, bool_cell(), directory_size(), json_entry_count(), main(), Build a sanitized JSON summary from the private server workspace. The script…, read_csv(), read_properties()

### Community 7 - "Gates de Release"
Cohesion: 0.25
Nodes (8): Bloqueio de distribuicao de CtE Resources, Divergencia entre manifesto e runtime, Falha de registros na criacao de mundo, Gate de audit para alpha, Bloqueio de pre-release, Estagios de versionamento, Pipeline de release, Smoke tests obrigatorios

### Community 8 - "Documentação do Servidor"
Cohesion: 0.25
Nodes (8): Arquitetura do servidor, Auditoria do servidor, Compatibilidade do cliente, Operação do servidor, Documentação do servidor, Releases do servidor, Segurança do servidor, Sistemas customizados

### Community 9 - "Persistência Automática Graphify"
Cohesion: 0.40
Nodes (5): Automatic Graph Persistence, File Change Watcher, Git Graph Hooks, Semantic Refresh Marker, Windows Logon Auto-Start Task

### Community 10 - "Operação do Graphify"
Cohesion: 0.67
Nodes (3): Agent Graph Query Workflow, Graphify All-Extras Installation, Portable Knowledge Graph Outputs

## Knowledge Gaps
- **35 isolated node(s):** `version`, `modLoaders`, `manifestType`, `manifestVersion`, `name` (+30 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Server Agent Guide` connect `Governança Cliente Servidor` to `Arquitetura da Plataforma`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **Why does `Phase 1 Platform Governance` connect `Arquitetura da Plataforma` to `Governança Cliente Servidor`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **Are the 5 inferred relationships involving `Platform Control Architecture` (e.g. with `Versioned Platform API Contracts` and `ADR-001 TypeScript Control Plane and Java Forge Bridge`) actually correct?**
  _`Platform Control Architecture` has 5 INFERRED edges - model-reasoned connections that need verification._
- **What connects `version`, `modLoaders`, `manifestType` to the rest of the system?**
  _35 weakly-connected nodes found - possible documentation gaps or missing edges._