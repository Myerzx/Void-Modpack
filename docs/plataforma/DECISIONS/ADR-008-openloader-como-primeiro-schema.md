# ADR-008 — OpenLoader como primeiro schema específico

- Status: aceita
- Data: 2026-08-04
- Proprietário: `voidfall-product-owner`

## Contexto

A Fase 7.1 exige uma escolha explícita do primeiro schema operável, com campos, limites, parser, serializador, política de segredo, restart e migração congelados antes de qualquer persistência, API ou painel. O proprietário escolheu OpenLoader desde que o recorte fosse seguro e adequado à arquitetura existente.

O diretório OpenLoader também contém data packs e resource packs. Esses conteúdos são extensos, heterogêneos e podem incluir JSON, NBT, ZIP, funções e outros assets; eles não são uma configuração tipada simples e permanecem fora desta decisão. A [documentação oficial do OpenLoader](https://docs.darkhax.net/1.20.1/open-loader/) identifica `config/openloader/advanced_options.json` como o arquivo de configuração, documenta os dois grupos aceitos e informa que alterações exigem encerrar e iniciar o jogo novamente.

## Decisão

Selecionar somente `openloader_advanced_options_v1`, limitado ao arquivo lógico `config/openloader/advanced_options.json`. Nenhum wildcard, diretório, data pack, resource pack, path fornecido pelo usuário ou schema fornecido pelo usuário pertence ao recorte.

### Identidade congelada

| Propriedade | Valor |
| --- | --- |
| Schema ID | `openloader-advanced-options` |
| Candidate ID | `openloader_advanced_options_v1` |
| Resource ID | `openloader-advanced-options` |
| Schema version | `1.0.0` |
| Schema SHA-256 | `25c2d9d41af6fb0ead2ecc25dd5b9eda130ab60353b37b1b707b6da7b9291ce0` |
| Formato | JSON UTF-8 estrito |
| Path lógico confiável | `config/openloader/advanced_options.json` |
| Limite | 4.096 bytes |
| Aplicação futura | somente offline |

### Campos permitidos

| Campo lógico | Tipo | Obrigatório | Default | Restart |
| --- | --- | --- | --- | --- |
| `dataPacks.enabled` | boolean | sim | `true` | sim |
| `resourcePacks.enabled` | boolean | sim | `true` | sim |

`dataPacks.additionalFolders` e `resourcePacks.additionalFolders` devem existir como arrays vazios no documento serializado, mas não são campos editáveis. Qualquer elemento nesses arrays é recusado pela versão 1. Isso impede paths relativos ou absolutos fornecidos pelo usuário.

### Parser e serializador

O parser `strict-openloader-json-v1`:

1. limita a entrada a 4.096 bytes;
2. aceita somente o objeto raiz com `resourcePacks` e `dataPacks`;
3. aceita em cada grupo somente `enabled` boolean e `additionalFolders` vazio;
4. rejeita chaves ausentes, desconhecidas ou duplicadas, JSON inválido e valores de outro tipo;
5. devolve apenas os dois campos booleanos tipados.

O serializador `canonical-openloader-json-v1` recebe somente esses campos registrados, restaura os arrays vazios e produz JSON determinístico com duas espaços, LF, ordem canônica do documento e newline final. Ele não recebe path, nome de arquivo, schema ou conteúdo extensível.

### Segredos, restart e migração

- não há campo secreto na versão 1;
- os dois campos exigem restart completo; `/reload` e recarga de resource pack não aplicam esse arquivo;
- a migração aceita somente um documento já compatível com a estrutura estrita e o normaliza pelo serializador canônico;
- documento com `additionalFolders` não vazio, chaves extras ou estrutura divergente bloqueia a migração e exige nova decisão/revisão manual;
- `data/` e `resources/` não são migrados, editados, copiados nem inventariados por esse schema;
- rollback futuro deverá restaurar a revisão anterior exata, continuar offline e nunca reiniciar o Minecraft implicitamente.

## Consequências

- OpenLoader substitui a recomendação inicial de `java_properties_v1` como primeiro schema por decisão explícita do proprietário;
- a Fase 7 prova um codec JSON específico sem transformar JSON genérico em superfície operacional;
- a seleção não resolve a incompatibilidade de versão do mod registrada pela Fase 7.0 e não certifica gameplay;
- persistência, registro operacional, locks compartilhados, aplicação em filesystem, auditoria, API, agente e painel continuam pertencendo às Fases 7.2 e 7.3;
- ampliar os campos ou permitir `additionalFolders` exige nova versão de schema e revisão de ameaça de paths;
- editar packs OpenLoader exige um recorte próprio de inspeção, proveniência, licenças e validação, não uma extensão silenciosa deste ADR.

## Fixtures e validação

As fixtures sanitizadas ficam em `Plataforma/packages/configuration-schemas/fixtures/openloader-advanced-options-v1/`. Elas cobrem o default público, desativação de data packs e rejeição explícita de path. Testes fixam a identidade SHA-256, o round-trip canônico, os limites e as recusas. Nenhuma fixture contém path local, segredo, mundo ou conteúdo de pack.

## Não autorização

Este ADR não autoriza leitura ou escrita operacional no servidor, importação dos packs existentes, endpoint, painel, job, restart, conexão ao agente ou alteração do runtime privado.
