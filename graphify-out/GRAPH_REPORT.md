# Graph Report - void pasta  (2026-08-03)

## Corpus Check
- 43 files · ~12,271 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 147 nodes · 130 edges · 31 communities (27 shown, 4 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 5 edges (avg confidence: 0.93)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `6e772232`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Automatic Graph Persistence
- Canonical CurseForge Pack Source
- manifest.json
- Fonte canonica Launcher/pack
- Gate de audit para alpha
- Client-Server Scope Isolation
- Coordenador
- Portable Knowledge Graph Outputs
- Licenciamento de ativos autorais
- Documentacao do launcher
- servidor/README.md
- export_server_summary.py
- Ciclo operacional recomendado
- Auditoria do servidor
- Compatibilidade do cliente
- Releases do servidor
- Segurança do servidor
- Server agent guide
- pack/README.md
- source/README.md

## God Nodes (most connected - your core abstractions)
1. `main()` - 6 edges
2. `Sistemas customizados` - 6 edges
3. `Auditoria do servidor` - 5 edges
4. `VoidFall Repository` - 5 edges
5. `Automatic Graph Persistence` - 5 edges
6. `Arquitetura do servidor` - 4 edges
7. `Compatibilidade do cliente` - 4 edges
8. `Operação do servidor` - 4 edges
9. `Ciclo operacional recomendado` - 4 edges
10. `Releases do servidor` - 4 edges

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

## Communities (31 total, 4 thin omitted)

### Community 0 - "Automatic Graph Persistence"
Cohesion: 0.14
Nodes (14): Graphify Knowledge Graph, Automatic Graph Persistence, File Change Watcher, Git Graph Hooks, Semantic Refresh Marker, Windows Logon Auto-Start Task, Evidence Documentation Boundary, Graphify Operations Documentation (+6 more)

### Community 1 - "Canonical CurseForge Pack Source"
Cohesion: 0.18
Nodes (12): Canonical CurseForge Pack Source, Provider-Resolved CurseForge Assets, Reviewed Portable Overrides, Sanitized Manifest, Blocked Modrinth Export, Cross-Launcher mrpack Import Validation, Curated Addon Mapping, Valid mrpack Index (+4 more)

### Community 2 - "manifest.json"
Cohesion: 0.18
Nodes (10): author, files, manifestType, manifestVersion, minecraft, modLoaders, version, name (+2 more)

### Community 3 - "Fonte canonica Launcher/pack"
Cohesion: 0.20
Nodes (10): Fonte canonica Launcher/pack, Isolamento futuro do servidor, Perfil original imutavel, Pipeline do launcher, Distribuicao por project/file IDs, Gate de arquivos acima de 95 MB, Quarentena de CtE Resources, CurseForge como primeiro artefato (+2 more)

### Community 4 - "Gate de audit para alpha"
Cohesion: 0.25
Nodes (8): Bloqueio de distribuicao de CtE Resources, Divergencia entre manifesto e runtime, Falha de registros na criacao de mundo, Gate de audit para alpha, Bloqueio de pre-release, Estagios de versionamento, Pipeline de release, Smoke tests obrigatorios

### Community 5 - "Client-Server Scope Isolation"
Cohesion: 0.40
Nodes (5): Client-Server Scope Isolation, Launcher Release Gates, Reproducible Launcher-Independent Modpack, Explicit User Activation, Reserved Server Scope

### Community 6 - "Coordenador"
Cohesion: 0.50
Nodes (4): Agente de ativos/UI, Agente do launcher, Agente do servidor, Coordenador

### Community 7 - "Portable Knowledge Graph Outputs"
Cohesion: 0.67
Nodes (3): Agent Graph Query Workflow, Graphify All-Extras Installation, Portable Knowledge Graph Outputs

### Community 19 - "servidor/README.md"
Cohesion: 0.12
Nodes (13): Arquitetura canônica do repositório, Arquitetura do servidor, Camadas observadas, Limites de responsabilidade, Documentação do servidor, Leitura recomendada, Perfil auditado, Facções e economia (+5 more)

### Community 20 - "export_server_summary.py"
Cohesion: 0.44
Nodes (8): Path, bool_cell(), directory_size(), json_entry_count(), main(), Build a sanitized JSON summary from the private server workspace. The script…, read_csv(), read_properties()

### Community 21 - "Ciclo operacional recomendado"
Cohesion: 0.25
Nodes (7): Backup e restauração, Ciclo operacional recomendado, Evidência atual, Inicialização, Operação do servidor, Parada, Requisitos conhecidos

### Community 22 - "Auditoria do servidor"
Cohesion: 0.33
Nodes (5): Auditoria do servidor, Evidências, O que não foi publicado, Resultado executivo, Riscos priorizados

### Community 23 - "Compatibilidade do cliente"
Cohesion: 0.40
Nodes (4): Caminho para compatibilidade, Comparação por nome exato de JAR, Compatibilidade do cliente, Conclusão

### Community 24 - "Releases do servidor"
Cohesion: 0.40
Nodes (4): Artefatos previstos, Gates obrigatórios, Releases do servidor, Versionamento

### Community 25 - "Segurança do servidor"
Cohesion: 0.40
Nodes (4): Baseline antes de publicar, Estado encontrado, Segurança do servidor, Verificação

### Community 26 - "Server agent guide"
Cohesion: 0.50
Nodes (3): Rules, Scope, Server agent guide

## Knowledge Gaps
- **68 isolated node(s):** `version`, `modLoaders`, `manifestType`, `manifestVersion`, `name` (+63 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What connects `version`, `modLoaders`, `manifestType` to the rest of the system?**
  _68 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Automatic Graph Persistence` be split into smaller, more focused modules?**
  _Cohesion score 0.14285714285714285 - nodes in this community are weakly interconnected._
- **Should `servidor/README.md` be split into smaller, more focused modules?**
  _Cohesion score 0.125 - nodes in this community are weakly interconnected._