# Plataforma de gerenciamento

Status: **Fase 2 — fundação**.

Esta pasta é a raiz do futuro painel, agentes e protocolo de atualização do modpack VoidFall. O primeiro recorte da Fase 2 cria somente o workspace TypeScript e os contratos compartilhados. Nenhum serviço, interface ou integração com o Minecraft foi implementado.

## Linguagens definidas

| Escopo | Linguagem | Motivo |
| --- | --- | --- |
| Painel, APIs, agente e worker | TypeScript estrito | Contratos compartilhados, validação estática e uma base comum entre web e serviços |
| Ponte do comando Forge | Java 17 | O comando roda dentro do servidor Forge 1.20.1, cujo runtime auditado usa Java 17 |
| Persistência | SQL/PostgreSQL | Integridade transacional, auditoria e fila durável de baixa escala |
| Automação operacional | PowerShell e shell mínimos | Somente adaptadores revisados; nunca comandos montados por concatenação |

## Estrutura

A árvore planejada está em [`docs/plataforma/ARCHITECTURE.md`](../docs/plataforma/ARCHITECTURE.md). Nesta abertura da Fase 2, apenas `packages/contracts/` pode ser criado. `apps/`, `integrations/` e `infra/` permanecem bloqueados até tarefas posteriores.

## Regras do recorte atual

- não criar projeto Next.js, API, banco, agente, worker, adaptador de processo ou mod Forge;
- não modificar o launcher ou o runtime privado do servidor;
- registrar decisões em ADRs antes de escolher ou trocar tecnologia;
- manter painel, agente, worker, launcher e ponte Forge como limites distintos;
- tratar segurança, auditoria e rollback como requisitos de arquitetura, não tarefas posteriores.

## Contratos compartilhados

O pacote `@voidfall/contracts` é a única implementação autorizada neste recorte. Ele contém schemas JSON e tipos TypeScript para `Job`, `AgentEnvelope`, `ModCatalogEntry`, `ReleaseManifest` e `AuditEvent`, além de validações semânticas que não executam operações externas.

Comece pela [documentação da plataforma](../docs/plataforma/README.md).
