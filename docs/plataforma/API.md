# Contratos de API

Status: subset administrativo mínimo da Fase 2 e Launcher API somente leitura da Fase 5 implementados. A Fase 6 implementou contratos/domínios, não rotas de jogador. Rotas marcadas como planejadas ainda podem mudar por ADR ou por uma nova versão incompatível.

## Implementado na Fase 2

| Método | Rota | Estado |
| --- | --- | --- |
| `GET` | `/health/live` | liveness sem dependência pesada |
| `GET` | `/health/ready` | readiness com consulta ao PostgreSQL |
| `POST` | `/api/v1/auth/login` | Argon2id, rate limit, lockout, cookie opaco e CSRF |
| `GET` | `/api/v1/auth/session` | sessão ativa e permissões |
| `POST` | `/api/v1/auth/logout` | CSRF e revogação |
| `GET` | `/api/v1/servers` | `server.view`, somente leitura |
| `GET` | `/api/v1/audit` | `audit.view`, somente leitura |
| `POST` | `/agent/v1/register/complete` | token de uso único |
| `POST` | `/agent/v1/heartbeat` | transporte autenticado, Ed25519, prazo e nonce |

As demais rotas administrativas deste documento continuam planejadas. Nenhuma rota operacional de start/stop/restart ou mutação de release foi criada.

## Implementado na Fase 5 — Launcher API pública

| Método | Rota | Estado |
| --- | --- | --- |
| `GET` | `/health/live` | liveness da Launcher API |
| `GET` | `/launcher/v1/channels/{channel}` | documento assinado `beta` ou `stable`, se publicado |
| `GET` | `/launcher/v1/releases/{version}/{buildId}/manifest` | manifesto assinado e imutável |
| `GET` | `/launcher/v1/artifacts/{artifactId}` | bytes verificados por SHA-256 |

O serviço pinna chaves públicas Ed25519 e valida documentos antes de servir. Não possui autenticação administrativa porque é exclusivamente de leitura pública, e não contém `POST`, upload, promoção ou rollback. Essas mutações futuras pertencem à Control API autenticada.

## Convenções

- HTTPS em produção e prefixo `/api/v1` para administração.
- JSON validado por schema na entrada; schemas de saída são obrigatórios antes de tornar uma rota pública estável.
- UUID para recursos persistentes e `correlationId` em toda operação.
- `Idempotency-Key` obrigatório em mutações operacionais.
- timestamps UTC em ISO 8601.
- paginação por cursor, nunca offset em streams de alto volume.
- erro público sem stack trace, segredo ou caminho interno.

Envelope de erro:

```json
{
  "error": {
    "code": "SERVER_STATE_CONFLICT",
    "message": "A operação não é válida no estado atual.",
    "correlationId": "uuid",
    "details": []
  }
}
```

## Autenticação

| Método | Rota | Uso |
| --- | --- | --- |
| `POST` | `/api/v1/auth/login` | iniciar sessão do painel |
| `POST` | `/api/v1/auth/logout` | revogar sessão atual |
| `POST` | `/api/v1/auth/mfa/challenge` | completar segundo fator |
| `GET` | `/api/v1/auth/sessions` | listar sessões do usuário |
| `DELETE` | `/api/v1/auth/sessions/{id}` | revogar uma sessão |

Cookies de sessão serão `HttpOnly`, `Secure` e `SameSite`; mutações exigem proteção CSRF quando a autenticação usar cookies.

## Servidores e operações

| Método | Rota | Permissão |
| --- | --- | --- |
| `GET` | `/api/v1/servers` | `server.view` |
| `GET` | `/api/v1/servers/{id}` | `server.view` |
| `POST` | `/api/v1/servers/{id}/actions/start` | `server.control.start` |
| `POST` | `/api/v1/servers/{id}/actions/stop` | `server.control.stop` |
| `POST` | `/api/v1/servers/{id}/actions/restart` | `server.control.restart` |
| `POST` | `/api/v1/servers/{id}/actions/force-kill` | `server.control.force` |
| `POST` | `/api/v1/servers/{id}/console/commands` | `console.command` |
| `GET` | `/api/v1/servers/{id}/metrics/latest` | `metrics.view` |

Cada action retorna `202 Accepted` com um `jobId`; o estado real nunca é presumido pela resposta inicial.

## Builds e releases

