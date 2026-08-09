---
type: "query"
date: "2026-08-09T00:51:38.156880+00:00"
question: "ok e oq mais precisa ser feito tbm ?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["Handoff da plataforma", "Roadmap, riscos e perguntas", "FINAL_IMPLEMENTATION_PLAN.md", ".reconcileOrphanProcessStates()", "FilesystemBackupService"]
---

# Q: ok e oq mais precisa ser feito tbm ?

## Answer

Expansão do vocabulário do grafo: [roadmap, handoff, process, restart, state, pid, orphan, recovery, backup, console, artifact, release]. O próximo trabalho imediato é corrigir a observação transitória do restart para nunca expor o PID morto como online atual, mantendo readiness como única autoridade de online. Depois, falta ownership persistente da JVM e recuperação segura após crash do agente: reconhecer uma JVM órfã, reanexar quando comprovadamente pertencente à instância ou bloquear ação duplicada, com smokes de queda durante boot, online e restart. Também falta reconciliar leases/locks/operações prepared após crash e validar que não nasce JVM duplicada. Antes das features, deve-se corrigir a higiene do lock local no Git e sincronizar ROADMAP/FINAL_IMPLEMENTATION_PLAN com o handoff atual. Console ao vivo, backup/restore real e artifact.install permanecem adiados. Para release/produção ainda faltam cliente canônico, proveniência/licenças, criação de mundo e conexão real, baseline seguro de autenticação/whitelist/RCON, mTLS/PostgreSQL/secret store/deploy e certificação E2E. Depois vêm servidor/mundo, grafo de conhecimento, análise automática de mods e administração real de jogadores.

## Outcome

- Signal: useful

## Source Nodes

- Handoff da plataforma
- Roadmap, riscos e perguntas
- FINAL_IMPLEMENTATION_PLAN.md
- .reconcileOrphanProcessStates()
- FilesystemBackupService