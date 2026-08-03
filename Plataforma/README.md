# Plataforma de gerenciamento

Status: **Fase 1 — planejamento e documentação**.

Esta pasta será a raiz do futuro painel, agentes e protocolo de atualização do modpack. Nenhum serviço, interface ou integração com o Minecraft foi implementado nesta fase.

## Linguagens definidas

| Escopo | Linguagem | Motivo |
| --- | --- | --- |
| Painel, APIs, agente e worker | TypeScript estrito | Contratos compartilhados, validação estática e uma base comum entre web e serviços |
| Ponte do comando Forge | Java 17 | O comando roda dentro do servidor Forge 1.20.1, cujo runtime auditado usa Java 17 |
| Persistência | SQL/PostgreSQL | Integridade transacional, auditoria e fila durável de baixa escala |
| Automação operacional | PowerShell e shell mínimos | Somente adaptadores revisados; nunca comandos montados por concatenação |

## Estrutura futura

A árvore proposta está em [`docs/plataforma/ARCHITECTURE.md`](../docs/plataforma/ARCHITECTURE.md). Os diretórios `apps/`, `packages/`, `integrations/` e `infra/` somente serão criados quando a Fase 2 for autorizada.

## Regras desta fase

- não criar `package.json`, projeto Next.js, API, banco ou mod Forge;
- não modificar o launcher ou o runtime privado do servidor;
- registrar decisões em ADRs antes de escolher ou trocar tecnologia;
- manter painel, agente, worker, launcher e ponte Forge como limites distintos;
- tratar segurança, auditoria e rollback como requisitos de arquitetura, não tarefas posteriores.

Comece pela [documentação da plataforma](../docs/plataforma/README.md).
