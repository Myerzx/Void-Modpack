# Plano — iniciar o servidor pelo painel

O que existe, o que falta, e em que ordem. Levantado do código em 2026-08-08, não de memória.

---

## O que já está pronto

Mais do que parece. A Fase 9/10 construiu a operação inteira e ninguém nunca a ligou:

| Peça | Onde | Estado |
| --- | --- | --- |
| Controlador de processo | `minecraft-process/src/controller.ts` | ✅ com máquina de estado |
| Adaptadores de processo | `node-runtime.ts`, Windows e Linux | ✅ inclusive `forceTerminate` |
| Plano de lançamento `-jar` | `createMinecraftProcessPlan` | ✅ serve vanilla, Paper, Spigot |
| Plano de lançamento Forge | `createForgeArgsFileProcessPlan` | ✅ e **provado** — é o que a sandbox usa |
| Capability `process.control` | `server-agent/src/process-operation.ts` | ✅ com lease e operação durável |
| Readiness que a desliga | `readiness.ts` → `no-process-controller-configured` | ✅ |
| Rota da API | `POST /api/v1/servers/:id/process/control` | ✅ |
| Console: leitura, envio, histórico | migrações `0009`/`0010`, `process-routes.ts` | ✅ |
| Métricas de processo | `metrics.ts`, `server_process_states` | ✅ |

O boot real de 102 segundos que a sandbox executou usou **exatamente** este controlador e este adaptador. A máquina funciona.

---

## Os cinco buracos que orientaram a implementação

### ~~1. O agente monta o plano errado~~ — resolvido em 2026-08-08

O agente seleciona `createForgeArgsFileProcessPlan` para Forge/NeoForge e mantém o plano `-jar` para Fabric/Paper/Spigot/vanilla. O plano vem do runtime detectado, não de um nome inventado pelo painel.

### ~~2. Não existe detecção de runtime~~ — resolvido em 2026-08-08

O runtime passou a ser **descoberto** com a mesma evidência usada pelo `sandbox-runner`:

```
libraries/net/minecraftforge/forge/<v>/{unix,win}_args.txt  -> forge, args file
libraries/net/neoforged/neoforge/<v>/…                      -> neoforge, args file
fabric-server-launch.jar | .fabric/                          -> fabric, -jar
paper-*.jar | spigot-*.jar | server.jar na raiz              -> paper/spigot/vanilla, -jar
nada reconhecido                                             -> recusa nomeada
```

### ~~3. Workspace e instância não se falam~~ — resolvido em 2026-08-08

`server_instances` ganhou `run_directory`, `runtime` e `runtime_detected_at`, e `panel_workspaces` ganhou a aresta opcional. `POST /api/v1/servers/:id/runtime` é o único lugar onde um caminho é enviado sobre uma instância, e é enviado uma vez; a resposta e a listagem carregam o descritor sem o diretório. `create` deliberadamente não aceita descritor: aceitar um na criação seria aceitar um que ninguém verificou.

### ~~4. O ambiente local não sobe o agente~~ — resolvido e endurecido em 2026-08-08

`npm run panel` sobe banco, API, painel e os agentes lógicos no mesmo processo local, cada um com identidade Ed25519, registro e heartbeat próprios.

**Medido em 2026-08-08, e o resultado muda o desenho.** Dois processos separados abriram e escreveram no mesmo diretório PGlite ao mesmo tempo, sem nenhuma recusa:

```
A: abriu e escreveu; segurando
B: ABRIU o mesmo diretório enquanto A o segura · linhas: 1
B: e ESCREVEU
```

A ausência de recusa é o perigo, não a permissão. PGlite não tem coordenação entre processos: cada um roda seu próprio Postgres em WebAssembly, com seu próprio cache, escrevendo nos mesmos arquivos. Isso corrompe em silêncio.

Então, no ambiente local, o agente roda **no mesmo processo** da Control API, compartilhando o único handle de banco. Isso não é um atalho: `AgentRuntime` recebe `repositories` como dependência justamente para isso, e o transporte continua sendo HTTP de loopback para a mesma API — a autoridade sobre o processo permanece no agente, e o protocolo permanece real.

`npm run panel` provisiona e registra pela rota real uma identidade por `ServerInstance`, constrói um `AgentRuntime` por instância e sincroniza a frota quando um runtime é vinculado ou alterado. Um lock atômico adquirido antes do PGlite impede duas cópias de `dist/local.js` sobre o mesmo estado; lock de PID morto é recuperado. Em produção o agente continua sendo processo separado contra PostgreSQL real.

