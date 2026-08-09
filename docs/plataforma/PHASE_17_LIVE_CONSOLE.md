# Fase 17 — console operacional ao vivo

Data: 2026-08-09

## Resultado

O console deixou de ser um snapshot coletado apenas ao fim de uma operação. A saída completa do processo agora percorre uma trilha incremental:

```
stdout/stderr do JVM
  → buffer limitado por processo e sequência local
  → lote retryable do adaptador
  → captura periódica do AgentRuntime
  → sequência durável e redação no PostgreSQL/PGlite
  → página inicial pelo fim + cursor progressivo na Control API
  → painel com polling, pausa e acompanhamento do final
```

Ler um lote no agente não o remove. O prefixo só é confirmado depois do commit no banco. Ticks sobrepostos compartilham uma única captura em voo; adapters legados continuam usando o snapshot anterior, sem duplicar linhas quando o modo incremental está disponível.

## Limites e segurança

- O processo conserva no máximo 1.000 linhas completas e 2.048 caracteres por linha; stdout e stderr continuam limitados também por bytes.
- O adaptador sanitiza ANSI e controles antes de entregar o lote e conserva no máximo 5.000 linhas ainda não confirmadas.
- Se a retenção do processo descartar uma lacuna durante um pico, o agente persiste um marcador explícito e truncado no histórico.
- O banco redige segredo, endereço e caminho na entrada; o navegador nunca recebe o valor original.
- O banco conserva 5.000 linhas por instância e a aba, 1.000. O cursor público nunca é reutilizado após retenção.
- `tail=true` abre somente a janela mais recente e retorna as linhas em ordem cronológica; depois disso toda leitura segue para frente.
- O painel não oferece terminal livre. Ele publica somente `list-players` e `save-all`, vindos do catálogo fechado da API, sob RBAC, CSRF, idempotência, operação/job e auditoria.
- Backup, restore operacional, `artifact.install` e `process.force-kill` não foram ligados neste recorte.

## Painel

A rota `/servidor/console` possui:

- seletor de `ServerInstance`;
- estado de conexão, pausa, retomada, auto-follow e limpeza somente da visualização local;
- diferenciação de stdout/stderr e badges de redação/truncamento;
- aviso quando o cursor caiu atrás da retenção durável;
- catálogo de comandos permitido, sem campo de texto livre;
- layout responsivo validado em desktop e viewport de 390 × 844.

## Smoke real

O rollout da cerca de ownership foi executado na ordem segura: stop pelo agente antigo, saída do JVM confirmada, reinício único de `dist/local.js` na porta 3100 e novo start pelo painel. O console novo recebeu a inicialização Forge em tempo real, distinguiu stderr, redigiu caminhos e endereço RCON e limitou a aba a 1.000 linhas.

A readiness única registrou `Done (241.830s)!`; a operação `server.start` e seu lease terminaram como `succeeded`, o supervisor voltou a `idle` e o painel publicou lifecycle `online` com o PID observado da geração nova.

O smoke final encontrou e fechou mais um hardening: o snapshot de processo antes envelhecia após 120 segundos mesmo com o agente e o JVM saudáveis. O `AgentRuntime` agora reinspeciona o adaptador a cada ciclo de reconciliação e atualiza a observação durável. Após rollout seguro da correção, a readiness registrou `Done (250.030s)!`; mais de 120 segundos depois, o painel continuou `online`/atual com o mesmo PID e um timestamp de observação novo.

O gate completo `npm run check` terminou com código 0 em 492,8 segundos: 945 casos descobertos, 943 aprovados no Windows, dois sockets Unix ignorados e zero falhas. Todos os builds, typechecks, o Forge Bridge e a exportação estática com `/servidor/console` foram concluídos.
