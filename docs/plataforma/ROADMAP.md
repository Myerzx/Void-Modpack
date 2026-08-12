# Roadmap, riscos e perguntas

O roteiro detalhado para execução via terminal, incluindo as Fases 7–13, gates, arquivos-alvo, validações e critérios de conclusão, está em [Plano de implementação das fases finais](FINAL_IMPLEMENTATION_PLAN.md).

## Fase 1 — planejamento

Status: concluída e aceita em 2026-08-03.

- [x] arquitetura e diagrama de serviços;
- [x] fluxo seguro de `/atualizar-modpack`;
- [x] fluxo de build, publicação atômica e rollback;
- [x] modelo inicial do banco e fila;
- [x] estrutura futura do monorepo;
- [x] formato inicial do manifesto;
- [x] autenticação, permissões e auditoria;
- [x] logs, métricas e fontes reais;
- [x] implantação, backups e recuperação;
- [x] backlog, riscos e perguntas;
- [x] ADRs e handoff;
- [x] nenhum código de aplicação implementado.

## Bloqueios e gates da Fase 2

O proprietário autorizou o início da Fase 2 com uma fatia que não depende dos P0 ainda abertos: toolchain e contratos sem efeitos externos. Cada P0 não resolvido continua bloqueando a capacidade relacionada e, em especial, qualquer publicação stable ou controle real do Minecraft.

### P0

1. [x] Identidade oficial definida como **VoidFall** no [ADR-006](DECISIONS/ADR-006-identidade-e-inicio-da-fase-2.md).
2. [ ] Escolher qual cliente será a base, porque o launcher atual só coincide com 11 dos 181 JARs do servidor.
3. [ ] Resolver origem, licença e permissão de distribuição dos mods, datapacks, stubs, patches e mídia.
4. [ ] Definir o modelo real de autenticação Minecraft (online mode direto ou proxy autenticador protegido).
5. [ ] Rotacionar o segredo RCON histórico e decidir se RCON será removido da arquitetura.

### P1

1. Escolher o provedor de permissões Forge após analisar o conjunto de mods.
2. Definir backend de artifacts/backups e limites de armazenamento.
3. Definir política de aprovação: candidato manual ou autopromoção em canais não estáveis.
4. Definir retenção de chat, coordenadas, IP administrativo, logs e auditoria.
5. Definir ambientes Windows/Linux oficialmente suportados.

## Fase 2 — fundação

1. [x] Criar monorepo e toolchain fixada.
2. [x] Implementar os cinco contratos compartilhados iniciais, schemas portáteis e testes de entrada.
3. [x] Criar PostgreSQL, migrações e repositórios.
4. [x] Implementar Control API mínima, autenticação, sessões, RBAC e auditoria.
5. [x] Implementar job queue transacional e worker de teste inofensivo.
6. [x] Implementar registro/heartbeat do agente sem controle de processo.
7. [x] Criar dashboard somente leitura com dados simulados claramente marcados e fixtures, não métricas falsas.
8. [x] Ampliar testes de contrato e segurança conforme cada novo trust boundary.

Status: concluída em 2026-08-03. O gate passou com autenticação, autorização, auditoria, fila e identidade do agente cobertas por testes. Consulte [Validação da Fase 2](PHASE_2_VALIDATION.md).

## Fase 3 — controle do Minecraft

