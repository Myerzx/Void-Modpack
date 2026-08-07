# Fase 16: construtor de release

Status: concluído em 2026-08-07, exceto a exportação CurseForge, que está bloqueada por licença e não por código.

Escopo previsto no ROADMAP: *"ZIP do servidor, modpack CurseForge, manifesto com hashes, changelog automático, arquivos por lado e rollback."*

---

## O que existe

| Item | Onde | Situação |
| --- | --- | --- |
| ZIP do servidor | `release-planner/src/archive.ts` + `package.ts` | executado contra o servidor real |
| ZIP do cliente | idem, `side: 'client'` | executado, e **parcial por construção** |
| Manifesto com hashes | `package.ts` → `voidfall-<lado>-<versão>.json` | digest do arquivo confere com o arquivo |
| Changelog automático | `changelog.ts` (Fase 16.0) | pronto desde a fatia anterior |
| Arquivos por lado | `side.ts` | evidência observada, nunca declaração |
| Rollback | `rollback.ts` | **plano**, não execução — ver limitação abaixo |
| Modpack CurseForge | `distribution.ts` → `canExportCurseForgePack` | recusa explicada, por licença |

---

## O escritor de ZIP

Sem dependência externa, como o resto do repositório, e sem nunca segurar uma entrada em memória: um pacote de servidor tem ~1 GB.

Duas armadilhas do formato estão registradas no próprio arquivo porque nenhuma das duas falha alto:

**O método de compressão fica no offset 8 do cabeçalho local e no offset 10 do cabeçalho do diretório central.** Escrever 8 nos dois deixa um diretório que declara "stored" sobre bytes deflatados; o leitor então recusa a divergência de tamanho — corretamente, e muito longe da causa. Esse erro já foi cometido uma vez neste repositório, num fixture de teste, e o inspetor o pegou. Agora existe um teste que lê o valor nos dois offsets.

**O CRC precisa estar no cabeçalho local, antes dos dados que ele descreve.** O caminho usual é bufferizar a entrada ou lê-la duas vezes. Em vez disso o cabeçalho sai com um marcador, os dados passam por um CRC corrente, e os quatro bytes são corrigidos depois — uma passada de leitura, uma de escrita, memória constante.

Entradas já comprimidas (`.jar`, `.zip`, `.png`, `.ogg`, …) são armazenadas em vez de deflatadas. Um jar é um zip; gastar CPU com um gigabyte deles não compra nada. Acima de 8 MiB nada é deflatado, pelo mesmo motivo.

Recusas, todas com o nome do arquivo: nome que escaparia da pasta na extração (`..`, raiz, barra invertida, letra de unidade, caractere de controle), nome duplicado, mais de 65.535 entradas ou mais de 4 GiB — os dois últimos exigiriam zip64, e escrever um arquivo que alguns leitores truncam em silêncio é pior do que recusar.

## Verificação por um leitor independente

O arquivo produzido é lido de volta por `@voidfall/artifact-inspection`, escrito meses antes e que não sabe nada deste escritor — e, no teste ponta a ponta, pelo `System.IO.Compression.ZipArchive` do .NET, que valida o CRC de cada entrada conforme ela é lida até o fim.

```
voidfall-server-0.1.0.zip   entradas 7.928   bytes lidos 1.149.584.806   nomes com barra invertida 0
voidfall-client-0.1.0.zip   entradas 7.719   bytes lidos   234.647.129   nomes com barra invertida 0
```

Nenhuma exceção em nenhuma das duas. O digest de cada manifesto confere com o arquivo em disco.

## O corte por lado

A única evidência honesta de qual lado um mod pertence é **onde ele foi observado**. Nada no `mods.toml` diz se o próprio mod é client-only: o campo `side` de lá descreve uma *dependência*, não o mod. Então `presenceFromProfiles` compara duas instalações reais.

Comparação por **nome**, não por digest, deliberadamente: servidor e cliente rotineiramente carregam builds diferentes do mesmo mod, e comparar bytes reportaria um jar como server-only e o outro como client-only — duas respostas erradas a partir de uma observação correta.

Observado entre `Servidor/workspace/server-original` e `Launcher/workspace/profile-original`:

```
11 em ambos      12 só-cliente      170 só-servidor
```

que reconcilia exatamente com os diretórios: 181 `.jar` no servidor (mais 14 `.jar.disabled`/`.bak`, que não são carregados) e 23 `.jar` no cliente (mais 66 desabilitados).

Isso **não** é o mesmo corte do `Servidor/catalog/compatibilidade-cliente.csv`, que registra 178/42/3/9. Aquele CSV compara o servidor com o *cliente embutido* do pacote; este comparou com o perfil do launcher que existe hoje na máquina. As duas observações são reais e respondem a perguntas diferentes.

Um arquivo sem registro de presença fica **`unassigned`**, nunca no pacote do servidor. A maioria dos mods é de servidor, então inferir acertaria com frequência suficiente para ser confiado e erraria com frequência suficiente para importar — um mod client-only num servidor é crash no boot.

