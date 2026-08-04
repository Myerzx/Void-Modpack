# Handoff da plataforma

## Estado atual

- Data: 2026-08-04
- Responsável: Codex
- Fase: 7.0 — concluída em isolamento; validação local e matriz Windows/Linux aprovadas
- Fase 2: concluída e validada
- Runtime Minecraft privado: não modificado e não conectado
- Compatibilidade contextual: regenerada em `docs/modpack/` somente com fixtures sanitizadas; nenhum workspace privado foi lido ou modificado
- Planejamento das fases finais: consolidado em `FINAL_IMPLEMENTATION_PLAN.md`, com Fases 7–13, gates, fatias verticais, arquivos-alvo, comandos de validação e critérios de conclusão

## Implementado

- monorepo TypeScript, contratos, PostgreSQL, migrações, RBAC e fila `SKIP LOCKED`;
- Argon2id, sessões opacas, CSRF, rate limit, revogação e auditoria;
- Control API mínima, worker `system.noop`, agente de heartbeat Ed25519 e dashboard estático de demonstração;
- `@voidfall/minecraft-process` com:
  - planos Windows/Linux de executável e diretório absolutos;
  - validação no adaptador e no runtime;
  - `spawn` com `shell: false`, `detached: false`, ambiente mínimo e PID observado;
  - captura limitada de stdout/stderr e detecção da linha de boot;
  - `requestGracefulStop()` limitado ao literal `stop\n`;
  - timeout que permanece em `stopping`, sem kill implícito;
  - controlador de `start`, `stop` e `restart` com uma única operação em voo;
  - chave idempotente, replay limitado em memória, rejeição de concorrência e eventos determinísticos;
  - restart que exige `offline` antes de iniciar uma segunda JVM;
  - snapshot de console por linhas, com remoção de ANSI/controles e limites adicionais;
  - catálogo fechado `list-players`/`save-all`, revalidado no runtime e sem argumentos;
  - exclusão imediata entre start, stop e comando no mesmo adaptador, sem fila;
  - snapshot imutável de métricas com fonte, unidade, qualidade e horário explícitos;
  - memória total/livre/usada, uptime e CPUs disponíveis do host por `node:os`;
  - estado, PID e uptime gerenciado do processo pelo adaptador;
  - CPU e RSS da JVM marcados como indisponíveis, sem zero ou dado substituto;
  - fixture Java 17 executada em diretório temporário;
- `@voidfall/server-backup` com:
  - estratégia única `offline-exclusive-v1` e guarda confiável obrigatória injetada;
  - raízes absolutas confiáveis, rejeição de sobreposição e inventário determinístico limitado;
  - rejeição de symlink/junction, hardlink, tipos especiais, traversal e colisão por case fold;
  - manifesto canônico v1 sem paths absolutos e SHA-256 por arquivo;
  - staging privado, verificação da origem e da cópia e promoção atômica por `rename`;
  - snapshot publicado imutável e conflito em vez de overwrite;
  - restore somente para destino novo e isolado, verificado antes da promoção;
  - recibos imutáveis, erros públicos sanitizados e limpeza limitada ao `.partial` da operação;
- `@voidfall/server-configuration` com:
  - registro confiável e fechado de recursos, paths, schemas, formatos e limites;
  - codec estrito `java-properties-v1` que preserva comentários, ordem, UTF-8 e LF/CRLF;
  - campos boolean, inteiro, enum e string com limites e necessidade de restart;
  - rejeição de chaves ausentes, desconhecidas ou duplicadas e de sintaxe ambígua;
  - guarda offline injetada, lock por recurso e hash atual esperado;
  - rejeição de symlink/junction, hardlink, tipo especial, sobreposição e conteúdo grande;
  - revisão anterior exata, manifesto canônico e publicação antes da substituição;
  - substituição sincronizada, verificação posterior e recuperação dos bytes anteriores;
  - rollback que cria nova revisão e não reinicia o Minecraft;
  - recibos imutáveis e erros sanitizados sem paths ou valores;
