# Metodologia e limites

## Fontes

- Manifesto e catálogo do launcher: `Launcher/pack/manifest.json` e `Launcher/catalog/addons.json`.
- Overrides públicos: `Launcher/pack/overrides/**`.
- Catálogos sanitizados do servidor: `Servidor/catalog/**`.
- Forense explícita e somente-leitura: metadados de loader nos diretórios ignorados `mods/` do launcher, servidor e cliente privado de referência.

## O que foi lido nos JARs

Somente estrutura ZIP, `META-INF/mods.toml`, `META-INF/neoforge.mods.toml`, `fabric.mod.json`, `mcmod.info`, `META-INF/MANIFEST.MF`, nomes de mixins e presença de access transformers, `data/` e `assets/`. Nenhuma classe foi carregada, executada ou descompilada.

## Confiança

- **Alta:** hash, manifesto do provedor, `mod_id`, versão e dependência declarados em metadado interno.
- **Média:** lado inferido pela presença nos conjuntos cliente/servidor e categorização apoiada por metadados.
- **Baixa:** impacto de performance, função sem descrição interna, risco comportamental ou versão online mais recente.

## Limites deliberados

- Mundos, logs, relatórios de crash, identidades, endereços, segredos e valores de configuração não foram exportados.
- `compatibilidade por nome/hash` não certifica protocolo, registries, datapacks ou gameplay.
- `versão mais recente` não foi tratada como `versão correta`; a matriz usa faixas declaradas e mantém atualização como revisão manual.
- A classificação de lado por presença é uma inferência. Mods de handshake opcional podem aparecer somente em um conjunto.
- A análise de performance é triagem sem benchmark.

## Referências oficiais verificadas

- [Forge 1.20.1 — downloads](https://files.minecraftforge.net/net/minecraftforge/forge/index_1.20.1.html) — recomendado 47.4.10, mais recente 47.4.22 em 2026-08-04.
- [Metadados `mods.toml`](https://docs.minecraftforge.net/en/1.20.x/gettingstarted/modfiles/).
- [Formato de exportação CurseForge](https://support.curseforge.com/support/solutions/articles/9000197908-exporting-a-modpack-for-curseforge-project-submission).

## Regeração

```powershell
$python = Get-Content graphify-out/.graphify_python
& $python tools/modpack/generate_modpack_docs.py --root .
& $python tools/modpack/validate_modpack_docs.py --root .
```

Análise gerada em: 2026-08-04.
