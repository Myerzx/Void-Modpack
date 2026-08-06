# ADR-010 — Provider de permissões Minecraft

- Status: **proposta** — aguarda decisão do proprietário
- Data: 2026-08-06
- Proprietário: `voidfall-product-owner`
- Responde: ROADMAP pergunta 5
- Bloqueia: Fase 11 itens 1, 4 e 5 (provider deny-by-default, executor tipado de moderação)

## Contexto

O domínio puro já existe. `Plataforma/packages/player-governance` traz `MinecraftPermissionRegistry`, `ModerationCaseRegistry`, `PlayerProfileRegistry` e `PlayerDataPolicyEngine`, com 12 testes. Os dois pontos de contato com o mundo real são interfaces **injetadas**:

- `MinecraftPermissionProvider` — responde se um jogador tem um nó, e sincroniza grupos;
- `ModerationExecutor` — aplica kick, ban, mute, whitelist e grupo.

Nenhuma tem implementação. É exatamente a forma que os guards de acesso exclusivo offline tinham antes da Fase 11.0: uma fronteira de confiança nomeada, sem nada por trás. A lição já foi paga uma vez — uma capability anunciada cuja dependência não existe é um trabalho reivindicado que só pode falhar.

### O que existe hoje no servidor

O catálogo revisado (`Servidor/catalog/mods.csv`, 195 mods) **não contém nenhum mod de permissões**. A pergunta 5 do ROADMAP pergunta "qual mod já existe ou pode ser introduzido sem conflito"; a primeira metade está respondida: nenhum. Qualquer provider é uma dependência nova, sujeita ao Gate G4 — lado, origem, licença, hash e dependências revisados.

Autorização hoje é o mecanismo vanilla: 7 operadores em `ops.json`, com níveis 1–4. Isso é binário na prática e não expressa nós.

### O RBAC do painel já existe e é separado

`Plataforma/packages/permissions` define `PANEL_PERMISSIONS` e cinco papéis, e a migração `0002_rbac_seed.sql` já semeia `players.view`, `players.kick`, `players.ban`, `players.whitelist`, `players.group` e `player.activity.sensitive`.

Isso **não** é o mesmo que permissão Minecraft, e os gates do projeto exigem que continuem separados: o RBAC decide quem pode pedir uma ação pelo painel; o provider decide o que um jogador pode fazer dentro do jogo. Este ADR trata só do segundo.

## Opções

### Opção A — Forge PermissionAPI, deny-by-default, sem mod novo

