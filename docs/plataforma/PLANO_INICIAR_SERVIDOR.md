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

## Os cinco buracos

### 1. O agente monta o plano errado

`server-agent/src/main.ts` chama só `createMinecraftProcessPlan`, que constrói `java -jar <serverJar> nogui`. Forge 1.20.1 **não tem jar gordo** — inicia por `@user_jvm_args.txt @libraries/.../win_args.txt`. O plano certo existe no mesmo pacote e não é usado.

Consequência: hoje o agente sabe iniciar Paper e vanilla, e não sabe iniciar o servidor do proprietário.

### 2. Não existe detecção de runtime

`ProcessConfiguration` exige `serverJar` digitado. Deve ser **descoberto**, como o `sandbox-runner` já descobre o args file do Forge e o Java do host:

```
libraries/net/minecraftforge/forge/<v>/{unix,win}_args.txt  -> forge, args file
libraries/net/neoforged/neoforge/<v>/…                      -> neoforge, args file
fabric-server-launch.jar | .fabric/                          -> fabric, -jar
paper-*.jar | spigot-*.jar | server.jar na raiz              -> paper/spigot/vanilla, -jar
nada reconhecido                                             -> recusa nomeada
```

### ~~3. Workspace e instância não se falam~~ — resolvido em 2026-08-08

`server_instances` ganhou `run_directory`, `runtime` e `runtime_detected_at`, e `panel_workspaces` ganhou a aresta opcional. `POST /api/v1/servers/:id/runtime` é o único lugar onde um caminho é enviado sobre uma instância, e é enviado uma vez; a resposta e a listagem carregam o descritor sem o diretório. `create` deliberadamente não aceita descritor: aceitar um na criação seria aceitar um que ninguém verificou.

### 4. O ambiente local não sobe o agente

`npm run panel` sobe banco, API e painel. O agente é processo separado, com identidade Ed25519, registro e heartbeat.

**Medido em 2026-08-08, e o resultado muda o desenho.** Dois processos separados abriram e escreveram no mesmo diretório PGlite ao mesmo tempo, sem nenhuma recusa:

```
A: abriu e escreveu; segurando
B: ABRIU o mesmo diretório enquanto A o segura · linhas: 1
B: e ESCREVEU
```

A ausência de recusa é o perigo, não a permissão. PGlite não tem coordenação entre processos: cada um roda seu próprio Postgres em WebAssembly, com seu próprio cache, escrevendo nos mesmos arquivos. Isso corrompe em silêncio.

Então, no ambiente local, o agente roda **no mesmo processo** da Control API, compartilhando o único handle de banco. Isso não é um atalho: `AgentRuntime` recebe `repositories` como dependência justamente para isso, e o transporte continua sendo HTTP de loopback para a mesma API — a autoridade sobre o processo permanece no agente, e o protocolo permanece real.

O que falta implementar: provisionar identidade e token do agente na primeira execução, registrar pela rota real, e construir o `AgentRuntime` com o controlador detectado. Em produção nada disso vale — lá o agente é processo separado contra um PostgreSQL de verdade, que é o caso para o qual ele foi escrito.

### 5. Nenhuma tela

Nenhuma das rotas de processo, console, métricas ou backup tem interface.

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

**Passo 3 — instância com diretório e runtime.** Migração acrescentando `run_directory` e `runtime` a `server_instances`, mais a aresta com o workspace. A rota de criação de instância já existe.

**Passo 4 — agente no ambiente local.** `npm run panel` provisiona a identidade do agente, registra e sobe o processo junto. Continua loopback, continua recusando `NODE_ENV=production`.

**Passo 5 — telas.** Servidor (estado, uptime, memória, CPU, PID, iniciar/parar/reiniciar), console (log ao vivo, envio, histórico), backups. As rotas já existem; é integração, não motor.

Os passos 1 e 2 sozinhos já tornam o servidor iniciável por API. O 5 é o que torna isso um painel.

---

## O que continua desligado de propósito

- **`process.force-kill`** — a capability existe no contrato e **nunca teve handler**. Matar um servidor pode perder tudo desde o último save. Continua deliberadamente desligada, e a readiness a distingue: `deliberately-disabled`, não `no-handler-implemented`.
- **`apply`** — escrever staging de volta no workspace segue sem dono.
- **Boot do servidor original a partir do caminho de build** — geração de configuração continua exclusivamente em sandbox descartável. Operar o servidor é outro caminho, com outro dono e outra guarda.
