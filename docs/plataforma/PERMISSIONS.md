# Permissões

## Dois domínios independentes

O painel controla pessoas que administram infraestrutura. O Minecraft controla jogadores dentro do jogo. Uma pessoa pode existir nos dois domínios, mas vínculo de identidade não concede permissão automaticamente.

## Papéis do painel

| Capacidade | Dono | Administrador | Moderador | Suporte | Somente leitura |
| --- | :---: | :---: | :---: | :---: | :---: |
| Ver dashboard/métricas | ✓ | ✓ | ✓ | ✓ | ✓ |
| Iniciar/parar/reiniciar | ✓ | ✓ | — | — | — |
| Force kill | ✓ | opcional | — | — | — |
| Console de leitura | ✓ | ✓ | ✓ | ✓ | ✓ |
| Enviar comando administrativo | ✓ | ✓ | limitado | — | — |
| Gerenciar jogadores | ✓ | ✓ | ✓ | consulta | — |
| Ver chat/coordenadas | ✓ | política | política | — | — |
| Gerenciar mods/configs | ✓ | ✓ | — | — | — |
| Solicitar build | ✓ | ✓ | — | — | — |
| Aprovar/promover/rollback | ✓ | política | — | — | — |
| Backups | ✓ | ✓ | — | consulta | consulta |
| Restaurar backup | ✓ | política | — | — | — |
| Gerenciar usuários/papéis | ✓ | limitado | — | — | — |
| Ver auditoria | ✓ | ✓ | limitado | limitado | — |
| Terminal do SO | break-glass | — | — | — | — |

As células “política” começam negadas e exigem habilitação explícita. “Limitado” significa comandos/recursos em allowlist.

## Permissões granulares do painel

Namespaces iniciais:

- `dashboard.view`, `metrics.view`;
- `server.view`, `server.control.start`, `.stop`, `.restart`, `.force`;
- `console.view`, `console.command`, `console.command.dangerous`;
- `logs.view`, `logs.export`, `player.activity.sensitive`;
- `players.view`, `.kick`, `.ban`, `.whitelist`, `.group`, `.teleport`;
- `mods.view`, `.manage`, `.classify`, `.licenseReview`;
- `files.view`, `.edit`, `.upload`, `.delete`;
- `backups.view`, `.create`, `.restore`, `.delete`;
- `modpack.build.request`, `.build.cancel`, `.release.approve`, `.release.promote`, `.release.rollback`;
- `schedules.view`, `.manage`;
- `users.view`, `.manage`, `roles.manage`;
- `audit.view`, `security.manage`.

## Grupos do Minecraft

| Grupo | Uso |
| --- | --- |
| `player` | padrão obrigatório de todo novo jogador; sem comando administrativo |
| `vip` | benefícios de gameplay explicitamente permitidos, sem administração |
| `moderator` | moderação limitada, sem controle de infraestrutura |
| `administrator` | comandos administrativos revisados |
| `owner` | controle máximo dentro do jogo, ainda separado do painel |

O grupo `player` não recebe `/gamemode`, `/give`, `/op`, gestão de permissões, controle do servidor, arquivos, painel ou informações administrativas.

## Comando de atualização

`/atualizar-modpack` exige uma permissão específica, planejada como `void.modpack.build.request`. Ela não será herdada por `player` ou `vip`. A ponte registra UUID, nome observado, instância, horário, resultado da autorização e request ID.

Essa permissão cria um candidato de build. Aprovar e promover release são capacidades separadas do painel.

## Mudanças de permissão

Toda mudança registra:

- ator e domínio de identidade;
- alvo por ID/UUID;
- papel/grupo anterior e novo;
- motivo;
- data e correlação;
- origem da solicitação;
- resultado local e resultado da sincronização com o servidor.

Não existe elevação automática por nome, primeiro login, posse de arquivo ou status de operador legado.

## Provedor do Forge

A integração definitiva com um sistema de permissões depende da análise dos mods ativos. O contrato da ponte deve abstrair `hasPermission(uuid, permissionNode)` e sincronização de grupos; a seleção do provedor exige novo ADR e teste com Forge 1.20.1.
