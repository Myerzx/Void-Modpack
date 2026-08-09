---
type: "query"
date: "2026-08-09T00:33:05.712495+00:00"
question: "Como executar com segurança o smoke real de servidor existente importado, vinculando workspace por workspaceId e validando start restart stop, leases jobs e operacoes residuais?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["AgentRuntime", "createProcessControlHandler()", "OperationRepository", "ProcessStateRepository"]
---

# Q: Como executar com segurança o smoke real de servidor existente importado, vinculando workspace por workspaceId e validando start restart stop, leases jobs e operacoes residuais?

## Answer

Expanded from graph vocabulary via: workspace, server, instance, agent, runtime, process, start, restart, stop, lease, job, operation. O fluxo seguro usa a sessao local em loopback, registra o workspace uma vez, liga a ServerInstance por workspaceId, envia operacoes tipadas e observa OperationRepository e ProcessStateRepository. O smoke real concluiu start, restart e stop com sucesso; os tres jobs ficaram completed, as tres leases foram liquidadas, e os contadores finais de leases abertas, jobs pendentes, operacoes em voo e locks ficaram em zero. O restart revelou que ProcessStateRepository preserva temporariamente o ultimo online/PID antigo durante o novo boot, embora o estado final fique correto.

## Outcome

- Signal: useful

## Source Nodes

- AgentRuntime
- createProcessControlHandler()
- OperationRepository
- ProcessStateRepository