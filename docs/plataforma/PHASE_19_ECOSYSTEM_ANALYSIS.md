# Fases 19–20 — ecossistema de mods e análise estática

Status: quatro fatias verticais funcionais, mais contratos públicos, RBAC, produtor na Control API, captura guardada, reader NBT limitado e composição operacional no Server Agent para a ordem efetiva de datapacks. A prova real anterior permanece válida; as Fases 19 e 20 **não estão concluídas**.

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

### Segunda fatia: classes Java como evidência limitada

O analyzer `1.2.0` estende o leitor existente, sem criar um segundo pipeline. Ele seleciona somente classes cujo caminho aponta para configuração, registry, mixin, compatibilidade, integração ou plugin e interpreta o class file como dado. O JAR nunca é carregado, ligado ou executado.

Os limites são explícitos e fail-closed:

- no máximo 1 MiB por classe, 256 classes e 8 MiB expandidos por artefato;
- no máximo 64 MiB expandidos no snapshot completo;
- tetos independentes para constant pool, membros, atributos, instruções e fatos;
- nomes exatos passam pelo leitor ZIP limitado já revisado;
- classe inválida ou acima do limite vira issue informativa; não habilita inferência alternativa.

A inspeção extrai referências e chamadas de membros, anotações runtime, alvos de `@Mixin` e chamadas literais do builder `ForgeConfigSpec`. Classes são atribuídas ao mod apenas quando existe um único proprietário exato no inventário. Com isso, o snapshot pode provar `INTEGRATES_WITH`, `COMPATIBILITY`, `READS_REGISTRY_FROM` e `MODIFIES_GAMEPLAY_OF`, sempre com classe, método e offset rastreáveis.

### Terceira fatia: schemas revisados e conflitos de datapack

O analyzer `1.3.0` preserva o pipeline e acrescenta um registry fechado de schemas por `namespace + resourceType`. O primeiro adapter revisado é `mmorpg-gear-rarity@1.0.0`: ele aceita somente a forma exata observada nos oito resources instalados e nos oito defaults embutidos no JAR do Mine and Slash. São 46 escalares por resource, com tipo, editabilidade, identidade e nove pares `min/max` explícitos.

O parser recusa chave duplicada, campo ausente ou extra, objeto vazio desconhecido, array, tipo divergente, número não finito, identidade diferente do filename, range atual invertido e mudança duplicada. Identidades, referências e enums cujo domínio não foi provado permanecem somente leitura. Número sem limite declarado continua dizendo que não há limite de domínio comprovado.

Recursos com a mesma coordenada são persistidos como `DatapackConflict`. O snapshot real contém seis colisões e todas possuem conteúdo divergente: cinco no namespace `library_of_exile` e uma tabela de loot de `ancient_obelisks`, sempre entre `cte_mns` e `cte_configuration`. Como a ordem efetiva não foi provada, a resolução é `unknown-load-order` e a edição semântica é bloqueada para os participantes.

### Fronteira seguinte: evidência de ordem efetiva

O ADR-018 introduz um contrato estrito e uma projeção somente leitura, sem alterar o analyzer 1.3.0 nem sua chave de cache. Uma observação declara fonte versionada, hash exato do inventário, horário, hash da evidência e a pilha normalizada de baixa para alta prioridade. Cada item usa apenas `rootPath` relativo e SHA-256 do pack.

A projeção só identifica o recurso vencedor quando todos os participantes e hashes correspondem ao mesmo snapshot. Inventário antigo, participante ausente, pack alterado ou recurso ambíguo falha fechado. O resultado fixa `authorizesSemanticEditing: false`: `DatapackConflict.resolution` continua `unknown-load-order` e os controles continuam bloqueados.

O passo seguinte implementa `GuardedDatapackLoadOrderObserver`. Ele aceita somente um reader confiável injetado, chama esse reader dentro de uma janela `offline-exclusive-v1`, fixa a fonte `minecraft-world-metadata-v1`, cria o timestamp no host e deriva a projeção do `EcosystemAnalysis` exato. A fixture pública contém apenas root paths relativos e hashes fictícios. O reader NBT limitado descrito abaixo implementa essa porta sem path fornecido pelo usuário.

