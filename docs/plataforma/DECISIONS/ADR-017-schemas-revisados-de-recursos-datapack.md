# ADR-017 — Schemas revisados para recursos de datapack

- Status: aceita
- Data: 2026-08-09
- Proprietário: `voidfall-product-owner`
- Supersedes: somente a exclusão operacional de packs OpenLoader no ADR-008; o schema `openloader_advanced_options_v1` e todos os seus limites permanecem inalterados

## Contexto

O ADR-008 separou corretamente o arquivo de configuração do OpenLoader dos packs heterogêneos que ele carrega. O ADR-016 criou o destino estrutural para esses packs: inventário, grafo, proveniência e painel. A primeira análise real encontrou 5.445 recursos em seis datapacks e mostrou que tratar todo JSON como configuração seria inseguro: há milhares de formatos, referências de registry, identidades, enums sem domínio comprovado e seis coordenadas fornecidas por mais de um pack.

Ao mesmo tempo, os oito recursos instalados em `data/mmorpg/mmorpg_gear_rarity/*.json` possuem exatamente a mesma forma de 46 escalares, e os oito defaults embutidos no JAR instalado do Mine and Slash 6.3.14 possuem a mesma forma. Esse conjunto é evidência suficiente para um primeiro adapter revisado, mas não para autorizar JSON genérico.

## Decisão

### 1. Um registry fechado estende a análise existente

Schemas de recurso vivem em um registry confiável do `@voidfall/ecosystem-analysis`, selecionado por `namespace + resourceType`. O fluxo continua único:

```text
inventário → análise → normalização → snapshot persistido → API → painel → staging existente
```

O browser nunca fornece schema, parser ou path arbitrário. A API resolve o arquivo no inventário atual e resolve o schema no snapshot persistido para o mesmo hash.

### 2. O primeiro schema é específico e versionado

| Propriedade | Valor |
| --- | --- |
| Schema ID | `mmorpg-gear-rarity` |
| Versão | `1.0.0` |
| Parser | `strict-json-object-v1` |
| Namespace | `mmorpg` |
| Resource type | `mmorpg_gear_rarity` |
| Limite por documento | 128 KiB |
| Forma revisada | 46 campos escalares exatos |

O hash do schema é derivado deterministicamente da identidade, limites, campos, tipos, editabilidade e pares ordenados. O adapter é o primeiro item do registry genérico; não existe condição por nome de pack, caminho privado ou `modId` no fluxo de autorização.

### 3. A forma é exata e fail-closed

O parser recusa JSON inválido, chave duplicada, array, valor não escalar, número não finito, chave ou objeto desconhecido — inclusive objeto vazio —, campo ausente, tipo divergente, documento acima do limite e `guid` diferente do nome do arquivo. Pares revisados `min/max` precisam estar ordenados tanto no documento atual quanto na proposta.

Mudanças duplicadas para a mesma chave são ambíguas e recusadas. Campos de identidade, referência ou domínio não comprovado permanecem somente leitura: `guid`, `higher_rar`, `item_model_data_num`, `lootable_gear_tier`, `min_map_rarity_to_drop`, `text_format` e `type`.

Um número sem limite declarado pelo mod continua sem limite de domínio inventado. O schema comprova forma e tipo; não transforma uma ausência de restrição em conhecimento.

### 4. Defaults exigem a mesma coordenada e o mesmo schema

Um valor padrão só é publicado quando a entrada embutida no JAR proprietário tem a mesma coordenada e também passa no schema exato. Falha, ausência ou divergência mantém `defaultValue: null`. O JAR é lido como ZIP limitado; nenhuma classe ou recurso é executado.

### 5. Colisões bloqueiam edição semântica

Recursos são agrupados pela coordenada `namespace:resourceType/resourcePath`. Mais de um provedor cria um `DatapackConflict`, classificado como conteúdo idêntico ou divergente por SHA-256. Enquanto a ordem efetiva de carregamento não for comprovada, a resolução é `unknown-load-order` e todos os recursos participantes ficam fora do editor semântico.

A análise persiste recursos, participantes, hashes e evidências. Não escolhe vencedor por ordem lexical, nome de pack ou opinião de IA.

### 6. Escrita continua sendo somente staging

O editor chama a validação do registry e reutiliza `@voidfall/configuration-staging`. Antes de preparar, a API confere novamente:

- arquivo presente no inventário atual;
- snapshot da mesma revisão;
- schema revisado resolvido pelo servidor;
- ausência de conflito;
- SHA-256 base ainda igual;
- todas as mudanças aceitas pelo schema.

O resultado é um diff em staging, auditado e descartável. Nenhum arquivo do workspace, mundo ou runtime é substituído; `apply`, restart implícito e comando de console não entram nesta decisão. Ler ou descartar uma cópia já preparada continua possível mesmo se uma análise posterior revogar o schema ou descobrir conflito.

## Consequências

- o ADR-008 continua sendo a autoridade exclusiva para `advanced_options.json`;
- novos resource types exigem adapter, versão, limites, corpus real, defaults comprovados e testes próprios;
- o snapshot operacional passa a representar `Configuration`, `DatapackResource`, `Conflict` e suas evidências, enquanto `graphify-out/` permanece a memória portátil do código/documentação;
- abrir páginas não reanalisa o servidor; mudança de inventário ou versão do analisador invalida o cache;
- UI amigável não remove arquivo, chave, parser, hash, status, confiança ou evidência;
- conteúdo não revisado continua visível tecnicamente e somente leitura.

## Prova real aceita

No servidor importado, o analyzer 1.3.0 persistiu oito resources revisados, 368 campos, 368 defaults e seis conflitos globais. Um teste operacional alterou `weight` de 225 para 226 apenas no staging, exibiu duas linhas de diff, retornou `appliedToWorkspace: false`, descartou o estágio e confirmou o mesmo SHA-256 no arquivo original antes e depois.

## Não autorização

Este ADR não autoriza JSON genérico, inferência de load order, edição de recurso conflitante, aplicação no workspace, restart, backup, console ao vivo, `artifact.install`, execução de JAR, cópia de dados privados para o repositório ou promoção automática de sugestão de IA.