### 5. Console ao vivo — concluído em 2026-08-09

stdout/stderr agora são capturados continuamente pelo runtime, persistidos pelo agente somente antes da confirmação do lote e lidos pelo painel com tail inicial, cursor, pausa e retenção. O único envio possível continua sendo o catálogo `list-players`/`save-all`. Backup e `artifact.install` continuam deliberadamente ausentes.

---

## Ordem de execução

~~**Passo 1 — detecção de runtime.**~~ **Feito em 2026-08-08.** `minecraft-process/src/runtime-detection.ts` lê um diretório e devolve família, forma de lançamento e entrada — Forge e NeoForge pelo args file, Fabric pelo launcher, Paper/Spigot/vanilla pelo jar. Um instalador nunca é confundido com o servidor, duas candidatas recusam em vez de escolher, e um layout desconhecido recusa com nome. A entrada é relativa ao diretório, porque o descritor termina num banco e depois numa tela.

~~**Passo 2 — o agente escolhe o plano certo.**~~ **Feito em 2026-08-08.** `VOIDFALL_SERVER_JAR` virou opcional: sem ele o runtime é detectado; com ele, vence, porque uma instalação estranha o bastante para precisar de nome é justamente onde a detecção não pode ser o único caminho. Contra o servidor real:

```
família   forge
forma     args-file
entrada   libraries/net/minecraftforge/forge/1.20.1-47.4.4/win_args.txt
comando   java -Xms4096M -Xmx8192M -Dfile.encoding=UTF-8 @libraries/.../win_args.txt nogui
```

~~**Passo 3 — instância com diretório e runtime.**~~ **Feito em 2026-08-08.** O workspace importado pode ser ligado por ID, sem repetir o path; o banco garante um diretório por instância e uma instância por workspace.

~~**Passo 4 — agente no ambiente local.**~~ **Feito e endurecido em 2026-08-08.** A frota local mantém identidade, claim de job e controlador isolados por `ServerInstance`, continua em loopback e recusa `NODE_ENV=production`.

~~**Passo 5 — console ao vivo.**~~ **Feito em 2026-08-09.** O fluxo completo e o smoke real estão em [PHASE_17_LIVE_CONSOLE.md](PHASE_17_LIVE_CONSOLE.md). Backup e `artifact.install` permanecem em recortes separados.

---

## O passo 4 em 2026-08-08: o servidor subiu, e três coisas apareceram

O agente roda no mesmo processo, registra pelo fluxo real, e **iniciou o servidor de verdade pelo painel**: JVM Forge lançado com `@…/win_args.txt`, heap chegando a 4,5 GiB, 205 linhas de console gravadas pela API, incluindo o carregamento do Mine and Slash.

O caminho até lá encontrou três defasagens, todas do mesmo tipo — contratos que pararam na fase em que foram escritos:

**Credencial de transporte.** O registro escreve `agents`; a reivindicação resolve `agent_credentials`, que é outro store, da Fase 9.1. Sem enrolar a credencial o agente registrava, anunciava, e tomava **401 em toda reivindicação**.

**Concessão de capability.** `agent_capability_grants` aceitava só o conjunto da Fase 9.1. Com a credencial resolvida, virou **403**: a capability existia no contrato, no handler e no anúncio, e não no único lugar que decide se pode ser servida.

**Registro de lease.** `agent_work_leases` tinha a mesma lista curta. Concedida a capability, a reivindicação seguinte quebrava com **500** — e o 500 não aparecia em lugar nenhum, porque o tratador de erro não registrava a causa. Registrar passou a ser a primeira correção, e ela pagou na primeira execução.

### Os buracos de lifecycle foram fechados

**~~A operação nunca liquida.~~ Corrigido.** O resultado do agente concluía o *job* e nunca a *operação*. São dois fatos diferentes e só o primeiro era escrito. Agora `/agent/v1/work/result` liquida a operação pelo `jobId`, de `accepted` ou `running`, e uma já liquidada é final. Preso por teste ponta a ponta.

**~~`observedState` não acompanha.~~ Corrigido.** `server_instances.observed_state` é uma coluna da Fase 1 que **nada jamais escreveu**. A observação real vive em `server_process_states`, com quem observou, quando, e se envelheceu — a listagem passou a ler de lá, com procedência, em vez de copiar para uma segunda coluna que depois teria de ser mantida verdadeira.

