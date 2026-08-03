# Portabilidade entre launchers

## O que “qualquer launcher” significa

Não existe um único arquivo aceito literalmente por todos os launchers. A portabilidade vem de uma fonte canônica independente de launcher e de exportações por formato:

- CurseForge: ZIP com `manifest.json` e `overrides/` na raiz.
- Modrinth: `.mrpack` com `modrinth.index.json`, hashes, URLs permitidas e `overrides/`.
- Prism Launcher: importa packs de fontes como CurseForge e Modrinth.
- Launchers sem importador: instalação manual documentada de Minecraft 1.20.1, Forge 47.4.0, dependências e overrides.

Referências oficiais:

- [Exportação de modpacks CurseForge](https://support.curseforge.com/support/solutions/articles/9000198500-exporting-a-modpack-for-curseforge-project-submission)
- [Formato Modrinth `.mrpack`](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack)
- [Recursos do Prism Launcher](https://prismlauncher.org/about/)

## Estratégia adotada

CurseForge é o primeiro artefato porque o perfil traz project IDs e file IDs confiáveis. O `.mrpack` fica bloqueado até mapear cada projeto para uma URL permitida pela especificação Modrinth e calcular SHA-1/SHA-512; não serão usados links CDN improvisados nem arquivos sem permissão.

## Configurações portáveis

- Somente caminhos relativos à raiz da instância.
- `options.txt` é incluído para a primeira instalação porque o mod Default Options não está presente.
- Atualizações futuras não devem sobrescrever preferências pessoais sem uma migração explícita.
- FancyMenu usa `config/fancymenu/...`, nunca um caminho de drive do Windows.
- Mundos, servidores recentes, keybinds privados e caches não entram nos overrides.

## Texturas

Better Leaves e Excalibur são dependências do manifesto CurseForge e os nomes no `options.txt` precisam permanecer idênticos aos arquivos instalados. O pack CtE de 167 MB fica fora da release até revisão de licença/origem. Shaders são opcionais e não são considerados funcionais enquanto Oculus/Embeddium estiverem desabilitados.

