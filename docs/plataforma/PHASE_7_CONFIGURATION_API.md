# Fase 7.3: API, agente e painel da configuração

Status: concluída tecnicamente em isolamento em 2026-08-04; gate local aprovado e matriz CI Windows/Linux registrada abaixo.

## Resultado

O schema revisado `openloader-advanced-options` v1.0.0 agora atravessa o caminho operacional completo:

`painel → Control API → job durável → capability do Server Agent → PersistentConfigurationService → filesystem temporário → auditoria encadeada`

A Fase 7.3 não repetiu nem reescreveu as Fases 7.0–7.2. Ela reutiliza `ConfigurationRepository`, `OperationalLockRepository`, `PersistentConfigurationService`, o registro fechado do OpenLoader, a fila `SKIP LOCKED` e a auditoria já existentes. Não há segunda fonte de verdade e nenhuma máquina de estados foi duplicada.

Todos os testes usam PGlite e diretórios temporários do sistema operacional. Nenhum runtime Minecraft privado foi lido, alterado, iniciado ou conectado, e `Launcher/workspace/**` e `Servidor/workspace/**` não foram acessados.

## Contratos públicos

`@voidfall/contracts` ganhou `server-configuration.ts` com dez contratos versionados e seus JSON Schemas exportados (o pacote passou de 17 para 27 schemas):

| Contrato | Papel |
| --- | --- |
| `ConfigurationSchemaCatalog` | schemas e recursos autorizados |
| `ConfigurationResourceState` | estado e valores redigidos |
| `ConfigurationRevisionPage` | revisões e elegibilidade de rollback |
| `ConfigurationValidationRequest` / `ConfigurationValidationResult` | validar sem aplicar |
| `ConfigurationApplyRequest` | aplicar com hash/versão esperados e idempotência |
| `ConfigurationRollbackRequest` | rollback para revisão elegível |
| `ConfigurationOperationAcceptance` | recibo do enfileiramento |
| `ConfigurationOperationCommand` | comando tipado entregue ao agente |
| `ConfigurationOperationResult` | resultado sanitizado do agente |

Decisões fixadas na fronteira:

- as alterações trafegam como lista explícita de entradas `{ name, value }`; nenhum schema usa `additionalProperties`, então não existe payload extensível;
- o valor é uma união fechada de boolean, inteiro seguro e string até 1.024 caracteres — objeto, array e `null` não atravessam;
- um campo redigido nunca carrega a propriedade `value`; a união torna isso inexprimível, não apenas improvável;
- `applied` é o literal `false` no resultado de validação: validar não pode produzir revisão;
- raiz, path absoluto ou relativo, documento de schema, nome de codec e bytes de revisão não existem em nenhum contrato, nos dois sentidos;
- `configuration.apply` e `configuration.rollback` passam a ser tipos de job duráveis.

## RBAC

A migration `0005_configuration_permissions.sql` cria `configuration.view`, `configuration.validate`, `configuration.apply` e `configuration.rollback`. A seed `0002` é imutável e não foi tocada.

Ler uma configuração pode expor valores operacionais revisados, então a concessão é deny-by-default: apenas `owner` e `administrator` recebem as quatro permissões. `moderator`, `support` e `read-only` não recebem nenhuma. Uma regressão fixa a concordância entre a seed do banco e a política TypeScript para todos os papéis, de modo que banco e API não possam divergir sobre quem pode mutar. Permissões do painel continuam separadas dos grupos de permissão do Minecraft.

## Leitura tipada e redação

O banco e a auditoria continuam sem valores de configuração. Para exibir o estado atual sem violar esse limite, `FilesystemConfigurationService.readConfiguration()` executa sob a mesma guarda `offline-exclusive-v1` das mutações, aceita somente um `resourceId` registrado e devolve valores tipados mais o SHA-256 observado — nunca bytes, path ou manifesto.

A política de apresentação é deny-by-default e deriva tudo do registro fechado:

- um campo é publicado apenas se o codec revisado o declara não secreto **e** o valor observado ainda corresponde ao tipo declarado;
- qualquer outro caso vira `redacted`, sem `value`;
- uma observação de campo fora do schema revisado é descartada e não aparece na resposta.

Os codecs revisados passaram a expor `secretFields` a partir da política aceita, de modo que um chamador não pode ampliar o que é publicável.

## Control API

| Método | Rota | Permissão |
| --- | --- | --- |
| `GET` | `/api/v1/servers/{id}/configuration/schemas` | `configuration.view` |
| `GET` | `/api/v1/servers/{id}/configuration/resources/{resourceId}` | `configuration.view` |
| `GET` | `/api/v1/servers/{id}/configuration/resources/{resourceId}/revisions` | `configuration.view` |
| `POST` | `/api/v1/servers/{id}/configuration/resources/{resourceId}/validate` | `configuration.validate` |
| `POST` | `/api/v1/servers/{id}/configuration/resources/{resourceId}/apply` | `configuration.apply` |
| `POST` | `/api/v1/servers/{id}/configuration/resources/{resourceId}/rollback` | `configuration.rollback` |

Todas exigem sessão autenticada, RBAC, rate limit próprio e validação estrita nos dois lados; as mutações exigem CSRF adicionalmente.

Pontos de projeto:

