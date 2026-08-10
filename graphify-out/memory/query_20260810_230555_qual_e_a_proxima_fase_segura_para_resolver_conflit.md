---
type: "query"
date: "2026-08-10T23:05:55.810416+00:00"
question: "Qual e a proxima fase segura para resolver conflitos de datapack?"
contributor: "graphify"
source_nodes: ["ReviewedDatapackSchema", "TrustedDatapackSchemaRegistry", "EcosystemAnalysisService", "AnalyzedDatapackConflict"]
---

# Q: Qual e a proxima fase segura para resolver conflitos de datapack?

## Answer

Expanded from original query via vocab: [phase, datapack, load, order, corpus, schema, reviewed, registry, conflict, resolution, openloader, evidence]. O cache do EcosystemAnalysis depende apenas de inventorySha256 e analyzerVersion, portanto uma ordem externa nao pode ser incorporada ao snapshot sem identidade propria. A primeira fatia segura e um contrato estrito de observacao vinculado ao hash do inventario e dos packs, aplicado como projecao read-only com authorizesSemanticEditing false. Nao inferir ordem por nome ou diretorio e nao ler o runtime privado nesta fatia.

## Source Nodes

- ReviewedDatapackSchema
- TrustedDatapackSchemaRegistry
- EcosystemAnalysisService
- AnalyzedDatapackConflict