Usar a [PermissionAPI](https://docs.minecraftforge.net/en/1.12.x/utilities/permissionapi/) do próprio Forge. Nós são registrados por `registerNode()` no formato `modid.subgrupo.permissao`, com um `DefaultPermissionLevel` entre `ALL`, `OP` e `NONE`.

- Nenhuma dependência nova. Gate G4 não é acionado.
- `NONE` como default é literalmente deny-by-default, que é o que a Fase 11 pede.
- Está no loader que o pack já usa; não há risco de conflito com os 195 mods.
- **Três níveis, não grupos.** Não há hierarquia, herança, expiração nem contexto. "Grupo" teria de ser construído por cima, no VoidFall, e o provider só saberia responder sim/não por nó.
- O handler default do Forge é substituível por um mod; se algum dos 195 já registrar um handler próprio, o comportamento muda sem aviso. Isso precisa ser verificado antes de aceitar.

### Opção B — LuckPerms (Forge 1.20.1)

O padrão de fato. Build oficial para Forge 1.20.1 ([v5.4.102 no CurseForge](https://www.curseforge.com/minecraft/mc-mods/luckperms/files/4738950), também no [Modrinth](https://modrinth.com/plugin/luckperms/version/v5.4.88-forge)), licença permissiva, mais de 2M downloads.

- Grupos, herança, contextos, expiração e nós — tudo que a Fase 11 quer expressar, já modelado.
- API e armazenamento próprios, com documentação madura.
- **Traz seu próprio banco e sua própria fonte de verdade.** Passam a existir dois lugares que sabem quem está em qual grupo, e a Fase 11 teria de decidir qual manda — o que é uma decisão de arquitetura, não de configuração.
- Problemas conhecidos e verificados em Forge 1.20.1: crash de startup em certas combinações de mods, e um erro de pré-login em que "permissions data for your user was not loaded during the pre-login" porque o UUID de pré-login ainda não é o definitivo. Esse segundo interage diretamente com o [ADR-009](ADR-009-autenticacao-minecraft-e-topologia.md) e com a regra de reconciliar por UUID.
- Existe um [fork comunitário](https://github.com/AlphaConqueror/LuckPerms-Forge-1.20.1) anunciando correção de um "Forge capabilities issue"; não consegui confirmar o defeito nem o conserto pela página do repositório. Depender de um fork não verificado no caminho de autorização não é aceitável sem revisão.
- Um mod novo em 195, num pack que a Fase 7.0 já mostrou ter conflitos de compatibilidade.

### Opção C — Adiar o provider e entregar a Fase 11 sem permissões in-game

Persistir perfis, aliases, casos e recibos; ligar moderação por comandos vanilla (kick, ban, whitelist) via console; deixar grupos e nós fora do recorte.

- Destrava a maior parte da Fase 11 sem dependência nova nenhuma.
- Moderação real funciona: kick, ban e whitelist são vanilla.
- **Grupos e nós continuam sem dono**, e `MinecraftPermissionRegistry` continua sendo domínio sem provider — exatamente o estado que este ADR existe para encerrar.
- O catálogo fechado de console hoje tem `list-players` e `save-all`. Kick, ban e whitelist exigiriam ampliar esse catálogo, o que é um recorte de segurança próprio: são comandos com argumento, e o console do VoidFall foi desenhado para literais revisados sem argumento.

## Recomendação

**Opção A para permissões, com o recorte de grupos ficando no VoidFall.** Duas razões:

1. O Gate G4 e a Fase 7.0 já mostraram o custo de introduzir mod neste pack. A PermissionAPI não introduz nenhum.
2. Ter duas fontes de verdade sobre grupos — LuckPerms e o VoidFall — é o tipo de divergência que esta base tem evitado deliberadamente em toda parte: o mapa de handlers é derivado da readiness, o comando vem da operação durável, o executor de agendamento enfileira a operação em vez de agir por fora. Um segundo banco de grupos contradiz isso.

**Com uma condição de entrada:** antes de aceitar, verificar se algum dos 195 mods ativos registra um `PermissionHandler` próprio. Se registrar, a Opção A muda de comportamento sem aviso e a decisão precisa ser refeita.

A moderação (kick, ban, mute, whitelist) fica sujeita à ampliação do catálogo de console, que merece o seu próprio recorte de segurança — comandos com argumento são uma categoria diferente dos literais revisados de hoje.

Se o objetivo for grupos ricos com herança e expiração desde o MVP, a Opção B é a escolha honesta; mas então a fonte de verdade precisa ser decidida no mesmo ato, e o fork comunitário precisa ser revisado ou descartado.

## Consequências, se A for aceita

- `MinecraftPermissionProvider` ganha implementação sobre a PermissionAPI, com default `NONE`;
- grupos são um conceito do VoidFall, persistidos por ele, projetados em nós na sincronização;
- nenhum mod novo entra no catálogo, e o Gate G4 não é acionado por esta decisão;
- a verificação de `PermissionHandler` concorrente entre os 195 mods vira pré-requisito registrado;
- kick, ban, mute e whitelist dependem de um recorte separado do catálogo de console;
- adotar LuckPerms depois exige novo ADR com `Supersedes` e migração de grupos.

## Não autorização

Este ADR não autoriza adicionar mod ao pack, alterar `ops.json`, ampliar o catálogo de console, executar comando no servidor real, nem persistir dado de jogador — este último é gated pelo [ADR-011](ADR-011-dados-de-jogador-e-retencao.md).
