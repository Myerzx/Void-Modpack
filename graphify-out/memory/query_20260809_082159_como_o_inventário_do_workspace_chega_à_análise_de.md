---
type: "architecture"
date: "2026-08-09T08:21:59.185015+00:00"
question: "Como o inventário do workspace chega à análise de ecossistema persistida e às páginas de Mods e Datapacks?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["EcosystemAnalysisService", "workspace_ecosystem_analyses", "listEcosystemMods", "ModsPage"]
---

# Q: Como o inventário do workspace chega à análise de ecossistema persistida e às páginas de Mods e Datapacks?

## Answer

WorkspaceInventoryService produz um inventário por hash; EcosystemAnalysisService 1.1.0 normaliza configurações, sistemas, datapacks, recursos, relações e evidências; workspace_ecosystem_analyses guarda snapshots imutáveis por workspace, hash e versão; a Control API lê ou gera o snapshot explicitamente; ecosystem-client alimenta ModsPage, detalhe do mod e DatapacksPage sem reanalisar ao abrir.

## Outcome

- Signal: useful

## Source Nodes

- EcosystemAnalysisService
- workspace_ecosystem_analyses
- listEcosystemMods
- ModsPage