- `@voidfall/mod-catalog` com:
  - contratos v1 `InventorySnapshot` e `CatalogReconciliationReport`, também exportados como JSON Schema;
  - separação entre identidade de conteúdo `sha256:*`, ID lógico revisado e ocorrência em inventário;
  - validação de fonte/escopo, runtime, path canônico, basename, estado, tamanho e hash;
  - união determinística de inventários cliente/servidor com o catálogo revisado;
  - estados `cataloged`, `untracked` e `ambiguous` sem associação por filename;
  - sugestão de lado baseada apenas em presença ativa, sem sobrescrever revisão;
  - bloqueios ordenados para ausência, inatividade, lado, distribuição, revisão, runtime, filename e tamanho;
  - relatório profundamente imutável, sem filesystem, rede, JAR, banco ou efeito operacional;
  - classificação humana limitada a lado, requisito, distribuição e estado de revisão;
  - hash canônico esperado, ator, motivo e revisão imutável para impedir decisão sobre estado obsoleto;
  - análise determinística de dependências ausentes, ciclos, ranges não provados, runtime, conteúdo duplicado, filename e conflitos revisados;
- `@voidfall/artifact-quarantine` com:
  - streaming opaco de `.jar`/`.zip` sem extração ou execução;
  - limites durante a leitura, tamanho declarado, SHA-256 e assinatura inicial de container ZIP;
  - raiz confiável, staging exclusivo, manifesto canônico, `fsync`, rename e conflito sem overwrite;
  - rejeição de root/link inseguro e limpeza limitada ao staging da própria identidade;
- `@voidfall/authorized-files` com:
  - registro fechado de raízes, extensões e limites, sem path absoluto na operação;
  - listagem limitada, leitura UTF-8 e rejeição de traversal, symlink/junction, hardlink e tipos especiais;
  - substituição somente de arquivo existente com hash esperado e exclusão local por recurso;
  - revisão imutável dos bytes anteriores preparada antes da troca, verificação e recuperação;
- `@voidfall/configuration-schemas` com:
  - metadata pura para Java Properties, JSON, TOML, YAML e CFG, sem parser ou acesso a arquivo;
  - campos boolean, integer, number, string e enum, com limites, defaults e restart;
  - patterns fechados, chaves estritas e validação determinística de valores;
  - registro e histórico imutável em memória com hash esperado e limites explícitos;
- Fase 5 com:
  - contratos v1 de canal assinado, estado gerenciado do launcher e intenção curta do Forge Bridge;
  - `@voidfall/modpack-release` com staging privado, bytes explícitos, três sanitizadores, integridade, Ed25519 e manifesto reproduzível;
  - artifacts por SHA-256, releases imutáveis, promoção por compare-and-swap e rollback somente para histórico do canal;
  - `@voidfall/launcher-protocol` com pin de chave, coerência canal/manifesto, monotonicidade e planner portátil;
  - `@voidfall/launcher-api` executável, somente leitura, com canal, manifesto e artifact verificados;
  - `modpack.build` no worker limitado a `planId`, executor confiável injetado e resultado/falha sanitizados;
  - núcleo Java 17 do Forge Bridge com permissão literal, janela curta, nonce, Ed25519 e capabilities deny-by-default;
  - nenhum acesso aos workspaces privados, nenhuma release real, nenhum adapter Forge e nenhuma ativação de comando;