No Server Agent, `datapack-load-order.observe` é uma capability e um job type fechados. O handler relê o job persistido, exige instância/workspace/análise/inventário exatos e recusa parâmetros adicionais. A raiz vem exclusivamente da única workspace `server` ligada à `ServerInstance`; `RegisteredWorldMetadataFileReader` aceita somente essa raiz e abre o literal `world/level.dat`, com contenção por `realpath`, recusa de links, identidade entre entry e file handle e leitura limitada a 8 MiB. O lease não carrega root, mundo, filename ou bytes.

Durante a execução, a capability adquire `minecraft-exclusive` com a operação literal, e `createOfflineExclusiveDatapackLoadOrderGuard` verifica o processo antes e depois da captura. A migration `0028_datapack_load_order_agent_operation.sql` vincula o efeito ao `job_id` único: um replay retorna a observação já gravada sem reler o filesystem. O primeiro insert e o evento de auditoria sanitizado são uma única transação; a auditoria registra somente IDs, hashes e contagem, nunca bytes ou paths. Readiness só anuncia a capability quando workspace registrada, process adapter/guard e reader construído estão presentes.

Na Control API, `POST /api/v1/servers/:serverId/datapack-load-order/observations` exige CSRF e a permissão exclusiva `datapacks.observe`. O request público fixa `analysisId`, `expectedInventorySha256`, motivo e chave de idempotência; a API resolve a única workspace `server` vinculada, relê a análise imutável e deriva o identificador durável antes de enfileirar somente o comando fechado. Aceite, replay, vínculo ausente, análise ausente e inventário divergente são auditados sem paths. A migration `0029_datapack_load_order_control_api.sql` concede a permissão somente a owner/administrator e não concede a capability do agente.

### Reader NBT limitado e prova da prioridade nativa

O adaptador `BoundedNbtWorldMetadataDatapackLoadOrderReader` implementa a primeira fonte reservada pelo ADR-018 sem receber path. Uma porta de construção confiável entrega somente os bytes gzip; o parser calcula o SHA-256 da evidência comprimida e extrai exclusivamente `Data.DataPacks.Enabled` e `Disabled`. Os bytes, o nome do mundo e qualquer estado vizinho não atravessam a fronteira normalizada.

Os limites são fixos e não podem ser ampliados pelo chamador: 8 MiB comprimidos, 32 MiB descomprimidos, profundidade 64, 100.000 tags, 4.096 itens por lista, 1.048.576 itens por array e 16 KiB por string NBT. O parser suporta os 12 tipos NBT conhecidos apenas para saltar com segurança até o alvo; tipo desconhecido, truncamento, tamanho negativo, chave duplicada, UTF modificado inválido, campo alvo com tipo divergente ou bytes finais extras falham fechados.

A direção `lowest-priority-first` foi comprovada sobre os artefatos públicos exatos, não deduzida pelo nome dos packs:

