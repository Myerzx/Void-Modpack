# Servidor

Fonte documental e ferramentas do servidor **The Casket of Reveries 2.0.26**.

## Pastas

- `workspace/server-original/`: servidor bruto de 30,66 GB, preservado localmente e ignorado pelo Git.
- `catalog/`: inventários sanitizados de mods, armazenamento e compatibilidade.
- `templates/`: configurações seguras de referência, sem credenciais ou dados do mundo.
- `pack/`: espaço reservado para o pacote dedicado reproduzível após os bloqueios de release.
- `source/`: espaço reservado para código próprio após revisão de autoria e licença.
- `tools/`: exportação de inventário e validação da documentação pública.
- `docs/servidor/`: auditoria, arquitetura, segurança, operação e compatibilidade.

## Comandos

```powershell
& .\Servidor\tools\Export-ServerInventory.ps1
& .\Servidor\tools\Test-ServerDocumentation.ps1
```

O servidor bruto não deve ser editado nem publicado. A versão documentada inicia com Minecraft 1.20.1, Forge 47.4.4 e Java 17, mas ainda não possui um pacote dedicado aprovado para release.
