# ADR-016 — O painel é o gerenciador completo do servidor

Status: aceito em 2026-08-08.

## Contexto

O [ADR-014](ADR-014-objetivo-central-e-replanejamento.md) definiu o caminho principal como inventário → configuração → sandbox → release. Isso era **ordem de construção**, e vinha sendo lido como **fronteira do produto**.

O proprietário confirmou que não é. O objetivo final é um painel central de gerenciamento, operação, configuração e análise de todo o servidor — do qual o modpack é uma parte, não o todo.

Uma auditoria contra o código, as migrações e os ADRs mostrou três situações distintas, e confundi-las seria o pior resultado deste documento:

**Construído e sem tela.** Processo, console, backups, restauração, telemetria, agendamentos, arquivos autorizados e configuração com validate/apply/rollback já existem como pacotes, tabelas e rotas desde as Fases 3, 9 e 10. Não há interface para nada disso. É trabalho da frente do ADR-015, não arquitetura nova.

**Previsto pela metade.** O `server.properties` tem parser (`server-configuration`), e nenhum schema revisado o cobre. O OpenLoader tem schema revisado do seu arquivo de configuração (ADR-008), e o conteúdo que ele carrega ficou explicitamente fora daquela decisão.

**Não previsto em lugar nenhum.** Quatro áreas inteiras que o proprietário descreveu e que não têm contrato, tabela nem menção: runtimes além de Forge, gerenciamento de mundo, gamerules, e o grafo de conhecimento do modpack.

## Decisão

### 1. O painel é o gerenciador completo, e o ADR-014 descrevia ordem, não escopo

O caminho principal continua sendo a ordem em que as capacidades profundas são construídas. O produto é maior:

1. runtime e processo do servidor;
2. console;
3. servidor (propriedades base);
4. mundo;
5. backups;
6. configurações;
7. mods;
8. datapacks;
9. relações entre mods;
10. grafo de conhecimento;
11. releases;
12. análise automática de mods.

O release **não encerra o painel**. Ele encerra a frente atual do ADR-015 e é fundação do resto: sem manifesto e diff entre versões, o grafo não tem a que se ancorar no tempo.

### 2. Workspace e instância são coisas diferentes, e a diferença é a que permite ligar o servidor

Hoje existem dois conceitos desconectados:

| | `panel_workspaces` | `server_instances` |
| --- | --- | --- |
| Nasceu na | Fase 12 / ADR-015 | Fase 1 |
| Para que serve | construir e publicar | operar |
| Escreve no diretório | **nunca** | sim, é o ponto |
| Quem age | Control API, leitura pura | agente, por operação durável |

Um workspace é uma **leitura imutável** de uma instalação. Uma instância é uma instalação **em operação**. Ligar o servidor pelo painel exige a aresta entre os dois — um workspace pode passar a ser servido por uma instância, e uma instância aponta para um diretório de execução e um runtime.

Isso não afrouxa nada. O inventário continua estruturalmente incapaz de escrever; o que escreve é o processo do Minecraft, sob o agente, que é onde essa autoridade sempre esteve.

### 3. O runtime deixa de ser Forge

`minecraft-process` já tem os dois planos de lançamento que importam: `createMinecraftProcessPlan` (`java -jar`, que serve vanilla, Paper e Spigot) e `createForgeArgsFileProcessPlan` (`@user_jvm_args.txt @…_args.txt`, que é a única forma de iniciar Forge 1.20.1).

O agente monta **apenas o primeiro**. Ou seja: a capability existe, o controlador existe, e o servidor do proprietário não inicia por ele.

Passa a existir um **descritor de runtime** por instância, detectado e não digitado, com um plano por família:

| Família | Como se reconhece | Plano |
| --- | --- | --- |
| Forge | `libraries/net/minecraftforge/forge/<v>/{unix,win}_args.txt` | args file |
| NeoForge | `libraries/net/neoforged/neoforge/<v>/…` | args file |
| Fabric | `fabric-server-launch.jar` ou `.fabric/` | `-jar` |
| Paper / Spigot / vanilla | um `.jar` de servidor na raiz | `-jar` |

Detectar é o mesmo trabalho que `discoverForgeArgsFile` já faz no `sandbox-runner`, generalizado. Uma família não reconhecida é **recusada com nome**, nunca chutada — iniciar um JVM com o plano errado no diretório que guarda o mundo não é coisa para improvisar.

### 4. Mundo, gamerules e `server.properties` ganham áreas próprias

**Mundo.** Uma instância conhece seus diretórios de mundo. Visualizar o ativo, importar, trocar, criar, remover e fazer backup são operações do agente, sob guarda offline — a mesma que o `server-backup` já exige. Nenhuma delas roda com o servidor de pé.

**Gamerules.** Descobertas do `level.dat` quando o servidor está parado, ou do console quando está de pé. Tipadas, validadas antes de aplicar, com as vanilla identificadas e as de mod marcadas como tal quando o grafo souber de onde vieram.

