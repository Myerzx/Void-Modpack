---
type: "query"
date: "2026-08-09T06:18:28.820697+00:00"
question: "Como continuar a fase atual e fechar o console ao vivo sem reabrir features ainda bloqueadas?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["server-agent/src/runtime.ts", "captureConsole()", "server_console_cursors", "PHASE_17_LIVE_CONSOLE.md"]
---

# Q: Como continuar a fase atual e fechar o console ao vivo sem reabrir features ainda bloqueadas?

## Answer

A fase fecha com captura incremental confirmada somente depois da persistência, leitura inicial pelo tail seguida por cursor progressivo, painel sem terminal livre e observação periódica do processo para impedir que um JVM saudável envelheça para unknown. Backup, artifact.install e force-kill continuam fora do recorte.

## Outcome

- Signal: useful

## Source Nodes

- server-agent/src/runtime.ts
- captureConsole()
- server_console_cursors
- PHASE_17_LIVE_CONSOLE.md