## Um defeito que só a execução real mostrou

A primeira execução ponta a ponta produziu um pacote de cliente com `world/serverconfig/*.toml` e com os jars desligados do servidor dentro. Ambos entravam por serem "compartilhados", isto é, por não serem `mod-archive` — passavam por fora do corte de lado, que é exatamente o que este módulo existe para impedir.

A regra passou a ser por localização além de papel: `world/` e `defaultconfigs/` são conceitos de servidor, e um arquivo dentro de `mods/` que não é um mod-archive é resíduo da pasta de alguém. O pacote de cliente caiu de 234 MiB para 198 MiB e de 7.758 para 7.719 entradas — as 209 exclusões são 170 jars só-servidor, 14 resíduos de `mods/`, 21 `world/serverconfig` e 4 `defaultconfigs`.

## O leitor de `mods.toml` estava perdendo 76 mods de 181

Encontrado ao rodar o inventário contra o servidor real, não por um teste. O inventário declarava **103 mods** onde havia 181 arquivos.

Duas causas, ambas no `parseModsToml` do `artifact-inspection`, ambas em construções que o próprio template do Forge produz:

**Comentário no fim da linha.** O MDK escreve literalmente `[[mods]] #mandatory` e `modId="examplemod" #mandatory`. Um leitor que exige a linha *terminar* em `]]` ou em aspas não abre o bloco e não lê a chave: o cabeçalho caía no ramo de atribuição, não tinha `=`, e era descartado; as atribuições seguintes iam para a tabela raiz. O corte agora acontece antes de qualquer decisão sobre a linha, rastreando aspas para que um `#` dentro de um valor sobreviva.

**Chave entre aspas no caminho da tabela.** `[[dependencies."configured"]]` é o que o mod do MrCrayfish publica. O caminho era validado contra uma classe de caracteres única, que rejeita as aspas e derruba o arquivo inteiro. Agora o caminho é segmentado fora das aspas e cada segmento é validado depois de tirá-las — uma chave entre aspas é aceita por ser uma chave, não por estar entre aspas.

Resultado no pacote real: **103 → 173 mods declarados**, e arquivos sem declaração de 79 → 9.

Os 9 restantes têm quatro causas distintas, todas relatadas e nenhuma silenciosa:

| Arquivo | Causa |
| --- | --- |
| `blue_skies` (80 MiB), `L_Enders_Cataclysm` (122 MiB) | `content-too-large` — limite de 64 MiB do inspetor |
| `chipped` (>20.000 entradas) | `too-many-entries` — limite de 20.000 |
| `supplementaries` | `unreadable within the reviewed subset` — terceira classe de sintaxe |
| `trek` | `no recognized [[mods]] block` — quarta classe |
| `kotlinforforge`, `lazyyyyy-core`, `mixin-booster`, `yet_another_config_lib` | sem `[[mods]]`; são bibliotecas/coremods |

Os dois primeiros são **política, não defeito**: os limites foram escolhidos para inspecionar metadados declarados, e um modpack real tem mods de 122 MiB. Subi-los é uma decisão a tomar, não uma correção a fazer.

## Limitações declaradas

**O pacote de cliente é parcial por construção.** Ele é cortado de uma instalação de servidor, então carrega a configuração compartilhada e os 11 mods vistos dos dois lados — mas os 12 jars que só existem no perfil do cliente não estão no servidor e não podem sair dele. `derivedFromServerWorkspace: true` no manifesto diz isso, em vez de deixar o arquivo parecer um cliente completo.

**O rollback é planejado aqui e executado em outro lugar**, que ainda não existe: escrever conteúdo de volta no workspace continua sem dono (`apply`). O plano é derivado de digests e pode ser mostrado antes de qualquer coisa em disco ser tocada.

**`worldStateCovered` é sempre `false`.** Restaurar os mods e a configuração de uma versão antiga não restaura o mundo que rodou sob a nova. Um mundo salvo com um mod presente pode falhar ao carregar depois que ele sai, e nenhuma comparação de arquivos enxerga isso. Está no plano, como campo, e não numa linha de documento que alguém pode não ler.

**A exportação CurseForge continua recusada, por licença.** Um manifesto referencia mods por id de projeto e de arquivo; sem eles o único caminho é copiar o jar para `overrides/`, o que é redistribuir. Nenhum dos dois caminhos existe sem a revisão, então a recusa conta quantos arquivos faltam em cada motivo em vez de virar um aviso para clicar por cima.

**`modernfix/structureCacheV1` entra nos dois pacotes**: 1.832 arquivos e 37 MiB de cache regenerável. Não é erro — o inventário classifica e não descarta — mas é um quinto das entradas do pacote. Excluir cache regenerável é uma mudança no inventário, com uma razão de exclusão nova, e não foi feita aqui.

## Gate

`npm run check` — `CHECK_EXIT=0`, 820 testes, 818 passando, 0 falhando, 2 pulados.
