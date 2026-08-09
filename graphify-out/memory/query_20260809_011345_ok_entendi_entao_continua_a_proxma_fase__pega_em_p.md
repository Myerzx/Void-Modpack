---
type: "query"
date: "2026-08-09T01:13:45.445215+00:00"
question: "ok entendi entao continua a proxma fase; pega em partes grandes para terminar"
contributor: "graphify"
outcome: "useful"
source_nodes: ["ObservedProcessState", "ProcessStateRepository", "OperationRepository", "Handoff da plataforma"]
---

# Q: ok entendi entao continua a proxma fase; pega em partes grandes para terminar

## Answer

Expansão do vocabulário do grafo: [restart, process, state, observation, observed, pid, readiness, controller, agent, operation, persist, stale]. O fluxo mostrou que o controlador já produz estados transitórios, mas a Control API persistia somente o recibo final do agente. O bloco implementado invalida atomicamente a observação anterior ao aceitar start, stop, restart ou force-kill: lifecycle passa a unknown/stale, PID, boot e observador antigos são removidos e o outbox publica process.invalidated. A readiness do agente continua sendo a única autoridade capaz de publicar online. Regressões provam que a API não expõe o PID antigo durante restart, que a nova readiness publica apenas o PID novo, que replay idempotente não a invalida e que restart offline continua sem criar trabalho ou alterar a observação. Gate completo: 922 testes descobertos, 920 aprovados, 2 ignorados, zero falhas. Próximo bloco grande: ownership persistente e recuperação segura de JVM órfã após crash do agente.

## Outcome

- Signal: useful

## Source Nodes

- ObservedProcessState
- ProcessStateRepository
- OperationRepository
- Handoff da plataforma