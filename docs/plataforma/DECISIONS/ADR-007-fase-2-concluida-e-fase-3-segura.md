# ADR-007 — Encerramento da Fase 2 e abertura segura da Fase 3

- Status: aceita
- Data: 2026-08-03

## Contexto

A Fase 2 precisava entregar os limites de confiança antes de qualquer controle do Minecraft: persistência, autenticação, autorização, auditoria, fila, identidade do agente e uma interface honesta. O proprietário autorizou concluir essa fase e seguir para a Fase 3. Autenticação Minecraft, topologia de produção e destino do RCON ainda são P0 abertos.

## Decisão

1. A Fase 2 é considerada concluída após o gate integral registrado em `PHASE_2_VALIDATION.md`.
2. A Fase 3 começa em `@voidfall/minecraft-process` com:
   - planos distintos para Windows e Linux;
   - executável e diretório absolutos vindos de configuração confiável;
   - argumentos fixos, `shell: false` e janela oculta no Windows;
   - máquina de estados observada separada do estado desejado;
   - interface de adaptador sem implementação operacional.
3. O recorte não executa Java, não acessa o runtime, não cria rotas de controle e não oferece force kill.
4. Spawn real, conexão API/agente e testes contra Minecraft descartável exigem uma nova tarefa delimitada e o tratamento dos P0 relacionados.

## Consequências

- agentes seguintes possuem um ponto único para implementar adaptadores sem aceitar texto de shell;
- o gate da Fase 2 não é reaberto por simples evolução da Fase 3, mas regressões continuam bloqueando avanço;
- o servidor privado permanece evidência imutável;
- start/stop/restart continuam indisponíveis no painel e na API.
