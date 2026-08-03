# Graph Report - void pasta  (2026-08-03)

## Corpus Check
- 190 files · ~74,760 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1561 nodes · 2374 edges · 123 communities (107 shown, 16 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 25 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `0a231cf4`
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
- database.ts
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
- Database
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
- server-backup/package.json
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
- Controlador de processo da Fase 3
- minecraft-process.test.ts
- metrics.ts
- ManagedMinecraftProcessAdapter
- adapter.ts
- Inventário e catálogo reconciliado da Fase 4
- NeverExitingHandle
- release-manifest.ts
- Configurações básicas e revisões da Fase 3
- catalog-reconciliation.ts
- Console limitado da Fase 3
- controller.ts
- Métricas limitadas da Fase 3
- Backup consistente e restore isolado da Fase 3
- service.ts
- server-backup/tsconfig.test.json
- server-backup/tsconfig.build.json
- server-configuration.test.ts
- server-configuration/src/validation.ts
- node-runtime.ts
- .#mutate
- server-configuration/src/service.ts
- properties.ts
- server-configuration/package.json
- server-configuration/src/types.ts
- server-configuration/tsconfig.test.json
- server-configuration/tsconfig.build.json
- Q: Como o backup e o restore isolado da Fase 3 se conectam no grafo?
- Q: Como o novo núcleo de configurações versionadas se conecta à arquitetura?
- MinecraftProcessController
- inventory-snapshot.ts
- export-schemas.ts
- contracts.test.ts
- audit-event.ts
- reconcile.ts
- mod-catalog/package.json
- mod-catalog/tsconfig.build.json
- mod-catalog/tsconfig.test.json
- launch-plan.ts
- Q: Quais contratos e limites existentes devem orientar o item 1 da Fase 4, inventário e catálogo reconciliado?
- AuditRepository

## God Nodes (most connected - your core abstractions)
1. `ManagedMinecraftProcessAdapter` - 24 edges
2. `compilerOptions` - 21 edges
3. `validateContract()` - 18 edges
4. `ProcessObservation` - 18 edges
5. `MinecraftProcessController` - 17 edges
6. `semanticIssue()` - 16 edges
7. `SpawnedProcess` - 16 edges
8. `appendSemanticIssues()` - 15 edges
9. `Database` - 15 edges
10. `validateManifestValue()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `Management Platform Phase 1` --references--> `Platform Control Architecture`  [EXTRACTED]
  Plataforma/README.md → docs/plataforma/ARCHITECTURE.md
- `VoidFall Repository` --conceptually_related_to--> `ADR-005 Reviewed Canonical Client Catalog`  [INFERRED]
  README.md → docs/plataforma/DECISIONS/ADR-005-fonte-canonica-do-cliente.md
- `Dedicated Server Promotion Gate` --conceptually_related_to--> `ADR-005 Reviewed Canonical Client Catalog`  [INFERRED]
  Servidor/pack/README.md → docs/plataforma/DECISIONS/ADR-005-fonte-canonica-do-cliente.md
- `ProcessMetricsObservation` --references--> `ObservedProcessState`  [EXTRACTED]
  Plataforma/packages/minecraft-process/src/metrics.ts → Plataforma/packages/minecraft-process/src/state-machine.ts
- `Fixture` --references--> `ConfigurationResourceDefinition`  [EXTRACTED]
  Plataforma/packages/server-configuration/test/server-configuration.test.ts → Plataforma/packages/server-configuration/src/types.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Graph Auto-Save Layers** — docs_graphify_readme_file_change_watcher, docs_graphify_readme_git_graph_hooks, docs_graphify_readme_windows_logon_task [EXTRACTED 1.00]
- **Gate de pre-release do launcher** — docs_launcher_readme_bloqueio_pre_release, docs_launcher_auditoria_gate_alpha, docs_launcher_releases_smoke_tests_obrigatorios [EXTRACTED 1.00]
- **Platform Phase 1 Planning Artifacts** — plataforma_agents_phase_1_platform_governance, plataforma_readme_management_platform_phase_1, docs_plataforma_architecture_platform_control_architecture, docs_plataforma_changelog_phase_1_documentation_release [EXTRACTED 1.00]
- **Five Initial Platform Architecture Decisions** — docs_plataforma_decisions_adr_001_linguagens_e_limites_typescript_control_plane_java_forge_bridge, docs_plataforma_decisions_adr_002_comunicacao_com_agente_outbound_authenticated_agent, docs_plataforma_decisions_adr_003_manifesto_e_publicacao_signed_immutable_release_manifest, docs_plataforma_decisions_adr_004_persistencia_e_fila_postgresql_durable_job_queue, docs_plataforma_decisions_adr_005_fonte_canonica_do_cliente_reviewed_canonical_client_catalog [EXTRACTED 1.00]
- **Dedicated Server Publication Boundaries** — servidor_agents_server_agent_guide, servidor_pack_readme_dedicated_server_promotion_gate, servidor_source_readme_project_owned_source_gate [INFERRED 0.95]

## Communities (123 total, 16 thin omitted)

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
Cohesion: 0.12
Nodes (15): `AgentEnvelope`, `AuditEvent`, `CatalogReconciliationReport`, Compatibilidade, Contratos compartilhados, Invariantes implementadas, `InventorySnapshot`, `Job` (+7 more)

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
Cohesion: 0.13
Nodes (24): AgentEnvelope, AgentHeartbeatPayload, AgentHeartbeatPayloadSchema, ActorRef, ActorRefSchema, Base64UrlSchema, ContractSchemaVersion, FileNameSchema (+16 more)

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
Nodes (12): ActiveSession, AgentRow, JobRow, mapServer(), PanelUser, RegisteredAgent, Repositories, ServerInstance (+4 more)

### Community 38 - "database.ts"
Cohesion: 0.20
Nodes (8): SqlClient, SqlResult, MigrationRow, runMigrations(), createRepositories(), createPGliteTestDatabase(), pgliteClient(), PGliteQueryResult

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

### Community 69 - "server-backup/package.json"
Cohesion: 0.14
Nodes (13): description, exports, files, dist, license, name, private, scripts (+5 more)

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

### Community 82 - "Controlador de processo da Fase 3"
Cohesion: 0.17
Nodes (11): Contrato implementado, Controlador de processo da Fase 3, Gate de saída, Invariantes de segurança, Matriz de testes validada, Objetivo do recorte, Restart, Resultados e falhas (+3 more)

### Community 83 - "minecraft-process.test.ts"
Cohesion: 0.09
Nodes (16): MinecraftProcessAdapter, WindowsMinecraftProcessAdapter, MinecraftProcessControllerOptions, ProcessControlRequestError, ProcessLaunchPlan, minimalEnvironment(), NodeProcessRuntime, ProcessRuntime (+8 more)

### Community 84 - "metrics.ts"
Cohesion: 0.16
Nodes (18): available(), AvailableMetric, createMinecraftMetricsSnapshot(), HostMetricsSample, MetricQuality, MetricSource, MetricUnavailableReason, MetricUnit (+10 more)

### Community 86 - "adapter.ts"
Cohesion: 0.10
Nodes (20): LinuxMinecraftProcessAdapter, MinecraftConsoleAdapter, MinecraftMetricsAdapter, MinecraftProcessAdapterOptions, COMMAND_LITERALS, createMinecraftConsoleSnapshot(), MINECRAFT_CONSOLE_COMMANDS, minecraftConsoleCommandLiteral() (+12 more)

### Community 87 - "Inventário e catálogo reconciliado da Fase 4"
Cohesion: 0.12
Nodes (15): Algoritmo de reconciliação, Bloqueios iniciais, Conflitos e precedência, Contrato `InventorySnapshot`, Determinismo, Entradas revisadas do catálogo, Estado dos dados atuais, Estados de correspondência (+7 more)

### Community 89 - "release-manifest.ts"
Cohesion: 0.23
Nodes (16): validateAgentEnvelope(), validateAgentHeartbeatPayload(), BuildIdSchema, normalizedPath(), validateInventorySnapshot(), validateJob(), validateModCatalogEntry(), normalizedPath() (+8 more)

### Community 90 - "Configurações básicas e revisões da Fase 3"
Cohesion: 0.13
Nodes (14): Concorrência e consistência, Configurações básicas e revisões da Fase 3, Estados e erros, Fluxo de alteração, Fluxo de rollback, Formato inicial, Gate de saída, Manifesto da revisão (+6 more)

### Community 91 - "catalog-reconciliation.ts"
Cohesion: 0.15
Nodes (14): CatalogMatchState, CatalogMatchStateSchema, CatalogObservation, CatalogObservationSchema, CatalogReconciliationReport, isStrictlySortedUnique(), observationKey(), ReconciledArtifact (+6 more)

### Community 92 - "Console limitado da Fase 3"
Cohesion: 0.20
Nodes (9): Catálogo inicial de comandos, Console limitado da Fase 3, Gate de saída, Invariantes de segurança, Leitura do console, Matriz de testes validada, Objetivo do recorte, Semântica de despacho (+1 more)

### Community 93 - "controller.ts"
Cohesion: 0.11
Nodes (19): ProcessObservation, ActiveOperation, copyLaunchPlan(), ProcessControlAction, ProcessControlEvent, ProcessControlEventPhase, ProcessControlFailureCode, ProcessControlOutcome (+11 more)

### Community 94 - "Métricas limitadas da Fase 3"
Cohesion: 0.18
Nodes (10): Dados deliberadamente ausentes, Gate de saída, Implementação, Invariantes, Matriz de testes executada, Modelo de cada valor, Métricas do host, Métricas do processo gerenciado (+2 more)

### Community 95 - "Backup consistente e restore isolado da Fase 3"
Cohesion: 0.14
Nodes (13): Backup consistente e restore isolado da Fase 3, Decisão de consistência, Entradas confiáveis, Estados e erros, Fluxo de backup, Fluxo de restore isolado, Gate de saída, Implementação entregue (+5 more)

### Community 96 - "service.ts"
Cohesion: 0.06
Nodes (75): BackupManifest, BackupManifestDirectoryEntry, BackupManifestEntry, BackupManifestFileEntry, backupManifestSha256(), compareManifestPaths(), exactKeys(), invalidManifest() (+67 more)

### Community 97 - "server-backup/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 98 - "server-backup/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 99 - "server-configuration.test.ts"
Cohesion: 0.09
Nodes (17): NodeConfigurationFileReplacer, ApplyConfigurationPlan, ConfigurationConsistencyLease, ConfigurationFileReplacer, ConfigurationReplacementInput, OfflineExclusiveConfigurationGuard, CorruptingReplacer, createFixture() (+9 more)

### Community 100 - "server-configuration/src/validation.ts"
Cohesion: 0.24
Nodes (20): canonicalObject(), configurationRevisionManifestSha256(), exactKeys(), invalidManifest(), parseConfigurationRevisionManifest(), serializeConfigurationRevisionManifest(), validateManifestObject(), BasicConfigurationField (+12 more)

### Community 101 - "node-runtime.ts"
Cohesion: 0.09
Nodes (8): MinecraftConsoleCommand, BoundedByteBuffer, NodeProcessRuntimeOptions, NodeSpawnedProcess, ProcessExit, ProcessOutputSnapshot, SpawnedProcess, CommandTrackingHandle

### Community 102 - ".#mutate"
Cohesion: 0.31
Nodes (9): cleanPartial(), FilesystemConfigurationService, isWithin(), readBoundedPlainFile(), rejectLinkedPathComponents(), requirePlainDirectory(), sha256(), ConfigurationMutationReceipt (+1 more)

### Community 103 - "server-configuration/src/service.ts"
Cohesion: 0.13
Nodes (20): ConfigurationRevisionManifest, acquireLock(), cleanTemporary(), CommonMutationPlan, isNodeError(), MutationMaterial, normalizeComparablePath(), pathExists() (+12 more)

### Community 104 - "properties.ts"
Cohesion: 0.21
Nodes (14): decodeContent(), diffPropertiesDocuments(), invalidContent(), mutatePropertiesDocument(), ParsedPropertiesDocument, parsePropertiesDocument(), parseTypedValue(), PropertiesLine (+6 more)

### Community 105 - "server-configuration/package.json"
Cohesion: 0.14
Nodes (13): description, exports, files, dist, license, name, private, scripts (+5 more)

### Community 106 - "server-configuration/src/types.ts"
Cohesion: 0.23
Nodes (10): BooleanConfigurationField, ConfigurationFieldBase, ConfigurationOperationError, ConfigurationOperationErrorCode, ConfigurationOperationStage, EnumConfigurationField, ERROR_MESSAGES, IntegerConfigurationField (+2 more)

### Community 107 - "server-configuration/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 108 - "server-configuration/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 109 - "Q: Como o backup e o restore isolado da Fase 3 se conectam no grafo?"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: Como o backup e o restore isolado da Fase 3 se conectam no grafo?, Source Nodes

### Community 110 - "Q: Como o novo núcleo de configurações versionadas se conecta à arquitetura?"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: Como o novo núcleo de configurações versionadas se conecta à arquitetura?, Source Nodes

### Community 112 - "inventory-snapshot.ts"
Cohesion: 0.14
Nodes (13): InventoryEntry, InventoryEntrySchema, InventoryEntryState, InventoryEntryStateSchema, InventoryFileKind, InventoryFileKindSchema, InventoryRuntime, InventoryRuntimeSchema (+5 more)

### Community 113 - "export-schemas.ts"
Cohesion: 0.20
Nodes (9): AgentEnvelopeSchema, AuditEventSchema, CatalogReconciliationReportSchema, schemaDirectory, schemas, InventorySnapshotSchema, JobSchema, ModCatalogEntrySchema (+1 more)

### Community 114 - "contracts.test.ts"
Cohesion: 0.18
Nodes (4): canPublishInStable(), hashA, hashB, signature

### Community 115 - "audit-event.ts"
Cohesion: 0.20
Nodes (12): AuditEvent, findForbiddenKey(), forbiddenAuditKeys, normalizeKey(), validateAuditEvent(), JsonValue, addFormats, ajv (+4 more)

### Community 116 - "reconcile.ts"
Cohesion: 0.10
Nodes (27): addCatalogBlockers(), ArtifactAccumulator, buildArtifact(), compareOrdinal(), exactKeys(), formatIssues(), freezeDeep(), getAccumulator() (+19 more)

### Community 117 - "mod-catalog/package.json"
Cohesion: 0.12
Nodes (16): dependencies, @voidfall/contracts, description, exports, files, dist, @voidfall/contracts, license (+8 more)

### Community 118 - "mod-catalog/tsconfig.build.json"
Cohesion: 0.20
Nodes (9): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json (+1 more)

### Community 119 - "mod-catalog/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 120 - "launch-plan.ts"
Cohesion: 0.43
Nodes (6): assertPlainValue(), createMinecraftProcessPlan(), MinecraftProcessConfig, platformPath(), SupportedHostPlatform, validateProcessLaunchPlan()

### Community 121 - "Q: Quais contratos e limites existentes devem orientar o item 1 da Fase 4, inventário e catálogo reconciliado?"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: Quais contratos e limites existentes devem orientar o item 1 da Fase 4, inventário e catálogo reconciliado?, Source Nodes

## Knowledge Gaps
- **678 isolated node(s):** `version`, `modLoaders`, `manifestType`, `manifestVersion`, `name` (+673 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `SpawnedProcess` connect `node-runtime.ts` to `NeverExitingHandle`, `minecraft-process.test.ts`, `ManagedMinecraftProcessAdapter`, `adapter.ts`?**
  _High betweenness centrality (0.001) - this node is a cross-community bridge._
- **Why does `ProcessObservation` connect `controller.ts` to `minecraft-process.test.ts`, `node-runtime.ts`, `adapter.ts`, `MinecraftProcessController`?**
  _High betweenness centrality (0.001) - this node is a cross-community bridge._
- **Why does `CommandTrackingHandle` connect `node-runtime.ts` to `minecraft-process.test.ts`?**
  _High betweenness centrality (0.001) - this node is a cross-community bridge._
- **What connects `version`, `modLoaders`, `manifestType` to the rest of the system?**
  _678 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Contratos compartilhados` be split into smaller, more focused modules?**
  _Cohesion score 0.125 - nodes in this community are weakly interconnected._
- **Should `common.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.12698412698412698 - nodes in this community are weakly interconnected._
- **Should `Plataforma/package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.06451612903225806 - nodes in this community are weakly interconnected._