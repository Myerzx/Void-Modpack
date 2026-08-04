# Fase 7.2: persistência e operação de configuração

Status: concluída tecnicamente em isolamento em 2026-08-04; gate local aprovado e matriz CI pendente de execução após o push.

## Resultado

O schema revisado `openloader-advanced-options` v1.0.0 agora percorre um fluxo isolado completo: registro fechado, persistência PostgreSQL, preparação otimista, lock operacional compartilhado, mutação segura do arquivo, revisão anterior, aplicação ou rollback, transição final e auditoria encadeada. Os testes usam PGlite e diretórios temporários; nenhum runtime Minecraft privado foi lido, alterado ou executado.

## Registro confiável

`@voidfall/configuration-schemas` expõe um registro de produto sem método público de cadastro. A única entrada é o codec `openloader-advanced-options-v1`, ligado ao schema, hash SHA-256, caminho relativo, limite de 4.096 bytes e modo `offline-only` aceitos no ADR-008.

`@voidfall/server-configuration` constrói o recurso a partir de uma raiz absoluta fornecida por configuração confiável e do caminho relativo congelado no registro. Uma definição OpenLoader é recusada se resource ID, schema ID, versão, hash, campos, limite, codec ou sufixo do caminho divergirem. JSON genérico, `additionalFolders`, paths de usuário e outros mods continuam negados.

O manifesto de revisão passou para a versão 2 para registrar também `resourceSchemaId`, `resourceSchemaSha256` e o codec aplicado. Revisões Java Properties continuam usando `previous.properties`; OpenLoader usa `previous.json`. Ambos preservam os bytes anteriores exatos.

## Persistência PostgreSQL

A migration `0004_configuration_operations.sql` adiciona:

- schemas e revisões imutáveis do schema revisado;
- recursos por instância, com path relativo e política vindos do registro confiável;
- revisões de operação nos estados `prepared`, `applied` ou `failed`;
- estado de aplicação por recurso nos estados `registered`, `prepared`, `applied` ou `failed`;
- lock compartilhado `minecraft-exclusive`, com proprietário e lease limitado.

As transições exigem versão esperada e SHA-256 atual esperado. Preparação, conclusão e falha usam locks de linha e compare-and-swap. Uma revisão de rollback só pode apontar para uma revisão aplicada do mesmo recurso e servidor.

O banco não recebe valores da configuração. Ele armazena apenas definição pública do schema, hashes, nomes de campos, ator, reason code, correlação, restart, código/estágio de falha e horários. A transição final e o evento da partição de auditoria `configuration` são gravados na mesma transação.

## Coordenação isolada

`PersistentConfigurationService` executa a sequência:

1. valida plano tipado e metadados de concorrência;
2. adquire `minecraft-exclusive` no PostgreSQL;
3. cria a revisão persistida `prepared`;
4. chama o `FilesystemConfigurationService`, que ainda exige a guarda `offline-exclusive-v1` e seu lock local por recurso;
5. marca a revisão como `applied` e grava auditoria atômica, ou marca `failed` com código e estágio sanitizados;
6. libera o lock compartilhado.

Aplicação e rollback do OpenLoader foram comprovados em diretório temporário. Uma falha da guarda offline preserva o arquivo, termina a revisão como `failed`, produz auditoria válida e libera o lock.

## Limites mantidos

- não há API, Server Agent ou painel ligados ao fluxo;
- nenhuma operação aponta para `Servidor/workspace/**` ou `Launcher/workspace/**`;
- o lock possui lease limitado, mas heartbeat, reconciliação de lock expirado e recuperação de operação `prepared` após crash pertencem à Fase 9;
- uma falha do banco depois da troca do arquivo pode deixar estado `prepared` para reconciliação; o serviço não inventa sucesso nem apaga a revisão filesystem;
- autorização e idempotência pública entram na Fase 7.3; este recorte persiste ator, motivo e correlação, mas não expõe endpoint;
- `restartRequired` continua metadata; nenhum restart é executado;
- divergências de versão do modpack permanecem evidência para smoke test e decisão humana, não impedem a evolução isolada deste fluxo.

## Validação

- `@voidfall/configuration-schemas`: build, typecheck e 14 testes;
- `@voidfall/database`: build, typecheck e 5 testes PostgreSQL/PGlite;
- `@voidfall/server-configuration`: build, typecheck e 13 testes descobertos; 12 executados no Windows e um socket Unix reservado à CI Linux;
- fluxo integrado: aplicação, rollback, falha, concorrência otimista, lock compartilhado e auditoria encadeada;
- gate completo local: 194 testes descobertos, 192 executados no Windows e dois sockets Unix ignorados; todos os builds/typechecks, Java 17, Forge Bridge e painel estático aprovados;
- `npm audit --omit=dev`: zero vulnerabilidades de runtime;
- validação documental: 299 componentes, 298 artefatos, 1.363 conexões, nenhuma dependência ausente e 26 arquivos públicos do servidor aprovados;
- matriz Windows/Linux pendente de execução após o push.

## Próximo recorte

Executar a Fase 7.3: contratos e endpoints autorizados de leitura, validação, aplicação e rollback; operação tipada no Server Agent; página de configuração com diff seguro e indicação de restart; E2E somente contra diretório temporário.
