# Handoff da plataforma

## Estado atual

- Data: 2026-08-03
- Responsável: Codex
- Fase: 3 — adaptadores isolados implementados; restart/orquestração pendentes
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
  - fixture Java 17 executada em diretório temporário;
- workflow de CI com Node 24 e Java 17 em Ubuntu/Windows.

## Limites obrigatórios

1. Não modificar `Launcher/`, `Servidor/workspace/`, mundos, configs privadas ou o processo Minecraft real.
2. Não expor `ProcessLaunchPlan`, shell, argumento, cwd ou texto de comando como payload público.
3. Não ligar os adaptadores ao agente/API antes de contratos operacionais estreitos, autorização, auditoria e idempotência por ação.
4. Não adicionar método genérico de stdin, force kill ou restore.
5. Não habilitar RCON; o segredo histórico precisa ser rotacionado e a decisão de remoção continua P0.
6. Não iniciar produção Minecraft antes de definir a topologia de autenticação oficial/proxy.
7. Não promover modpack stable antes de cliente canônico, proveniência e licenças.

## Validação

- pacote de processo: build, typecheck e 7 testes aprovados com Java 17;
- gate local aprovado: 40 testes, typechecks e builds de todos os workspaces;
- matriz CI aprovada em `ubuntu-latest` e `windows-latest`: [execução 30827511608](https://github.com/Myerzx/Void-Modpack/actions/runs/30827511608);
- `npm audit --omit=dev`: zero vulnerabilidades de runtime;
- Graphify atualizado com 971 nós, 1.219 arestas e diagnóstico de integridade sem arestas ausentes, pendentes, duplicadas ou colapsadas.

## Riscos não resolvidos

- o estado do adaptador é local à memória; não existe reconciliação após reinício do agente;
- restart serializado, concorrência/idempotência operacional e persistência de PID ainda não existem;
- transporte mTLS real, rotação de certificado e supervisor do agente ainda não foram implantados;
- autenticação Minecraft, whitelist e RCON continuam P0;
- cliente, origem/licença e classificação de lado continuam incompletos;
- advisories transitivos do Next de build estático continuam documentados em `PHASE_2_VALIDATION.md`.

## Próximo recorte recomendado

Implementar dentro de `@voidfall/minecraft-process` um controlador serializado de start/stop/restart com chave idempotente, uma única operação em voo, timeout explícito e eventos determinísticos. Usar runtime falso e a fixture Java; ainda não criar rotas, jobs operacionais ou integração com `server-agent`.

## Commits relevantes

- `ed450a4` — planos e contrato inicial da Fase 3;
- `d4cf50c` — runtime e adaptadores gerenciados;
- `f6f3058` — geração limpa dos tipos de rota do painel;
- `7eae482` — fixture Java pré-compilada e limpeza segura no Windows;
- `396a5d4` — grafo atualizado do recorte.

Acrescentar decisões e validações a cada recorte. Nunca apagar riscos ainda abertos.
