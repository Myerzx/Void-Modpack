# Fases 19–20 — primeira fatia vertical do ecossistema de mods

Status: primeira fatia vertical funcional e validada no servidor real em 2026-08-09. As Fases 19 e 20 **não estão concluídas**.

## Objetivo entregue

A cadeia abaixo existe de ponta a ponta e não depende de dados simulados:

```text
Servidor registrado
  → inventário imutável
  → análise semântica limitada
  → snapshot normalizado por hash
  → entidades, arestas e evidências
  → Control API
  → Mods / Datapacks no painel
```

O primeiro caso real é Mine and Slash, cujo `modId` instalado é `mmorpg`. Não há condição especial para esse ID no analisador. Classificação, ownership, parsing e relações são produzidos pelas mesmas regras aplicadas aos demais mods.

## O que foi reaproveitado

| Capacidade anterior | Uso nesta fatia |
| --- | --- |
| `@voidfall/workspace-inventory` | caminhos relativos, SHA-256, metadata dos JARs, candidatos de configuração e conteúdo OpenLoader |
| `@voidfall/artifact-inspection` | índice estrutural de entradas ZIP/JAR sem extração nem execução |
| `@voidfall/configuration-inference` | TOML/JSON, comentários Forge, ranges, allowed values e tipos seguros |
| staging de configuração | validação, diff e preparação sem escrever no workspace importado |
| workspaces persistidos | raiz autorizada no host e snapshot integral do inventário |
| ADR-016 | entidade, aresta e proveniência obrigatória, com GraphQL mantido separado |

`@voidfall/mod-adapters` não foi duplicado nem usado como segunda fonte. Seu adaptador histórico do Mine and Slash permanece isolado; o novo fluxo é genérico e parte do `modId` real declarado no JAR.

## Lacunas corrigidas antes da análise

- `config/openloader/data/**` agora é datapack e `config/openloader/resources/**` é recurso, não arquivo de configuração;
- `world/serverconfig/*-server.toml` encontra o proprietário por aliases derivados da metadata, incluindo `mine_and_slash` → `mmorpg`;
- dependências declaradas pelo artefato passam do inventário para a análise sem novo parse concorrente;
- tabelas TOML com segmentos entre aspas, como `[general."Default Feature Configs"]`, são lidas pelo parser existente;
- uma configuração Forge parcialmente representada continua bloqueada; depois da correção do construct real, o arquivo do Mine and Slash passou a completo sem relaxar a guarda.

## Modelo normalizado

O pacote `@voidfall/ecosystem-analysis` produz as entidades `Server`, `Mod`, `ModVersion`, `System`, `Configuration`, `ConfigFile`, `Datapack`, `DatapackResource`, `Registry`, `Resource` e `Evidence`.

As relações estruturais são `OWNS`, `DEFINED_IN`, `USES` e `PROVEN_BY`. As relações funcionais disponíveis são `REQUIRES`, `OPTIONAL_DEPENDENCY`, `LOADS_AFTER`, `CONFIGURES`, `INTEGRATES_WITH`, `COMPATIBILITY`, `READS_REGISTRY_FROM`, `EXTENDS`, `OVERRIDES`, `DATAPACK_EXTENDS` e `MODIFIES_GAMEPLAY_OF`.

Uma relação só é criada quando uma fonte concreta a sustenta. Nesta fatia:

- metadata do artefato prova dependências e sua direção;
- `data/<namespace>/...` dentro de um JAR prova que o artefato de origem estende ou sobrescreve o namespace de outro mod instalado;
- caminho igual no JAR proprietário prova `OVERRIDES`;
- namespace conhecido sem caminho base igual prova `DATAPACK_EXTENDS`;
- cada evidência guarda fonte, caminho relativo, hash quando disponível, detalhe, status e confiança.

Nome de arquivo, semelhança textual e opinião de IA não criam relações.

## Configurações

Cada configuração normalizada guarda proprietário, nome, descrição disponível, categoria, sistema, tipo, valor atual, default comprovado ou `null`, limites, valores permitidos, arquivo, path, linha, parser, lado, necessidade de restart comprovada ou `null`, status, confiança e evidências.

O painel oferece toggle, select, número com limites e texto conforme o tipo. Listas e formas não comprovadas permanecem técnicas. Alterar um controle não escreve no servidor: o botão **Validar e preparar** passa pelo validador e cria somente um staging revisável.

Defaults e restart não são deduzidos do valor atual. No arquivo real do Mine and Slash não existe declaração de default; por isso esses campos permanecem desconhecidos.

## Persistência e invalidação

A migration `0026_ecosystem_analysis.sql` cria `workspace_ecosystem_analyses`. O cache é imutável e único por:

```text
workspaceId + inventorySha256 + analyzerVersion
```

Abrir uma página apenas lê o snapshot. Uma análise é executada depois de um novo scan ou por ação explícita. Arquivo, mod, versão, configuração ou datapack alterado muda o hash do inventário; evolução das regras muda `analyzerVersion`. Ambos invalidam o cache sem sobrescrever o histórico anterior.

