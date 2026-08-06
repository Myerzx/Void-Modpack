# ADR-010 — Provider de permissões Minecraft

- Status: **aceita**
- Data: 2026-08-06
- Proprietário: `voidfall-product-owner`
- Responde: ROADMAP pergunta 5
- Desbloqueia: Fase 11 itens 4 e 5 (provider deny-by-default, executor tipado)
- Resolvido depois: por qual caminho a operação chega ao LuckPerms — [ADR-013](ADR-013-permissoes-tipadas-no-forge-bridge.md)

## Contexto

O domínio puro já existe em `Plataforma/packages/player-governance`: `MinecraftPermissionRegistry`, `ModerationCaseRegistry`, `PlayerProfileRegistry` e `PlayerDataPolicyEngine`, com 12 testes. Os dois pontos de contato com o mundo real — `MinecraftPermissionProvider` e `ModerationExecutor` — são interfaces **injetadas sem implementação**, a mesma forma que os guards de acesso exclusivo offline tinham antes da Fase 11.0.

O catálogo revisado (`Servidor/catalog/mods.csv`, 195 mods) **não contém nenhum mod de permissões**. A primeira metade da pergunta 5 está respondida: nenhum existe. Autorização hoje é `ops.json` com 7 operadores, o que é binário e não expressa nós.

Uma proposta anterior recomendou usar apenas a PermissionAPI do Forge, com grupos construídos dentro do VoidFall, para evitar duas fontes de verdade. O proprietário rejeitou o recorte: a PermissionAPI tem três níveis (`ALL`, `OP`, `NONE`) e nenhuma noção de grupo, herança, contexto, metadado ou histórico, e reconstruir tudo isso no VoidFall é reimplementar um problema que já tem solução madura.

## Decisão

1. **A PermissionAPI do Forge é interface de compatibilidade, não provider.** Ela é o ponto onde mods do pack perguntam "este jogador pode?", e continua sendo isso.
2. **LuckPerms é o provider** de grupos, nós, heranças, contextos, metadados e histórico.
3. **LuckPerms é a fonte de verdade.** O VoidFall é painel de controle: ele **envia operações duráveis** ao servidor e **não mantém uma segunda fonte editável** de permissões.

