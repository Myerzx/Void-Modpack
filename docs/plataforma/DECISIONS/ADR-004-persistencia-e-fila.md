# ADR-004 — Persistência e fila

- Status: Aceito para planejamento
- Data: 2026-08-03

## Contexto

Build, backup, restore e restart são tarefas longas. A escala inicial é pequena, mas jobs precisam sobreviver a reinícios e registrar progresso.

## Opções

1. Memória do processo.
2. PostgreSQL para estado e fila por lease/row lock.
3. PostgreSQL mais broker dedicado desde o primeiro dia.

## Decisão

Escolher a opção 2. PostgreSQL guarda jobs, eventos, idempotência e leases. Pacotes e dados grandes ficam em object storage.

## Motivo

Reduz infraestrutura inicial e mantém criação do job, autorização e auditoria na mesma transação. Atende uma instalação de baixa escala.

## Consequências

- queries e índices de fila precisam de teste de concorrência;
- workers usam `SKIP LOCKED`, lease e renovação;
- efeitos externos permanecem idempotentes;
- logs/metrics de alto volume não devem sobrecarregar o banco;
- broker será considerado quando métricas demonstrarem necessidade.

## Revisão futura

Latência, volume, múltiplas regiões ou fan-out podem justificar NATS/RabbitMQ/Redis Streams por novo ADR.
