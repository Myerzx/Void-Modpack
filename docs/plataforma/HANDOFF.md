# Handoff da plataforma

## Estado atual

- Data: 2026-08-03
- Responsável: Codex
- Fase: 4 — item 1 implementado e validado localmente em isolamento; matriz CI pendente
- Fase 2: concluída e validada
- Runtime Minecraft privado: não modificado e não conectado

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
- workflow de CI com Node 24 e Java 17 em Ubuntu/Windows.

## Limites obrigatórios

1. Não modificar `Launcher/`, `Servidor/workspace/`, mundos, configs privadas ou o processo Minecraft real.
2. Não expor `ProcessLaunchPlan`, shell, argumento, cwd ou texto de comando como payload público.
3. Não ligar os adaptadores ao agente/API antes de contratos operacionais estreitos, autorização, auditoria e idempotência por ação.
4. Não adicionar método genérico de stdin, force kill ou restore operacional; o restore isolado não autoriza troca de mundo.
5. Não habilitar RCON; o segredo histórico precisa ser rotacionado e a decisão de remoção continua P0.
6. Não iniciar produção Minecraft antes de definir a topologia de autenticação oficial/proxy.
7. Não promover modpack stable antes de cliente canônico, proveniência e licenças.
8. Não tratar o codec inicial como editor Java Properties completo ou genérico; JSON/TOML/YAML, schemas de mods e paths públicos permanecem bloqueados.
9. Não tratar presença, filename, project/file ID ou `distributionAllowed` como identidade lógica, lado aprovado ou licença.
10. Não importar os inventários atuais como catálogo real antes que o cliente possua SHA-256/tamanho e a revisão manual seja registrada.

## Validação

- pacote de processo: build, typecheck e 25 testes aprovados com Java 17;
- pacote de backup: build, typecheck e 10 casos aprovados; no Windows, 9 executados e 1 socket Unix ignorado;
- pacote de configuração: build, typecheck e 11 casos aprovados; no Windows, 10 executados e 1 socket Unix ignorado;
- pacote de contratos: build, typecheck, 18 casos e 7 JSON Schemas aprovados;
- pacote de catálogo: build, typecheck e 12 casos aprovados;
- gate local aprovado: 95 casos, typechecks e builds de todos os workspaces; 93 executados no Windows e 2 sockets Unix ignorados;
- matriz CI final da Fase 3 aprovada em `ubuntu-latest` e `windows-latest`: [execução 30848108269](https://github.com/Myerzx/Void-Modpack/actions/runs/30848108269); os 79 casos passam no Linux e os 77 aplicáveis passam no Windows;
- matriz CI do console aprovada em `ubuntu-latest` e `windows-latest`: [execução 30840780189](https://github.com/Myerzx/Void-Modpack/actions/runs/30840780189);
- matriz CI das métricas aprovada em `ubuntu-latest` e `windows-latest`: [execução 30842410863](https://github.com/Myerzx/Void-Modpack/actions/runs/30842410863);
- matriz CI do backup/restore aprovada em `ubuntu-latest` e `windows-latest`: [execução 30845229436](https://github.com/Myerzx/Void-Modpack/actions/runs/30845229436); os 10 testes passam no Linux e os 9 aplicáveis passam no Windows;
- `npm audit --omit=dev`: zero vulnerabilidades de runtime;
- Graphify atualizado com 1.561 nós, 2.374 arestas e diagnóstico de integridade sem arestas ausentes, pendentes, duplicadas, autociclos ou colapsadas.

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
- transporte mTLS real, rotação de certificado e supervisor do agente ainda não foram implantados;
- autenticação Minecraft, whitelist e RCON continuam P0;
- cliente, origem/licença e classificação de lado continuam incompletos;
- advisories transitivos do Next de build estático continuam documentados em `PHASE_2_VALIDATION.md`.

## Próximo recorte recomendado

Após a matriz Windows/Linux do item 1 ficar verde, encerrar o recorte isolado e iniciar o item 2 da Fase 4: classificação manual por lado e distribuição. Antes de classificar os artefatos reais, criar um exportador de cliente que produza SHA-256/tamanho e um importador revisado para `InventorySnapshot`; não usar filename como identidade e não promover licença por metadata do provedor.

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

Acrescentar decisões e validações a cada recorte. Nunca apagar riscos ainda abertos.
