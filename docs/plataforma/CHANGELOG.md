# Changelog da plataforma

Todas as mudanças relevantes de planejamento e, futuramente, implementação serão registradas aqui.

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
- 10 testes do pacote cobrindo integridade, limites e recuperação de falhas; validação local aprovada e matriz Ubuntu/Windows pendente.

### Não habilitado

Start/stop/restart na API, integração com agente, console genérico, force kill, backup/restore operacional ou acesso ao servidor privado. O único processo iniciado nos testes é a fixture Java versionada; os testes de backup usam somente diretórios temporários.

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
