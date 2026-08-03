---
type: "query"
date: "2026-08-03T20:37:48.850581+00:00"
question: "Quais contratos e limites existentes devem orientar o item 1 da Fase 4, inventário e catálogo reconciliado?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["ReleaseManifestSchema", "ModCatalogEntrySchema", "validateModCatalogEntry", "canPublishInStable"]
---

# Q: Quais contratos e limites existentes devem orientar o item 1 da Fase 4, inventário e catálogo reconciliado?

## Answer

Expanded from original query via graph vocab: [catalog, inventory, mod, hash, license, manifest, release, schema, server, source, unknown, client]. ModCatalogEntrySchema já concentra identidade lógica, SHA-256, lado, origem, decisão de distribuição, revisão e dependências. ReleaseManifestSchema deriva artifactId do SHA-256 e exige paths canônicos. Os inventários sanitizados do launcher e servidor são evidência, não fonte automática de aprovação: o reconciliador deve identificar bytes por hash, manter o ID lógico separado, produzir sugestões e conflitos determinísticos e preservar unknown/licença pendente como bloqueios de stable, sem ler o runtime privado.

## Outcome

- Signal: useful

## Source Nodes

- ReleaseManifestSchema
- ModCatalogEntrySchema
- validateModCatalogEntry
- canPublishInStable