Essa separação coincide com a orientação do próprio projeto LuckPerms, que instrui autores de mod a checar permissão pela [Forge Permissions API](https://luckperms.net/wiki/Developer-API) e a usar a [API do LuckPerms](https://luckperms.net/wiki/Developer-API-Usage) para mutação. Não é um arranjo inventado aqui.

### O que "não manter segunda fonte editável" significa na prática

- o VoidFall **lê** estado de permissão para exibir e para decidir se uma operação faz sentido;
- o VoidFall **pode cachear** essa leitura para a tela, com a origem e o instante da leitura visíveis;
- o VoidFall **nunca** aceita edição direta do seu cache como se fosse a verdade;
- toda mudança nasce como **operação durável** — ator, motivo, idempotência, autorização e recibo — e só existe de fato depois que o servidor a confirma.

É a mesma forma que o resto da base já usa: o mapa de handlers é derivado da readiness, o comando de console vem da operação durável, e o executor de agendamento enfileira a operação em vez de agir por fora.

## Consequências

### O caminho da operação até o LuckPerms ainda não existe

Esta é a consequência de maior peso e vale dizer sem rodeio.

O agente serve `console.command` sobre um **catálogo fechado de literais revisados sem argumento**: hoje `list-players` e `save-all`. Comandos do LuckPerms têm argumentos — jogador, grupo, nó, contexto — e portanto **não cabem nesse catálogo por desenho**, não por omissão.

Restam duas saídas, ambas trabalho real:

- **Ampliar o catálogo de console** para comandos parametrizados, com um recorte de segurança próprio: quais comandos, quais argumentos, como são validados e por que um argumento vindo do plano de controle não recria o executor genérico que este protocolo existe para evitar;
- **Usar o Forge Bridge** contra a API do LuckPerms. O [Bridge](../../../Plataforma/integrations/forge-bridge/) existe, mas hoje serve apenas ao `/build` assinado, e seu `PermissionVerifier` é — mais uma vez — interface sem implementação.

Enquanto nenhuma das duas existir, `MinecraftPermissionProvider` e `ModerationExecutor` continuam sem implementação, e a Fase 11 entrega perfis, casos e telas **sem efeito no servidor**. Isso é um estado honesto e declarável, desde que declarado: a readiness da Fase 11.0 mostrou o custo de anunciar capacidade cuja dependência não existe.

### LuckPerms precisa passar pelo Gate G4

Build oficial para Forge 1.20.1 existe — [v5.4.102 no CurseForge](https://www.curseforge.com/minecraft/mc-mods/luckperms/files/4738950), também no [Modrinth](https://modrinth.com/plugin/luckperms/version/v5.4.88-forge) — com licença permissiva. Ainda assim é o 196º mod de um pack que a Fase 7.0 já mostrou ter conflitos, e o gate exige lado, origem, licença, hash e dependências revisados.

Dois pontos específicos a resolver na revisão:

- **Crash de startup** relatado em Forge 1.20.1 com certas combinações de mods. Precisa de teste de boot com o pack completo antes de entrar em `stable`.
- **O fork comunitário** [LuckPerms-Forge-1.20.1](https://github.com/AlphaConqueror/LuckPerms-Forge-1.20.1) anuncia corrigir um "Forge capabilities issue". Não consegui confirmar o defeito nem o conserto pela página do repositório. **A decisão é usar o build oficial**; adotar o fork exigiria revisar o diff e seria ADR próprio — depender de fork não verificado no caminho de autorização não é aceitável.

### O defeito de pré-login interage com o ADR-009

Há relato conhecido em Forge 1.20.1 de "permissions data for your user was not loaded during the pre-login", porque o UUID no pré-login ainda não é o definitivo. Isso importa mais sob o [ADR-009](ADR-009-autenticacao-minecraft-e-topologia.md) do que importaria em online-mode: com autenticação offline e reivindicação de identidade, o instante em que o UUID passa a ser confiável é **depois** do login, não antes.

Portanto: **permissão nunca é resolvida em pré-login.** Um jogador não autenticado não tem grupo, e a resolução acontece após a reivindicação ser verificada. Isso precisa ser testado explicitamente, não presumido.

### Deny-by-default continua valendo

O default é negar. Um jogador sem grupo, ou cuja identidade não foi reivindicada, não recebe nó nenhum. Se o LuckPerms estiver indisponível, a resposta é negar — não é conceder por otimismo, e não é derrubar o servidor.

### Separação de RBAC preservada

`Plataforma/packages/permissions` e a semente `0002_rbac_seed.sql` decidem **quem pode pedir** uma ação pelo painel. O LuckPerms decide **o que um jogador pode fazer** no jogo. As duas continuam separadas, e nenhuma linha deste ADR concede permissão de painel.

### Pré-requisito registrado

Antes de instalar, verificar se algum dos 195 mods ativos já registra um `PermissionHandler` próprio no Forge. Se registrar, a interface de compatibilidade muda de comportamento sem aviso e a integração precisa ser reavaliada.

## Não autorização

Este ADR não autoriza instalar LuckPerms, adicionar mod ao pack, ampliar o catálogo de console, implementar Bridge, alterar `ops.json`, executar comando no servidor real, nem persistir dado de jogador.

## Histórico

A primeira versão desta proposta recomendava apenas a PermissionAPI do Forge, com grupos no VoidFall, para evitar duas fontes de verdade. O proprietário rejeitou o recorte em 2026-08-06 e resolveu a objeção por outro caminho — mais limpo: o VoidFall deixa de ser fonte de permissão em vez de virar a segunda. A proposta não chegou a ser aceita, então foi reescrita em vez de superada.
