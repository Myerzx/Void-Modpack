# VoidFall — mapa técnico do modpack

## Resumo

Base auditada: Minecraft 1.20.1, Java 17 e Forge 47.4.x. O cliente canônico e o servidor ainda não formam uma release compatível: somente 11 dos 181 JARs ativos do servidor coincidem por nome exato com o launcher publicado.

## Versões principais

| Componente | Versão |
| --- | --- |
| Minecraft | 1.20.1 |
| Java | 17 |
| Forge do launcher | 47.4.0 |
| Forge do servidor | 47.4.4 |

## Quantidades

- Componentes ativos mapeados por `mod_id`: **245**.
- Componentes documentados, incluindo desativados/candidatos: **299**.
- Artefatos únicos inventariados: **298**.
- Dependências declaradas: **1363**.
- Dependências obrigatórias ausentes: **0**.

## Quantidade por categoria

| Categoria | Componentes ativos |
| --- | ---: |
| armazenamento | 1 |
| automacao | 2 |
| bibliotecas | 43 |
| cliente | 63 |
| combate | 26 |
| magia | 4 |
| mundo | 31 |
| otimizacao | 9 |
| outros | 44 |
| progressao | 9 |
| rede | 3 |
| scripts | 4 |
| servidor | 6 |

## Mods críticos

`epicfight`, `architectury`, `geckolib`, `cloth_config`, `curios`, `cupboard`, `efn`, `epic_fight_avalon`, `ftblibrary`, `library_of_exile`, `playeranimator`, `cataclysm`, `yungsapi`, `ba_bt`, `balm`, `citadel`, `embeddium`, `iceberg`, `invincible`, `konkrete`, `lionfishapi`, `mmorpg`, `moonlight`, `prism`, `resourcefulconfig`, `structure_gel`, `terrablender`, `attributeslib`, `bookshelf`, `cerbons_api`

## Problemas encontrados

- O launcher atual não é compatível com o servidor por inventário.
- Forge diverge entre cliente (47.4.0) e servidor (47.4.4).
- A fonte oficial lista Forge 47.4.10 como recomendado e 47.4.22 como mais recente para 1.20.1; isso não autoriza atualização automática.
- Proveniência, licença e redistribuição ainda não estão resolvidas para a maioria dos artefatos do servidor.
- Compatibilidade da versão mais recente de cada projeto não foi presumida; exige revisão oficial e smoke test.
- Configurações privadas foram preservadas; apenas caminhos públicos e agregados sanitizados entram nesta base.

## Dependências ausentes

Nenhuma ausente confirmada no conjunto agregado.

## Incompatibilidades

- `client-server-baseline-mismatch`
- `forge-baseline-divergence`
- `armourers_workshop`: resolver findings e repetir smoke test
- `epicfight`: resolver findings e repetir smoke test
- `openloader`: resolver findings e repetir smoke test
- `wom`: resolver findings e repetir smoke test

## Candidatos à remoção

78 componentes foram marcados apenas para revisão; nada foi removido. Consulte [remocoes.json](remocoes.json).

## Navegação

- [Resumo para agentes](resumo.json)
- [Inventário](inventario.json)
- [Dependências](dependencias.json)
- [Conexões](conexoes.json)
- [Compatibilidade](compatibilidade.json)
- [Riscos](riscos.json)
- [Remoções](remocoes.json)
- [Performance](performance.json)
- [Configurações, scripts e datapacks](configuracoes.json)
- [Categorias](categorias/)
- [Fichas individuais](mods/)
- [Gráficos](graficos/)
- [Metodologia e limites](metodologia.md)
- [Relatório final](relatorio-final.md)
