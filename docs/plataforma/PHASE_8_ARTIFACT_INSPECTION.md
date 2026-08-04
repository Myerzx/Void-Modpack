# Fase 8.1: inspeção segura de artefato

Status: concluída tecnicamente em isolamento em 2026-08-04; gate local aprovado e [matriz Windows/Linux 30961224930](https://github.com/Myerzx/Void-Modpack/actions/runs/30961224930) aprovada nos dois sistemas.

## Resultado

`@voidfall/artifact-inspection` responde a uma única pergunta: **o que este arquivo declara?**

Ele lê o central directory do ZIP e infla apenas o conjunto fechado de descritores revisados. Não carrega classe, não executa artefato, não abre JAR aninhado, não desserializa objeto arbitrário e não escreve em disco. O único decodificador usado é DEFLATE bruto do `node:zlib`.

O julgamento de compatibilidade **não** pertence a esta fatia; ele é da Fase 8.2. Aqui só existe declaração e evidência.

## Descritores lidos

| Entrada | Papel |
| --- | --- |
| `META-INF/MANIFEST.MF` | seção principal, com continuação dobrada |
| `META-INF/mods.toml` | descritor Forge |
| `META-INF/neoforge.mods.toml` | descritor NeoForge, atribuído separadamente |
| `fabric.mod.json` | descritor Fabric |
| `META-INF/jarjar/metadata.json` | índice de bibliotecas embutidas |
| `mcmod.info` | marcador legado, sem parser |

Nenhuma outra entrada é inflada. Um `fabric.mod.json` presente junto de um descritor Forge é registrado como evidência mas não reivindica o loader.

## Limites

| Limite | Padrão |
| --- | --- |
| bytes do arquivo | 64 MiB |
| entradas | 20.000 |
| comprimento do nome | 512 |
| profundidade do caminho | 32 |
| bytes de um descritor | 512 KiB |
| expansão total | 4 MiB |
| razão de compressão | 200:1 |
| bibliotecas embutidas | 64 |
| mods declarados | 64 |
| dependências por mod | 128 |

A razão de compressão e o orçamento de expansão são verificados **contra os tamanhos declarados, antes de qualquer alocação**. `inflateRawSync` ainda recebe `maxOutputLength` como parada dura caso o diretório minta, e o tamanho real é conferido depois.

## Recusas

- container que não é ZIP, e arquivo truncado;
- ZIP64, multi-disco, entrada cifrada e método de compressão não suportado;
- path traversal (`..`), caminho absoluto, prefixo de unidade (`C:`), barra invertida e caractere de controle em nome de entrada;
- nome que não faz round-trip em UTF-8, para que nenhum caractere de substituição entre em um relatório;
- ZIP bomb pela razão declarada;
- descritor cujo tamanho real contradiz o diretório;
- hash esperado divergente.

A verificação de caractere de controle é feita por ponto de código, não por literal de regex, para que um acidente de codificação neste arquivo-fonte não possa enfraquecer a guarda.

## Declaração, não avaliação

- `${file.jarVersion}` é resolvido **somente** pelo `Implementation-Version` do manifesto que o declara; sem isso permanece literal. Nada é inventado.
- Um descritor presente mas ilegível dentro do subconjunto estrito vira uma issue registrada, nunca uma omissão — uma fase posterior precisa poder tratá-lo como desconhecido em vez de ausente.
- Bibliotecas JarJar são reportadas como declarações; o JAR aninhado nunca é aberto, o que evitaria recursão sem limite.
- `unknown` descreve a ausência de descritor e não pode ser combinado com um loader declarado.

## Contrato público

`ArtifactInspectionReport` v1 fixa o relatório. A lista de evidências é uma **união fechada** dos seis descritores revisados, então um nome de entrada arbitrário não pode ser reportado. O contrato também exige que todo loader e toda evidência citados por um mod já estejam declarados pelo relatório, e recusa qualquer campo de path, localização absoluta ou bytes.

## Subconjunto estrito de TOML

O leitor aceita apenas atribuições simples, `[[mods]]` e `[[dependencies.<modId>]]`. Strings multilinha, tabelas inline, arrays de valores, números e datas são ignorados em vez de aproximados — o mesmo princípio já aplicado ao Java Properties na Fase 3.

## Fixtures

As fixtures são construídas em código por um escritor ZIP determinístico, e não commitadas como binários. Cada campo que um teste corrompe — tamanho declarado, método de compressão, flag de cifra, nome de entrada — permanece explícito e revisável no diff.

## Limites mantidos

1. Nenhum JAR privado foi aberto; os testes constroem seus próprios arquivos.
2. Nenhuma classe é carregada e nenhum artefato é executado.
3. O pacote é puro: sem filesystem, rede, banco, fila ou efeito operacional.
4. Nenhuma decisão de compatibilidade, licença ou instalação é tomada aqui.

## Riscos abertos após a Fase 8.1

- a inspeção comprova estrutura e declaração, mas não certifica malware, autoria, licença ou comportamento em jogo;
- CRC-32 por entrada ainda não é verificado; o tamanho declarado é a autoridade atual;
- JARs aninhados são reportados por declaração e nunca inspecionados, então uma biblioteca embutida permanece sem análise própria;
- o subconjunto de TOML cobre os descritores revisados; um descritor que use recursos fora dele vira issue e não análise.
