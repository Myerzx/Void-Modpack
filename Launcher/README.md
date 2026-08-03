# Launcher

Fonte e ferramentas do cliente VoidFall.

## Pastas

- `pack/`: conteúdo que entra no ZIP CurseForge (`manifest.json` + `overrides/`).
- `catalog/`: inventário sanitizado dos addons do perfil auditado.
- `platforms/`: estado e requisitos de formatos alternativos, como Modrinth.
- `tools/`: scripts de inventário, sincronização, validação e build.
- `workspace/profile-original/`: perfil bruto preservado e ignorado pelo Git.
- `build/`: artefatos locais ignorados.

## Comandos

```powershell
& .\Launcher\tools\Export-LauncherInventory.ps1
& .\Launcher\tools\Sync-PackOverrides.ps1
& .\Launcher\tools\Test-LauncherPack.ps1
& .\Launcher\tools\Build-CurseForgePackage.ps1
```

Leia `docs/launcher/` antes de alterar dependências ou ativos.

