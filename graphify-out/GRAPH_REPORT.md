# Graph Report - void pasta  (2026-08-03)

## Corpus Check
- 150 files · ~44,534 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 971 nodes · 1219 edges · 83 communities (70 shown, 13 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 20 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `f106d8e2`
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
- database/package.json
- compilerOptions
- tsconfig.build.json
- `@voidfall/contracts`
- tsconfig.json
- clean.mjs
- authentication/package.json
- authentication/src/index.ts
- repositories.ts
- Database
- 0001_foundation.sql
- asIso
- compilerOptions
- permissions/package.json
- compilerOptions
- permissions/src/index.ts
- authentication/tsconfig.test.json
- AgentRepository
- permissions/tsconfig.test.json
- authentication/tsconfig.build.json
- permissions/tsconfig.build.json
- UserRepository
- JobRepository
- app.ts
- worker.ts
- clean-workspace.mjs
- dependencies
- control-api/tsconfig.build.json
- AuditRepository
- compilerOptions
- build-worker/tsconfig.build.json
- agent-client.ts
- panel-web/package.json
- server-agent/package.json
- minecraft-process/package.json
- server-agent/tsconfig.test.json
- server-agent/tsconfig.build.json
- build-worker/package.json
- contracts/tsconfig.test.json
- minecraft-process.test.ts
- compilerOptions
- page.tsx
- PostgresDatabase
- layout.tsx
- next.config.ts
- next-env.d.ts
- minecraft-process/tsconfig.build.json
- Validação da Fase 2
- minecraft-process/tsconfig.test.json
- ADR-007 — Encerramento da Fase 2 e abertura segura da Fase 3
- FakeMinecraftFixture
- Adaptadores de processo da Fase 3
- ServerRepository

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 21 edges
2. `Database` - 15 edges
3. `ManagedMinecraftProcessAdapter` - 15 edges
4. `validateContract()` - 14 edges
5. `SpawnedProcess` - 14 edges
6. `compilerOptions` - 12 edges
7. `semanticIssue()` - 12 edges
8. `appendSemanticIssues()` - 11 edges
9. `Handoff da plataforma` - 11 edges
10. `Planejamento da plataforma` - 11 edges

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

## Communities (83 total, 13 thin omitted)

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
Nodes (61): AgentEnvelope, AgentEnvelopeSchema, AgentHeartbeatPayload, AgentHeartbeatPayloadSchema, validateAgentEnvelope(), validateAgentHeartbeatPayload(), AuditEvent, AuditEventSchema (+53 more)

### Community 26 - "Plataforma/package.json"
Cohesion: 0.06
Nodes (30): description, devDependencies, tsx, @types/node, typescript, engines, node, npm (+22 more)

### Community 27 - "compilerOptions"
Cohesion: 0.08
Nodes (24): compilerOptions, declaration, declarationMap, esModuleInterop, exactOptionalPropertyTypes, forceConsistentCasingInFileNames, lib, module (+16 more)

### Community 28 - "contracts/package.json"
Cohesion: 0.09
Nodes (22): ajv, ajv-formats, dependencies, ajv, ajv-formats, @sinclair/typebox, description, exports (+14 more)

### Community 29 - "database/package.json"
Cohesion: 0.06
Nodes (31): pg, dependencies, pg, @voidfall/authentication, @voidfall/contracts, @voidfall/permissions, description, devDependencies (+23 more)

### Community 30 - "compilerOptions"
Cohesion: 0.14
Nodes (13): compilerOptions, declaration, declarationMap, lib, skipLibCheck, sourceMap, extends, include (+5 more)

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

### Community 35 - "authentication/package.json"
Cohesion: 0.10
Nodes (20): argon2, json-canonicalize, dependencies, argon2, json-canonicalize, @voidfall/contracts, description, exports (+12 more)

### Community 36 - "authentication/src/index.ts"
Cohesion: 0.23
Nodes (13): computeAgentPayloadHash(), createOpaqueToken(), EnvelopeFreshnessOptions, hashOpaqueToken(), hashPassword(), isAgentEnvelopeFresh(), PASSWORD_OPTIONS, safeEqualHex() (+5 more)

### Community 37 - "repositories.ts"
Cohesion: 0.14
Nodes (11): ActiveSession, AgentRow, JobRow, PanelUser, PermissionRepository, RegisteredAgent, Repositories, ServerInstance (+3 more)

### Community 38 - "Database"
Cohesion: 0.18
Nodes (9): Database, SqlClient, SqlResult, MigrationRow, runMigrations(), createRepositories(), createPGliteTestDatabase(), pgliteClient() (+1 more)

### Community 39 - "0001_foundation.sql"
Cohesion: 0.24
Nodes (13): agent_nonces, agent_provision_tokens, agents, audit_events, job_events, jobs, panel_users, permissions (+5 more)

### Community 41 - "compilerOptions"
Cohesion: 0.14
Nodes (13): compilerOptions, declaration, declarationMap, lib, skipLibCheck, sourceMap, extends, include (+5 more)

### Community 42 - "permissions/package.json"
Cohesion: 0.14
Nodes (13): description, exports, files, dist, license, name, private, scripts (+5 more)

### Community 43 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, composite, lib, outDir, rootDir, skipLibCheck, extends, include (+4 more)

### Community 44 - "permissions/src/index.ts"
Cohesion: 0.27
Nodes (9): hasPermission(), isPanelPermission(), knownPermissions, PANEL_PERMISSIONS, PANEL_ROLES, PanelPermission, PanelRole, permissionsForRoles() (+1 more)

### Community 45 - "authentication/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 47 - "permissions/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 48 - "authentication/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 49 - "permissions/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 52 - "app.ts"
Cohesion: 0.08
Nodes (26): AgentRegistrationBody, AgentRegistrationBodySchema, AgentTransportVerifier, anonymizeIp(), ApiError, auditEvent(), AuthContext, buildControlApi() (+18 more)

### Community 53 - "worker.ts"
Cohesion: 0.27
Nodes (6): controller, database, NoopWorkerResult, runNoopWorker(), runNoopWorkerOnce(), databases

### Community 54 - "clean-workspace.mjs"
Cohesion: 0.50
Nodes (3): buildInfoFile, outputDirectory, workspaceRoot

### Community 55 - "dependencies"
Cohesion: 0.06
Nodes (34): fastify, @fastify/cookie, @fastify/helmet, @fastify/rate-limit, dependencies, fastify, @fastify/cookie, @fastify/helmet (+26 more)

### Community 57 - "control-api/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 59 - "compilerOptions"
Cohesion: 0.14
Nodes (13): compilerOptions, declaration, declarationMap, lib, skipLibCheck, sourceMap, extends, include (+5 more)

### Community 60 - "build-worker/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 61 - "agent-client.ts"
Cohesion: 0.21
Nodes (6): AgentFetch, AgentHttpResponse, AgentIdentity, createHeartbeatEnvelope(), HeartbeatInput, VoidFallAgentClient

### Community 62 - "panel-web/package.json"
Cohesion: 0.08
Nodes (23): lucide-react, next, description, devDependencies, lucide-react, next, react, react-dom (+15 more)

### Community 63 - "server-agent/package.json"
Cohesion: 0.12
Nodes (16): dependencies, @voidfall/authentication, @voidfall/contracts, description, exports, @voidfall/authentication, @voidfall/contracts, license (+8 more)

### Community 64 - "minecraft-process/package.json"
Cohesion: 0.14
Nodes (13): description, exports, files, dist, license, name, private, scripts (+5 more)

### Community 65 - "server-agent/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 66 - "server-agent/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 67 - "build-worker/package.json"
Cohesion: 0.10
Nodes (19): dependencies, @voidfall/database, description, devDependencies, @electric-sql/pglite, @voidfall/contracts, @electric-sql/pglite, @voidfall/contracts (+11 more)

### Community 68 - "contracts/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 69 - "minecraft-process.test.ts"
Cohesion: 0.06
Nodes (33): LinuxMinecraftProcessAdapter, ManagedMinecraftProcessAdapter, MinecraftProcessAdapter, MinecraftProcessAdapterOptions, ProcessObservation, WindowsMinecraftProcessAdapter, assertPlainValue(), createMinecraftProcessPlan() (+25 more)

### Community 70 - "compilerOptions"
Cohesion: 0.08
Nodes (24): compilerOptions, allowJs, declaration, declarationMap, incremental, isolatedModules, jsx, lib (+16 more)

### Community 71 - "page.tsx"
Cohesion: 0.32
Nodes (3): metricIcons, navigation, DashboardFixture

### Community 76 - "minecraft-process/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 77 - "Validação da Fase 2"
Cohesion: 0.33
Nodes (5): Dependências, Gate executado, Matriz, Não ações confirmadas, Validação da Fase 2

### Community 78 - "minecraft-process/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 79 - "ADR-007 — Encerramento da Fase 2 e abertura segura da Fase 3"
Cohesion: 0.40
Nodes (4): ADR-007 — Encerramento da Fase 2 e abertura segura da Fase 3, Consequências, Contexto, Decisão

### Community 81 - "Adaptadores de processo da Fase 3"
Cohesion: 0.29
Nodes (6): Adaptadores de processo da Fase 3, Componentes, Fora do escopo, Invariantes, Objetivo do recorte, Teste de integração

## Knowledge Gaps
- **458 isolated node(s):** `version`, `modLoaders`, `manifestType`, `manifestVersion`, `name` (+453 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **13 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Database` connect `Database` to `repositories.ts`, `PostgresDatabase`, `asIso`, `AgentRepository`, `ServerRepository`, `JobRepository`, `UserRepository`, `AuditRepository`?**
  _High betweenness centrality (0.002) - this node is a cross-community bridge._
- **What connects `version`, `modLoaders`, `manifestType` to the rest of the system?**
  _458 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Contratos compartilhados` be split into smaller, more focused modules?**
  _Cohesion score 0.14285714285714285 - nodes in this community are weakly interconnected._
- **Should `common.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06886338393187708 - nodes in this community are weakly interconnected._
- **Should `Plataforma/package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.06451612903225806 - nodes in this community are weakly interconnected._
- **Should `compilerOptions` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `contracts/package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.08695652173913043 - nodes in this community are weakly interconnected._