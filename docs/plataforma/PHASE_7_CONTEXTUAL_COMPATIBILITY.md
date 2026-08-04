# Fase 7.0 — compatibilidade contextual

Status: concluída em 2026-08-04, em tooling e contratos isolados; [matriz Windows/Linux 30936868796](https://github.com/Myerzx/Void-Modpack/actions/runs/30936868796) aprovada.

## Resultado

O analisador agora conserva cada ocorrência por contexto, lado, loader e contêiner. Dependências são avaliadas somente no branch de metadata e no lado aplicável; bibliotecas em `META-INF/jarjar/` são componentes próprios. O relatório distingue `compatible`, `incompatible` e `unknown` e nunca converte falta de evidência em compatibilidade.

A regeneração determinística de `docs/modpack/` documenta 299 componentes, 298 artefatos e 1.363 declarações de dependência contextualizadas:

- 4 componentes incompatíveis por conflito entre launcher e servidor;
- 32 componentes compatíveis com a evidência disponível;
- 263 componentes desconhecidos, que continuam bloqueados para promoção automática;
- nenhuma dependência obrigatória ausente nos contextos ativos;
- dependências ausentes somente em referência/histórico permanecem findings informativos ou de aviso.

## Regressões congeladas

| Componente | Resultado 7.0 | Interpretação |
| --- | --- | --- |
| Armourer’s Workshop | `incompatible` | conflito canônico de versão |
| Epic Fight | `incompatible` | conflito canônico de versão |
| OpenLoader | `incompatible` | conflito canônico de versão |
| WOM | `incompatible` | conflito canônico de versão; ranges de Epic Fight são avaliados no próprio contexto |
| KillCam | `unknown` | divergência entre servidor e cliente privado de referência, sem conflito launcher-servidor comprovado |
| Preloading Tricks | `unknown` | componente Fabric somente no cliente de referência |

`cumulus_menus` e `nitrogen_internals` permanecem bibliotecas JarJar separadas do Aether. O loader deriva do metadata da ocorrência, não da união dos loaders do JAR externo.

## Contratos e semântica

`ModCompatibilityAnalysisPlan` e `ModCompatibilityReport` são contratos v1 estritos. O plano exige os contextos canônicos, identifica ocorrências e associa dependências ao metadata que as declarou. O relatório emite códigos estáveis para conflito canônico, divergência de referência/histórico, loader, ausência e range incompatível/desconhecido.

Ranges usam a sintaxe Maven adotada pelo Forge. Intervalos abertos/fechados, união, versão exata, qualifiers e builds do corpus são avaliados; operadores de outro ecossistema, formas malformadas e valores sem baseline retornam `unknown`. Um requisito recomendado Maven sem colchetes só é confirmado quando coincide exatamente. As referências normativas são [metadata Forge](https://docs.minecraftforge.net/en/1.20.x/gettingstarted/modfiles/), [versionamento Forge](https://docs.minecraftforge.net/en/1.20.1/gettingstarted/versioning/), [requisitos de versão Maven](https://maven.apache.org/pom.html#dependency-version-requirement-specification) e [versionamento NeoForge](https://docs.neoforged.net/docs/gettingstarted/versioning/).

## Evidência e isolamento

- entrada integral: `tools/modpack/fixtures/sanitized-artifact-inventory-v1.json`;
- corpus mínimo: `tools/modpack/fixtures/contextual-compatibility-regressions.json`;
- gerador: `tools/modpack/generate_modpack_docs.py`;
- validador: `tools/modpack/validate_modpack_docs.py`;
- testes compartilhados em TypeScript e Python.

Nenhum comando da Fase 7.0 leu ou modificou `Launcher/workspace` ou `Servidor/workspace`. A data da análise vem da fixture, eliminando dependência do relógio para a saída.

## Gate e próximo recorte

O gate cobre schema, semântica, determinismo, os seis casos nomeados, JarJar, lado, branch de loader, ranges e proteção contra baseline NeoForge fabricado. Isso não certifica gameplay, conexão nem redistribuição.

O próximo recorte é a Fase 7.1: registrar um ADR que escolha explicitamente o primeiro schema. Nenhum candidato foi selecionado por esta implementação.
