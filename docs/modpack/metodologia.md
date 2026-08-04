# Metodologia e limites

## Fontes

- Manifesto e catálogo do launcher: `Launcher/pack/manifest.json` e `Launcher/catalog/addons.json`.
- Overrides públicos: `Launcher/pack/overrides/**`.
- Catálogos sanitizados do servidor: `Servidor/catalog/**`.
- Fixture versionada: `tools/modpack/fixtures/sanitized-artifact-inventory-v1.json`.
- Corpus de regressão: `tools/modpack/fixtures/contextual-compatibility-regressions.json`.

## Limite de execução

Esta regeneração não abre JARs nem acessa `Launcher/workspace` ou `Servidor/workspace`. A fixture preserva somente evidência sanitizada de uma extração anterior revisada: hashes, nomes de arquivo, `mod_id`, metadados de loader, dependências declaradas, contexto e presença de recursos.

## Confiança

- **Alta:** hash, manifesto do provedor, `mod_id`, versão e dependência declarados em metadado interno.
- **Média:** lado inferido pela presença nos conjuntos cliente/servidor e categorização apoiada por metadados.
- **Baixa:** impacto de performance, função sem descrição interna, risco comportamental ou versão online mais recente.

## Limites deliberados

- Mundos, logs, relatórios de crash, identidades, endereços, segredos e valores de configuração não foram exportados.
- `compatibilidade por nome/hash` não certifica protocolo, registries, datapacks ou gameplay.
- `versão mais recente` não foi tratada como `versão correta`; a matriz usa faixas declaradas e mantém atualização como revisão manual.
- Faixas seguem a sintaxe Maven usada pelo Forge. Sintaxe ambígua, operadores de outro ecossistema e versões ausentes resultam em `unknown`, nunca em compatibilidade presumida.
- Dependências são avaliadas somente no contexto, lado e branch de loader que as declarou. Um baseline Forge não é usado para satisfazer uma dependência NeoForge.
- Mods internos em `META-INF/jarjar/` são componentes próprios e preservam o artefato contêiner como evidência.
- A classificação de lado por presença é uma inferência. Mods de handshake opcional podem aparecer somente em um conjunto.
- A análise de performance é triagem sem benchmark.

## Referências oficiais verificadas

- [Forge 1.20.1 — downloads](https://files.minecraftforge.net/net/minecraftforge/forge/index_1.20.1.html) — recomendado 47.4.10, mais recente 47.4.22 em 2026-08-04.
- [Metadados `mods.toml`](https://docs.minecraftforge.net/en/1.20.x/gettingstarted/modfiles/).
- [Versionamento Forge e ranges Maven](https://docs.minecraftforge.net/en/1.20.1/gettingstarted/versioning/).
- [Requisitos de versão Maven](https://maven.apache.org/pom.html#dependency-version-requirement-specification).
- [Versionamento NeoForge](https://docs.neoforged.net/docs/gettingstarted/versioning/).
- [Formato de exportação CurseForge](https://support.curseforge.com/support/solutions/articles/9000197908-exporting-a-modpack-for-curseforge-project-submission).

## Regeração

```powershell
$python = Get-Content graphify-out/.graphify_python
& $python tools/modpack/generate_modpack_docs.py --root .
& $python -m unittest discover -s tools/modpack/tests -p "test_*.py"
& $python tools/modpack/validate_modpack_docs.py --root .
```

Análise gerada em: 2026-08-04.
