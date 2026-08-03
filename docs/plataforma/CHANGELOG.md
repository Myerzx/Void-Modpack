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

### Não habilitado

Start/stop/restart na API, integração com agente, console genérico, force kill, backup, restore ou acesso ao servidor privado. O único processo iniciado nos testes é a fixture Java versionada, executada em diretório temporário.

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
