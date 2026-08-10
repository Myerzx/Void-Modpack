---
type: "query"
date: "2026-08-10T23:27:21.986474+00:00"
question: "pode continuar"
contributor: "graphify"
outcome: "useful"
source_nodes: ["DatapackLoadOrderObservation", "DatapackLoadOrderProjection", "GuardedDatapackLoadOrderObserver", "OfflineGuardOptions", "DatapackLoadOrderRepository"]
---

# Q: pode continuar

## Answer

Expanded from original query via graph vocab: [datapack, order, observation, adapter, trusted, offline, guard, persistence, repository, migration, projection, inventory]. O proximo recorte reutiliza a guarda offline-exclusive-v1 do Server Agent e separa a observacao da cache do analyzer. GuardedDatapackLoadOrderObserver captura somente de um reader confiavel injetado e gera projecao sem autorizar edicao. A migration 0027 e DatapackLoadOrderRepository vinculam workspace, analysisId, inventorySha256 e observationId, recalculam a projecao do snapshot armazenado e recusam replay divergente. O reader NBT nativo, capability, API e UI permanecem ausentes.

## Outcome

- Signal: useful

## Source Nodes

- DatapackLoadOrderObservation
- DatapackLoadOrderProjection
- GuardedDatapackLoadOrderObserver
- OfflineGuardOptions
- DatapackLoadOrderRepository