- Fase 6 com:
  - contratos v1 e JSON Schemas para `PlayerProfile`, `MinecraftPermissionBinding`, `ModerationCase`, `PlayerDataPolicy` e `AuditChainExportManifest`;
  - `@voidfall/player-governance` com registros limitados, imutáveis e idempotentes de perfil/alias por UUID;
  - grupos Minecraft separados do RBAC do painel, baseline `player` e porta de provider deny-by-default;
  - moderação tipada para warning, mute, kick e bans, com expiração e executor injetado sem comando livre;
  - motor de privacidade que decide coleta/leitura/export, exige política aprovada e não recebe payload de chat/coordenada;
  - `@voidfall/audit-chain` com SHA-256 por partição, sequência, verificação e NDJSON canônico;
  - `0003_audit_chain.sql` e `AuditRepository` com cabeça bloqueada, integridade pertencente ao storage e export limitado;
  - nenhuma importação de jogador, arquivo, chat, coordenada ou estado do servidor privado;
- Fase 7.0 com:
  - contratos v1 estritos para plano e relatório de compatibilidade contextual;
  - análise por `launcher_current`, `server_active`, referência e histórico, preservando lado e branch de loader;
  - bibliotecas JarJar como componentes próprios, sem herdar a união de loaders do JAR externo;
  - ranges Maven com qualifiers/builds e resultado `unknown` para sintaxe não suportada ou baseline ausente;
  - quatro conflitos canônicos preservados e KillCam/Preloading Tricks reclassificados como evidência de referência desconhecida;
  - gerador documental determinístico alimentado por `sanitized-artifact-inventory-v1.json`, sem leitura dos runtimes privados;
  - regressões compartilhadas em TypeScript/Python e validador CI para os seis casos, JarJar, side, loader e baseline NeoForge;
- workflow de CI com Node 24, Java 17 e testes Python em Ubuntu/Windows.

## Limites obrigatórios

1. Não modificar `Launcher/`, `Servidor/workspace/`, mundos, configs privadas ou o processo Minecraft real.
2. Não expor `ProcessLaunchPlan`, shell, argumento, cwd ou texto de comando como payload público.
3. Não ligar os adaptadores ao agente/API antes de contratos operacionais estreitos, autorização, auditoria e idempotência por ação.
4. Não adicionar método genérico de stdin, force kill ou restore operacional; o restore isolado não autoriza troca de mundo.
5. Não habilitar RCON; o segredo histórico precisa ser rotacionado e a decisão de remoção continua P0.
6. Não iniciar produção Minecraft antes de definir a topologia de autenticação oficial/proxy.
7. Não promover modpack stable antes de cliente canônico, proveniência e licenças.
8. Não tratar schemas genéricos como adapters operacionais: JSON/TOML/YAML/CFG ainda não possuem parser, serializer, persistência, path público ou aplicação em arquivo real.
9. Não tratar presença, filename, project/file ID ou `distributionAllowed` como identidade lógica, lado aprovado ou licença.
10. Não importar os inventários atuais como catálogo real antes que o cliente possua SHA-256/tamanho e a revisão manual seja registrada.
11. Não fornecer raiz, path, catálogo, chave ou comando no payload de `modpack.build`; somente `planId` opaco pode atravessar a fila.
12. Não dar chave privada à Launcher API; ela recebe somente conjunto de chaves públicas pinadas.
13. Não habilitar `stable`, instalar o Bridge ou registrar `/atualizar-modpack` até todos os gates externos estarem aprovados.
14. Não usar alias como identidade, autenticação ou autorização; somente UUID identifica jogador.
15. Não adicionar payload genérico ao motor de política nem persistir atividade/chat/coordenadas antes de finalidade, retenção e acesso aprovados.
16. Não aceitar hash de auditoria do produtor; partição, sequência e cadeia pertencem ao storage.
17. Não tratar fake de provider/executor como integração Forge real.

## Validação

