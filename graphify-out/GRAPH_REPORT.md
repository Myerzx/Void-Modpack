# Graph Report - .  (2026-08-02)

## Corpus Check
- Corpus is ~7,286 words - fits in a single context window. You may not need a graph.

## Summary
- 80 nodes · 62 edges · 19 communities (17 shown, 2 thin omitted)
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 5 edges (avg confidence: 0.93)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Graph Auto-Save System
- Portable Launcher Model
- CurseForge Manifest Structure
- Launcher Architecture Rules
- Release Audit Blockers
- Launcher Server Boundaries
- Agent Responsibilities
- Graphify Operations Workflow
- Asset Licensing
- Launcher Documentation

## God Nodes (most connected - your core abstractions)
1. `VoidFall Repository` - 5 edges
2. `Automatic Graph Persistence` - 5 edges
3. `Canonical CurseForge Pack Source` - 4 edges
4. `Blocked Modrinth Export` - 4 edges
5. `Gate de audit para alpha` - 4 edges
6. `minecraft` - 3 edges
7. `VoidFall Launcher Client Source` - 3 edges
8. `Provider-Resolved CurseForge Assets` - 3 edges
9. `Coordenador` - 3 edges
10. `Fonte canonica Launcher/pack` - 3 edges

## Surprising Connections (you probably didn't know these)
- `Graphify Knowledge Graph` --conceptually_related_to--> `VoidFall Repository`  [INFERRED]
  AGENTS.md → README.md
- `Client-Server Scope Isolation` --references--> `Reserved Server Scope`  [INFERRED]
  AGENTS.md → Servidor/README.md
- `Graphify Auto-Save Integration` --references--> `Automatic Graph Persistence`  [EXTRACTED]
  README.md → docs/graphify/README.md
- `Canonical Pack Directory` --references--> `Canonical CurseForge Pack Source`  [INFERRED]
  Launcher/README.md → Launcher/pack/README.md
- `Blocked Modrinth Export` --conceptually_related_to--> `Provider-Resolved CurseForge Assets`  [INFERRED]
  Launcher/platforms/modrinth/README.md → Launcher/pack/README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Gate de pre-release do launcher** — docs_launcher_readme_bloqueio_pre_release, docs_launcher_auditoria_gate_alpha, docs_launcher_releases_smoke_tests_obrigatorios [EXTRACTED 1.00]
- **Graph Auto-Save Layers** — docs_graphify_readme_file_change_watcher, docs_graphify_readme_git_graph_hooks, docs_graphify_readme_windows_logon_task [EXTRACTED 1.00]

## Communities (19 total, 2 thin omitted)

### Community 0 - "Graph Auto-Save System"
Cohesion: 0.14
Nodes (14): Graphify Knowledge Graph, Automatic Graph Persistence, File Change Watcher, Git Graph Hooks, Semantic Refresh Marker, Windows Logon Auto-Start Task, Evidence Documentation Boundary, Graphify Operations Documentation (+6 more)

### Community 1 - "Portable Launcher Model"
Cohesion: 0.18
Nodes (12): Canonical CurseForge Pack Source, Provider-Resolved CurseForge Assets, Reviewed Portable Overrides, Sanitized Manifest, Blocked Modrinth Export, Cross-Launcher mrpack Import Validation, Curated Addon Mapping, Valid mrpack Index (+4 more)

### Community 2 - "CurseForge Manifest Structure"
Cohesion: 0.18
Nodes (10): author, files, manifestType, manifestVersion, minecraft, modLoaders, version, name (+2 more)

### Community 3 - "Launcher Architecture Rules"
Cohesion: 0.20
Nodes (10): Fonte canonica Launcher/pack, Isolamento futuro do servidor, Perfil original imutavel, Pipeline do launcher, Distribuicao por project/file IDs, Gate de arquivos acima de 95 MB, Quarentena de CtE Resources, CurseForge como primeiro artefato (+2 more)

### Community 4 - "Release Audit Blockers"
Cohesion: 0.25
Nodes (8): Bloqueio de distribuicao de CtE Resources, Divergencia entre manifesto e runtime, Falha de registros na criacao de mundo, Gate de audit para alpha, Bloqueio de pre-release, Estagios de versionamento, Pipeline de release, Smoke tests obrigatorios

### Community 5 - "Launcher Server Boundaries"
Cohesion: 0.40
Nodes (5): Client-Server Scope Isolation, Launcher Release Gates, Reproducible Launcher-Independent Modpack, Explicit User Activation, Reserved Server Scope

### Community 6 - "Agent Responsibilities"
Cohesion: 0.50
Nodes (4): Agente de ativos/UI, Agente do launcher, Agente do servidor, Coordenador

### Community 7 - "Graphify Operations Workflow"
Cohesion: 0.67
Nodes (3): Agent Graph Query Workflow, Graphify All-Extras Installation, Portable Knowledge Graph Outputs

## Knowledge Gaps
- **36 isolated node(s):** `version`, `modLoaders`, `manifestType`, `manifestVersion`, `name` (+31 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What connects `version`, `modLoaders`, `manifestType` to the rest of the system?**
  _36 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Graph Auto-Save System` be split into smaller, more focused modules?**
  _Cohesion score 0.14285714285714285 - nodes in this community are weakly interconnected._
