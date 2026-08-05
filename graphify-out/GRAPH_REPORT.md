# Graph Report - void pasta  (2026-08-05)

## Corpus Check
- 409 files · ~638,259 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 3566 nodes · 5989 edges · 245 communities (218 shown, 27 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 61 edges (avg confidence: 0.69)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `37afa50c`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Handoff da plataforma
- Pacote CurseForge Canônico
- Modelo Manifesto CurseForge
- Platform Control Architecture
- Fonte canonica Launcher/pack
- Invariantes implementadas
- export_server_summary.py
- Gate de audit para alpha
- Documentação do servidor
- Automatic Graph Persistence
- Portable Knowledge Graph Outputs
- Licenciamento de ativos autorais
- Documentacao do launcher
- ADR-006 — Identidade VoidFall e início limitado da Fase 2
- audit-event.ts
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
- configuration-repositories.ts
- compilerOptions
- permissions/package.json
- compilerOptions
- permissions/src/index.ts
- authentication/tsconfig.test.json
- artifact-compatibility.ts
- permissions/tsconfig.test.json
- authentication/tsconfig.build.json
- permissions/tsconfig.build.json
- artifact-inspection/src/service.ts
- JobRepository
- control-api/src/app.ts
- worker.ts
- clean-workspace.mjs
- contracts/src/common.ts
- control-api/tsconfig.build.json
- AuditRepository
- compilerOptions
- build-worker/tsconfig.build.json
- configuration-operation.ts
- panel-web/package.json
- build-worker/package.json
- minecraft-process/package.json
- server-agent/tsconfig.test.json
- server-agent/tsconfig.build.json
- configuration-view.ts
- contracts/tsconfig.test.json
- server-backup/package.json
- compilerOptions
- page.tsx
- artifact-view.ts
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
- .requestBuild
- Inventário e catálogo reconciliado da Fase 4
- mod-catalog/src/types.ts
- authorized-files/package.json
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
- persistent-service.ts
- maven-version.ts
- document.ts
- server-configuration/package.json
- server-configuration/src/types.ts
- server-configuration/tsconfig.test.json
- server-configuration/tsconfig.build.json
- Q: Como o backup e o restore isolado da Fase 3 se conectam no grafo?
- Q: Como o novo núcleo de configurações versionadas se conecta à arquitetura?
- MinecraftProcessController
- configuration-schemas/package.json
- Contrato de execução da Fase 5 — build e launcher
- adapter.ts
- player-governance/src/types.ts
- classification.ts
- mod-catalog/package.json
- mod-catalog/tsconfig.build.json
- mod-catalog/tsconfig.test.json
- artifact-quarantine/src/service.ts
- Q: Quais contratos e limites existentes devem orientar o item 1 da Fase 4, inventário e catálogo reconciliado?
- artifact-quarantine/package.json
- mod-catalog.test.ts
- Q: Os contratos, o reconciliador, os testes e a documentação do item 1 da Fase 4 estão conectados no grafo?
- Conclusão da Fase 4 — catálogo, artefatos, arquivos e schemas
- artifact-quarantine/tsconfig.test.json
- artifact-quarantine/tsconfig.build.json
- authorized-files/src/service.ts
- authorized-files/tsconfig.build.json
- trusted-registry.ts
- configuration-schemas/tsconfig.build.json
- authorized-files/tsconfig.test.json
- configuration-schemas/tsconfig.test.json
- Q: Como concluir todos os itens restantes da Fase 4 sem romper a arquitetura e as fronteiras de seguranca existentes?
- ProcessOutputSnapshot
- generate_modpack_docs.py
- forge-bridge/package.json
- mod-compatibility.ts
- builder.ts
- modpack-release/package.json
- modpack-release/tsconfig.build.json
- launcher-api/tsconfig.test.json
- launcher-api/src/app.ts
- filesystem-repository.ts
- sanitization.ts
- modpack-release/src/types.ts
- modpack-release.test.ts
- launcher-protocol/tsconfig.build.json
- canonicalJsonBytes
- launcher-api/package.json
- launcher-protocol/package.json
- java-tools.mjs
- launcher-protocol/tsconfig.test.json
- launcher-api/tsconfig.build.json
- modpack-release/tsconfig.test.json
- Fase 6 — jogadores, privacidade e auditoria
- Q: Como concluir a Fase 5 inteira sem violar os gates de cliente, licença e publicação stable?
- configuration-routes.ts
- openloader-advanced-options.ts
- server-configuration.ts
- audit-chain/package.json
- audit-chain/tsconfig.test.json
- player-governance/tsconfig.build.json
- chain.ts
- audit-chain/tsconfig.build.json
- player-governance/package.json
- VoidFall — mapa técnico do modpack
- player-governance/tsconfig.test.json
- presentation.ts
- Q: Quais contratos e limites existentes devem orientar a Fase 6 completa de perfis UUID, permissoes, moderacao, privacidade e auditoria?
- Q: Como a Fase 6 completa separa identidade UUID, permissoes Minecraft, moderacao, privacidade e auditoria encadeada?
- validate_modpack_docs.py
- Q: How does Phase 7.0 contextual compatibility work?
- 0003_audit_chain.sql
- armazenamento.md
- automacao.md
- bibliotecas.md
- cliente.md
- combate.md
- magia.md
- mundo.md
- otimizacao.md
- outros.md
- progressao.md
- rede.md
- scripts.md
- servidor.md
- tecnologia.md
- modpack/README.md
- Q: antes de ir para fase 7 vamos executar essa auditoria do modpack
- Plano de implementação das fases finais
- Fase 10 — operações completas do servidor
- Protocolo de execução no terminal
- Gates transversais
- Fase 12 — release, launcher e Forge Bridge
- Fase 13 — produção, segurança e encerramento
- Fase 7 — configurações verificáveis
- Fase 8 — entrada adaptativa de mods e incompatibilidades
- Q: Aí faça uma documentação e salva como um planejamento para executar, porque agora eu vou começar a usar o terminal pra codar.
- Handoff de execução final para Claude
- reconcile.ts
- ADR-008 — OpenLoader como primeiro schema específico
- contextual-compatibility.ts
- server-configuration/src/service.ts
- dependency-analysis.ts
- registry.ts
- Fase 7.0 — compatibilidade contextual
- validateContract
- Q: Map Phase 7.0 compatibility analyzer architecture before implementation
- configuration-schemas/src/validation.ts
- Q: Does OpenLoader make sense as the first Phase 7.1 configuration schema?
- configuration-schemas/src/types.ts
- ConfigurationRepository
- Q: Como o Claude deve continuar da Fase 7.3 até a Fase 13 e executar todo o planejamento com segurança?
- artifact-inspection/package.json
- configuration-worker.test.ts
- Fase 7.2: persistência e operação de configuração
- Q: entendi, sobre isso algumas versao podem ser diferente, mas dentro do jogo funciona, entao nao fique muito preso nestá parte, vamos continuar
- ProcessObservation
- artifact-worker.ts
- server-agent/package.json
- artifact-review.ts
- agent-client.ts
- Fase 8.1: inspeção segura de artefato
- control-api/src/main.ts
- configuration-api.test.ts
- dependencies
- Fase 8.2: motor de compatibilidade
- buildControlApi
- Fase 7.3: API, agente e painel da configuração
- Fases 8.3 e 8.4: persistência, API, revisão e painel
- configuration-schemas.test.ts
- configuration-e2e.test.ts
- artifact-inspection/tsconfig.test.json
- artifact-inspection/tsconfig.build.json
- artifact-compatibility.test.ts
- Fase 9.1: contratos operacionais e persistência
- Primeira missão: Fase 7.3
- Validação
- Fase 9 — núcleo operacional e painel funcional mínimo
- NodeSpawnedProcess
- SessionRepository

## God Nodes (most connected - your core abstractions)
1. `validateContract()` - 50 edges
2. `semanticIssue()` - 46 edges
3. `appendSemanticIssues()` - 45 edges
4. `ManagedMinecraftProcessAdapter` - 24 edges
5. `build_docs()` - 22 edges
6. `ContractSchemaVersion` - 21 edges
7. `IsoDateTimeSchema` - 21 edges
8. `ContractValidationIssue` - 21 edges
9. `ContractValidationResult` - 21 edges
10. `immutable()` - 21 edges

## Surprising Connections (you probably didn't know these)
- `Management Platform Phase 1` --references--> `Platform Control Architecture`  [EXTRACTED]
  Plataforma/README.md → docs/plataforma/ARCHITECTURE.md
- `VoidFall Repository` --conceptually_related_to--> `ADR-005 Reviewed Canonical Client Catalog`  [INFERRED]
  README.md → docs/plataforma/DECISIONS/ADR-005-fonte-canonica-do-cliente.md
- `Dedicated Server Promotion Gate` --conceptually_related_to--> `ADR-005 Reviewed Canonical Client Catalog`  [INFERRED]
  Servidor/pack/README.md → docs/plataforma/DECISIONS/ADR-005-fonte-canonica-do-cliente.md
- `validateAgentHeartbeatPayload()` --calls--> `validateContract()`  [EXTRACTED]
  Plataforma/packages/contracts/src/agent-envelope.ts → Plataforma/packages/contracts/src/validation.ts
- `ProcessControlResult` --references--> `ProcessObservation`  [EXTRACTED]
  Plataforma/packages/minecraft-process/src/controller.ts → Plataforma/packages/minecraft-process/src/adapter.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Graph Auto-Save Layers** — docs_graphify_readme_file_change_watcher, docs_graphify_readme_git_graph_hooks, docs_graphify_readme_windows_logon_task [EXTRACTED 1.00]
- **Gate de pre-release do launcher** — docs_launcher_readme_bloqueio_pre_release, docs_launcher_auditoria_gate_alpha, docs_launcher_releases_smoke_tests_obrigatorios [EXTRACTED 1.00]
- **Platform Phase 1 Planning Artifacts** — plataforma_agents_phase_1_platform_governance, plataforma_readme_management_platform_phase_1, docs_plataforma_architecture_platform_control_architecture, docs_plataforma_changelog_phase_1_documentation_release [EXTRACTED 1.00]
- **Five Initial Platform Architecture Decisions** — docs_plataforma_decisions_adr_001_linguagens_e_limites_typescript_control_plane_java_forge_bridge, docs_plataforma_decisions_adr_002_comunicacao_com_agente_outbound_authenticated_agent, docs_plataforma_decisions_adr_003_manifesto_e_publicacao_signed_immutable_release_manifest, docs_plataforma_decisions_adr_004_persistencia_e_fila_postgresql_durable_job_queue, docs_plataforma_decisions_adr_005_fonte_canonica_do_cliente_reviewed_canonical_client_catalog [EXTRACTED 1.00]
- **Dedicated Server Publication Boundaries** — servidor_agents_server_agent_guide, servidor_pack_readme_dedicated_server_promotion_gate, servidor_source_readme_project_owned_source_gate [INFERRED 0.95]

## Communities (245 total, 27 thin omitted)

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

### Community 5 - "Invariantes implementadas"
Cohesion: 0.09
Nodes (21): `AgentEnvelope`, `AuditChainExportManifest`, `AuditEvent`, `CatalogReconciliationReport`, Compatibilidade, Contratos compartilhados, Invariantes implementadas, `InventorySnapshot` (+13 more)

### Community 6 - "export_server_summary.py"
Cohesion: 0.44
Nodes (8): bool_cell(), directory_size(), json_entry_count(), main(), Path, Build a sanitized JSON summary from the private server workspace. The script…, read_csv(), read_properties()

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

### Community 25 - "audit-event.ts"
Cohesion: 0.31
Nodes (8): AuditEvent, AuditEventSchema, findForbiddenKey(), forbiddenAuditKeys, normalizeKey(), validateAuditEvent(), JsonValue, ResourceRefSchema

### Community 26 - "Plataforma/package.json"
Cohesion: 0.06
Nodes (32): description, devDependencies, tsx, @types/node, typescript, engines, node, npm (+24 more)

### Community 27 - "compilerOptions"
Cohesion: 0.08
Nodes (24): compilerOptions, declaration, declarationMap, esModuleInterop, exactOptionalPropertyTypes, forceConsistentCasingInFileNames, lib, module (+16 more)

### Community 28 - "contracts/package.json"
Cohesion: 0.09
Nodes (22): ajv, ajv-formats, dependencies, ajv, ajv-formats, @sinclair/typebox, description, exports (+14 more)

### Community 29 - "database/package.json"
Cohesion: 0.06
Nodes (35): pg, dependencies, pg, @voidfall/audit-chain, @voidfall/authentication, @voidfall/configuration-schemas, @voidfall/contracts, @voidfall/permissions (+27 more)

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
Cohesion: 0.09
Nodes (14): ActiveSession, AgentRow, JobRow, mapServer(), mapUser(), PanelUser, PermissionRepository, RegisteredAgent (+6 more)

### Community 38 - "Database"
Cohesion: 0.11
Nodes (12): ConfigurationPersistenceError, Database, normalizeResult(), PostgresDatabase, SqlClient, SqlResult, MigrationRow, runMigrations() (+4 more)

### Community 39 - "0001_foundation.sql"
Cohesion: 0.17
Nodes (19): configuration_application_states, agent_nonces, agent_provision_tokens, agents, audit_events, job_events, jobs, panel_users (+11 more)

### Community 40 - "configuration-repositories.ts"
Cohesion: 0.11
Nodes (19): ACTOR_TYPES, actorRef(), CompletedConfigurationOperation, ConfigurationApplicationState, ConfigurationApplicationStatus, ConfigurationPersistenceErrorCode, LockRow, OperationalLockLease (+11 more)

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

### Community 46 - "artifact-compatibility.ts"
Cohesion: 0.06
Nodes (37): ArtifactCompatibilityContext, ArtifactCompatibilityContextKind, ArtifactCompatibilityContextKindSchema, ArtifactCompatibilityContextSchema, ArtifactCompatibilityPlan, ArtifactCompatibilityPlanSchema, ArtifactCompatibilityReport, CompatibilityArtifactEvaluation (+29 more)

### Community 47 - "permissions/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 48 - "authentication/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 49 - "permissions/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 50 - "artifact-inspection/src/service.ts"
Cohesion: 0.08
Nodes (45): boundedText(), declaredDependenciesFor(), declaredEmbeddedLibraries(), declaredModsFromFabric(), declaredModsFromToml(), decodeUtf8(), normalizedSide(), parseJarManifest() (+37 more)

### Community 52 - "control-api/src/app.ts"
Cohesion: 0.13
Nodes (13): AgentRegistrationBody, AgentRegistrationBodySchema, AgentTransportVerifier, ApiError, AuthContext, BuildControlApiOptions, defaultAgentTransportVerifier(), fastify (+5 more)

### Community 53 - "worker.ts"
Cohesion: 0.16
Nodes (12): controller, database, exactBuildPlanId(), IsolatedBuildExecutionResult, IsolatedBuildExecutor, ModpackBuildWorkerResult, NoopWorkerResult, runModpackBuildWorkerOnce() (+4 more)

### Community 54 - "clean-workspace.mjs"
Cohesion: 0.50
Nodes (3): buildInfoFile, outputDirectory, workspaceRoot

### Community 55 - "contracts/src/common.ts"
Cohesion: 0.06
Nodes (64): AgentEnvelope, AgentEnvelopeSchema, AgentHeartbeatPayload, AgentHeartbeatPayloadSchema, validateAgentEnvelope(), validateAgentHeartbeatPayload(), AuditChainExportManifest, AuditChainExportManifestSchema (+56 more)

### Community 57 - "control-api/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 58 - "AuditRepository"
Cohesion: 0.15
Nodes (5): AgentRepository, asIso(), AuditRepository, mapAgent(), parseJson()

### Community 59 - "compilerOptions"
Cohesion: 0.14
Nodes (13): compilerOptions, declaration, declarationMap, lib, skipLibCheck, sourceMap, extends, include (+5 more)

### Community 60 - "build-worker/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 61 - "configuration-operation.ts"
Cohesion: 0.12
Nodes (17): AGENT_CONFIGURATION_CAPABILITY, changesRecord(), ConfigurationCapabilityError, ConfigurationCapabilityErrorCode, ConfigurationOperationCapability, ConfigurationOperationCapabilityOptions, createConfigurationResultEnvelope(), PUBLISHABLE_FAILURE_CODES (+9 more)

### Community 62 - "panel-web/package.json"
Cohesion: 0.08
Nodes (24): lucide-react, next, description, devDependencies, lucide-react, next, react, react-dom (+16 more)

### Community 63 - "build-worker/package.json"
Cohesion: 0.08
Nodes (24): @electric-sql/pglite, dependencies, @voidfall/artifact-compatibility, @voidfall/artifact-inspection, @voidfall/contracts, @voidfall/database, description, devDependencies (+16 more)

### Community 64 - "minecraft-process/package.json"
Cohesion: 0.14
Nodes (13): description, exports, files, dist, license, name, private, scripts (+5 more)

### Community 65 - "server-agent/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 66 - "server-agent/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 67 - "configuration-view.ts"
Cohesion: 0.09
Nodes (29): ConfigurationPage(), PanelSession, ConfigurationAcceptanceView, ConfigurationApiError, ConfigurationApiFailure, ConfigurationApplyInput, ConfigurationClient, ConfigurationRollbackInput (+21 more)

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

### Community 72 - "artifact-view.ts"
Cohesion: 0.09
Nodes (36): install, ModsPage(), PanelSession, ArtifactAnalysisSummary, ArtifactListItemView, ArtifactListView, ArtifactSubmission, ArtifactSubmissionDetail (+28 more)

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
Cohesion: 0.15
Nodes (9): LinuxMinecraftProcessAdapter, WindowsMinecraftProcessAdapter, MINECRAFT_CONSOLE_COMMANDS, compileJavaFixture(), execFileAsync, fakeControllerPlan, fixtureSource, javaExecutable (+1 more)

### Community 84 - "metrics.ts"
Cohesion: 0.12
Nodes (23): ProcessControlEvent, available(), AvailableMetric, createMinecraftMetricsSnapshot(), HostMetricsSample, MetricQuality, MetricSource, MetricUnavailableReason (+15 more)

### Community 85 - "ManagedMinecraftProcessAdapter"
Cohesion: 0.30
Nodes (4): ManagedMinecraftProcessAdapter, MinecraftMetricsAdapter, MinecraftMetricsSnapshot, transitionObservedProcessState()

### Community 86 - ".requestBuild"
Cohesion: 0.06
Nodes (22): Override, AgentGateway, FunctionalInterface, BridgeCapabilities, BuildCommandResult, Status, ACCEPTED, DENIED (+14 more)

### Community 87 - "Inventário e catálogo reconciliado da Fase 4"
Cohesion: 0.12
Nodes (15): Algoritmo de reconciliação, Bloqueios iniciais, Conflitos e precedência, Contrato `InventorySnapshot`, Determinismo, Entradas revisadas do catálogo, Estado dos dados atuais, Estados de correspondência (+7 more)

### Community 88 - "mod-catalog/src/types.ts"
Cohesion: 0.11
Nodes (15): CatalogClassificationChanges, CatalogClassificationError, CatalogClassificationErrorCode, CatalogClassificationField, CatalogClassificationPlan, CatalogClassificationResult, CatalogClassificationRevision, CatalogDependencyAnalysisError (+7 more)

### Community 89 - "authorized-files/package.json"
Cohesion: 0.14
Nodes (13): description, exports, files, dist, license, name, private, scripts (+5 more)

### Community 90 - "Configurações básicas e revisões da Fase 3"
Cohesion: 0.13
Nodes (14): Concorrência e consistência, Configurações básicas e revisões da Fase 3, Estados e erros, Fluxo de alteração, Fluxo de rollback, Formato inicial, Gate de saída, Manifesto da revisão (+6 more)

### Community 91 - "catalog-reconciliation.ts"
Cohesion: 0.08
Nodes (29): CatalogMatchState, CatalogMatchStateSchema, CatalogObservation, CatalogObservationSchema, CatalogReconciliationReport, CatalogReconciliationReportSchema, isStrictlySortedUnique(), observationKey() (+21 more)

### Community 92 - "Console limitado da Fase 3"
Cohesion: 0.20
Nodes (9): Catálogo inicial de comandos, Console limitado da Fase 3, Gate de saída, Invariantes de segurança, Leitura do console, Matriz de testes validada, Objetivo do recorte, Semântica de despacho (+1 more)

### Community 93 - "controller.ts"
Cohesion: 0.10
Nodes (20): MinecraftProcessAdapter, ActiveOperation, copyLaunchPlan(), MinecraftProcessControllerOptions, ProcessControlAction, ProcessControlEventPhase, ProcessControlFailureCode, ProcessControlOutcome (+12 more)

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
Nodes (16): NodeConfigurationFileReplacer, ConfigurationConsistencyLease, ConfigurationFileReplacer, ConfigurationReplacementInput, OfflineExclusiveConfigurationGuard, CorruptingReplacer, createFixture(), digest() (+8 more)

### Community 100 - "server-configuration/src/validation.ts"
Cohesion: 0.19
Nodes (26): canonicalObject(), ConfigurationRevisionManifest, configurationRevisionManifestSha256(), exactKeys(), invalidManifest(), parseConfigurationRevisionManifest(), serializeConfigurationRevisionManifest(), validateManifestObject() (+18 more)

### Community 101 - "node-runtime.ts"
Cohesion: 0.10
Nodes (10): MinecraftConsoleCommand, ProcessLaunchPlan, BoundedByteBuffer, minimalEnvironment(), NodeProcessRuntime, NodeProcessRuntimeOptions, ProcessRuntime, SpawnedProcess (+2 more)

### Community 102 - "persistent-service.ts"
Cohesion: 0.16
Nodes (13): canonicalNow(), exactObject(), generatedUuid(), PersistedApplyConfigurationPlan, PersistedConfigurationMutationReceipt, PersistedRollbackConfigurationPlan, PersistentConfigurationService, PersistentConfigurationServiceError (+5 more)

### Community 103 - "maven-version.ts"
Cohesion: 0.20
Nodes (16): compareMavenVersions(), compareQualifiers(), compareTokens(), evaluateMavenVersionRange(), matchesRestriction(), MavenVersionRangeResult, nullToken(), paddedToken() (+8 more)

### Community 104 - "document.ts"
Cohesion: 0.15
Nodes (24): codecFailure(), ConfigurationDocumentMutation, diffConfigurationDocuments(), mutateConfigurationDocument(), openLoaderCodec(), ParsedConfigurationDocument, ParsedJavaPropertiesDocument, ParsedOpenLoaderDocument (+16 more)

### Community 105 - "server-configuration/package.json"
Cohesion: 0.10
Nodes (20): dependencies, @voidfall/configuration-schemas, @voidfall/contracts, @voidfall/database, description, exports, files, dist (+12 more)

### Community 106 - "server-configuration/src/types.ts"
Cohesion: 0.19
Nodes (12): basicField(), createReviewedConfigurationResource(), BasicConfigurationField, BooleanConfigurationField, ConfigurationFieldBase, ConfigurationOperationError, ConfigurationOperationErrorCode, ConfigurationOperationStage (+4 more)

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

### Community 112 - "configuration-schemas/package.json"
Cohesion: 0.14
Nodes (13): description, exports, files, dist, license, name, private, scripts (+5 more)

### Community 113 - "Contrato de execução da Fase 5 — build e launcher"
Cohesion: 0.12
Nodes (16): Arquitetura da entrega, Assinatura e identidade, Contrato de execução da Fase 5 — build e launcher, Fora de escopo, Forge Bridge, Gate de conclusão técnica, Gates, Gates de candidato (+8 more)

### Community 114 - "adapter.ts"
Cohesion: 0.13
Nodes (17): MinecraftConsoleAdapter, MinecraftProcessAdapterOptions, COMMAND_LITERALS, createMinecraftConsoleSnapshot(), minecraftConsoleCommandLiteral(), MinecraftConsoleCommandReceipt, MinecraftConsoleLine, MinecraftConsoleSnapshot (+9 more)

### Community 115 - "player-governance/src/types.ts"
Cohesion: 0.07
Nodes (49): MinecraftAlias, assertActor(), assertOptions(), assertReason(), assertUuid(), canonicalTimestamp(), canonicalValue(), compareOrdinal() (+41 more)

### Community 116 - "classification.ts"
Cohesion: 0.28
Nodes (14): canonicalClone(), canonicalJson(), canonicalSha256(), canonicalValue(), compareOrdinal(), freezeDeep(), CHANGE_FIELDS, classifyCatalogEntry() (+6 more)

### Community 117 - "mod-catalog/package.json"
Cohesion: 0.12
Nodes (16): dependencies, @voidfall/contracts, description, exports, files, dist, @voidfall/contracts, license (+8 more)

### Community 118 - "mod-catalog/tsconfig.build.json"
Cohesion: 0.20
Nodes (9): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json (+1 more)

### Community 119 - "mod-catalog/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 120 - "artifact-quarantine/src/service.ts"
Cohesion: 0.11
Nodes (28): ArtifactQuarantineService, canonicalJson(), canonicalTimestamp(), compareOrdinal(), createOrRequirePlainDirectory(), exactKeys(), exists(), freezeDeep() (+20 more)

### Community 121 - "Q: Quais contratos e limites existentes devem orientar o item 1 da Fase 4, inventário e catálogo reconciliado?"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: Quais contratos e limites existentes devem orientar o item 1 da Fase 4, inventário e catálogo reconciliado?, Source Nodes

### Community 122 - "artifact-quarantine/package.json"
Cohesion: 0.14
Nodes (13): description, exports, files, dist, license, name, private, scripts (+5 more)

### Community 123 - "mod-catalog.test.ts"
Cohesion: 0.12
Nodes (11): CatalogReconciliationError, CatalogReconciliationPlan, ContextualCompatibilityAnalysisError, comparePath(), compatibilityFixture, CompatibilityRegressionFixture, hashA, hashB (+3 more)

### Community 124 - "Q: Os contratos, o reconciliador, os testes e a documentação do item 1 da Fase 4 estão conectados no grafo?"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: Os contratos, o reconciliador, os testes e a documentação do item 1 da Fase 4 estão conectados no grafo?, Source Nodes

### Community 125 - "Conclusão da Fase 4 — catálogo, artefatos, arquivos e schemas"
Cohesion: 0.14
Nodes (13): 1. Classificação manual revisável, 2. Dependências, duplicatas e conflitos, 3. Quarentena de artefatos, 4. Arquivos em raízes autorizadas, 5. Schemas genéricos de configuração, Arquitetura do recorte, Conclusão da Fase 4 — catálogo, artefatos, arquivos e schemas, Gate de conclusão (+5 more)

### Community 126 - "artifact-quarantine/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 127 - "artifact-quarantine/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 128 - "authorized-files/src/service.ts"
Cohesion: 0.10
Nodes (40): AuthorizedFileService, canonicalJson(), canonicalTimestamp(), compareOrdinal(), decodeText(), exactKeys(), freezeDeep(), freezeExtensionList() (+32 more)

### Community 129 - "authorized-files/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 130 - "trusted-registry.ts"
Cohesion: 0.15
Nodes (9): OPENLOADER_ADVANCED_OPTIONS_MAXIMUM_BYTES, OPENLOADER_ADVANCED_OPTIONS_V1, OPENLOADER_ADVANCED_OPTIONS_CODEC_V1, TrustedConfigurationCodec, TrustedConfigurationCodecId, TrustedConfigurationRegistry, TrustedConfigurationRegistryErrorCode, GenericConfigurationSchema (+1 more)

### Community 131 - "configuration-schemas/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 132 - "authorized-files/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 133 - "configuration-schemas/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 134 - "Q: Como concluir todos os itens restantes da Fase 4 sem romper a arquitetura e as fronteiras de seguranca existentes?"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: Como concluir todos os itens restantes da Fase 4 sem romper a arquitetura e as fronteiras de seguranca existentes?, Source Nodes

### Community 136 - "generate_modpack_docs.py"
Cohesion: 0.09
Nodes (58): Any, analyze_components(), artifact_component_id(), bool_value(), build_components(), build_docs(), builtin_version(), category_for() (+50 more)

### Community 137 - "forge-bridge/package.json"
Cohesion: 0.20
Nodes (9): description, license, name, private, scripts, build, test, type (+1 more)

### Community 138 - "mod-compatibility.ts"
Cohesion: 0.09
Nodes (26): contextIssues(), duplicateValues(), ModCompatibilityAnalysisPlan, ModCompatibilityAnalysisPlanSchema, ModCompatibilityComponent, ModCompatibilityComponentEvaluation, ModCompatibilityComponentEvaluationSchema, ModCompatibilityComponentSchema (+18 more)

### Community 139 - "builder.ts"
Cohesion: 0.16
Nodes (26): cleanupWorkspace(), comparePaths(), FilesystemReleaseBuilder, isNodeError(), isWithin(), normalizedPath(), positiveInteger(), requirePlainDirectory() (+18 more)

### Community 140 - "modpack-release/package.json"
Cohesion: 0.12
Nodes (16): dependencies, @voidfall/contracts, description, exports, files, dist, @voidfall/contracts, license (+8 more)

### Community 141 - "modpack-release/tsconfig.build.json"
Cohesion: 0.20
Nodes (9): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json (+1 more)

### Community 142 - "launcher-api/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 143 - "launcher-api/src/app.ts"
Cohesion: 0.05
Nodes (36): ArtifactParams, ArtifactParamsSchema, buildLauncherApi(), BuildLauncherApiOptions, ChannelParams, ChannelParamsSchema, correlationId(), fastify (+28 more)

### Community 144 - "filesystem-repository.ts"
Cohesion: 0.14
Nodes (20): signLauncherChannel(), ChannelMutationTarget, FilesystemReleaseRepository, isNodeError(), isWithin(), pathExists(), readBoundedFile(), RepositoryLayout (+12 more)

### Community 145 - "sanitization.ts"
Cohesion: 0.27
Nodes (11): decodeUtf8(), normalizedKey(), SanitizedArtifact, sanitizeJson(), sanitizeProperties(), sanitizeReleaseArtifact(), SENSITIVE_KEYS, validateAllowedKeys() (+3 more)

### Community 146 - "modpack-release/src/types.ts"
Cohesion: 0.12
Nodes (15): CanonicalJsonObjectPolicy, ChannelMutationReceipt, DEFAULT_RELEASE_BUILD_LIMITS, ERROR_MESSAGES, ExactReviewedBytesPolicy, JavaPropertiesAllowlistPolicy, ReleaseBuildArtifact, ReleaseBuildErrorCode (+7 more)

### Community 147 - "modpack-release.test.ts"
Cohesion: 0.27
Nodes (8): sha256Bytes(), PublishReleaseInput, ReleaseRepository, CapturingRepository, catalogEntry(), plan(), publishExactRelease(), roots

### Community 148 - "launcher-protocol/tsconfig.build.json"
Cohesion: 0.20
Nodes (9): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json (+1 more)

### Community 149 - "canonicalJsonBytes"
Cohesion: 0.15
Nodes (16): canonicalize(), canonicalJson(), canonicalJsonBytes(), CanonicalJsonValue, launcherChannelPayload(), unsignedChannel(), UnsignedLauncherChannel, verifyLauncherChannelSignature() (+8 more)

### Community 150 - "launcher-api/package.json"
Cohesion: 0.07
Nodes (26): dependencies, fastify, @fastify/helmet, @fastify/rate-limit, @sinclair/typebox, @voidfall/contracts, @voidfall/launcher-protocol, @voidfall/modpack-release (+18 more)

### Community 151 - "launcher-protocol/package.json"
Cohesion: 0.11
Nodes (18): dependencies, @voidfall/contracts, @voidfall/modpack-release, description, exports, files, dist, @voidfall/contracts (+10 more)

### Community 152 - "java-tools.mjs"
Cohesion: 0.40
Nodes (7): output, cleanOutput(), compileJava(), integrationRoot, javaSources(), run(), output

### Community 153 - "launcher-protocol/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 154 - "launcher-api/tsconfig.build.json"
Cohesion: 0.20
Nodes (9): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json (+1 more)

### Community 155 - "modpack-release/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 156 - "Fase 6 — jogadores, privacidade e auditoria"
Cohesion: 0.13
Nodes (14): Binding de grupos, Cadeia e exportação de auditoria, Classificação e minimização, Componentes, Contratos e invariantes, Fase 6 — jogadores, privacidade e auditoria, Gate técnico de conclusão, Gates externos preservados (+6 more)

### Community 157 - "Q: Como concluir a Fase 5 inteira sem violar os gates de cliente, licença e publicação stable?"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: Como concluir a Fase 5 inteira sem violar os gates de cliente, licença e publicação stable?, Source Nodes

### Community 158 - "configuration-routes.ts"
Cohesion: 0.13
Nodes (15): ApplyBody, ApplyBodySchema, ConfigurationPermission, ConfigurationRouteDependencies, operationCorrelationId(), registerConfigurationRoutes(), ResourceParams, ResourceParamsSchema (+7 more)

### Community 159 - "openloader-advanced-options.ts"
Cohesion: 0.26
Nodes (10): hasExactKeys(), hasExpectedKeyOccurrences(), isRecord(), OPENLOADER_ADVANCED_OPTIONS_RESOURCE_ID, OPENLOADER_ADVANCED_OPTIONS_SCHEMA_ID, OPENLOADER_ADVANCED_OPTIONS_SCHEMA_VERSION, OpenLoaderAdvancedOptionsCodecErrorCode, OpenLoaderAdvancedOptionsValues (+2 more)

### Community 160 - "server-configuration.ts"
Cohesion: 0.04
Nodes (51): ArtifactSubmissionDetailSchema, ArtifactUploadAcceptanceSchema, schemaDirectory, schemas, ConfigurationApplicationStatusSchema, ConfigurationApplyModeSchema, ConfigurationApplyRequest, ConfigurationApplyRequestSchema (+43 more)

### Community 161 - "audit-chain/package.json"
Cohesion: 0.12
Nodes (16): dependencies, @voidfall/contracts, description, exports, files, dist, @voidfall/contracts, license (+8 more)

### Community 162 - "audit-chain/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 163 - "player-governance/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 164 - "chain.ts"
Cohesion: 0.14
Nodes (24): canonicalJson(), compareOrdinal(), freezeRecursive(), immutable(), sha256(), visit(), assertPartition(), assertSequence() (+16 more)

### Community 165 - "audit-chain/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 166 - "player-governance/package.json"
Cohesion: 0.12
Nodes (16): dependencies, @voidfall/contracts, description, exports, files, dist, @voidfall/contracts, license (+8 more)

### Community 167 - "VoidFall — mapa técnico do modpack"
Cohesion: 0.08
Nodes (23): Candidatos à remoção, Dependências ausentes, Incompatibilidades, Mods críticos, Navegação, Problemas encontrados, Quantidade por categoria, Quantidades (+15 more)

### Community 168 - "player-governance/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 169 - "presentation.ts"
Cohesion: 0.33
Nodes (12): changeIssue(), ConfigurationChangeSetEvaluation, describeReviewedConfiguration(), evaluateConfigurationChangeSet(), fieldDescriptor(), frozen(), isPublishableConfigurationField(), listReviewedConfigurationIds() (+4 more)

### Community 170 - "Q: Quais contratos e limites existentes devem orientar a Fase 6 completa de perfis UUID, permissoes, moderacao, privacidade e auditoria?"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: Quais contratos e limites existentes devem orientar a Fase 6 completa de perfis UUID, permissoes, moderacao, privacidade e auditoria?, Source Nodes

### Community 171 - "Q: Como a Fase 6 completa separa identidade UUID, permissoes Minecraft, moderacao, privacidade e auditoria encadeada?"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: Como a Fase 6 completa separa identidade UUID, permissoes Minecraft, moderacao, privacidade e auditoria encadeada?, Source Nodes

### Community 172 - "validate_modpack_docs.py"
Cohesion: 0.50
Nodes (4): load(), main(), Path, Validate the committed modpack knowledge base without private runtimes.

### Community 173 - "Q: How does Phase 7.0 contextual compatibility work?"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: How does Phase 7.0 contextual compatibility work?, Source Nodes

### Community 190 - "Q: antes de ir para fase 7 vamos executar essa auditoria do modpack"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: antes de ir para fase 7 vamos executar essa auditoria do modpack, Source Nodes

### Community 191 - "Plano de implementação das fases finais"
Cohesion: 0.25
Nodes (8): Como usar este plano, Definição de projeto concluído, Fase 11 — jogadores, permissões e moderação reais, Linha de base, Plano de implementação das fases finais, Primeira sequência recomendada, Saída esperada de cada sessão, Visão das fases finais

### Community 192 - "Fase 10 — operações completas do servidor"
Cohesion: 0.33
Nodes (6): 10.1 — processo e console, 10.2 — arquivos e configurações, 10.3 — backups e restore, 10.4 — métricas, logs e alertas, 10.5 — agendamentos, Fase 10 — operações completas do servidor

### Community 193 - "Protocolo de execução no terminal"
Cohesion: 0.33
Nodes (6): Baseline antes de uma fase, Ciclo de cada fatia, Comandos de validação por escopo, Divisão obrigatória de commits, Início de uma sessão, Protocolo de execução no terminal

### Community 194 - "Gates transversais"
Cohesion: 0.33
Nodes (6): Gate G1 — dados e privacidade, Gate G2 — efeitos externos, Gate G3 — runtime Minecraft, Gate G4 — distribuição, Gate G5 — qualidade, Gates transversais

### Community 195 - "Fase 12 — release, launcher e Forge Bridge"
Cohesion: 0.40
Nodes (5): 12.1 — catálogo e build de produção, 12.2 — assinatura, canais e launcher, 12.3 — Forge Bridge e `/atualizar-modpack`, 12.4 — certificação da release, Fase 12 — release, launcher e Forge Bridge

### Community 196 - "Fase 13 — produção, segurança e encerramento"
Cohesion: 0.40
Nodes (5): 13.1 — decisões finais obrigatórias, 13.2 — implantação, 13.3 — segurança e resiliência, 13.4 — aceite final, Fase 13 — produção, segurança e encerramento

### Community 197 - "Fase 7 — configurações verificáveis"
Cohesion: 0.40
Nodes (5): 7.0 — corrigir a base de compatibilidade usada pelo painel, 7.1 — registrar a decisão do primeiro schema, 7.2 — persistência e operação de configuração, 7.3 — API, agente e painel, Fase 7 — configurações verificáveis

### Community 198 - "Fase 8 — entrada adaptativa de mods e incompatibilidades"
Cohesion: 0.40
Nodes (5): 8.1 — inspeção segura de artefato, 8.2 — motor de compatibilidade, 8.3 — persistência, API e revisão, 8.4 — experiência do painel, Fase 8 — entrada adaptativa de mods e incompatibilidades

### Community 199 - "Q: Aí faça uma documentação e salva como um planejamento para executar, porque agora eu vou começar a usar o terminal pra codar."
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: Aí faça uma documentação e salva como um planejamento para executar, porque agora eu vou começar a usar o terminal pra codar., Source Nodes

### Community 200 - "Handoff de execução final para Claude"
Cohesion: 0.12
Nodes (16): Alteração local que não pertence ao planejamento, Atualização documental de cada recorte, Ciclo obrigatório de cada fatia, Decisões que exigem o proprietário, Distribuição e produção, Divisão de commits, Formato obrigatório do relatório de sessão, Fronteiras que nunca podem ser atravessadas silenciosamente (+8 more)

### Community 201 - "reconcile.ts"
Cohesion: 0.24
Nodes (16): addCatalogBlockers(), ArtifactAccumulator, buildArtifact(), compareOrdinal(), exactKeys(), formatIssues(), freezeDeep(), getAccumulator() (+8 more)

### Community 202 - "ADR-008 — OpenLoader como primeiro schema específico"
Cohesion: 0.18
Nodes (10): ADR-008 — OpenLoader como primeiro schema específico, Campos permitidos, Consequências, Contexto, Decisão, Fixtures e validação, Identidade congelada, Não autorização (+2 more)

### Community 203 - "contextual-compatibility.ts"
Cohesion: 0.28
Nodes (15): analyzeContextualCompatibility(), BUILTIN_DEPENDENCIES, builtinAvailable(), builtinVersion(), compareOrdinal(), dependencyApplies(), evidenceForOccurrences(), findingKey() (+7 more)

### Community 204 - "server-configuration/src/service.ts"
Cohesion: 0.15
Nodes (25): parseConfigurationDocument(), revisionPayloadFileName(), acquireLock(), cleanPartial(), cleanTemporary(), CommonMutationPlan, FilesystemConfigurationService, isNodeError() (+17 more)

### Community 205 - "dependency-analysis.ts"
Cohesion: 0.31
Nodes (14): analyzeCatalogDependencies(), compareIssue(), compareOrdinal(), exactKeys(), isRecord(), issueKey(), normalizedFilename(), sameRuntime() (+6 more)

### Community 206 - "registry.ts"
Cohesion: 0.24
Nodes (13): canonicalJson(), canonicalTimestamp(), cloneSchema(), compareOrdinal(), ConfigurationSchemaRegistry, exactKeys(), freezeEntry(), hashConfigurationSchema() (+5 more)

### Community 207 - "Fase 7.0 — compatibilidade contextual"
Cohesion: 0.29
Nodes (6): Contratos e semântica, Evidência e isolamento, Fase 7.0 — compatibilidade contextual, Gate e próximo recorte, Regressões congeladas, Resultado

### Community 208 - "validateContract"
Cohesion: 0.12
Nodes (33): ActorRefSchema, normalizedPath(), validateInventorySnapshot(), normalizedPath(), validateLauncherManagedState(), validateModerationCase(), categoryOrder, PlayerDataCategory (+25 more)

### Community 209 - "Q: Map Phase 7.0 compatibility analyzer architecture before implementation"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: Map Phase 7.0 compatibility analyzer architecture before implementation, Source Nodes

### Community 210 - "configuration-schemas/src/validation.ts"
Cohesion: 0.22
Nodes (18): ConfigurationValueIssue, ConfigurationValueValidationResult, GenericConfigurationField, GenericConfigurationFormat, baseValid(), compareOrdinal(), exactOrOptionalKeys(), fieldValueIssue() (+10 more)

### Community 211 - "Q: Does OpenLoader make sense as the first Phase 7.1 configuration schema?"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: Does OpenLoader make sense as the first Phase 7.1 configuration schema?, Source Nodes

### Community 212 - "configuration-schemas/src/types.ts"
Cohesion: 0.27
Nodes (10): ConfigurationSchemaOperationErrorCode, ConfigurationSchemaRevision, ConfigurationValueIssueCode, GenericBooleanField, GenericConfigurationFieldBase, GenericEnumField, GenericIntegerField, GenericNumberField (+2 more)

### Community 213 - "ConfigurationRepository"
Cohesion: 0.17
Nodes (17): VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY, appendAuditRecord(), asIso(), canonicalTimestamp(), ConfigurationRepository, identifier(), mapLock(), mapResource() (+9 more)

### Community 214 - "Q: Como o Claude deve continuar da Fase 7.3 até a Fase 13 e executar todo o planejamento com segurança?"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: Como o Claude deve continuar da Fase 7.3 até a Fase 13 e executar todo o planejamento com segurança?, Source Nodes

### Community 215 - "artifact-inspection/package.json"
Cohesion: 0.14
Nodes (13): description, exports, files, dist, license, name, private, scripts (+5 more)

### Community 216 - "configuration-worker.test.ts"
Cohesion: 0.15
Nodes (9): ConfigurationOperationExecutor, ConfigurationWorkerResult, exactCommand(), matchesJobType(), runConfigurationWorkerOnce(), databases, HASH_A, HASH_B (+1 more)

### Community 217 - "Fase 7.2: persistência e operação de configuração"
Cohesion: 0.22
Nodes (8): Coordenação isolada, Fase 7.2: persistência e operação de configuração, Limites mantidos, Persistência PostgreSQL, Próximo recorte, Registro confiável, Resultado, Validação

### Community 218 - "Q: entendi, sobre isso algumas versao podem ser diferente, mas dentro do jogo funciona, entao nao fique muito preso nestá parte, vamos continuar"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: entendi, sobre isso algumas versao podem ser diferente, mas dentro do jogo funciona, entao nao fique muito preso nestá parte, vamos continuar, Source Nodes

### Community 219 - "ProcessObservation"
Cohesion: 0.54
Nodes (3): ProcessObservation, FakeMinecraftProcessAdapter, waitForState()

### Community 220 - "artifact-worker.ts"
Cohesion: 0.16
Nodes (8): ArtifactJobParameters, ArtifactWorkerResult, CompatibilityPlanFactory, exactParameters(), failureFor(), QuarantinedArtifactReader, runArtifactWorkerOnce(), WORKER_ID

### Community 221 - "server-agent/package.json"
Cohesion: 0.08
Nodes (23): dependencies, @voidfall/authentication, @voidfall/contracts, @voidfall/database, @voidfall/server-configuration, description, devDependencies, @voidfall/configuration-schemas (+15 more)

### Community 222 - "artifact-review.ts"
Cohesion: 0.04
Nodes (46): ArtifactCompatibilityReportSchema, ReviewedSideSchema, ArtifactInspectionReportContract, ArtifactInspectionReportSchema, DeclaredDependencyContract, DeclaredDependencySchema, DeclaredLoaderContract, DeclaredLoaderSchema (+38 more)

### Community 224 - "agent-client.ts"
Cohesion: 0.21
Nodes (6): AgentFetch, AgentHttpResponse, AgentIdentity, createHeartbeatEnvelope(), HeartbeatInput, VoidFallAgentClient

### Community 225 - "Fase 8.1: inspeção segura de artefato"
Cohesion: 0.18
Nodes (11): Contrato público, Declaração, não avaliação, Descritores lidos, Fase 8.1: inspeção segura de artefato, Fixtures, Limites, Limites mantidos, Recusas (+3 more)

### Community 226 - "control-api/src/main.ts"
Cohesion: 0.31
Nodes (6): database, ControlApiConfig, parseBoolean(), readControlApiConfig(), config, database

### Community 227 - "configuration-api.test.ts"
Cohesion: 0.36
Nodes (6): applyPayload(), digest(), fixture(), NOW, openLoaderDocument(), resources

### Community 228 - "dependencies"
Cohesion: 0.05
Nodes (38): @fastify/cookie, dependencies, fastify, @fastify/cookie, @fastify/helmet, @fastify/rate-limit, @sinclair/typebox, @voidfall/authentication (+30 more)

### Community 229 - "Fase 8.2: motor de compatibilidade"
Cohesion: 0.18
Nodes (11): Contextos, Códigos, `detail` sanitizado, Dois eixos independentes, Evidência fechada, Fase 8.2: motor de compatibilidade, Julgamentos que o motor recusa fazer, Limites mantidos (+3 more)

### Community 230 - "buildControlApi"
Cohesion: 0.22
Nodes (8): anonymizeIp(), auditEvent(), buildControlApi(), clearSessionCookie(), requestCorrelationId(), setSessionCookie(), fixture(), resources

### Community 231 - "Fase 7.3: API, agente e painel da configuração"
Cohesion: 0.15
Nodes (13): Contratos públicos, Control API, Critério de conclusão da Fase 7, Fase 7.3: API, agente e painel da configuração, Job durável, Leitura tipada e redação, Limites mantidos, Painel (+5 more)

### Community 232 - "Fases 8.3 e 8.4: persistência, API, revisão e painel"
Cohesion: 0.15
Nodes (13): Correção trazida da Fase 8.1, Critério de conclusão da Fase 8, Fases 8.3 e 8.4: persistência, API, revisão e painel, Jobs duráveis, Limites mantidos, Máquina de estados, Painel, Permissões (+5 more)

### Community 233 - "configuration-schemas.test.ts"
Cohesion: 0.14
Nodes (6): OPENLOADER_ADVANCED_OPTIONS_FILE_PATH, OPENLOADER_ADVANCED_OPTIONS_POLICY_V1, OpenLoaderAdvancedOptionsCodecError, serializeOpenLoaderAdvancedOptions(), TrustedConfigurationRegistryError, ConfigurationSchemaOperationError

### Community 234 - "configuration-e2e.test.ts"
Cohesion: 0.31
Nodes (7): digest(), NOW, OfflineGuard, openLoaderDocument(), stack(), teardown, screenStateForError()

### Community 235 - "artifact-inspection/tsconfig.test.json"
Cohesion: 0.20
Nodes (9): compilerOptions, declaration, declarationMap, sourceMap, extends, include, src/**/*.ts, test/**/*.ts (+1 more)

### Community 236 - "artifact-inspection/tsconfig.build.json"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, outDir, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 237 - "artifact-compatibility.test.ts"
Cohesion: 0.27
Nodes (9): candidate(), clientContext, dependency(), inspection(), issuesOf(), mod(), onlyIssue(), plan() (+1 more)

### Community 238 - "Fase 9.1: contratos operacionais e persistência"
Cohesion: 0.15
Nodes (12): Correlação, Dois defeitos encontrados pelo gate, Estado observado e PID, Exclusão mútua, Fase 9.1: contratos operacionais e persistência, Idempotência, Limites mantidos, Outbox sem dual write (+4 more)

### Community 239 - "Primeira missão: Fase 7.3"
Cohesion: 0.29
Nodes (7): 1. Contratos públicos de configuração, 2. Orquestração durável e autorização, 3. Control API, 4. Server Agent, 5. Painel, 6. E2E e gate da Fase 7, Primeira missão: Fase 7.3

### Community 241 - "Validação"
Cohesion: 0.40
Nodes (5): Baseline no início de uma fase, Gate de CI, Validadores de repositório, Validação, Workspaces iniciais da Fase 7.3

### Community 242 - "Fase 9 — núcleo operacional e painel funcional mínimo"
Cohesion: 0.50
Nodes (4): 9.1 — contratos operacionais e persistência, 9.2 — transporte real Control API ↔ Server Agent, 9.3 — painel dinâmico, Fase 9 — núcleo operacional e painel funcional mínimo

## Knowledge Gaps
- **1486 isolated node(s):** `Como usar este plano`, `Linha de base`, `Definição de projeto concluído`, `Visão das fases finais`, `Gate G1 — dados e privacidade` (+1481 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **27 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Work-memory lessons

**Preferred sources** — corroborated by past sessions; start here.
- `FilesystemConfigurationService` (3× useful, score=2.899811433)
- `ConfigurationRepository` (2× useful, score=1.978914401)
- `OperationalLockRepository` (2× useful, score=1.978914401)
- `PersistentConfigurationService` (2× useful, score=1.978914401)
- `Handoff da plataforma` (2× useful, score=1.974198835)
- `ConfigurationRevisionManifest` (2× useful, score=1.93325516)
- `RollbackConfigurationPlan` (2× useful, score=1.93325516)
- `CatalogReconciliationReportSchema` (2× useful, score=1.932819842)
- `mod-catalog.test.ts` (2× useful, score=1.932819842)
- `ModCatalogEntrySchema` (2× useful, score=1.932608512)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `IDENTIFIER` connect `authorized-files/src/service.ts` to `server-configuration/src/validation.ts`, `registry.ts`, `configuration-schemas/src/validation.ts`, `player-governance/src/types.ts`, `ConfigurationRepository`, `artifact-quarantine/src/service.ts`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Why does `MinecraftAlias` connect `player-governance/src/types.ts` to `contracts/src/common.ts`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **Why does `validateIdentifier()` connect `server-configuration/src/validation.ts` to `authorized-files/src/service.ts`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **What connects `Como usar este plano`, `Linha de base`, `Definição de projeto concluído` to the rest of the system?**
  _1486 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Invariantes implementadas` be split into smaller, more focused modules?**
  _Cohesion score 0.09090909090909091 - nodes in this community are weakly interconnected._
- **Should `Plataforma/package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.06060606060606061 - nodes in this community are weakly interconnected._
- **Should `compilerOptions` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._