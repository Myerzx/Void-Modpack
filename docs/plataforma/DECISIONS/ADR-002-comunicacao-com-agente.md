# ADR-002 — Comunicação com o agente

- Status: Aceito para planejamento
- Data: 2026-08-03

## Contexto

O painel precisa controlar uma máquina que contém processo, mundo e credenciais sensíveis. Expor RCON ou uma API privilegiada diretamente aumenta o risco.

## Opções

1. Control API conecta diretamente ao host/RCON.
2. Agente abre conexão/consulta jobs autenticados e executa operações tipadas.
3. Compartilhar pasta/banco entre painel e servidor.

## Decisão

Escolher a opção 2. O agente possui identidade por instância, autenticação mútua e inicia comunicação de saída. Jobs são duráveis, idempotentes e limitados a capacidades declaradas.

## Motivo

Evita porta administrativa ampla no host, permite revogação por instância e separa intenção central de execução local.

## Consequências

- heartbeat e compatibilidade de protocolo obrigatórios;
- lease, retry e deduplicação de efeitos;
- operações tipadas e allowlist no agente;
- modo offline do control plane precisa de comportamento fail-safe;
- console em tempo real usa canal autenticado e auditado.

## Revisão futura

Um broker dedicado ou túnel persistente pode substituir polling se volume/latência justificarem, por novo ADR.