**`server.properties`.** Recebe um schema revisado, como o OpenLoader recebeu. Campo tipado, limite declarado, política de restart, e os campos sensíveis tratados como sensíveis. Um valor sem schema revisado continua editável como texto e **dizendo que é texto** — o mesmo `RAW_EDITABLE` que o resto usa.

### 5. O grafo de conhecimento é um modelo de dados próprio, e GraphQL é outra pergunta

Hoje há três relações modeladas, todas estreitas e todas honestas: `artifact_compatibility_issues` liga mods com `determinacy: proven | unproven`; `configurationCandidates` liga mod → arquivo **com a regra que casou**; `mod_catalog_entries` guarda lado e requisito por servidor.

Nenhuma delas representa `registry`, `recipe`, `tag`, `bioma`, `estrutura`, `worldgen`, `dimensão`, `comando` ou `integração`, nem arestas entre eles.

Passa a existir um grafo com **entidade, aresta e proveniência**. A proveniência é a parte que não pode faltar: cada nó e cada aresta carrega de onde veio — metadado declarado, arquivo lido, boot observado, adaptador revisado, ou sugestão de IA confirmada por uma pessoa. Um grafo que não distingue "o mod declarou" de "alguém achou" responde com a mesma confiança as duas perguntas que o proprietário quer fazer:

> Se eu alterar isso, o que será afetado?
> Onde essa funcionalidade é definida?

**GraphQL não é o grafo.** A API hoje é REST tipada por TypeBox e é adequada às telas que existem. Se a consulta de relações provar que precisa de travessia arbitrária, GraphQL entra como camada de leitura sobre o mesmo modelo — e essa decisão é tomada quando o modelo existir, não antes.

### 6. Os packs do OpenLoader entram pelo grafo

O ADR-008 diz, com todas as letras, que editar packs OpenLoader exige recorte próprio de inspeção, proveniência, licenças e validação, e não uma extensão silenciosa daquela decisão. Isso continua valendo.

O que muda é que agora há onde colocar o resultado: `OpenLoader → diretório carregado → datapack → o que ele modifica` é uma cadeia de arestas com proveniência, não um documento explicando como o OpenLoader funciona.

### 7. Análise assistida por IA vira conhecimento revisado, e é assim que um mod sobe de nível

Nesta versão o pipeline aceito é `análise do mod → IA → documentação estruturada → revisão humana → grafo → painel`.

O ADR-014 diz "nunca presuma que um mod pode ser entendido semanticamente a partir do JAR". Continua certo como default, e este ADR **acrescenta** o caminho que faltava estar escrito: uma revisão humana registrada é o que transforma suposição em conhecimento, e o mecanismo já existe — `reviewedResourcePaths` é o que promove um mod de `STRUCTURED` para `FULLY_MANAGED`.

A restrição do ADR-014 sobre IA restringe **aplicar**, não **analisar**. Ler um jar e gravar o resultado com proveniência `ai-suggested` é leitura. O que segue proibido é uma sugestão virar mudança sem alguém confirmar.

### 8. A análise automática é a direção, e nada hoje a impede

A camada `deep` da inspeção é `not-attempted` com `limit: 'no-adapter'`. Não é porta fechada: é porta com dono. `readSelectedEntries({ names, budgetBytes })` existe exatamente para um analisador que sabe quais arquivos quer, com orçamento declarado e sem poder enumerar.

O pipeline futuro — metadata, loader, dependências, configs, mixins, registries, datapacks, recipes, tags, worldgen, comandos, integrações — entra por essa porta, camada a camada, cada uma com sua própria proveniência.

## O que este ADR **não** muda

- **A prioridade do ADR-015.** Release fecha a frente atual e continua sendo o próximo item.
- **A sandbox descartável.** Quando um mod precisa rodar para gerar configuração, isso continua acontecendo só em cópia descartável, sem tocar o mundo original. Operar o servidor é outra coisa, com outro dono.
- **O `apply` continua sem dono.** É o único passo destrutivo do produto e o proprietário confirmou que pode seguir indisponível até existir fluxo seguro.
- **Nenhum executor genérico.** Toda operação nova continua sendo uma capability nomeada e revisada, nunca "execute isto".
- **Deny-by-default.** Uma capacidade sem o que a sustenta se declara indisponível com motivo nomeado, em vez de falhar no botão.

## Consequências

- o ROADMAP ganha fases para operação no painel, servidor e mundo, grafo de conhecimento e análise automática;
- o agente ganha detecção de runtime e o plano de args file, sem o qual `process.control` não inicia um Forge;
- `server_instances` ganha diretório de execução e descritor de runtime, e a aresta com `panel_workspaces`;
- `server.properties` entra na fila de schemas revisados, atrás do OpenLoader e junto das gamerules;
- o grafo é fase própria, com proveniência obrigatória, e GraphQL fica registrado como decisão adiada e separada.

## Não autorização

Este ADR não autoriza: escrever no workspace importado, aplicar configuração sem o fluxo do `apply`, iniciar o servidor original a partir do caminho de build, expor um executor genérico de comandos, nem gravar no grafo uma aresta sem proveniência.
