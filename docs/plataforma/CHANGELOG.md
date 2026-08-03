# Changelog da plataforma

Todas as mudanças relevantes de planejamento e, futuramente, implementação serão registradas aqui.

## 2026-08-03 — Fase 2: fundação de contratos

### Adicionado

- identidade oficial VoidFall e namespace `@voidfall/*`;
- npm workspace com Node 24 LTS, npm e dependências fixados;
- contratos v1 de `Job`, `AgentEnvelope`, `ModCatalogEntry`, `ReleaseManifest` e `AuditEvent`;
- validação estrutural Ajv em modo estrito e invariantes semânticas sem efeitos externos;
- exportação de JSON Schemas portáteis para consumidores não TypeScript;
- testes de paths, proveniência, identidade, lease, validade temporal e redação de auditoria.

### Ainda não implementado

Serviços, banco, migrações, UI, agente, worker, ponte Forge, launcher próprio e qualquer controle real do Minecraft.

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
