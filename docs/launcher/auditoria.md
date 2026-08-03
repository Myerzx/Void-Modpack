# Auditoria do perfil original

## Escopo e preservação

O perfil recebido foi movido sem alteração para `Launcher/workspace/profile-original/`. Ele é evidência local e está fora do Git e do corpus do Graphify.

Inventário inicial:

- 14.708 arquivos em 1.999 diretórios.
- Aproximadamente 3,05 GB.
- Minecraft 1.20.1.
- Runtime utilizado: Forge 47.4.0 e Java 17.
- 93 addons registrados: 27 habilitados e 66 desabilitados.
- Diretório `mods`: 23 JARs ativos e 66 JARs desabilitados.

## Divergências críticas

### P0 — manifesto não representa o runtime

O `manifest.json` legado identifica `Outland (1)`, Forge 47.3.38 e 62 projetos. O perfil utilizado identifica `VoidFall`, Forge 47.4.0 e 93 addons. Publicar o manifesto legado não reconstrói o estado testado.

A fonte nova gera um manifesto de auditoria a partir dos 27 addons habilitados. Isso corrige a fotografia de dependências, mas ainda precisa de importação e teste funcional.

### P0 — criação de mundo falha

O log mais recente inicia o cliente e carrega os packs `Better-Leaves-9.4.zip`, `Excalibur_V1.20.zip` e o pack do OpenLoader, mas a tela de mundo termina com `Failed to load registries due to above errors`.

As causas registradas incluem:

- loot tables que pedem itens de `lightmanscurrency`, mod ausente;
- loot table que pede `betterarcheology:growth_totem`, mod ausente;
- recursos/modelos com identificadores inválidos contendo maiúsculas ou parênteses;
- datapacks herdados do Craft to Exile 2 com referências a namespaces removidos.

Por isso, `openloader/data/` do perfil original não foi promovido à fonte canônica.

### P0 — ativo visual grande e sem licença confirmada

`openloader/resources/resources.zip` tem 167 MB, excede o limite normal de 100 MB por arquivo do GitHub e se identifica apenas como `CtE Resources`. Ele não será versionado nem redistribuído até existir origem, versão, licença e método de download verificáveis.

## Dívida de configuração

- `config/openloader/` é um subconjunto duplicado de `openloader/`: 4.793 arquivos idênticos por caminho/tamanho, enquanto a raiz contém 1.273 arquivos adicionais.
- `config/openloader.rar` adiciona mais 175 MB e é um backup, não configuração de runtime.
- `config/worldedit/` usa aproximadamente 1,60 GB com mundos/regiões e schematics; não pertence ao cliente distribuível.
- `config/defaultoptions/` referencia packs inexistentes e o mod Default Options não está instalado.
- O `options.txt` real referencia apenas Better Leaves e Excalibur; ele foi adotado como base portátil de primeira instalação.
- FancyMenu possuía duas referências locais quebradas. A sincronização limpa remove o preload inexistente e troca o áudio ausente por um arquivo existente.

## Dados que nunca devem ser publicados

`minecraftinstance.json`, logs, crash reports, caches de usuários, UUIDs, caminhos locais, mundos, screenshots, mapas Xaero, skin caches e preferências do launcher permanecem somente no workspace ignorado.

## Critério para retirar o bloqueio

Uma release só passa de `audit` para `alpha` depois de:

1. importar o ZIP em uma instância vazia;
2. iniciar o jogo sem erro fatal;
3. confirmar FancyMenu e os dois resource packs;
4. criar e reabrir um mundo novo;
5. validar conexão com o servidor quando essa fase existir;
6. registrar versões, hash do artefato e resultado no changelog/release.