1. [x] Adaptadores Windows/Linux de processo — concluídos com runtime, PID, ambiente mínimo, saída limitada e stop gracioso; gate completo aprovado na matriz Ubuntu/Windows do GitHub.
2. [x] Estado observado, start, stop e restart seguro — concluído no pacote isolado com controlador serializado/idempotente, testes falsos e fixture Java; gate aprovado na [matriz Ubuntu/Windows](https://github.com/Myerzx/Void-Modpack/actions/runs/30833243148).
3. [x] Console de leitura e comandos em allowlist — concluído no pacote isolado com snapshots limitados e catálogo `list-players`/`save-all`; gate aprovado na [matriz Ubuntu/Windows](https://github.com/Myerzx/Void-Modpack/actions/runs/30840780189).
4. [x] Métricas de host/processo e fonte exibida — concluídas no pacote isolado com snapshot tipado, 25 testes do pacote e gate de 58 testes aprovado na [matriz Ubuntu/Windows](https://github.com/Myerzx/Void-Modpack/actions/runs/30842410863).
5. [x] Backup consistente e restore em ambiente isolado — concluído no pacote `@voidfall/server-backup` com guarda offline obrigatória, manifesto canônico verificável, promoção atômica e restore somente em destino novo; gate aprovado na [matriz Ubuntu/Windows](https://github.com/Myerzx/Void-Modpack/actions/runs/30845229436).
6. [x] Configurações básicas com revisão anterior — concluídas no pacote `@voidfall/server-configuration`: registro confiável, subconjunto estrito de Java Properties, alteração tipada, hash esperado, revisão imutável anterior, recuperação e rollback versionado; gate aprovado na [matriz Windows/Linux](https://github.com/Myerzx/Void-Modpack/actions/runs/30848108269).

Gate: a Fase 3 foi concluída em isolamento. Force kill e restore operacional permanecem desabilitados até recortes próprios de falha, recuperação e integração.

Recorte atual: `@voidfall/minecraft-process` chama `spawn` somente por plano validado, com `shell: false`, ambiente mínimo e fixture Java em diretório temporário. O controlador serializa o ciclo de vida; o adaptador limita a leitura do console, aceita somente dois IDs sem argumentos e produz snapshots de host/processo com fonte, unidade, qualidade e timestamp. `@voidfall/server-backup` opera apenas sobre raízes confiáveis de teste, exige uma guarda offline injetada e publica/restaura diretórios por staging verificado. `@voidfall/server-configuration` altera somente recursos Java Properties registrados em fixtures, publica a revisão anterior antes da troca e exige guarda offline, lock e hash esperado. CPU/RSS da JVM permanecem explicitamente indisponíveis. Histórico idempotente, exclusão e recibos ainda são locais à memória ou ao filesystem. Nenhum dos pacotes toca no servidor ou está conectado à Control API, ao agente ou ao painel.

Status: concluída em 2026-08-03 dentro desses limites isolados. A Fase 4 foi implementada em seguida sem ampliar a integração operacional.

## Progresso por fase

Percentuais calculados pelos itens explícitos de cada fase; não representam esforço ou prazo equivalente.

| Fase | Progresso | Base |
| --- | ---: | --- |
| 1 — planejamento | 100% | concluída |
| 2 — fundação | 100% | 8 de 8 itens |
| 3 — controle do Minecraft | 100% | 6 de 6 itens |
| 4 — mods, arquivos e schemas | 100% | 6 de 6 itens concluídos |
| 5 — build e launcher | 100% técnico | 7 de 7 itens concluídos em isolamento; ativação operacional bloqueada pelos P0 |
| 6 — jogadores e auditoria | 100% técnico | 6 de 6 itens concluídos em isolamento; ingestão e efeitos reais bloqueados |
| pré-7 — auditoria técnica do modpack | 100% documental | 299 componentes, 298 artefatos e 737 conexões; base contextual corrigida |
| 7 — configurações específicas | 100% | Fases 7.0–7.3 concluídas e aprovadas em CI |
| 8 — mods adaptativos | 0% | planejada; correção contextual concluída, ainda depende da ordem das fatias finais |
| 9 — núcleo operacional e painel | 0% | planejada; domínios continuam isolados |
| 10 — operações completas | 0% | planejada; sem ligação ao runtime real |
| 11 — jogadores e permissões reais | 0% | planejada; providers e política ainda pendentes |
| 12 — release, launcher e Bridge | 0% operacional | base técnica isolada existe; ativação bloqueada pelos P0 |
| 13 — produção e certificação | 0% | planejada; deploy e aceite ainda não iniciados |
| 19 — grafo de conhecimento | 65% | modelo, proveniência, persistência, configs, OpenLoader, evidências Java e travessia REST/painel limitada ligados; cobertura universal de entidades ainda pendente |
| 20 — análise automática | 50% | pipeline genérico e bytecode estático limitado validados no Mine and Slash real; novos formatos, defaults dinâmicos e revisão universal ainda pendentes |
| desktop Windows | 60% | ZIP portátil de QA executado fora do checkout e painel desktop responsivo; instalador assinado, update, rollback e certificação em máquina limpa separada pendentes |

## Fase 4 — mods, arquivos e schemas

1. [x] Inventário e catálogo reconciliado — concluído em isolamento no pacote `@voidfall/mod-catalog`: snapshots sanitizados, identidade por SHA-256 e relatório determinístico de conflitos/bloqueios; gate aprovado na [matriz Windows/Linux](https://github.com/Myerzx/Void-Modpack/actions/runs/30852157194), sem varredura do runtime ou aprovação automática.
2. [x] Classificação manual por lado e distribuição — revisão imutável, ator/motivo, hash esperado e transições conservadoras em `@voidfall/mod-catalog`.
3. [x] Upload em quarantine e validação segura — streaming limitado, hash/tamanho, assinatura ZIP mínima e publicação sem overwrite em `@voidfall/artifact-quarantine`.
4. [x] File manager em raízes autorizadas — listagem/leitura UTF-8 e substituição otimista com revisão anterior em `@voidfall/authorized-files`.
5. [x] Schemas genéricos de configuração e histórico — definições declarativas, revisão em memória e validação estrita em `@voidfall/configuration-schemas`.
6. [x] Dependências, duplicatas e conflitos — dependências ausentes, ciclos, runtimes, hashes, filenames, ranges não provados e conflitos revisados no catálogo.

Status: concluída em isolamento em 2026-08-03. O gate local passou com 125 casos descobertos, 123 executados no Windows e dois casos específicos de socket Unix ignorados. A [matriz final 30855561911](https://github.com/Myerzx/Void-Modpack/actions/runs/30855561911) aprovou o gate completo e a auditoria de runtime em `ubuntu-latest` e `windows-latest`.

## Fase 5 — build e launcher

1. [x] Worker isolado e staging reproduzível — job aceita somente `planId` opaco; o executor confiável recebe a referência e o build usa raízes temporárias autorizadas.
2. [x] Sanitização e gates — bytes exatos revisados, JSON canônico e Java Properties em allowlist, com integridade de entrada/saída e limites.
3. [x] Manifesto assinado e artifacts imutáveis — JSON canônico, Ed25519, identidade SHA-256 e criação sem overwrite.
4. [x] Launcher API e canais — Fastify somente leitura para canal, manifesto e artifact, com chave pública pinada.
5. [x] Adaptador de cliente/launcher escolhido — protocolo portátil VoidFall, independente de produto, com estado gerenciado e plano determinístico.
6. [x] Publicação, promoção e rollback — repositório local encapsulado, CAS por revisão e rollback somente para histórico do mesmo canal.
7. [x] Forge Bridge e `/atualizar-modpack` — núcleo Java 17 implementado e testado; o adapter Forge e o comando permanecem desabilitados pelos gates reais.

Status: conclusão técnica em isolamento em 2026-08-03. O gate local e a [matriz Windows/Linux 30859356360](https://github.com/Myerzx/Void-Modpack/actions/runs/30859356360) passaram: 149 casos no Linux; 147 aprovados e dois sockets Unix ignorados no Windows; auditoria de runtime sem vulnerabilidades.

Gate operacional: o canal `stable`, a instalação no Forge real e `/atualizar-modpack` continuam desabilitados até cliente-base compatível, cadeia de distribuição, importação limpa e compatibilidade de launch/conexão serem aprovados com evidência. Não existe bypass de força.

## Fase 6 — jogadores e auditoria

1. [x] Perfis por UUID — registro puro, versionado, limitado e com concorrência otimista.
2. [x] Aliases observados — histórico case-insensitive, origem explícita e UUID como única identidade.
3. [x] Integração de permissões — porta de provider e estado desejado separados do RBAC do painel, deny-by-default sem provider.
4. [x] Moderação e punições — casos tipados, expiração e executor injetado sem texto de comando.
5. [x] Atividade, chat e coordenadas sob política de privacidade — motor de decisão sem payload sensível ou persistência de observações.
6. [x] Auditoria encadeada/exportável — cadeia SHA-256 por partição, verificação, NDJSON e append transacional no PostgreSQL.

Status: conclusão técnica em isolamento em 2026-08-03. O gate local e a [matriz Windows/Linux 30862534188](https://github.com/Myerzx/Void-Modpack/actions/runs/30862534188) passaram com 178 casos no Linux, 176 aprovados no Windows e dois casos de socket Unix ignorados. Os cinco novos contratos geram JSON Schemas portáteis; `@voidfall/player-governance` possui 12 testes, `@voidfall/audit-chain` possui 7 e o repositório de auditoria encadeia appends concorrentes em PGlite.

Gate operacional: autenticação Minecraft, provider Forge, executor de moderação, importação de jogador, coleta de atividade/chat/coordenadas, telas/rotas sensíveis e export externo continuam desabilitados. Dependem das decisões P0/P1 de autenticação, provider e retenção, além de autorização, auditoria de leitura e teste no Forge real. Consulte [Fase 6: jogadores, privacidade e auditoria](PHASE_6_PLAYERS_AUDIT.md).

## Fase 7 — configurações específicas

Somente após inventário completo e seleção dos mods suportados. Cada schema específico exige proprietário, versão, teste, validação, rollback e indicação de restart.

A auditoria prévia foi corrigida pela Fase 7.0 em 2026-08-04. A regeneração em [`docs/modpack/`](../modpack/index.md) usa somente fixtures sanitizadas e preserva 298 artefatos/299 componentes em 1.363 declarações contextualizadas. O resultado separa quatro conflitos canônicos de duas divergências que agora permanecem `unknown`; não há dependência obrigatória ausente em contexto ativo. Contexto, lado, loader, JarJar e ranges Maven possuem regressões em TypeScript e Python, conforme [Validação da Fase 7.0](PHASE_7_CONTEXTUAL_COMPATIBILITY.md), e a [matriz Windows/Linux 30936868796](https://github.com/Myerzx/Void-Modpack/actions/runs/30936868796) aprovou o gate completo.

A Fase 7.1 selecionou explicitamente `openloader_advanced_options_v1` no [ADR-008](DECISIONS/ADR-008-openloader-como-primeiro-schema.md). O recorte aceita apenas `dataPacks.enabled` e `resourcePacks.enabled`, fixa `additionalFolders` como vazio, exige restart e possui parser/serializador estritos com fixtures sanitizadas. Os diretórios de packs, paths fornecidos pelo usuário e qualquer outro schema continuam negados. O gate local e a [matriz Windows/Linux 30943931215](https://github.com/Myerzx/Void-Modpack/actions/runs/30943931215) aprovaram o recorte completo. Persistência e operação isolada foram concluídas na Fase 7.2; API, agente e painel continuam reservados à Fase 7.3.

A [Fase 7.2](PHASE_7_CONFIGURATION_PERSISTENCE.md) persiste somente o schema revisado, recursos, revisões, estado de aplicação e lock compartilhado. O codec OpenLoader foi ligado ao `server-configuration` por registro fechado; aplicação, falha e rollback são correlacionados por versão, hash, ator, motivo e auditoria sem valores. Os testes usam PGlite e diretórios temporários, e a [matriz Windows/Linux 30952093047](https://github.com/Myerzx/Void-Modpack/actions/runs/30952093047) aprovou o gate completo. API, Server Agent, painel e runtime privado continuam desconectados; a próxima fatia é a Fase 7.3.

## Fases 8–13 — integração e conclusão operacional

As fases posteriores preservam a numeração histórica das Fases 1–7 e acrescentam o trabalho que ainda separa os pacotes isolados de um produto completo:

1. **Fase 8 — mods adaptativos:** inspeção segura, análise contextual, quarentena, revisão e janela de incompatibilidades, sem instalação automática.
2. **Fase 9 — núcleo operacional e painel:** persistência, transporte autenticado, idempotência durável, APIs e painel dinâmico.
3. **Fase 10 — operações completas:** processo, console, arquivos, backups, restore, métricas, logs, alertas e agendamentos.
4. **Fase 11 — identidade de jogador:** **encerrada** em 2026-08-06 com identidade estável, reivindicações, aliases, perfis e casos de moderação persistidos. O restante do escopo original foi adiado.

O [ADR-014](DECISIONS/ADR-014-objetivo-central-e-replanejamento.md) esclareceu o objetivo central e reordenou o que vem depois. O VoidFall é, antes de tudo, um **painel pessoal de construção, configuração e publicação** de servidores e modpacks Forge: importar, inventariar, configurar, testar em sandbox descartável e publicar. Gestão de jogadores não está nesse caminho.

5. **Fase 12 — importação e inventário:** analisador estático de JAR, descoberta de configurações, datapacks, scripts e recursos, e classificação do nível de edição de cada mod.
6. **Fase 13 — edição segura por esquema inferido:** formulário gerado, validação, staging, diff e rollback, sem presumir semântica que ninguém revisou.
7. **Fase 14 — sandbox descartável:** boot isolado a partir dos mods e arquivos mínimos, para gerar arquivos de runtime e confirmar que uma alteração inicia. Nunca contra o mundo original.
8. **Fase 15 — adaptadores específicos:** Mine and Slash como primeiro adaptador completo. Assistência de IA somente como sugestão, com confiança explícita e confirmação humana.
9. **Fase 16 — construtor de release:** **encerrada** em 2026-08-07 com ZIP de servidor e de cliente, manifesto com hashes, changelog automático, corte por lado e plano de rollback, todos executados contra o servidor real ([registro](PHASE_16_RELEASE_BUILDER.md)). A exportação CurseForge permanece recusada por licença, não por código, e a execução do rollback depende do `apply`, que ainda não tem dono.
10. **Fase 17 — operação do servidor no painel:** lifecycle, detecção de runtime, vínculo de instância, agente local, ownership durável, [console ao vivo](PHASE_17_LIVE_CONSOLE.md), `artifact.install` e [backup local cifrado](PHASE_17_LOCAL_BACKUPS.md) concluídos. Restore do mundo ativo permanece bloqueado até existir boot real da cópia isolada — ver [plano](PLANO_INICIAR_SERVIDOR.md).
11. **Fase 18 — servidor e mundo:** primeira fatia de `server.properties` concluída com schema revisado de autenticação/whitelist/RCON, preservação opaca, bootstrap e painel; backup do mundo está operacional, enquanto demais propriedades, gamerules, criação/importação/troca/remoção de mundos e restore permanecem sob guarda offline e pendentes. Consulte [Fase 18 — segurança do server.properties](PHASE_18_SERVER_PROPERTIES_SECURITY.md).
12. **Fase 19 — grafo de conhecimento do modpack:** entidade, aresta e **proveniência obrigatória**, cobrindo registries, recipes, tags, worldgen, dimensões, biomas, estruturas, comandos e integrações. Inclui os packs carregados pelo OpenLoader, que o ADR-008 deixou explicitamente fora do seu recorte. GraphQL fica adiado e separado: é camada de leitura sobre este modelo, não o modelo.
13. **Fase 20 — análise automática de mods:** o pipeline que aprende como um mod deve ser administrado ao ser adicionado. Entra pela porta que a inspeção em camadas já deixou aberta — `readSelectedEntries`, com orçamento declarado — e grava no grafo com proveniência.

Quatro fatias verticais das Fases 19–20 entregues até 2026-08-10: inventário → análise genérica e bytecode limitado → schemas revisados/conflitos de datapack → snapshot imutável → grafo/evidência → travessia limitada → REST → painel. As três primeiras foram validadas no Mine and Slash 6.3.14 e nos packs OpenLoader reais; a quarta limita a leitura a 3 saltos, 250 nós e 500 arestas, com estrutura opt-in. O resultado, as contagens e os limites estão em [Fases 19–20 — ecossistema de mods e análise estática](PHASE_19_ECOSYSTEM_ANALYSIS.md). Isso não encerra nenhuma das duas fases.

A fronteira de ordem efetiva agora inclui contrato, captura offline guardada, persistência isolada, reader gzip/NBT limitado para `Data.DataPacks`, composição operacional no Server Agent, produtor tipado na Control API e ensaio E2E sintético do `POST` ao handler via transporte/lease reais. A raiz é resolvida da workspace `server` vinculada, o único arquivo permitido é `world/level.dat`, e request/job/capability/handler/readiness, replay e auditoria não carregam paths ou bytes. `datapacks.observe` é concedida somente a owner/administrator e permanece separada do grant da capability. Status/painel somente leitura, grant operacional explícito, smoke do mundo privado e qualquer mudança no gate de edição continuam pendentes; nenhum mundo privado foi lido.
14. **Fase 21 — runtime e administração de jogadores:** retoma o que a Fase 11 deixou decidido nos ADRs 009, 010, 012 e 013 e não implementado. Adiar não é revogar.

O [ADR-016](DECISIONS/ADR-016-painel-como-gerenciador-completo.md) registra que o painel é o **gerenciador completo do servidor**, e que o ADR-014 descrevia ordem de construção e não fronteira do produto. O release encerra a frente do ADR-015, não o painel.

Em paralelo às fases acima, e sem interrompê-las, corre a **frente de integração do painel** ([ADR-015](DECISIONS/ADR-015-frente-de-integracao-do-painel.md)): cada capacidade madura é exposta na interface quando houver tela útil para ela, em vez de acumular integração para o final. Ela também serve de validação — uma capacidade tecnicamente correta que fique impraticável pelo painel muda de contrato antes de a decisão endurecer. Como subir o painel está em [PAINEL_LOCAL.md](PAINEL_LOCAL.md).

### Frente desktop Windows

O [ADR-019](DECISIONS/ADR-019-aplicativo-desktop-electron.md) escolhe Electron para a primeira aplicação desktop e preserva a Control API como única fronteira privilegiada. O [recorte desktop](PHASE_DESKTOP_SHELL.md) abre o painel, compõe PGlite/agente em utility process, usa estado no AppData, encerra sem órfãos e agora produz um ZIP portátil de QA com dependências e licenças inventariadas. Mobile permanece fora do escopo.

O smoke de empacotamento fora do checkout passou em 2026-08-11: primeira abertura, sessão, health, PGlite/migrations, segunda instância, encerramento e persistência após reabrir foram aprovados. O próximo gate exige formato de instalador, identidade visual/metadados, certificado de assinatura e validação em uma máquina Windows limpa separada. Auto-update e distribuição continuam bloqueados. Consulte a [análise de lacunas do produto final](FINAL_PRODUCT_GAP_ANALYSIS.md).

O escopo executável, dependências e definição de pronto de cada uma estão no [plano final](FINAL_IMPLEMENTATION_PLAN.md). Nenhuma fase nova reabre ou reduz os gates P0/P1 existentes.

## Riscos técnicos

| Risco | Impacto | Mitigação planejada |
| --- | --- | --- |
| cliente e servidor divergentes | release não inicia/conecta | catálogo comum e smoke test real |
| classificação errada de lado | crash ou vazamento | `unknown` bloqueia stable e revisão manual |
| licença ausente | remoção/reclamação | provenance e decisão por arquivo |
| agente comprometido | controle do host | escopo mínimo, identidade por instância e allowlist |
| path traversal/junction | leitura/escrita externa | canonicalização e testes cross-platform |
| build não reproduzível | hash/release imprevisível | inputs imutáveis, ordem canônica e ambiente fixado |
| mundo inconsistente | perda de dados | protocolo save/snapshot e restore testado |
| log com segredo/dado pessoal | incidente de segurança | redação, retenção e acesso restrito |
| chave de assinatura comprometida | update malicioso | cofre, rotação, revogação e chave pública fixada |
| queue job duplicado | dupla operação destrutiva | idempotência, lease e efeitos deduplicados |
| plugin/mod de permissão incompatível | privilégio incorreto | adapter e teste no Forge real |
| disco cheio | crash/build/backup falho | quotas, preflight e alertas |

## Perguntas pendentes

1. [Respondida] O nome oficial é **VoidFall**. O versionamento de releases permanece SemVer e o schema possui versão própria.
2. O cliente privado de 220 JARs será a base ou será reconstruído do catálogo?
3. Quais launchers precisam ser suportados no primeiro release?
4. [Respondida] Nenhum dos dois. `online-mode` permanece `false` porque o servidor aceita jogadores sem conta oficial, com camada de autenticação obrigatória e reivindicação de identidade — [ADR-009](DECISIONS/ADR-009-autenticacao-minecraft-e-topologia.md). Onde mora a credencial continua pendente.
5. [Respondida] Nenhum existe entre os 195 mods. LuckPerms é o provider e a fonte de verdade; a PermissionAPI do Forge fica como interface de compatibilidade — [ADR-010](DECISIONS/ADR-010-provider-de-permissoes-minecraft.md). O caminho da operação até o LuckPerms continua pendente.
6. A produção inicial continuará em Windows ou migrará para Linux?
7. Onde artifacts e backups serão armazenados e qual orçamento/retention?
8. Quem pode aprovar/promover stable e rollback? Exige duas pessoas?
9. [Respondida] Núcleo mínimo: identidade, vínculo e moderação, com casos encerrados por 2 anos. IP, chat e coordenadas ficam fora até haver finalidade, retenção e controle de acesso — [ADR-011](DECISIONS/ADR-011-dados-de-jogador-e-retencao.md).
10. O painel será acessível pela internet, VPN ou somente LAN?
11. Qual política para mods extras/opcionais no cliente?
12. O launcher será apenas protocolo/adaptadores ou aplicativo próprio no futuro?
13. Há necessidade real de múltiplos servidores/instâncias no MVP?
14. Quais testes de gameplay definem uma release compatível?
15. Quais componentes locais possuem autoria/licença para entrar em `Servidor/source`?

## Histórico do primeiro recorte da Fase 2

O primeiro recorte criou toolchain e contratos versionados (`Job`, `AgentEnvelope`, `ModCatalogEntry`, `ReleaseManifest`, `AuditEvent`) sem efeitos externos. Recortes posteriores, autorizados pelo proprietário, completaram a fundação. Os P0 remanescentes continuam gates obrigatórios para as capacidades relacionadas.