**~~O handler de start nunca retorna.~~ Corrigido.** O adaptador usa a readiness Minecraft já existente como fonte única. O timeout solicitado percorre todo o fluxo, e a lease recebe esse prazo mais margem. Boot real de aproximadamente 723 segundos concluiu; crash durante boot retorna `error`; JVM viva sem readiness retorna `operation-timeout`.

**~~Restart offline virava falha genérica.~~ Corrigido.** Estado offline fresco é recusado como `state-conflict` antes de criar operação/job. O agente repete a mesma classificação caso o estado mude depois da aceitação.

**~~Uma identidade local podia operar só a instância provisionada.~~ Corrigido.** Há um runtime lógico por `ServerInstance`, identidade persistente própria, claim filtrado pelo vínculo no banco, link atômico de workspace importado por ID e ownership exclusivo de `runDirectory`. A frota detecta novas instâncias e troca somente o runtime cuja versão mudou.

**~~Duas cópias locais podiam compartilhar PGlite.~~ Corrigido.** `dist/local.js` adquire lock atômico antes de reset ou abertura do banco, recusa o segundo PID vivo e recupera lock órfão.

Depois dos testes reais de lifecycle ficaram zero leases abertas, zero jobs pendentes e zero operações em voo.

### Smoke do servidor existente/importado — concluído em 2026-08-08

O workspace `server-original` foi registrado e ligado por `workspaceId` à instância que já possuía o runtime Forge detectado. A resposta não expôs o path. A frota parou somente o agente dessa instância, reutilizou a identidade escopada e voltou anunciando `process.control`.

O ciclo real terminou com `start` em aproximadamente 338,5 s, `restart` em 88,5 s e `stop` em 11,6 s. Os três jobs ficaram `succeeded/completed`, as três leases foram liquidadas com sucesso e a auditoria final encontrou zero leases abertas, jobs pendentes ou com owner, operações em voo e locks operacionais. Nenhuma JVM Minecraft permaneceu.

**~~O restart mantinha o PID encerrado como `online` atual.~~ Corrigido.** A aceitação durável de qualquer operação que altera o lifecycle invalida a observação anterior na mesma transação: publica `process.invalidated`, remove PID/boot/observador e expõe `unknown`/`stale` até o agente observar o resultado. A readiness continua sendo a única fonte capaz de devolver `online`, e um replay idempotente não invalida a observação nova.

**~~Não havia ownership durável do JVM após crash do agente.~~ Corrigido.** A migration `0025` reserva uma geração aleatória por `ServerInstance` antes do spawn e anexa o PID somente à mesma geração. No startup, outro boot limpa apenas PID comprovadamente morto; PID vivo, reutilizado, inacessível ou reserva sem PID vira ownership órfão e bloqueia novo spawn. Não existe adoção por PID. Troca de runtime também é recusada enquanto a geração existir.

Smokes determinísticos cobrem queda durante boot, online e no intervalo do restart, PID reutilizado e owner morto. A leitura concorrente enquanto o PID é anexado não publica PID nem libera a reserva. Ownership incerto liquida a tentativa como `precondition-not-met`/`unknown`, sem afirmar que o servidor está offline.

**~~A observação do processo expirava mesmo com o JVM saudável.~~ Corrigido.** O resultado de uma operação não é usado como heartbeat eterno. O agente reinspeciona o adaptador no ciclo periódico, grava lifecycle/PID/boot com timestamp novo e só deixa a reconciliação marcar `unknown` quando a inspeção realmente deixa de acontecer. O smoke final manteve `online`/atual e o mesmo PID após ultrapassar a janela anterior de 120 segundos.

O rollout controlado foi executado em 2026-08-09: stop pelo agente antigo, saída do JVM confirmada, reinício único de `dist/local.js` e novo start sob a geração persistente. O console ao vivo foi validado durante o boot real. Backup e instalação de artefato continuam fora.

---

## O que continua desligado de propósito

- **`process.force-kill`** — a capability existe no contrato e **nunca teve handler**. Matar um servidor pode perder tudo desde o último save. Continua deliberadamente desligada, e a readiness a distingue: `deliberately-disabled`, não `no-handler-implemented`.
- **`apply`** — escrever staging de volta no workspace segue sem dono.
- **Boot do servidor original a partir do caminho de build** — geração de configuração continua exclusivamente em sandbox descartável. Operar o servidor é outro caminho, com outro dono e outra guarda.
