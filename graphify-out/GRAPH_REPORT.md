# Graph Report - void pasta  (2026-08-03)

## Corpus Check
- 86 files · ~28,513 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 316 nodes · 422 edges · 34 communities (32 shown, 2 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 19 edges (avg confidence: 0.87)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ecd79c66`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Handoff da plataforma
- Pacote CurseForge Canônico
- Modelo Manifesto CurseForge
- Platform Control Architecture
- Fonte canonica Launcher/pack
- Contratos compartilhados
- export_server_summary.py
- Gate de audit para alpha
- Documentação do servidor
- Automatic Graph Persistence
- Portable Knowledge Graph Outputs
- Licenciamento de ativos autorais
- Documentacao do launcher
- ADR-006 — Identidade VoidFall e início limitado da Fase 2
- common.ts
- Plataforma/package.json
- compilerOptions
- contracts/package.json
- tsconfig.test.json
- tsconfig.build.json
- `@voidfall/contracts`
- tsconfig.json
- clean.mjs

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 21 edges
2. `validateContract()` - 13 edges
3. `semanticIssue()` - 12 edges
4. `appendSemanticIssues()` - 11 edges
5. `Handoff da plataforma` - 11 edges
6. `Planejamento da plataforma` - 11 edges
7. `Contratos compartilhados` - 8 edges
8. `Platform Control Architecture` - 8 edges
9. `validateReleaseManifest()` - 7 edges
10. `Documentação do servidor` - 7 edges

## Surprising Connections (you probably didn't know these)
- `Management Platform Phase 1` --references--> `Platform Control Architecture`  [EXTRACTED]
  Plataforma/README.md → docs/plataforma/ARCHITECTURE.md
- `VoidFall Repository` --conceptually_related_to--> `ADR-005 Reviewed Canonical Client Catalog`  [INFERRED]
  README.md → docs/plataforma/DECISIONS/ADR-005-fonte-canonica-do-cliente.md
- `Dedicated Server Promotion Gate` --conceptually_related_to--> `ADR-005 Reviewed Canonical Client Catalog`  [INFERRED]
  Servidor/pack/README.md → docs/plataforma/DECISIONS/ADR-005-fonte-canonica-do-cliente.md
- `VoidFall Repository Operating Guide` --references--> `Agent Scope and Minimum Handoff`  [EXTRACTED]
  AGENTS.md → docs/agentes/escopos.md
- `VoidFall Repository Operating Guide` --conceptually_related_to--> `VoidFall Repository`  [EXTRACTED]
  AGENTS.md → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Graph Auto-Save Layers** — docs_graphify_readme_file_change_watcher, docs_graphify_readme_git_graph_hooks, docs_graphify_readme_windows_logon_task [EXTRACTED 1.00]
- **Gate de pre-release do launcher** — docs_launcher_readme_bloqueio_pre_release, docs_launcher_auditoria_gate_alpha, docs_launcher_releases_smoke_tests_obrigatorios [EXTRACTED 1.00]
- **Platform Phase 1 Planning Artifacts** — plataforma_agents_phase_1_platform_governance, plataforma_readme_management_platform_phase_1, docs_plataforma_architecture_platform_control_architecture, docs_plataforma_changelog_phase_1_documentation_release [EXTRACTED 1.00]
- **Five Initial Platform Architecture Decisions** — docs_plataforma_decisions_adr_001_linguagens_e_limites_typescript_control_plane_java_forge_bridge, docs_plataforma_decisions_adr_002_comunicacao_com_agente_outbound_authenticated_agent, docs_plataforma_decisions_adr_003_manifesto_e_publicacao_signed_immutable_release_manifest, docs_plataforma_decisions_adr_004_persistencia_e_fila_postgresql_durable_job_queue, docs_plataforma_decisions_adr_005_fonte_canonica_do_cliente_reviewed_canonical_client_catalog [EXTRACTED 1.00]
- **Dedicated Server Publication Boundaries** — servidor_agents_server_agent_guide, servidor_pack_readme_dedicated_server_promotion_gate, servidor_source_readme_project_owned_source_gate [INFERRED 0.95]

## Communities (34 total, 2 thin omitted)

### Community 0 - "Handoff da plataforma"
Cohesion: 0.32
Nodes (12): Registros de decisão arquitetural, Implantação e operação, Handoff da plataforma, Protocolo do launcher, Logs, auditoria e métricas, Build do modpack, Permissões, Contexto do projeto (+4 more)

### Community 1 - "Pacote CurseForge Canônico"
Cohesion: 0.18
Nodes (12): Canonical CurseForge Pack Source, Provider-Resolved CurseForge Assets, Reviewed Portable Overrides, Sanitized Manifest, Blocked Modrinth Export, Cross-Launcher mrpack Import Validation, Curated Addon Mapping, Valid mrpack Index (+4 more)

### Community 2 - "Modelo Manifesto CurseForge"
Cohesion: 0.18
Nodes (10): author, files, manifestType, manifestVersion, minecraft, modLoaders, version, name (+2 more)

### Community 3 - "Platform Control Architecture"
Cohesion: 0.15
Nodes (20): VoidFall Repository Operating Guide, Agent Scope and Minimum Handoff, Versioned Platform API Contracts, Platform Control Architecture, Phase 1 Documentation Release, PostgreSQL Transactional Platform Model, ADR-001 TypeScript Control Plane and Java Forge Bridge, ADR-002 Outbound Authenticated Server Agent (+12 more)

### Community 4 - "Fonte canonica Launcher/pack"
Cohesion: 0.20
Nodes (10): Fonte canonica Launcher/pack, Isolamento futuro do servidor, Perfil original imutavel, Pipeline do launcher, Distribuicao por project/file IDs, Gate de arquivos acima de 95 MB, Quarentena de CtE Resources, CurseForge como primeiro artefato (+2 more)

### Community 5 - "Contratos compartilhados"
Cohesion: 0.14
Nodes (13): `AgentEnvelope`, `AuditEvent`, Compatibilidade, Contratos compartilhados, Invariantes implementadas, `Job`, Limite de confiança, Matriz de contratos (+5 more)

### Community 6 - "export_server_summary.py"
Cohesion: 0.44
Nodes (8): Path, bool_cell(), directory_size(), json_entry_count(), main(), Build a sanitized JSON summary from the private server workspace. The script…, read_csv(), read_properties()

### Community 7 - "Gate de audit para alpha"
Cohesion: 0.25
Nodes (8): Bloqueio de distribuicao de CtE Resources, Divergencia entre manifesto e runtime, Falha de registros na criacao de mundo, Gate de audit para alpha, Bloqueio de pre-release, Estagios de versionamento, Pipeline de release, Smoke tests obrigatorios

### Community 8 - "Documentação do servidor"
Cohesion: 0.25
Nodes (8): Arquitetura do servidor, Auditoria do servidor, Compatibilidade do cliente, Operação do servidor, Documentação do servidor, Releases do servidor, Segurança do servidor, Sistemas customizados

### Community 9 - "Automatic Graph Persistence"
Cohesion: 0.40
Nodes (5): Automatic Graph Persistence, File Change Watcher, Git Graph Hooks, Semantic Refresh Marker, Windows Logon Auto-Start Task

### Community 10 - "Portable Knowledge Graph Outputs"
Cohesion: 0.67
Nodes (3): Agent Graph Query Workflow, Graphify All-Extras Installation, Portable Knowledge Graph Outputs

### Community 24 - "ADR-006 — Identidade VoidFall e início limitado da Fase 2"
Cohesion: 0.29
Nodes (6): ADR-006 — Identidade VoidFall e início limitado da Fase 2, Consequências, Contexto, Decisão, Motivo, Revisão futura

### Community 25 - "common.ts"
Cohesion: 0.07
Nodes (58): AgentEnvelope, AgentEnvelopeSchema, validateAgentEnvelope(), AuditEvent, AuditEventSchema, findForbiddenKey(), forbiddenAuditKeys, normalizeKey() (+50 more)

### Community 26 - "Plataforma/package.json"
Cohesion: 0.07
Nodes (27): description, devDependencies, tsx, @types/node, typescript, engines, node, npm (+19 more)

### Community 27 - "compilerOptions"
Cohesion: 0.08
Nodes (24): compilerOptions, declaration, declarationMap, esModuleInterop, exactOptionalPropertyTypes, forceConsistentCasingInFileNames, lib, module (+16 more)

### Community 28 - "contracts/package.json"
Cohesion: 0.09
Nodes (22): ajv, ajv-formats, dependencies, ajv, ajv-formats, @sinclair/typebox, description, exports (+14 more)

### Community 30 - "tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, ../../tsconfig.base.json (+1 more)

### Community 31 - "tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 32 - "`@voidfall/contracts`"
Cohesion: 0.40
Nodes (4): Comandos, Conteúdo inicial, Evolução, `@voidfall/contracts`

### Community 33 - "tsconfig.json"
Cohesion: 0.50
Nodes (3): files, references, $schema

### Community 34 - "clean.mjs"
Cohesion: 0.50
Nodes (3): buildInfoFile, outputDirectory, packageRoot

## Knowledge Gaps
- **150 isolated node(s):** `version`, `modLoaders`, `manifestType`, `manifestVersion`, `name` (+145 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What connects `version`, `modLoaders`, `manifestType` to the rest of the system?**
  _150 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Contratos compartilhados` be split into smaller, more focused modules?**
  _Cohesion score 0.14285714285714285 - nodes in this community are weakly interconnected._
- **Should `common.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07283702213279677 - nodes in this community are weakly interconnected._
- **Should `Plataforma/package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.07142857142857142 - nodes in this community are weakly interconnected._
- **Should `compilerOptions` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `contracts/package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.08695652173913043 - nodes in this community are weakly interconnected._