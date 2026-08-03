# Inventário e catálogo reconciliado da Fase 4

Status: contratos e reconciliador implementados e validados localmente; matriz Windows/Linux pendente.

## Objetivo do recorte

Criar um núcleo TypeScript determinístico que receba snapshots sanitizados de inventários cliente/servidor e entradas revisadas do catálogo, identifique artefatos pelos bytes e produza um relatório canônico de presença, conflitos e bloqueios. O recorte termina em contratos portáteis, um pacote isolado e testes. Não lê `Launcher/workspace/` ou `Servidor/workspace/`, não abre JARs, não consulta provedores, não altera banco, não cria rotas, não publica releases e não decide licença ou lado automaticamente.

## Separação de identidades

Existem três identidades diferentes e elas não podem ser confundidas:

| Identidade | Exemplo | Uso |
| --- | --- | --- |
| artefato de conteúdo | `sha256:<64 hex>` | prova que dois inventários observaram exatamente os mesmos bytes |
| entrada lógica | `ancient-obelisks` | acompanha o projeto/mod ao longo de versões e arquivos |
| ocorrência | inventário + path | registra onde e em qual estado o artefato foi observado |

Nome do arquivo, nome amigável, project ID ou URL não são identidade de conteúdo. Coincidência de filename pode gerar evidência ou conflito, mas nunca uma união automática.

## Contrato `InventorySnapshot`

Cada snapshot é produzido fora deste pacote por um exportador autorizado e contém somente metadados sanitizados:

- `schemaVersion: 1`;
- `inventoryId` estável para a coleta;
- `observedAt` UTC;
- fonte com `sourceId`, escopo `client` ou `server` e tipo fechado;
- runtime observado: Minecraft, loader e versão do loader quando conhecida;
- entradas com path relativo, filename coerente, tipo, estado, bytes e SHA-256.

Tipos de fonte iniciais:

- `launcher-export`;
- `server-export`;
- `release-manifest`;
- `reviewed-import`.

Estados observáveis:

- `active`: o exportador comprovou que a ocorrência está habilitada;
- `disabled`: a ocorrência existe, mas não está habilitada;
- `unknown`: o exportador não consegue provar o estado.

O snapshot não transporta path absoluto, conteúdo, conta de launcher, mundo, jogador, log, endereço, segredo, licença aprovada ou decisão final de lado.

## Invariantes do snapshot

1. lista de entradas em ordem canônica por path normalizado;
2. paths únicos após NFC, case fold e normalização de separador;
3. basename do path igual ao `filename`;
4. SHA-256 minúsculo e tamanho positivo;
5. nenhuma propriedade adicional;
6. no máximo 100.000 entradas;
7. runtime e fonte explícitos;
8. o snapshot vazio é permitido como observação real, mas não prova ausência global.

## Entradas revisadas do catálogo

`ModCatalogEntry` continua sendo a única entrada com decisão de publicação. O reconciliador valida todas as entradas recebidas e preserva:

- ID lógico;
- hash e tamanho;
- runtime;
- lado revisado;
- origem/provedor;
- decisão e evidência de distribuição;
- estado de revisão;
- dependências.

Metadado `distributionAllowed` de um launcher, presença num modpack anterior ou download por um provedor são evidências, não licença concedida. Somente uma entrada `allowed` com expressão de licença, referência, revisor e horário cumpre o contrato atual.

## Algoritmo de reconciliação

1. validar plano, runtime alvo, catálogo e todos os snapshots sem efeito externo;
2. ordenar as entradas e rejeitar snapshots não canônicos ou paths colidentes;
3. derivar `artifactId` exclusivamente de `sha256`;
4. agrupar ocorrências com o mesmo hash;
5. unir o conjunto de hashes observados ao conjunto de hashes catalogados;
6. associar um artefato a uma entrada lógica somente quando o hash tiver exatamente uma entrada de catálogo;
7. manter zero correspondências como `untracked` e múltiplas como `ambiguous`;
8. calcular evidência de lado apenas a partir de ocorrências `active`;
9. comparar essa evidência com o lado revisado sem sobrescrevê-lo;
10. detectar colisões de filename entre hashes diferentes;
11. comparar runtimes observados/catalogados com o runtime alvo;
12. produzir artefatos, conflitos, bloqueios e totais em ordem canônica.

