# Arquitetura do repositório

## Princípio

O perfil de um launcher é estado de execução; não é a fonte do produto. A arquitetura separa evidência, fonte canônica, metadados externos, builds e documentação.

```text
VoidFall/
├── Launcher/
│   ├── pack/
│   │   ├── manifest.json
│   │   └── overrides/
│   ├── catalog/
│   ├── platforms/
│   ├── tools/
│   ├── workspace/profile-original/  # ignorado
│   └── build/                       # ignorado
├── Servidor/                        # próxima fase
├── docs/
│   ├── launcher/
│   └── agentes/
├── tools/graphify/
└── graphify-out/
```

## Fluxo de dados

1. `profile-original` é lido, nunca editado.
2. `Export-LauncherInventory.ps1` sanitiza metadados e gera catálogo/manifesto.
3. `Sync-PackOverrides.ps1` copia somente configurações selecionadas e corrige referências locais conhecidas.
4. `Test-LauncherPack.ps1` bloqueia dados sensíveis, caminhos absolutos, arquivos grandes e referências quebradas.
5. `Build-CurseForgePackage.ps1` cria o ZIP ignorado em `Launcher/build/`.
6. Smoke tests externos decidem se o artefato pode receber uma tag.

## Fonte canônica

`Launcher/pack/` é a única entrada de release. Não construir a partir de um diretório de instância, porque ele acumula downloads, preferências, mundos, caches e alterações feitas durante o jogo.

## Separação futura do servidor

O servidor terá manifesto/configuração próprios e receberá apenas a camada comum explicitamente revisada. Configs client-only, FancyMenu, shaders e `options.txt` nunca devem ser copiados automaticamente para `Servidor/`.

