# Inspeção de artefato em camadas

Status: implementado em 2026-08-07. Corrige a Fase 8.1 sem mexer nos limites que ela definiu.

---

## O problema

Um conjunto único de limites decidia tudo. Um artefato grande demais ou numeroso demais para ser percorrido inteiro era recusado **antes** de alguém tentar ler os quatrocentos bytes que o identificam.

Observado no modpack real:

| Arquivo | Tamanho | O que acontecia |
| --- | --- | --- |
| `L_Enders_Cataclysm-3.16.jar` | 122 MiB | recusado por `maximumArchiveBytes` |
| `blue_skies-1.20.1-1.3.31.jar` | 80 MiB | recusado por `maximumArchiveBytes` |
| `chipped-forge-1.20.1-3.0.7.jar` | >20.000 entradas | recusado por `maximumEntries` |

Os três declaram mod, versão e dependências normalmente. O relatório dizia que não declaravam nada — e "não olhamos" não é a mesma coisa que "não declara", nem para um construtor de pacote nem para o gate de distribuição.

A saída errada seria subir os limites. Isso compra silêncio, não conhecimento: o próximo mod de 200 MiB volta a cair, e a proteção contra descompressão excessiva teria sido afrouxada para todo mundo por causa de três arquivos.

## As três camadas

**`metadata` — seletiva.** Abre o container, percorre o índice procurando um conjunto **fechado** de caminhos conhecidos (`META-INF/mods.toml`, `META-INF/neoforge.mods.toml`, `fabric.mod.json`, `META-INF/MANIFEST.MF`, `META-INF/jarjar/metadata.json`, `mcmod.info`) e lê só esses. Não coleta, não valida e nem decodifica o nome dos vinte e cinco mil `.class` por onde passa.

O custo é o diretório central — cerca de 46 bytes mais um nome por entrada — mais os poucos descritores lidos. Nada disso escala com o tamanho do artefato, então o tamanho do artefato não é motivo para recusar. O limite desta camada é o próprio índice: `maximumDirectoryBytes`, 16 MiB por padrão.

Um nome só é validado quando **casa** com algo procurado. Recusar um mod inteiro porque um asset qualquer tem nome estranho seria recusar identificar um arquivo por causa de outro que ninguém vai ler.

**`structural` — enumeração.** Percorre todas as entradas e valida todos os nomes: `entryCount` e `features` saem daqui. É exatamente o trabalho para o qual os limites genéricos foram escritos, e eles **continuam idênticos**.

**`deep` — expansão de conteúdo.** Deliberadamente não tentada de forma genérica. Sem saber quais arquivos importam, "ler mais" não tem limite que signifique alguma coisa. A camada aparece sempre como `not-attempted` com `limit: 'no-adapter'`.

Um adaptador que sabe exatamente o que quer chama `readSelectedEntries({ content, names, budgetBytes })`: nomes exatos, sem padrão nem prefixo, sem enumerar, e o orçamento é dele e justificado por ele. É uma porta estreita de propósito — não um buraco por baixo dos limites.

## O que o relatório passou a distinguir

```jsonc
{
  "mods": [ { "modId": "cataclysm", "version": "3.16", … } ],
  "entryCount": null,          // não é zero: ninguém enumerou
  "features": null,            // não é tudo-falso: ninguém olhou
  "layers": [
    { "layer": "metadata",   "outcome": "completed",     "limit": null,                  "unknown": [] },
    { "layer": "structural", "outcome": "refused",       "limit": "maximumArchiveBytes",
      "unknown": ["entryCount", "features.containsClasses", …] },
    { "layer": "deep",       "outcome": "not-attempted", "limit": "no-adapter",
      "unknown": ["configuration-defaults-embedded-in-the-artifact", …] }
  ]
}
```

`entryCount` e `features` viraram anuláveis porque um booleano não consegue carregar as duas afirmações: "este arquivo não tem mixins" e "ninguém enumerou este arquivo" precisam ler diferente.