| Método | Rota | Permissão |
| --- | --- | --- |
| `POST` | `/api/v1/servers/{id}/builds` | `modpack.build.request` |
| `GET` | `/api/v1/builds/{id}` | `modpack.build.view` |
| `POST` | `/api/v1/builds/{id}/cancel` | `modpack.build.cancel` |
| `POST` | `/api/v1/builds/{id}/approve` | `modpack.release.approve` |
| `POST` | `/api/v1/releases/{id}/promote` | `modpack.release.promote` |
| `POST` | `/api/v1/channels/{channel}/rollback` | `modpack.release.rollback` |

O corpo do pedido inclui versão base, bump pretendido, canal candidato, observação e política de aprovação. O servidor deriva usuário, permissões e timestamps da sessão.

## Mods e catálogo

- `GET /api/v1/mods`
- `GET /api/v1/mods/{id}`
- `PATCH /api/v1/mods/{id}/classification`
- `POST /api/v1/mods/{id}/versions`
- `POST /api/v1/catalog/validate`
- `GET /api/v1/catalog/conflicts`

Mudanças de lado, origem, licença, obrigatoriedade e hash geram auditoria com valor anterior e novo.

## Jogadores

- `GET /api/v1/players`
- `GET /api/v1/players/{uuid}`
- `POST /api/v1/players/{uuid}/actions/kick`
- `POST /api/v1/players/{uuid}/actions/ban`
- `POST /api/v1/players/{uuid}/actions/unban`
- `PUT /api/v1/players/{uuid}/whitelist`
- `PUT /api/v1/players/{uuid}/group`

UUID é a chave externa do jogador. Nomes são aliases históricos e não identificadores de autorização.

Essas rotas continuam planejadas e desabilitadas. `@voidfall/player-governance` não foi conectado à Control API; autenticação Minecraft, provider, retenção, autorização sensível e auditoria de leitura permanecem gates obrigatórios.

## Backups, arquivos e agendamentos

- `POST /api/v1/servers/{id}/backups`
- `POST /api/v1/backups/{id}/restore`
- `GET /api/v1/files?root=config&path=...`
- `PUT /api/v1/files/{fileId}` com revisão esperada;
- `POST /api/v1/schedules`
- `PATCH /api/v1/schedules/{id}`
- `DELETE /api/v1/schedules/{id}`

Uploads não aceitam path livre do cliente. A API recebe um identificador de raiz e caminho relativo, e o agente resolve ambos dentro de uma allowlist.

## API do agente

Autenticação mútua e identidade por agente:

- `POST /agent/v1/register/complete`: completar provisionamento de uso único;
- `POST /agent/v1/heartbeat`: estado, capacidades e versão;
- `POST /agent/v1/jobs/lease`: adquirir jobs compatíveis;
- `POST /agent/v1/jobs/{id}/renew`: renovar lease;
- `POST /agent/v1/jobs/{id}/events`: progresso e resultado;
- `POST /agent/v1/inventory`: inventário sanitizado;
- `POST /agent/v1/telemetry`: amostras com fonte e timestamp.

O agente inicia a conexão; a API pública não expõe porta administrativa no host do Minecraft.

## Endpoint local da ponte Forge

`POST /bridge/v1/modpack-build-requests` permanece planejado para loopback ou canal local equivalente. O contrato `ForgeBuildRequest` contém `requestId`, `correlationId`, `serverInstanceId`, `playerUuid`, emissão, expiração curta, nonce, permissão literal e assinatura Ed25519. O núcleo Java valida permissão, capabilities e replay antes do gateway; nenhum endpoint local ou adapter Forge foi habilitado.

O nome é contexto de auditoria; UUID é a identidade.

## WebSocket

Canal autenticado `/ws/v1` com subscriptions autorizadas:

- `server.status.changed`
- `server.console.appended`
- `job.progressed`
- `build.stage.changed`
- `metrics.sampled`
- `alert.changed`
- `audit.created`

Eventos possuem `eventId`, `type`, `occurredAt`, `correlationId`, `resource`, `sequence` e `payload`. Reconexão usa cursor; perda de eventos exige ressincronização REST.

## Compatibilidade

Alterações aditivas permanecem em `v1`. Remoção, mudança semântica ou tipo incompatível cria nova versão de contrato. Panel, API, agent e worker declaram intervalos de versões suportadas e recusam operações perigosas quando incompatíveis.
