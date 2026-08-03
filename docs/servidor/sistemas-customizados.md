# Sistemas customizados

## OpenLoader

Foram observados seis datapacks carregados por configuração:

| Pacote | Arquivos | Função inferida pelo material |
| --- | ---: | --- |
| `cte_configuration` | 371 | Configuração e integração geral |
| `cte_epicfight_mns_staff_compat` | 4 | Compatibilidade de cajados |
| `cte_epicfight_roe_compat` | 157 | Compatibilidade de combate/equipamentos |
| `cte_events` | 3 | Eventos do pack |
| `cte_fix` | 22 | Correções orientadas a dados |
| `cte_mns` | 4.894 | Conteúdo principal de progressão e integração |

Esses nomes e contagens descrevem a cópia auditada. O conteúdo ainda exige autoria, licença e testes antes de distribuição.

## KubeJS

Os scripts analisados implementam ou ajustam:

- localização de chefes, uso de itens de retorno e teleporte de grupo;
- drops probabilísticos de moedas de facção, com bônus por raridade;
- gravação e restauração de posições para diferentes atividades;
- velocidade de ataque de itens customizados;
- registro de doze atributos de progressão MMORPG.

Alguns scripts contêm coordenadas operacionais do mundo. Elas permanecem no workspace privado e devem virar configuração externa antes de uma futura publicação.

## Patch Forge local

Há fonte de um mod de compatibilidade local para impedir recompensas indevidas de criaturas passivas e aplicar requisitos de nível por raridade de profissão. O artefato se declara `0.0.1`, atua nos dois lados e usa mixins em integrações específicas.

A fonte permanece como evidência privada porque autoria e licença precisam ser deliberadamente confirmadas. Somente depois disso ela poderá ser promovida a `Servidor/source/`, receber build reproduzível, testes e changelog.

## Stubs de compatibilidade

Três JARs ativos aparentam ser stubs para satisfazer dependências legadas. Stubs reduzem falhas de carregamento, mas podem mascarar chamadas ausentes e têm risco próprio de autoria/distribuição. Cada um precisa de código-fonte, licença, justificativa e teste de ausência do mod original.

## Facções e economia

O material privado também contém especificações de facções e economia. Elas são documentação de intenção e não prova automática de que todas as regras estão ativas. A certificação deve ligar cada regra a script/datapack, teste e versão de release.