## API e painel

Rotas adicionadas:

- `GET|POST /api/v1/workspaces/:workspaceId/analysis`;
- `GET /api/v1/workspaces/:workspaceId/ecosystem/mods`;
- `GET /api/v1/workspaces/:workspaceId/ecosystem/mods/:modId`;
- `GET /api/v1/workspaces/:workspaceId/ecosystem/mods/:modId/datapack-resources`;
- `GET /api/v1/workspaces/:workspaceId/ecosystem/datapacks`.

O painel tem sidebar apenas com as nove categorias de produto e navegação horizontal por área. A revisão de artefatos anterior foi preservada em **Mods → Compatibilidade**. A área de mods instalados oferece busca, filtros, contagens, estado da análise e páginas de mod com Geral, Configurações, Sistemas, Integrações, Datapacks, Arquivos e Grafo.

## Prova no servidor real

A validação foi somente leitura sobre o workspace privado; nenhum arquivo de runtime foi alterado ou copiado para o repositório.

### Ecossistema completo observado

| Medida | Resultado |
| --- | ---: |
| arquivos inventariados | 7.928 |
| mods declarados no inventário | 176 |
| mods normalizados | 175 |
| sistemas | 304 |
| configurações | 3.999 |
| datapacks | 6 |
| recursos de datapack | 5.445 |
| relações | 19.347 |
| issues explícitas | 110 |

### Mine and Slash 6.3.14

| Medida | Resultado |
| --- | ---: |
| configurações diretas | 83 |
| controles semanticamente editáveis | 80 |
| listas mantidas em visualização técnica | 3 |
| booleanos / inteiros / números / listas | 22 / 20 / 38 / 3 |
| campos com range declarado | 58 |
| campos com descrição | 63 |
| sistemas funcionais | 15 |
| datapacks relacionados | 2 |
| recursos nesses datapacks | 4.896 |
| relações funcionais | 25 |
| issues diretas | 0 |

Os 15 sistemas encontrados são combate/sobrevivência, compatibilidade, gear/raridade, geral, itens, loot/drops, mapas/dungeons, mensagens/diagnóstico, mobs/entidades, party/times, progressão/níveis, skills/profissões, spells/mana, stats/atributos e worldgen.

As relações incluem oito dependências declaradas, extensões direcionais vindas de `mine_and_meals`, `mns_compat` e `void_mns_prof_compat`, integrações de recursos do próprio Mine and Slash com `library_of_exile`/Curios e os efeitos dos packs `cte_mns` e `cte_epicfight_mns_staff_compat`. O add-on `mns_compat` mantém suas 52 configurações sob o proprietário correto; elas não são falsamente atribuídas ao mod base.

## Validação técnica

- `npm run check` concluiu com código 0 em 438 segundos: build dos pacotes, typecheck de todos os workspaces, todos os testes, Forge Bridge, integrações e builds dos apps/painel;
- os recortes diretamente alterados passaram com 19 casos de inventário, 16 de inferência, 2 de análise do ecossistema, 59 de banco, 17 de Workspace API e 60 do painel;
- o fluxo real foi inspecionado em Chrome nas páginas Mods, Mine and Slash → Configurações/Integrações/Datapacks e Datapacks global;
- o drawer mostrou arquivo, chave, linha, parser, restrições e evidências; a página real exibiu as 83 configurações, 83 ações de origem e 80 controles semânticos, mantendo três listas em leitura técnica;
- a viewport móvel de 390 × 844 foi validada sem overflow horizontal depois do ajuste responsivo;
- `git diff --check` não encontrou erro.

## Relação com o Graphify

O snapshot normalizado é o grafo operacional persistido. `graphify-out/` continua sendo o grafo portátil do código e da documentação e passa a indexar este modelo, a migration, as rotas e esta prova. Dados privados do runtime não são copiados para `graphify-out/`.

Depois da atualização incremental, o grafo portátil contém 6.499 nós e 11.352 arestas; a visão agregada de comunidades também foi regenerada.

Essa separação preserva as duas responsabilidades:

- Graphify: memória navegável e portátil da arquitetura do projeto;
- snapshot de ecossistema: memória versionada do servidor observado, vinculada ao hash do inventário.

## Trabalho restante

- interpretar formatos além de TOML/JSON e estruturas complexas com segurança;
- extrair defaults e política de restart somente quando bytecode, schema ou comentário os comprovarem;
- analisar classes, mixins, registries e chamadas Java sem executar o JAR;
- modelar conflitos semânticos e compatibilidade que não aparecem por metadata ou namespace;
- expor travessia e filtros completos do grafo sem enviar milhares de arestas estruturais a uma página;
- tornar recursos de datapack semanticamente editáveis apenas após schemas/revisões próprios;
- resolver as 110 lacunas explícitas do ecossistema completo e ampliar a validação para outros mods.

Portanto, esta entrega valida a arquitetura e conclui a primeira fatia vertical real. Ela não declara a análise automática universal concluída.
