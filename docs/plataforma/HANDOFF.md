# Handoff da plataforma

## Estado atual

- Data: 2026-08-03
- Responsável: Codex
- Fase: 3 — primeiro recorte seguro em andamento
- Fase 2: concluída e validada
- Runtime Minecraft: não modificado e não conectado

## Implementado

- monorepo TypeScript estrito e contratos `Job`, `AgentEnvelope`, `ModCatalogEntry`, `ReleaseManifest` e `AuditEvent`;
- PostgreSQL com migrações, repositórios, RBAC e fila `SKIP LOCKED`;
- Argon2id, sessões opacas, CSRF, rate limit, lockout, revogação e auditoria;
- Control API mínima com health, autenticação, servidores/auditoria somente leitura e identidade do agente;
- worker que aceita exclusivamente `system.noop`;
- agente outbound-only para provisionamento e heartbeat Ed25519;
- dashboard estático de demonstração, responsivo e sem controles operacionais;
- início da Fase 3 com planos Windows/Linux, argv fixo e máquina de estados, ainda sem spawn.

## Limites obrigatórios

1. Não modificar `Launcher/`, `Servidor/workspace/`, mundos, configs privadas ou processo Minecraft a partir deste handoff.
2. Não expor shell, texto de comando, path livre ou argumento arbitrário por API/job.
3. Não ligar `@voidfall/minecraft-process` ao agente/API antes de uma tarefa delimitada, autorização/auditoria por operação e teste com processo descartável.
4. Não habilitar RCON; o segredo histórico precisa ser rotacionado e a decisão de remoção continua P0.
5. Não iniciar produção Minecraft antes de definir a topologia de autenticação oficial/proxy.
6. Não promover modpack stable antes de cliente canônico, proveniência e licenças.

## Arquivos para continuidade

- `docs/plataforma/ROADMAP.md`
- `docs/plataforma/PHASE_2_VALIDATION.md`
- `docs/plataforma/DECISIONS/ADR-007-fase-2-concluida-e-fase-3-segura.md`
- `Plataforma/packages/minecraft-process/`
- `Plataforma/apps/control-api/`
- `Plataforma/apps/server-agent/`
- `Plataforma/AGENTS.md`

## Validação

- `npm run check`: build, typecheck e 36 testes aprovados no monorepo após a abertura segura da Fase 3;
- `npm audit --omit=dev`: zero vulnerabilidades no conjunto de runtime;
- painel: build estático e inspeção headless em desktop/mobile;
- Graphify deve ser atualizado e validado após o último commit documental.

## Riscos não resolvidos

- cliente e servidor continuam incompatíveis pelo catálogo atual;
- origem/licença e lado de dependências continuam incompletos;
- autenticação Minecraft, whitelist e RCON continuam P0;
- transporte mTLS real, rotação de certificado e supervisor do agente ainda não foram implantados;
- o audit completo do workspace reporta advisories transitivos no Next usado apenas durante o build estático; detalhes em `PHASE_2_VALIDATION.md`.

## Próximo recorte recomendado

Implementar adaptadores Windows/Linux atrás da interface `MinecraftProcessAdapter`, usando um runtime injetado e um processo Java de fixture descartável. O recorte deve comprovar: `shell: false`, processo filho identificado, timeout, captura limitada de stdout/stderr, parada graciosa simulada, nenhuma janela no Windows e zero acesso a `Servidor/workspace/`. Não criar rotas operacionais ainda.

## Commits relevantes

- `d0a6cc0` — autenticação e PostgreSQL;
- `3b2fa45` — Control API;
- `0014af7` — worker `noop`;
- `32f0480` — cliente do agente;
- `678aa4c` — dashboard somente leitura.

Acrescentar decisões e validações a cada recorte. Nunca apagar riscos ainda abertos.
