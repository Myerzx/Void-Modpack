# Graphify no VoidFall

O Graphify está instalado via `uv` com o pacote `graphifyy[all]`. Os resultados portáteis ficam em `graphify-out/`: `graph.json`, `graph.html`, `GRAPH_REPORT.md`, `BENCHMARK.json` e `manifest.json`. Cache, PID, log e custo local são ignorados pelo Git.

## Salvamento automático

O projeto usa três mecanismos complementares:

1. o watcher monitora alterações e atualiza código determinístico por AST;
2. os hooks `post-commit` e `post-checkout` mantêm o grafo alinhado ao Git;
3. a tarefa `VoidFall-Graphify-AutoSave` reinicia o watcher a cada login do Windows.

Instalar ou reparar toda a automação:

```powershell
& .\tools\graphify\Install-GraphifyAutoSave.ps1
```

Verificar:

```powershell
graphify --version
graphify hook status
Get-ScheduledTask -TaskName VoidFall-Graphify-AutoSave
Get-Content .\graphify-out\watcher.pid
Get-Content .\graphify-out\watcher.log -Tail 30
```

Parar ou iniciar somente nesta sessão:

```powershell
& .\tools\graphify\Stop-GraphifyBackground.ps1
& .\tools\graphify\Start-GraphifyBackground.ps1
```

Remover watcher, tarefa e hooks sem desinstalar o Graphify:

```powershell
& .\tools\graphify\Uninstall-GraphifyAutoSave.ps1
```

## Limite conhecido

Atualizações de código são locais e não usam API. Documentos, imagens e relações conceituais precisam de uma nova extração semântica; sem uma chave de modelo configurada, o watcher cria `graphify-out/.needs_update` para um agente executar essa etapa. Nunca registrar chaves de API no repositório.

Para consultas dos agentes, usar primeiro `graphify query`, `graphify path` ou `graphify explain`, conforme as regras em `AGENTS.md`.