Mesma entrada em cliente e servidor sugere `both`; somente cliente sugere `client`; somente servidor sugere `server`; ausência de ocorrência ativa sugere `unknown`. Toda sugestão continua sendo evidência e exige revisão humana no item seguinte da Fase 4.

## Estados de correspondência

- `cataloged`: exatamente uma entrada lógica possui o hash;
- `untracked`: o hash foi observado, mas não existe no catálogo;
- `ambiguous`: o mesmo hash está atribuído a mais de uma entrada lógica.

Entradas catalogadas que não aparecem em nenhum snapshot também entram no relatório para que ausência de evidência não seja silenciosa.

## Bloqueios iniciais

- `missing-catalog-entry`;
- `ambiguous-catalog-match`;
- `missing-inventory-evidence`;
- `inactive-only`;
- `unknown-side`;
- `side-conflict`;
- `distribution-pending`;
- `distribution-blocked`;
- `catalog-review-required`;
- `runtime-mismatch`;
- `filename-collision`;
- `size-mismatch`.

Bloqueios são deduplicados e ordenados. O relatório não autoriza publicação; ele apenas torna explícito o trabalho necessário.

## Conflitos e precedência

- SHA-256 prevalece para identidade de bytes;
- o catálogo revisado prevalece para ID lógico, lado, origem, licença e dependências;
- inventário prevalece apenas para presença, path e estado observados;
- filename nunca prevalece sobre hash;
- valores desconhecidos permanecem desconhecidos;
- conflitos não são resolvidos por maioria de fontes.

## Determinismo

Para a mesma entrada validada, o pacote deve produzir o mesmo relatório independentemente da ordem dos snapshots, ocorrências e entradas de catálogo. Ordenações usam comparação ordinal sobre valores normalizados. O relógio e `reconciliationId` vêm do plano confiável; não são criados implicitamente no núcleo.

## Limites de confiança

O pacote não:

- varre diretórios;
- segue links ou recebe paths absolutos;
- executa ou descompacta JAR/ZIP;
- chama CurseForge, Modrinth, GitHub ou outra rede;
- converte metadata de provedor em aprovação;
- altera `ModCatalogEntry`;
- persiste relatório;
- registra ator ou auditoria;
- publica no canal stable.

Exportadores, upload/quarantine, inspeção segura de arquivos, persistência, revisão humana, API, painel e worker terão recortes próprios.

## Estado dos dados atuais

Os inventários públicos existentes comprovam a necessidade do recorte, mas ainda não formam um catálogo real reconciliado:

- o inventário sanitizado do servidor possui filename, estado, tamanho e SHA-256;
- o catálogo do launcher possui project/file IDs e estado, mas não possui SHA-256 nem tamanho;
- a comparação atual por nome de arquivo é evidência de divergência, não prova de identidade;
- a licença e o lado de muitos artefatos continuam desconhecidos.

Portanto, os arquivos atuais não serão convertidos silenciosamente. Um exportador de cliente com hash e um importador revisado deverão produzir `InventorySnapshot` antes da reconciliação real.

## Matriz de testes implementada

1. aceita snapshots canônicos cliente/servidor e agrupa bytes iguais por hash;
2. produz resultado idêntico para entradas em ordens diferentes;
3. mantém hashes sem catálogo como `untracked`;
4. detecta múltiplos IDs lógicos para o mesmo hash;
5. inclui catálogo sem observação e ocorrências somente desabilitadas;
6. sugere lado por presença ativa sem promover a sugestão;
7. detecta conflito entre lado revisado e evidência;
8. preserva licença pendente/bloqueada e revisão incompleta como bloqueio;
9. detecta runtime, tamanho e filename conflitantes;
10. rejeita traversal, basename divergente, path duplicado, ordem não canônica e campos extras;
11. limita snapshots e entradas;
12. comprova que o pacote não acessa filesystem, rede ou runtime privado.

## Gate de saída

O item 1 pode ser concluído em isolamento quando contratos, JSON Schema, reconciliador e testes passarem em Windows e Linux. Isso não significa que os 181 JARs ativos do servidor ou os addons do launcher estejam aprovados. A classificação manual por lado e distribuição é o item 2 da Fase 4 e depende primeiro de snapshots com hashes completos.

O gate local passou com 18 testes de contratos, 12 testes específicos do reconciliador e 95 casos no monorepo. No Windows local, os 93 aplicáveis passam e dois sockets Unix de pacotes anteriores são ignorados. Falta confirmar a matriz do GitHub em Windows e Linux antes de marcar o item como concluído.
