# Changelog da plataforma

Todas as mudanças relevantes de planejamento e, futuramente, implementação serão registradas aqui.

## 2026-08-10 — ordem efetiva de datapacks no Server Agent

### Adicionado

- contratos fechados de comando/resultado e capability/job type `datapack-load-order.observe`, sem path ou payload operacional extensível;
- migration `0028` com allowlists de grant/lease e idempotência operacional por `job_id` único;
- reader de filesystem construído da workspace `server` registrada e limitado ao literal `world/level.dat`, com recusa de links e orçamento de 8 MiB;
- handler offline exclusivo, persistência e auditoria atômicas, replay sem nova leitura e readiness com razões explícitas.

### Validado

- 108 testes de contratos, 61 do banco e 115 do Server Agent;
- corpus NBT sintético materializado somente em diretórios temporários, sem ler ou copiar o runtime privado.

### Não habilitado

Control API, nova permissão/RBAC, painel, smoke do mundo privado e mudança no gate de edição semântica.

## 2026-08-09 — Fases 19–20: recursos de datapack revisados

### Adicionado

- registry fechado de schemas de recurso no analyzer 1.3.0, com `mmorpg-gear-rarity@1.0.0` como primeiro adapter real;
- 368 configurações semânticas ligadas a oito resources, seus systems, arquivos, defaults embutidos e evidências;
- seis conflitos persistidos por coordenada e SHA-256, com ordem desconhecida explícita e edição bloqueada;
- filtros e paginação de resources, drawer técnico, escopo por resource e staging pelo painel;
- ADR-017 fixando forma exata, defaults comprovados, campos read-only, gates de hash/conflito e ausência de apply.

### Validado

- snapshot real com 175 mods, 4.367 configurações, 5.445 resources e 20.824 relações;
- ciclo `validar → staging → diff → descartar` sem alterar o SHA-256 do arquivo original;
- `npm run check` integral, navegador sobre dados reais e Graphify incremental.

### Não habilitado

Apply no workspace, inferência de load order, edição de conflito, JSON genérico, console ao vivo, backup e `artifact.install`.

## 2026-08-04 — Fase 7.1: primeiro schema específico

### Adicionado

- ADR-008 selecionando `openloader_advanced_options_v1` por decisão explícita do proprietário;
- schema OpenLoader v1.0.0 limitado a `config/openloader/advanced_options.json` e aos dois campos booleanos `enabled`;
- parser e serializador determinísticos com limite de 4.096 bytes, rejeição de chaves duplicadas e SHA-256 de schema fixado;
- fixtures sanitizadas para default, desativação de data packs e rejeição de path;
- candidato único selecionado e validação documental deny-by-default.

### Não habilitado

`additionalFolders`, data/resource packs, paths ou schemas fornecidos pelo usuário, persistência, aplicação em filesystem, API, agente, painel e restart. O codec opera somente sobre valores/fixtures em isolamento até a Fase 7.2.

## 2026-08-03 — Fase 6: jogadores e auditoria em isolamento

### Adicionado

