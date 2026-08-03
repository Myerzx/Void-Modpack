# Processo de release

## Preparação

```powershell
git status --short
& .\Launcher\tools\Export-LauncherInventory.ps1
& .\Launcher\tools\Sync-PackOverrides.ps1
& .\Launcher\tools\Test-LauncherPack.ps1
& .\Launcher\tools\Build-CurseForgePackage.ps1
```

O build gera ZIP e SHA-256 em `Launcher/build/`, que é ignorado pelo Git.

## Smoke tests obrigatórios

Use sempre uma instância vazia, sem reaproveitar caches:

1. importar o ZIP;
2. confirmar Minecraft 1.20.1 e Forge 47.4.0;
3. verificar a lista de mods baixados;
4. iniciar e observar FancyMenu;
5. confirmar Better Leaves e Excalibur ativos;
6. criar um mundo, sair e reabrir;
7. registrar warnings relevantes sem publicar logs completos;
8. quando o servidor existir, testar protocolo/mod parity e conexão.

## Versionamento

- `0.1.0-audit`: fotografia organizada, ainda bloqueada.
- `0.1.0-alpha.N`: instala e passa o smoke test básico.
- `0.1.0-beta.N`: cliente/servidor integrados e conteúdo estabilizado.
- `1.0.0`: licenças, atualização e rollback documentados.

Tags e releases devem apontar para o commit do manifesto e incluir o SHA-256 do artefato.

