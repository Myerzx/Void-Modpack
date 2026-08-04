# ANÁLISE DO MODPACK CONCLUÍDA

- Mods/componentes ativos encontrados: **245**
- Componentes analisados: **299**
- Bibliotecas: **43**
- Mods críticos: **45**
- Mods de cliente: **52**
- Mods de servidor: **2**
- Mods de ambos os lados: **191**
- Dependências obrigatórias ausentes: **0**
- Incompatibilidades: **6**
- Conflitos globais prováveis: **2**
- Candidatos à remoção/revisão: **78**
- Itens não verificados: **7**

## Dez maiores riscos

| Mod ID | Nível | Score | Evidência resumida |
| --- | --- | ---: | --- |
| `epicfight` | critico | 13 | 17 dependente(s) obrigatório(s); pode registrar conteúdo persistente ou orientado a dados; mais de uma versão ativa observada entre os conjuntos |
| `geckolib` | critico | 13 | 10 dependente(s) obrigatório(s); pode registrar conteúdo persistente ou orientado a dados; mais de uma versão ativa observada entre os conjuntos |
| `architectury` | critico | 11 | 12 dependente(s) obrigatório(s); pode registrar conteúdo persistente ou orientado a dados |
| `curios` | critico | 11 | 6 dependente(s) obrigatório(s); pode registrar conteúdo persistente ou orientado a dados; mais de uma versão ativa observada entre os conjuntos |
| `efn` | alto | 8 | 4 dependente(s) obrigatório(s); pode registrar conteúdo persistente ou orientado a dados; origem/licença ainda não ligada a um provedor |
| `invincible` | alto | 8 | 2 dependente(s) obrigatório(s); pode registrar conteúdo persistente ou orientado a dados; mais de uma versão ativa observada entre os conjuntos; origem/licença ainda não ligada a um provedor |
| `cloth_config` | alto | 7 | 7 dependente(s) obrigatório(s) |
| `library_of_exile` | alto | 7 | 4 dependente(s) obrigatório(s); pode registrar conteúdo persistente ou orientado a dados |
| `ba_bt` | alto | 6 | 2 dependente(s) obrigatório(s); pode registrar conteúdo persistente ou orientado a dados; origem/licença ainda não ligada a um provedor |
| `cataclysm` | alto | 6 | 3 dependente(s) obrigatório(s); pode registrar conteúdo persistente ou orientado a dados |

## Principais pontos únicos de falha

- `epicfight`: 17 dependentes obrigatórios.
- `architectury`: 12 dependentes obrigatórios.
- `geckolib`: 10 dependentes obrigatórios.
- `cloth_config`: 7 dependentes obrigatórios.
- `curios`: 6 dependentes obrigatórios.
- `cupboard`: 4 dependentes obrigatórios.
- `efn`: 4 dependentes obrigatórios.
- `epic_fight_avalon`: 4 dependentes obrigatórios.
- `ftblibrary`: 4 dependentes obrigatórios.
- `library_of_exile`: 4 dependentes obrigatórios.
- `playeranimator`: 4 dependentes obrigatórios.
- `cataclysm`: 3 dependentes obrigatórios.
- `yungsapi`: 3 dependentes obrigatórios.
- `ba_bt`: 2 dependentes obrigatórios.
- `balm`: 2 dependentes obrigatórios.

## Validação manual pendente

- alinhar Forge do cliente e servidor
- selecionar o catálogo cliente compatível com o servidor
- resolver origem/licença de cada artefato
- validar valores de configuração sem publicá-los
- importar em launcher limpo, iniciar, criar mundo e conectar ao servidor
- executar backup e restauração antes de remoções/atualizações

## Próximas etapas

- revisar `compatibilidade.json` e selecionar schemas explícitos para a Fase 7
- resolver divergências de baseline e revisar integrações opcionais
- promover somente configurações necessárias e sanitizadas
- executar matriz de smoke tests cliente-servidor
