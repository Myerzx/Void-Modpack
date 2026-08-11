# Fase 18 — segurança do `server.properties`

Status: primeira fatia vertical implementada em 2026-08-11. A fase ampla de mundo e gamerules continua parcial.

## Escopo entregue

O registro fechado de configurações agora inclui `minecraft-server-properties-v1`, ligado somente ao arquivo lógico `server.properties` e aos campos:

- `online-mode`;
- `white-list`;
- `enforce-whitelist`;
- `enforce-secure-profile`;
- `enable-rcon`;
- `broadcast-rcon-to-ops`.

Todos são booleanos, exigem o servidor offline para aplicação e declaram restart. Path, schema, formato e limite continuam vindo do produto; a API recebe somente `resourceId` e valores tipados.

## Preservação e sigilo

O codec interpreta apenas os seis campos revisados. Toda propriedade restante é mantida como texto opaco na mesma posição e com o mesmo line ending. Ela não entra em leitura pública, diff, job ou auditoria. Isso cobre especialmente senha RCON, seed, IP, porta, MOTD e chaves adicionadas por mods.

Uma alteração publica os bytes anteriores no repositório privado de revisões antes da substituição atômica, exige hash/versão esperados e pode ser revertida. O parser recusa campos revisados ausentes ou duplicados, controles, arquivo acima de 64 KiB, link e alteração concorrente.

## Integração

- o bootstrap local registra o recurso somente depois de uma leitura válida dentro do lock `minecraft-exclusive` e com o processo observado offline;
- Control API, persistência, job, lease e Server Agent reutilizam a capability fechada `configuration.apply`;
- o painel permite alternar entre segurança do servidor e OpenLoader e deixa explícito que os demais valores permanecem opacos;
- nenhum executor genérico, path digitado ou edição direta do workspace foi adicionado.

## Evidência local

O smoke real de 2026-08-11 concluiu boot Forge 1.20.1/47.4.4, comando fechado `list-players` e desligamento gracioso. O console revelou autenticação offline e RCON habilitado no runtime atual. O teste não alterou esses valores: migrar `online-mode` pode mudar UUIDs e inventários de jogadores, e ativar whitelist pode bloquear acesso. A decisão deve ser explícita e acompanhada de backup, revisão da lista e plano de migração.

## Pendente

- decisão operacional para autenticação, whitelist, RCON, firewall e rotação do segredo existente;
- demais propriedades tipadas ou editor `RAW_EDITABLE` previsto no ADR-016;
- gamerules e gerenciamento de mundo;
- smoke de conexão de um cliente compatível, backup e restore.