- cinco contratos v1 e JSON Schemas para perfil/alias, binding Minecraft, moderação, política de dados e manifesto de export de auditoria;
- `@voidfall/player-governance` com perfis por UUID, aliases limitados, revisão/idempotência, grupos provider-neutral e moderação tipada;
- decisões deny-by-default para coleta, leitura e exportação de atividade, chat e coordenadas sem receber conteúdo sensível;
- `@voidfall/audit-chain` com SHA-256 por partição, verificação de adulteração e NDJSON canônico;
- migração `0003_audit_chain.sql` e append transacional com cabeça bloqueada, sequência contígua, verificação e export no repositório de auditoria;
- gate local e [matriz Ubuntu/Windows 30862534188](https://github.com/Myerzx/Void-Modpack/actions/runs/30862534188) aprovados com 178 casos no Linux, 176 aplicáveis no Windows e dois sockets Unix ignorados.

### Não habilitado

Importação de arquivos ou jogadores reais, autenticação Minecraft, provider Forge, aplicação de grupos/moderação, coleta de chat/coordenadas, rotas/telas sensíveis e export para storage externo. UUID é identidade; alias nunca concede acesso.

## 2026-08-03 — Fase 5: build e launcher em isolamento

### Adicionado

- build por entradas explícitas, staging privado, sanitização versionada e limpeza em falha;
- manifesto e canais em JSON canônico assinados por Ed25519;
- repositório local encapsulado com artifacts SHA-256, releases imutáveis, CAS e rollback;
- contratos portáteis de canal, estado gerenciado e intenção do Forge Bridge;
- planner `portable-v1` com chave pinada e operações `keep/download/replace/remove`;
- Launcher API Fastify somente leitura;
- worker `modpack.build` limitado a `planId` opaco e executor injetado;
- núcleo Java 17 do Forge Bridge com permissão, expiração, nonce e capabilities;
- gate local e [matriz Ubuntu/Windows 30859356360](https://github.com/Myerzx/Void-Modpack/actions/runs/30859356360) aprovados com 149 casos no Linux, 147 aplicáveis no Windows e auditoria de runtime sem vulnerabilidades.

### Não habilitado

Cliente real, publicação `stable`, adapter Forge, endpoint local do Bridge e `/atualizar-modpack`. Os gates de cliente-base, distribuição, importação e compatibilidade continuam obrigatórios e sem bypass.

## 2026-08-03 — Fase 4: inventário reconciliado

### Adicionado

- contratos v1 `InventorySnapshot` e `CatalogReconciliationReport` com JSON Schemas portáteis;
- snapshots sanitizados com fonte/escopo, runtime, paths canônicos, estado, tamanho e SHA-256;
- `@voidfall/mod-catalog` com identidade de conteúdo por hash e ID lógico mantido no catálogo revisado;
- agrupamento determinístico de ocorrências cliente/servidor e sugestão não autoritativa de lado;
- estados `cataloged`, `untracked` e `ambiguous`, além de bloqueios de presença, lado, distribuição, revisão, runtime, filename e tamanho;
- relatório profundamente imutável e validado, sem imports de filesystem ou rede;
- 4 novos testes de contrato e 12 testes do reconciliador;
- gate integral aprovado com 95 casos e auditoria de runtime sem vulnerabilidades na [matriz Ubuntu/Windows 30852157194](https://github.com/Myerzx/Void-Modpack/actions/runs/30852157194).

### Não habilitado

Varredura do runtime privado, leitura/execução de JARs, integração com provedores, importação dos inventários atuais, classificação automática, persistência, API, painel, worker ou publicação. Filename e metadata do launcher não são tratados como identidade ou licença.

## 2026-08-03 — Fase 3: abertura segura

### Adicionado

- `@voidfall/minecraft-process` com planos de processo Windows/Linux;
- validação de paths absolutos, nome do JAR e limites de memória;
- argv fixo, `shell: false`, janela oculta no Windows e stdio explícito;
- máquina de estados observada e interface para futuros adaptadores.
- runtime Node com ambiente mínimo, PID, saída limitada e tratamento de executável ausente;
- adaptadores Windows/Linux com detecção de boot e `stop` gracioso;
- fixture Java 17 descartável e matriz CI Ubuntu/Windows.
- fixture compilada antecipadamente com `javac` e limpeza graciosa rastreada para evitar vazamento de processo no primeiro uso frio do Windows.
- matriz GitHub Actions aprovada em Ubuntu e Windows após a correção do typecheck limpo do Next.js e da inicialização fria da fixture Java.
- controlador serializado de `start`, `stop` e `restart`, preso a um plano confiável e sem payload operacional extensível;
- deduplicação idempotente em voo e concluída, histórico limitado, rejeição sem fila e eventos de estado determinísticos;
- restart condicionado à confirmação de `offline`, timeout sem force kill e falhas de adaptador sanitizadas;
- testes determinísticos do controlador e ciclo completo contra a fixture Java descartável.
- gate integral aprovado em Ubuntu e Windows na execução `30833243148`, com 48 testes e auditoria de runtime sem vulnerabilidades.
- snapshot de console por linhas com remoção de ANSI/controles, limites de linhas/caracteres e sinalização de truncamento;
- catálogo sem argumentos com somente `list-players` e `save-all`, convertido internamente para literais fixos;
- revalidação no runtime e exclusão sem fila entre efeitos de start, stop e comando;
- fixture Java ampliada para comprovar os dois comandos sem acessar o servidor privado.
- gate integral do console aprovado em Ubuntu e Windows na execução `30840780189`, com 53 testes e auditoria de runtime sem vulnerabilidades.
- snapshot imutável de métricas com fonte, unidade, timestamp e qualidade `real`, `calculated` ou `unavailable`;
- coleta portátil de memória, uptime e CPUs do host, além de estado, PID e uptime gerenciado do processo;
- motivos tipados para ausência de PID/uptime e indisponibilidade honesta de CPU/RSS da JVM;
- validação de amostras e relógios, testes determinísticos e transição comprovada na fixture Java descartável;
- gate integral aprovado com 58 testes e auditoria de runtime sem vulnerabilidades na [matriz Ubuntu/Windows 30842410863](https://github.com/Myerzx/Void-Modpack/actions/runs/30842410863).
- `@voidfall/server-backup` com guarda offline exclusiva obrigatória, inventário limitado e manifesto canônico v1;
- snapshots imutáveis promovidos de staging por `rename`, com verificação SHA-256 da origem e do destino;
- restore permitido somente para destino novo e isolado, com nova verificação antes da promoção;
- rejeição de sobreposição, traversal, colisões por case fold, symlink/junction, hardlink e tipos especiais;
- erros públicos sanitizados, recibos imutáveis e limpeza restrita ao diretório parcial da própria operação;
- 10 testes do pacote cobrindo integridade, limites e recuperação de falhas;
- gate integral aprovado com 68 casos e auditoria de runtime sem vulnerabilidades na [matriz Ubuntu/Windows 30845229436](https://github.com/Myerzx/Void-Modpack/actions/runs/30845229436).
- `@voidfall/server-configuration` com registro fechado de recursos e codec estrito `java-properties-v1`;
- schemas básicos de boolean, inteiro, enum e string, com limites e necessidade de restart;
- concorrência otimista por SHA-256, guarda offline obrigatória e lock exclusivo por recurso;
- revisão anterior imutável com manifesto canônico, escrita sincronizada e publicação antes da troca;
- substituição verificada com recuperação automática dos bytes anteriores em saída divergente;
- rollback que também captura revisão, sem restart ou alteração de runtime;
- 11 testes do pacote cobrindo tipos, sintaxe, links, concorrência, falhas, integridade e rollback;
- detecção de links por componentes reais do filesystem, preservando contenção sem rejeitar aliases 8.3 legítimos do Windows;
- gate integral aprovado com 79 casos e auditoria de runtime sem vulnerabilidades na [matriz Ubuntu/Windows 30848108269](https://github.com/Myerzx/Void-Modpack/actions/runs/30848108269).

### Não habilitado

Start/stop/restart na API, integração com agente, console genérico, force kill, backup/restore/configuração operacional ou acesso ao servidor privado. O único processo iniciado nos testes é a fixture Java versionada; os testes de backup e configuração usam somente diretórios temporários.

## 2026-08-03 — Fase 2: fundação concluída

### Adicionado

- PostgreSQL, migrações imutáveis, repositórios e seed RBAC;
- autenticação Argon2id, sessões opacas, CSRF, rate limit e lockout;
- Control API mínima, auditoria e respostas públicas sanitizadas;
- fila transacional com lease/idempotência e worker limitado a `system.noop`;
- provisionamento de agente de uso único e heartbeat Ed25519 com proteção contra replay;
- dashboard VoidFall responsivo, somente leitura e identificado como fixture;
- testes de integração e relatório do gate da fase.

## 2026-08-03 — Fase 2: fundação de contratos

### Adicionado

- identidade oficial VoidFall e namespace `@voidfall/*`;
- npm workspace com Node 24 LTS, npm e dependências fixados;
- contratos v1 de `Job`, `AgentEnvelope`, `ModCatalogEntry`, `ReleaseManifest` e `AuditEvent`;
- validação estrutural Ajv em modo estrito e invariantes semânticas sem efeitos externos;
- exportação de JSON Schemas portáteis para consumidores não TypeScript;
- testes de paths, proveniência, identidade, lease, validade temporal e redação de auditoria.

### Ainda não implementado naquele recorte

Este registro descreve o primeiro recorte da Fase 2; os itens foram implementados no encerramento acima, exceto ponte Forge, launcher próprio e controle real do Minecraft.

## 2026-08-03 — Fase 1

### Adicionado

- contexto consolidado da plataforma;
- arquitetura e escolha de linguagens;
- protocolos de build e launcher;
- modelos iniciais de dados e API;
- estratégias de segurança, permissões, logs, métricas e deployment;
- roadmap, riscos, perguntas e handoff;
- cinco decisões arquiteturais iniciais.

### Implementação

Nenhuma. Esta entrega é deliberadamente documental.