O inventário acompanhou: `undeclaredArchives` só registra `no-declared-mod` quando a camada de metadados **rodou**. Um limite nunca mais chega ao inventário como "não declara nada".

## O que não mudou, e por quê

Nove testes existentes falharam na primeira tentativa, e estavam certos. A versão inicial tratava *qualquer* falha da enumeração como recusa de camada, o que rebaixava decisões de segurança a aviso.

A regra final é estreita: viram recusa de camada **apenas** `too-many-entries` e o limite de tamanho do artefato. Ambos são limites de capacidade que este pacote escolheu, e nenhum diz nada sobre o artefato declarar um mod.

Tudo o mais continua recusando a inspeção inteira, como antes:

- nome de entrada inseguro (`..`, absoluto, letra de unidade, barra invertida, caractere de controle);
- entrada cifrada, ZIP64, multi-disco, diretório truncado;
- descritor acima de `maximumMetadataBytes`;
- razão de compressão implausível (bomba zip), checada pelos tamanhos declarados antes de alocar;
- tamanho real que contradiz o diretório;
- estouro do orçamento total de expansão.

Um descritor de 600 KiB não é um mod grande sendo identificado barato — é um arquivo pedindo para ser expandido, e ser barato de **encontrar** não é permissão para ler qualquer coisa.

## Testes

`packages/artifact-inspection/test/layered-inspection.test.ts`, cobrindo o que foi pedido:

| Caso | Resultado esperado |
| --- | --- |
| JAR grande com metadados válidos | mod identificado; `structural` recusada nomeando `maximumArchiveBytes` |
| Mais entradas que o limite profundo | mod identificado; `structural` recusada nomeando `too-many-entries` |
| JAR grande sem metadados conhecidos | `metadata` **completed** com `limit: null` e zero mods — "olhamos e não há nada" |
| Entrada de metadados anormalmente grande | recusa com `metadata-too-large` |
| ZIP/JAR malformado | `not-a-zip-container`; nunca vira recusa de camada, porque um artefato inválido não é um limite |
| Proteção contra expansão excessiva | razão implausível recusada; orçamento do adaptador respeitado; `readSelectedEntries` não enumera |
| Nome de entrada inseguro | continua recusando o artefato inteiro |
| Índice grande demais | `directory-too-large`; `metadata` recusada nomeando `maximumDirectoryBytes` |

## Resultado contra o modpack real

```
antes:  181 arquivos de mod → 103 declarados,  79 sem declaração (3 recusados por limite)
depois: 181 arquivos de mod → 176 declarados,   6 sem declaração (0 recusados por limite)
```

Os três casos que motivaram a mudança:

```
blue_skies       80 MiB  → blue_skies@1.3.31  structural: refused(maximumArchiveBytes)
L_Enders_Cataclysm 122 MiB → cataclysm@3.16   structural: refused(maximumArchiveBytes)
chipped          >20k entradas → chipped@3.0.7 structural: refused(too-many-entries)
```

Identificados, com as proteções profundas intactas e nomeadas. Nenhum limite global foi aumentado.

Os 6 restantes não têm nada a ver com limite: `supplementaries` e `trek` são duas classes de sintaxe TOML ainda não cobertas, e `kotlinforforge`, `lazyyyyy-core`, `mixin-booster` e `yet_another_config_lib` são bibliotecas/coremods sem bloco `[[mods]]`.

## Contrato

`ArtifactInspectionReportSchema` ganhou `layers` (obrigatório, exatamente 3) e tornou `entryCount` e `features` anuláveis. `ContractSchemaVersion` continua `1`: o campo é novo e não há relatório persistido em lugar nenhum — não existe banco de produção. Se existisse, um relatório antigo falharia a validação e a versão precisaria subir.

## Gate

`npm run check` — `CHECK_EXIT=0`, 834 testes, 832 passando, 0 falhando, 2 pulados.