1. o [servidor oficial Minecraft 1.20.1](https://piston-data.mojang.com/v1/objects/84194a2f286ef7c14ed7ce0090dba59902951553/server.jar), SHA-1 `84194a2f286ef7c14ed7ce0090dba59902951553`, e os [mapeamentos oficiais](https://piston-data.mojang.com/v1/objects/0b4dba049482496c507b2387a73a913230ebbd76/server.txt), SHA-1 `0b4dba049482496c507b2387a73a913230ebbd76`, fixam `Data` → `DataPacks` → listas `Enabled`/`Disabled` e a leitura gzip;
2. `MinecraftServer.configurePackRepository` copia `Enabled` para um `LinkedHashSet`; `PackRepository.setSelected`, `getSelectedIds` e `openAllSelected` conservam essa ordem;
3. `MultiPackResourceManager` empilha os packs nessa mesma ordem e `FallbackResourceManager.getResource` procura do último índice para o primeiro. Logo, o último ID persistido é o de maior prioridade. Isso também é consistente com a [documentação oficial do Forge](https://docs.minecraftforge.net/en/1.20.1/concepts/resources/), segundo a qual o pack no topo sobrescreve os inferiores;
4. o [OpenLoader 1.20.1 no commit `1a09605`](https://github.com/Darkhax-Minecraft/Open-Loader/blob/1a09605218a69808509680ad43cd3ff4a476c05a/common/src/main/java/net/darkhax/openloader/packs/OpenLoaderRepositorySource.java#L77-L80) registra cada candidato com ID `data/<nome do arquivo>` e posição `TOP`; o tipo `DATA` fixa o diretório `data` no [mesmo commit](https://github.com/Darkhax-Minecraft/Open-Loader/blob/1a09605218a69808509680ad43cd3ff4a476c05a/common/src/main/java/net/darkhax/openloader/packs/RepoType.java#L10).

O [source artifact público do Forge 1.20.1-47.4.4](https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.4/forge-1.20.1-47.4.4-sources.jar), SHA-256 `0979dda2dad68f66a63608942aebc3fcb3e643dcc0ead5f6c3cf211c7d03c83d`, foi conferido para a variante do servidor documentada. Seus patches adicionam fontes e packs de mods, mas não invertem a lista persistida. O reader mapeia somente IDs ativos `data/<nome>` para datapacks OpenLoader do mesmo `EcosystemAnalysis`; ID ativo fora do inventário, duplicidade ou ausência total de packs reconhecidos é recusado. Packs vanilla/mod permanecem fora do documento normalizado e sua remoção não altera a ordem relativa entre os packs analisados.

O corpus v1 é inteiramente sintético e gerado em memória. Ele cobre todos os tipos NBT padrão, gzip/hash, UTF modificado, listas vazias, budgets, profundidade, tipo desconhecido, chaves e IDs duplicados e pack ativo não inventariado. Os testes operacionais materializam esses bytes somente em diretórios temporários e comprovam path literal, limite, recusa de link, janela offline, auditoria sanitizada e replay sem nova leitura. Nenhum `level.dat`, mundo, jogador, path local ou conteúdo de terceiros foi versionado ou lido; portanto a prioridade do mundo privado atual ainda não foi observada.

## Configurações

Cada configuração normalizada guarda proprietário, nome, descrição disponível, categoria, sistema, tipo, valor atual, default comprovado ou `null`, limites, valores permitidos, arquivo, path, linha, parser, lado, necessidade de restart comprovada ou `null`, status, confiança e evidências.

O painel oferece toggle, select, número com limites e texto conforme o tipo. Listas e formas não comprovadas permanecem técnicas. Alterar um controle não escreve no servidor: o botão **Validar e preparar** passa pelo validador e cria somente um staging revisável.

Resources revisados entram no mesmo modelo `Configuration`, ligados a `System`, `DatapackResource`, arquivo e evidências. Defaults só vêm da mesma coordenada embutida no JAR depois de ela passar no mesmo schema. O browser não envia schema nem parser; a API resolve ambos no snapshot da revisão atual, recusa conflitos e confere novamente o SHA-256 antes de usar o staging existente.

Defaults e restart não são deduzidos do valor atual. O arquivo TOML real não declara defaults, mas o bytecode do `ForgeConfigSpec` agora comprova 69 valores padrão e 58 ranges do Mine and Slash. Os 14 defaults restantes continuam `null`: onze são montados dinamicamente em uma iteração e três pertencem a listas que o parser não reconstrói com segurança. A política de restart permanece desconhecida.

## Persistência e invalidação

A migration `0026_ecosystem_analysis.sql` cria `workspace_ecosystem_analyses`. O cache é imutável e único por:

```text
workspaceId + inventorySha256 + analyzerVersion
```

Abrir uma página apenas lê o snapshot. Uma análise é executada depois de um novo scan ou por ação explícita. Arquivo, mod, versão, configuração ou datapack alterado muda o hash do inventário; evolução das regras muda `analyzerVersion`. Ambos invalidam o cache sem sobrescrever o histórico anterior.

A migration `0027_datapack_load_order_observations.sql` cria `workspace_datapack_load_order_observations` fora desse cache. A chave imutável é `workspaceId + analysisId + observationId`; uma FK também exige o mesmo `inventorySha256` da análise. O repositório revalida a identidade content-addressed, carrega a análise persistida e recalcula a projeção no servidor antes do insert. Replay idêntico retorna o registro original; inventário obsoleto, análise ausente, documento inválido ou replay divergente falham fechados. Checks JSONB mantêm `authorizesSemanticEditing` no literal `false`.

A migration `0028_datapack_load_order_agent_operation.sql` acrescenta `job_id` opcional às observações históricas e único quando presente, além de alinhar as allowlists de grants e leases ao nome `datapack-load-order.observe`. `saveOperational` grava observação, projeção e sucesso auditado na mesma transação. O replay pelo mesmo job devolve o registro original e não duplica a auditoria.

A migration `0029_datapack_load_order_control_api.sql` adiciona somente a autoridade do painel `datapacks.observe`, com grants para owner/administrator. Permissões Minecraft e grants de capability permanecem domínios independentes.

## API e painel

Rotas adicionadas:

- `POST /api/v1/servers/:serverId/datapack-load-order/observations`;
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
| sistemas | 705 |
| configurações | 4.367 |
| datapacks | 6 |
| recursos de datapack | 5.445 |
| recursos com schema revisado | 8 |
| campos semânticos de datapack | 368 |
| conflitos de datapack | 6 |
| relações | 20.824 |
| issues explícitas | 123 |

### Mine and Slash 6.3.14

| Medida | Resultado |
| --- | ---: |
| configurações diretas | 83 |
| configurações normalizadas totais | 451 |
| controles diretos semanticamente editáveis | 80 |
| controles semânticos de datapack | 312 |
| controles semânticos totais | 392 |
| listas mantidas em visualização técnica | 3 |
| booleanos / inteiros / números / listas | 22 / 20 / 38 / 3 |
| campos com range declarado | 58 |
| campos com default comprovado | 69 |
| defaults comprovados totais | 437 |
| campos com descrição | 63 |
| sistemas funcionais | 15 |
| datapacks relacionados | 2 |
| recursos nesses datapacks | 4.896 |
| recursos diretamente relacionados ao mod | 4.112 |
| resources revisados / campos semânticos | 8 / 368 |
| relações funcionais | 35 |
| evidências de bytecode expostas no detalhe | 417 |
| issues diretas | 0 |

Os 15 sistemas encontrados são combate/sobrevivência, compatibilidade, gear/raridade, geral, itens, loot/drops, mapas/dungeons, mensagens/diagnóstico, mobs/entidades, party/times, progressão/níveis, skills/profissões, spells/mana, stats/atributos e worldgen.

As relações incluem oito dependências declaradas, extensões direcionais vindas de `mine_and_meals`, `mns_compat` e `void_mns_prof_compat`, integrações de recursos do próprio Mine and Slash com `library_of_exile`/Curios e os efeitos dos packs `cte_mns` e `cte_epicfight_mns_staff_compat`. A nova fonte comprova ainda quatro grupos `INTEGRATES_WITH`, três `READS_REGISTRY_FROM` e três `MODIFIES_GAMEPLAY_OF` ligados ao Mine and Slash. Exemplos reais incluem chamadas de `mmorpg` aos registries de `library_of_exile`, mixins de `void_mns_prof_compat` sobre classes do mod base e um mixin do Mine and Slash sobre `ancient_obelisks`. O add-on `mns_compat` mantém suas 52 configurações sob o proprietário correto; elas não são falsamente atribuídas ao mod base.

Os seis conflitos globais pertencem a resources de outros namespaces carregados pelos mesmos packs; por isso a aba do Mine and Slash mostra zero conflito diretamente ligado ao mod, enquanto a página global e os cards dos packs mostram as seis colisões sem contá-las duas vezes.

## Travessia limitada do grafo

O snapshot persistido agora possui uma projeção de leitura sob demanda em `GET /api/v1/workspaces/{workspaceId}/ecosystem/mods/{modId}/graph`. A raiz é sempre o `Mod` indicado pela rota e a consulta permite:

- direção `incoming`, `outgoing` ou `both`;
- profundidade de 1 a 3 saltos;
- filtro exato por tipo de relação e por tipo de entidade adjacente;
- inclusão explícita de relações estruturais, que ficam ocultas por padrão;
- limites configuráveis até o teto de 250 entidades e 500 relações.

A travessia é BFS, determinística e usa somente os IDs registrados no grafo do snapshot. Um tipo de relação exato pode selecionar uma relação estrutural mesmo quando a inclusão ampla de estrutura está desligada. Se uma aresta declarar um endpoint ausente do inventário, a API conserva a referência em `unresolvedReferences` e não fabrica um nó. Se um teto for alcançado, `truncated.entities` ou `truncated.relationships` torna a perda de cobertura explícita.

A aba **Grafo** consome apenas essa projeção limitada. Ela oferece filtros compactos, tabela de nós, arestas com proveniência expansível e avisos de truncamento ou referências ausentes; não reutiliza mais a lista funcional do detalhe nem envia as milhares de arestas `OWNS`, `DEFINED_IN`, `USES`, `PROVEN_BY` e `PARTICIPATES_IN` sem solicitação do operador.

## Validação técnica

- `npm run check` concluiu com código 0 em 820,1 segundos, cobrindo builds de packages, typecheck de todos os workspaces, testes Node, Forge Bridge, integrações e os cinco apps; o painel exportou 17 páginas;
- a terceira fatia passou com 4 casos do analyzer, 14 do staging, 27 casos direcionados da Workspace API, a persistência PGlite e os 60 casos do painel;
- o fluxo real foi inspecionado em Chrome nas páginas Mine and Slash → Configurações/Integrações/Datapacks e Datapacks global, sem erro originado pela aplicação;
- o drawer mostrou coordenada, arquivo, SHA-256, schema/hash, parser, campos atuais/defaults, editabilidade e evidências; o formulário escopado exibiu 46 campos do resource real e os ordenou por arquivo/chave;
- a aba Integrações abriu evidências reais de bytecode com JAR relativo, classe, método, offset, membro invocado e direção da relação;
- o ciclo `validar → staging → diff → descartar` alterou `weight` de 225 para 226 somente na cópia preparada, devolveu `appliedToWorkspace: false`, deixou zero estágios e preservou o SHA-256 original `e4792d9d…cb634b`;
- a viewport móvel de 390 × 844 foi validada sem overflow horizontal depois do ajuste responsivo;
- `git diff --check` não encontrou erro.

O recorte de travessia acrescentou três casos no pacote de ecossistema e cobertura end-to-end na Workspace API para direção, profundidade, filtro de tipos, referência ausente e recusa de limite inválido. O pacote passou com 7 testes, a Workspace API direcionada com 17 e o typecheck do painel concluiu sem erro.

A fronteira de ordem efetiva mantém 16 testes no pacote de ecossistema e seis casos operacionais no Server Agent. Além da projeção original, a regressão cobre reader chamado somente dentro da guarda, fonte/timestamp resolvidos pelo host, corpus NBT sintético, todos os tipos padrão, gzip/hash, modified UTF-8, budgets, profundidade, listas, tipos/chaves/IDs inválidos, mapeamento OpenLoader estrito, path literal, link, payload extensível, relógio anterior ao lease, replay por job e auditoria sem paths. Passaram 109 testes de contratos, 6 de permissões, 62 do banco, 180 da Control API e 115 do Server Agent, além de typecheck/build direcionados, sem ler o runtime privado.

## Relação com o Graphify

O snapshot normalizado é o grafo operacional persistido. `graphify-out/` continua sendo o grafo portátil do código e da documentação e passa a indexar este modelo, a migration, as rotas e esta prova. Dados privados do runtime não são copiados para `graphify-out/`.

Depois da atualização incremental deste recorte, o grafo portátil contém 6.897 nós, 12.094 arestas e 431 comunidades; a visão agregada também foi regenerada. A consulta focada encontrou `DatapackLoadOrderObservationAcceptance`, `registerDatapackLoadOrderRoutes`, `DatapackLoadOrderObservationCapability`, `createDatapackLoadOrderObservationHandler` e `DatapackLoadOrderRepository`; o caminho estrutural liga o produtor ao handler via composição da app e transporte do agente. O diagnóstico encontrou zero endpoint ausente, zero duplicata e manteve somente as duas autociclagens SQL `references` já documentadas.

Essa separação preserva as duas responsabilidades:

- Graphify: memória navegável e portátil da arquitetura do projeto;
- snapshot de ecossistema: memória versionada do servidor observado, vinculada ao hash do inventário.

## Trabalho restante

- interpretar formatos além de TOML/JSON e estruturas complexas com segurança;
- ampliar a interpretação conservadora de defaults dinâmicos e listas sem executar bytecode;
- extrair política de restart somente quando schema, documentação ou outra fonte concreta a comprovar;
- cobrir classes fora dos caminhos de alto sinal apenas por novas seleções revisadas, sem busca irrestrita;
- fechar um ensaio E2E sintético do produtor ao handler e, depois, expor somente status/leitura no painel; nenhum byte real de mundo foi lido e a ordem do servidor privado continua não observada;
- ampliar o registry revisado para `value_calc`, spells, stats e outras famílias somente depois de corpus, limites e defaults próprios;
- resolver as lacunas explícitas restantes do ecossistema completo e ampliar a validação para outros mods.

Portanto, esta entrega valida a arquitetura e conclui a terceira fatia vertical real. Ela não declara a análise automática universal concluída.