- Fase 7.0: 34 casos de contratos, 23 casos do catálogo e 3 regressões Python aprovados;
- gate completo local aprovado: 185 casos descobertos, 183 executados no Windows e dois sockets Unix ignorados; builds/typechecks de todos os workspaces, Java 17, Forge Bridge e painel estático aprovados;
- matriz CI da Fase 7.0 aprovada em `ubuntu-latest` e `windows-latest`: [execução 30936868796](https://github.com/Myerzx/Void-Modpack/actions/runs/30936868796), incluindo regressões Python, validador documental, gate completo e auditoria de runtime;
- documentação regenerada deterministicamente: 299 componentes, 298 artefatos, 1.363 declarações contextualizadas e nenhuma dependência obrigatória ausente em contexto ativo;
- validador confirmou os seis resultados nomeados, JarJar separado e ausência de baseline Forge usado como NeoForge;
- planejamento das Fases 7–13 validado com 47 links Markdown locais resolvidos e `git diff --check` sem erro;
- pacote de processo: build, typecheck e 25 testes aprovados com Java 17;
- pacote de backup: build, typecheck e 10 casos aprovados; no Windows, 9 executados e 1 socket Unix ignorado;
- pacote de configuração: build, typecheck e 11 casos aprovados; no Windows, 10 executados e 1 socket Unix ignorado;
- pacote de contratos: build, typecheck, 34 casos e 17 JSON Schemas aprovados;
- pacote de catálogo: build, typecheck e 23 casos aprovados;
- pacote de quarentena: build, typecheck e 7 casos aprovados;
- pacote de arquivos autorizados: build, typecheck e 8 casos aprovados;
- pacote de schemas genéricos: build, typecheck e 8 casos aprovados;
- gate local aprovado: 125 casos descobertos, typechecks e builds de todos os workspaces; 123 executados no Windows e 2 sockets Unix ignorados;
- gate local da Fase 5 aprovado: 149 casos descobertos, 147 aprovados no Windows e dois sockets Unix ignorados; build/typecheck de todos os workspaces, Java 17, Launcher API e export estático aprovados;
- Fase 5 por componente: contratos 22, release 7, launcher protocol 4, Launcher API 3, build worker 4 e Forge Bridge 3 casos aprovados;
- gate local da Fase 6 aprovado: 178 casos descobertos; 176 aprovados no Windows e dois sockets Unix ignorados; builds/typechecks de todos os workspaces, Java 17, Launcher API e export estático aprovados;
- Fase 6 por componente novo/ampliado: contratos 31, player governance 12, audit chain 7 e database 3 casos aprovados;
- append concorrente de auditoria comprovado em PGlite com sequência contígua, verificação e export NDJSON;
- matriz CI final da Fase 6 aprovada em `ubuntu-latest` e `windows-latest`: [execução 30862534188](https://github.com/Myerzx/Void-Modpack/actions/runs/30862534188); 178 casos passam no Linux e os 176 aplicáveis passam no Windows, com dois sockets Unix ignorados;
- auditoria pré-Fase 7 aprovada na [matriz Windows/Linux 30880499197](https://github.com/Myerzx/Void-Modpack/actions/runs/30880499197): os dois sistemas validaram a base de 299 componentes, executaram o gate completo e concluíram `npm audit --omit=dev` sem falha;
- matriz CI de fechamento da Fase 5 aprovada em `ubuntu-latest` e `windows-latest`: [execução 30859356360](https://github.com/Myerzx/Void-Modpack/actions/runs/30859356360); 149 casos passam no Linux e os 147 aplicáveis passam no Windows, com dois sockets Unix ignorados;
- matriz CI de fechamento da Fase 4 aprovada em `ubuntu-latest` e `windows-latest`: [execução 30855561911](https://github.com/Myerzx/Void-Modpack/actions/runs/30855561911); 125 casos passam no Linux e os 123 aplicáveis passam no Windows, com dois sockets Unix ignorados;
- matriz CI do inventário reconciliado aprovada em `ubuntu-latest` e `windows-latest`: [execução 30852157194](https://github.com/Myerzx/Void-Modpack/actions/runs/30852157194); os 95 casos passam no Linux e os 93 aplicáveis passam no Windows;
- matriz CI final da Fase 3 aprovada em `ubuntu-latest` e `windows-latest`: [execução 30848108269](https://github.com/Myerzx/Void-Modpack/actions/runs/30848108269); os 79 casos passam no Linux e os 77 aplicáveis passam no Windows;
- matriz CI do console aprovada em `ubuntu-latest` e `windows-latest`: [execução 30840780189](https://github.com/Myerzx/Void-Modpack/actions/runs/30840780189);
- matriz CI das métricas aprovada em `ubuntu-latest` e `windows-latest`: [execução 30842410863](https://github.com/Myerzx/Void-Modpack/actions/runs/30842410863);
- matriz CI do backup/restore aprovada em `ubuntu-latest` e `windows-latest`: [execução 30845229436](https://github.com/Myerzx/Void-Modpack/actions/runs/30845229436); os 10 testes passam no Linux e os 9 aplicáveis passam no Windows;
- `npm audit --omit=dev`: zero vulnerabilidades de runtime;
- Graphify atualizado após a conclusão da fase, com diagnóstico de integridade sem arestas ausentes, pendentes, duplicadas, autociclos ou colapsadas.

## Riscos não resolvidos

- o estado do adaptador é local à memória; não existe reconciliação após reinício do agente;
- o histórico idempotente e a exclusão mútua são locais à instância; não sobrevivem a crash ou reinício;
- persistência de PID, lock entre processos e reconciliação com processo órfão ainda não existem;
- snapshots de console não possuem cursor e ainda não aplicam a política futura de redação para exposição remota;
- recibos de comando não são auditoria nem idempotência durável e não confirmam processamento pelo Minecraft;
- snapshot de métricas não possui persistência, agregação, alerta nem transporte remoto;
- `node:os` descreve a visão do host fornecida ao Node e ainda não prova limites de container/cgroup;
- CPU e RSS da JVM exigem um observador portátil futuro e permanecem indisponíveis;
- a guarda offline usada pelo backup ainda é somente um trust boundary injetado; não existe lock durável compartilhado com start/stop nem reconciliação após crash;
- o fluxo online `save-off`/`save-all flush`/`save-on` continua desabilitado porque o console ainda não confirma processamento;
- o filesystem local ainda não é o backend P1 de storage; retenção destrutiva, assinatura, criptografia e imutabilidade externa não estão implementadas;
- SHA-256 detecta corrupção, mas não autentica a origem do snapshot;
- restore isolado não troca o mundo ativo, não inicia Minecraft e não certifica boot, dimensões, inventários ou dados de mods;
- a guarda offline de configuração também é apenas um trust boundary injetado e ainda não compartilha exclusão durável com processo, backup ou file manager;
- o lock de configuração é um arquivo local e pode ficar obsoleto após crash; não existe reconciliação operacional;
- o codec implementa somente um subconjunto estrito de Java Properties e exige que todos os campos estejam registrados; não suporta escapes, continuação, JSON, TOML, YAML ou configs de mods;
- revisões podem conter segredos presentes no arquivo anterior; storage cifrado, permissões operacionais, retenção e backend remoto ainda não existem;
- uma revisão publicada é preservada quando a substituição falha; o resultado precisa ser correlacionado pela auditoria futura antes de exibição como histórico aplicado;
- `restartRequired` é apenas metadata; nenhuma mutação agenda ou executa restart;
- configuração não possui persistência PostgreSQL, ator, motivo humano, autorização, auditoria ou integração com agente/API/painel;
- o catálogo atual do launcher não possui SHA-256/tamanho e o inventário do servidor não possui proveniência/licença completa; não existe reconciliação real dos artefatos atuais;
- sugestão de lado por presença não prova compatibilidade de loader, comportamento em jogo ou necessidade de dependências;
- o reconciliador é puro e não possui persistência, histórico, ator, autorização, auditoria, exportador, importador, API, painel ou integração com worker;
- colisão de filename é conservadora e exige revisão humana; o pacote não tenta inferir versão pelo nome do arquivo;
- classificação e análise do catálogo são puras e não possuem persistência, autorização ou trilha de auditoria durável;
- o avaliador cobre somente a sintaxe Maven documentada e o corpus sanitizado; operadores Fabric/SemVer, formas malformadas e baseline ausente permanecem `unknown`;
- a validação de quarentena comprova limite, hash, tamanho e assinatura inicial, mas não certifica a estrutura ZIP completa, malware, mod ID, licença ou compatibilidade;
- quarentena não possui endpoint, retenção, antivírus, promoção, backend externo ou inspeção profunda;
- o registro de raízes do file manager continua sendo uma entrada confiável de construção; não há descoberta, criação, delete, move, copy ou download público;
- revisões de arquivo podem preservar segredos do conteúdo anterior e precisam de storage cifrado, retenção e autorização antes de uso operacional;
- o manifesto de revisão de arquivo registra estado `prepared-before-replacement`; uma falha posterior exige correlação futura com auditoria e recibo antes de ser exibida como aplicada;
- schemas genéricos e seu histórico vivem somente na memória e não leem, interpretam, serializam ou aplicam formatos reais;
- transporte mTLS real, rotação de certificado e supervisor do agente ainda não foram implantados;
- autenticação Minecraft, whitelist e RCON continuam P0;
- cliente, origem/licença e classificação de lado continuam incompletos;
- o repositório de releases implementado usa filesystem local encapsulado; object storage, replicação, retenção e recuperação operacional continuam P1;
- o builder recebe raízes, catálogo, signer e executor como dependências confiáveis; ainda não existe registry persistente de planos nem wiring de produção;
- sanitização operacional cobre bytes revisados, JSON objeto e subconjunto simples de Properties; TOML/YAML/CFG exigem adapters próprios ou bytes finais previamente revisados;
- a Launcher API recalcula integridade antes de abrir o stream, mas imutabilidade e controle de escrita do backend continuam premissas operacionais;
- o planner produz plano e próximo estado, mas não baixa, aplica rename, cria rollback local nem integra um launcher específico;
- o núcleo do Bridge não depende do Forge, não está empacotado como mod e não possui transporte local ao agente;
- as chaves Ed25519 reais, rotação, HSM/secret store e cerimônia de promoção ainda não foram definidos;
- advisories transitivos do Next de build estático continuam documentados em `PHASE_2_VALIDATION.md`.
- perfis, aliases, bindings e casos da Fase 6 vivem somente na memória; não há repositório PostgreSQL, API, paginação ou reconciliação após restart;
- autenticação Minecraft permanece P0 e nenhum vínculo painel-jogador foi criado;
- provider de permissões Forge permanece P1; os fakes apenas validam a porta e os recibos;
- executor de moderação não está conectado e estado puro não prova kick/mute/ban aplicado no Minecraft;
- política exata, base/finalidade, prazos e responsáveis por atividade/chat/coordenadas continuam P1; nenhum dado foi coletado;
- cadeia SHA-256 detecta alteração interna, mas ainda não possui assinatura/âncora externa, storage imutável, criptografia, retenção ou cerimônia de export;
- `AuditRepository` limita verificação/export a 100.000 registros por operação e ainda não possui paginação/âncora incremental para partições maiores;

## Próximo recorte recomendado

Executar a **Fase 7.1** do [`FINAL_IMPLEMENTATION_PLAN.md`](FINAL_IMPLEMENTATION_PLAN.md): registrar um ADR escolhendo explicitamente o primeiro schema da Fase 7, com proprietário, versão, campos, limites, segredo, restart e migração. A recomendação planejada é `java_properties_v1` para provar o fluxo ponta a ponta antes de `forge_toml_v1`, mas a escolha continua sendo decisão do proprietário e não deve ser inferida silenciosamente. Não iniciar persistência, API, agente ou painel antes desse gate.

## Commits relevantes

- `ed450a4` — planos e contrato inicial da Fase 3;
- `d4cf50c` — runtime e adaptadores gerenciados;
- `f6f3058` — geração limpa dos tipos de rota do painel;
- `7eae482` — fixture Java pré-compilada e limpeza segura no Windows;
- `396a5d4` — grafo atualizado do recorte.
- `c2d0ff4` — contrato documentado do controlador serializado;
- `864f6ba` — implementação do controlador de ciclo de vida;
- `121ea3f` — testes de idempotência, concorrência e restart real em fixture.
- `7aa01e1` — contrato documentado do console limitado;
- `ea487d6` — snapshots e catálogo fechado de comandos;
- `dec8e79` — testes de limites, concorrência e fixture Java.
- `9809068` — contrato documentado das métricas com disponibilidade explícita;
- `8adf3ab` — snapshots de host/processo e integração no adaptador;
- `806b44b` — testes de fontes, validação e ciclo de vida das métricas.
- `86afe55` — validação local, limites e handoff do recorte;
- `408b57e` — grafo atualizado da arquitetura de métricas.
- `dd03049` — contrato documentado de backup consistente e restore isolado;
- `862ffaa` — snapshots guardados e restore de filesystem;
- `c3d540c` — testes de integridade, limites e recuperação isolada.
- `351efbe` — validação local e handoff do recorte;
- `5c1a50f` — grafo atualizado da arquitetura de backup.
- `d40e59e` — contrato documentado de configuração tipada e revisão anterior;
- `6cf7819` — mutações Java Properties, manifestos, recuperação e rollback;
- `6129f63` — testes de tipos, concorrência, falhas e integridade.
- `68561a1` — validação local, limites e handoff do recorte;
- `fe07f18` — grafo atualizado da arquitetura de configurações;
- `268748d` — compatibilidade segura com aliases canônicos do Windows.
- `f6b2c2e` — contrato documental do inventário e catálogo reconciliado;
- `346dae7` — contratos e JSON Schemas de snapshot/relatório;
- `65a6078` — reconciliador determinístico por SHA-256;
- `b7e274a` — testes de conflitos, bloqueios e determinismo.
- `0a231cf` — validação local, limites e handoff do recorte;
- `01ebbcd` — grafo atualizado da arquitetura de reconciliação.
- `bb26aaf` — contrato único e limites de conclusão da Fase 4;
- `71bfb4d` — classificação revisável e análise de dependências/conflitos;
- `519926e` — quarentena opaca e limitada de artefatos;
- `0481276` — arquivos versionados em raízes autorizadas;
- `4a9085c` — schemas genéricos e histórico em memória.
- `5f1ecdd` — equivalência segura de aliases canônicos do Windows em quarantine e file manager.
- `fc08266` — contrato integral e gates da Fase 5;
- `f5f01d7` — build reproduzível, sanitização e assinatura Ed25519;
- `8fe76e5` — contratos de canal, estado do launcher e Bridge;
- `ea784b9` — artifacts imutáveis, promoção CAS e rollback;
- `8009fb3` — planner portátil verificado;
- `1c5f01f` — Launcher API somente leitura;
- `a6aae57` — núcleo Java 17 do Forge Bridge;
- `f799cee` — executor isolado de `modpack.build` por referência.
- `b4b142e` — contrato integral, privacidade e gates da Fase 6;
- `ca47d8a` — contratos portáteis de jogadores, política e export de auditoria;
- `257f447` — domínio puro de governança de jogadores;
- `0993208` — cadeia SHA-256 e export NDJSON;
- `55ceec7` — append transacional encadeado no PostgreSQL/PGlite.
- `55f48f7` — contratos v1 da compatibilidade contextual;
- `e23e68c` — motor contextual e ranges Maven com corpus de regressão;
- `a74e322` — gerador fixture-only, documentação regenerada e gate Python/CI.
- `41ecd0e` — fechamento da Fase 7.0 no plano, roadmap e handoff;
- `13f8952` — Graphify atualizado com o modelo de compatibilidade contextual.

Acrescentar decisões e validações a cada recorte. Nunca apagar riscos ainda abertos.