- **leitura deny-by-default**: o leitor tipado é uma dependência opcional injetada. Sem ele a API responde `valuesAvailable: false` com `values: []` e a validação informa `changedFields: null` — “diferença desconhecida”, jamais “nenhuma diferença”.
- **idempotência pública e durável**: o `correlationId` da operação é derivado deterministicamente de `idempotencyKey`, `serverId` e `resourceId`. A fila deduplica pelo hash da requisição inteira; um `correlationId` aleatório faria um replay honesto parecer outra requisição e ser recusado. O `correlationId` HTTP por requisição continua separado e é o que a auditoria carrega.
- **replay versus conflito**: a mesma chave com a mesma requisição devolve `200` com `replayed: true` e o job original; a mesma chave com requisição diferente devolve `409 CONFIGURATION_IDEMPOTENCY_CONFLICT`.
- **concorrência obsoleta**: hash ou versão de estado divergentes são recusados com `409 CONFIGURATION_STATE_STALE` antes de qualquer enfileiramento.
- **campo duplicado**: recusado com `400` na fronteira. Resolver silenciosamente pelo primeiro ou último valor permitiria contrabandear uma intenção não revisada.
- **rollback**: aceito apenas para revisão `applied` do mesmo recurso e da mesma instância.
- **erros**: sempre `{ code, message, correlationId, details: [] }`, sem stack trace, path, host ou mensagem interna.

## Server Agent

A capability `configuration.apply` executa a operação tipada. Não existe executor genérico:

- o comando só pode nomear um `resourceId` revisado e campos revisados;
- raiz, path, schema e codec são resolvidos exclusivamente pela configuração confiável local do agente, com allowlist explícita de recursos;
- um comando recusado lança antes de qualquer persistência, então nunca vira revisão nem operação auditada;
- um comando aceito sempre resolve para um resultado sanitizado, inclusive em falha;
- falhas passam por um conjunto fechado de códigos publicáveis, de modo que um erro interno inesperado não vira canal para path, estágio ou detalhe de host;
- o envelope de resultado é assinado e outbound-only.

Nesta fase a capability executa somente contra diretório de integração temporário. `restartRequired` continua metadata: nada inicia, para ou reinicia o Minecraft.

## Job durável

`runConfigurationWorkerOnce` reutiliza a fila existente. O payload contém exatamente um comando tipado válido; payload malformado, parâmetro extra ou operação que discorda do tipo do job falham o job antes de a capability ser chamada. Recusa e falha sanitizada viram erro de job não-retryable cujo código deriva do código publicado. Eventos de job registram nomes de campos, hashes e o flag de restart — nunca um valor.

## Painel

`/configuracoes` é a única área do painel servida pela API real; o dashboard continua fixture declarada. As regras vivem em um view model puro e testável:

- um valor redigido nunca é renderizado nem entra no diff;
- um campo sem valor legível é reportado como “não comparável” em vez de aparecer mudando a partir de uma linha de base inventada, e é excluído da requisição;
- um campo que o schema revisado não declara é descartado, não enviado;
- uma ação ausente das permissões da sessão não é oferecida;
- restart aparece apenas como metadata — a tela não possui controle que inicie, pare ou reinicie o Minecraft;
- loading, vazio, negado, conflito, erro e sucesso têm estados distintos, e falhas da API viram mensagens sanitizadas.

`panel-web` passou a ser ES module para que o view model puro possa ser exercitado pela prova E2E.

## Prova E2E

`apps/control-api/test/configuration-e2e.test.ts` cobre, sempre contra diretório temporário do SO:

1. validação sem efeito em disco ou estado;
2. aplicação completa, com bytes, estado persistido, revisão e auditoria encadeada concordando;
3. replay idempotente produzindo um job e uma revisão;
4. hash obsoleto de um escritor concorrente recusado em vez de sobrescrever;
5. falha sanitizada que deixa o documento intacto e ainda libera o lock compartilhado;
6. rollback restaurando os bytes anteriores exatos como nova revisão;
7. formato não registrado, recurso desconhecido e identificador em forma de path que nunca alcançam o filesystem;
8. sessão sem permissão negada em todo o fluxo.

Cada cenário também verifica que nenhuma resposta, job ou registro de auditoria carrega a raiz temporária, o caminho relativo revisado ou um valor de configuração, e que a partição de auditoria `configuration` continua verificável.

## Critério de conclusão da Fase 7

- [x] uma configuração suportada percorre painel → API → job/agente → filesystem isolado → auditoria;
- [x] validação, concorrência, falha e rollback testados;
- [x] nenhum formato não registrado pode ser editado.

## Limites mantidos

1. O runtime Minecraft privado continua desconectado; nenhum processo é iniciado, parado ou reiniciado.
2. `restartRequired` é metadata; nenhuma mutação agenda ou executa restart.
3. Somente o codec OpenLoader revisado possui registro, persistência e aplicação. JSON genérico, TOML, YAML e CFG continuam sem parser, path público ou operação.
4. Banco e auditoria continuam sem valores de configuração.
5. A guarda offline continua um trust boundary injetado; a reconciliação durável com start/stop pertence à Fase 9.
6. O transporte real API↔Agent pertence à Fase 9.2; nesta fatia o leitor tipado e o executor são dependências injetadas e a integração permanece deny-by-default quando ausentes.

## Riscos abertos após a Fase 7.3

- não há heartbeat nem reconciliação automática de lock expirado ou operação `prepared` após crash;
- revisões podem conter segredos presentes no arquivo anterior; storage cifrado, retenção e backend remoto ainda não existem;
- o leitor tipado é síncrono com a requisição; não há cache, paginação de revisões além de 50 nem cursor;
- a lista de revisões é limitada a 100 por consulta e não possui âncora incremental.
