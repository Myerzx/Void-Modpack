# Roadmap, riscos e perguntas

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
| 7 — configurações específicas | 0% | ainda não iniciada |

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
4. O servidor usará autenticação oficial direta ou proxy? Qual topologia?
5. Qual mod de permissões já existe ou pode ser introduzido sem conflito?
6. A produção inicial continuará em Windows ou migrará para Linux?
7. Onde artifacts e backups serão armazenados e qual orçamento/retention?
8. Quem pode aprovar/promover stable e rollback? Exige duas pessoas?
9. Quais dados de jogador podem ser armazenados e por quanto tempo?
10. O painel será acessível pela internet, VPN ou somente LAN?
11. Qual política para mods extras/opcionais no cliente?
12. O launcher será apenas protocolo/adaptadores ou aplicativo próprio no futuro?
13. Há necessidade real de múltiplos servidores/instâncias no MVP?
14. Quais testes de gameplay definem uma release compatível?
15. Quais componentes locais possuem autoria/licença para entrar em `Servidor/source`?

## Histórico do primeiro recorte da Fase 2

O primeiro recorte criou toolchain e contratos versionados (`Job`, `AgentEnvelope`, `ModCatalogEntry`, `ReleaseManifest`, `AuditEvent`) sem efeitos externos. Recortes posteriores, autorizados pelo proprietário, completaram a fundação. Os P0 remanescentes continuam gates obrigatórios para as capacidades relacionadas.
