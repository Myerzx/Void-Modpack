# Plataforma de gerenciamento

Status: **Fase 3 — controle do Minecraft, primeiro recorte sem efeitos operacionais**.

Esta pasta é a raiz implementada do painel, da Control API, do agente, do worker e dos contratos da plataforma VoidFall. A Fase 2 foi concluída com persistência, autenticação, RBAC, auditoria, fila transacional, heartbeat assinado e dashboard estático de demonstração. A Fase 3 começou somente pelo contrato seguro de processo; nenhuma operação foi ligada ao servidor real.

## Linguagens definidas

| Escopo | Linguagem | Motivo |
| --- | --- | --- |
| Painel, APIs, agente e worker | TypeScript estrito | Contratos compartilhados, validação estática e uma base comum entre web e serviços |
| Ponte do comando Forge | Java 17 | O comando roda dentro do servidor Forge 1.20.1, cujo runtime auditado usa Java 17 |
| Persistência | SQL/PostgreSQL | Integridade transacional, auditoria e fila durável de baixa escala |
| Automação operacional | PowerShell e shell mínimos | Somente adaptadores revisados; nunca comandos montados por concatenação |

## Estrutura implementada

- `apps/control-api`: Fastify, sessões opacas, CSRF, RBAC, auditoria e identidade do agente;
- `apps/build-worker`: consumidor PostgreSQL limitado a `system.noop`;
- `apps/server-agent`: cliente outbound-only de registro e heartbeat Ed25519;
- `apps/panel-web`: dashboard responsivo somente leitura, exportado como site estático;
- `packages/contracts`, `authentication`, `permissions` e `database`: fundação compartilhada;
- `packages/minecraft-process`: início da Fase 3 com planos Windows/Linux e máquina de estados, ainda sem executar processos.

## Limite do recorte atual

- não chamar `spawn`, shell, serviço do Windows, systemd ou o Java do servidor;
- não modificar `Launcher/`, `Servidor/workspace/` ou qualquer runtime privado;
- não ligar start/stop/restart à API antes dos bloqueios do [roadmap](../docs/plataforma/ROADMAP.md);
- usar apenas executável e diretório absolutos de configuração confiável, argv fixo e `shell: false`;
- manter o dashboard como demonstração até existir telemetria real autenticada.

## Validação

```powershell
cd Plataforma
npm ci
npm run check
npm audit --omit=dev
```

O relatório da Fase 2 está em [`docs/plataforma/PHASE_2_VALIDATION.md`](../docs/plataforma/PHASE_2_VALIDATION.md). Detalhes de integração, confiança e evolução estão em [`docs/plataforma/CONTRACTS.md`](../docs/plataforma/CONTRACTS.md).

Comece pela [documentação da plataforma](../docs/plataforma/README.md).
