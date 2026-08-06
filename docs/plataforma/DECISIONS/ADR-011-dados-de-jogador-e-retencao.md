# ADR-011 — Dados de jogador, retenção e acesso

- Status: **proposta** — aguarda decisão do proprietário
- Data: 2026-08-06
- Proprietário: `voidfall-product-owner`
- Responde: ROADMAP pergunta 9
- Bloqueia: Fase 11 itens 2, 7 e 9 (persistência, política antes da coleta, auditoria de leitura e retenção)

## Contexto

O Gate G1 é explícito: **políticas de retenção e acesso existem antes de persistir dados sensíveis.** Hoje não existe nenhuma tabela de jogador — nenhuma das 14 migrações cria perfis, aliases, bindings, casos ou recibos. Isso não é um atraso; é o gate funcionando. Criar as tabelas e decidir a retenção depois inverte a ordem, e dado pessoal gravado sob política adivinhada não se desfaz com um `DROP`.

`PlayerDataPolicyEngine` já existe em `player-governance` e é onde a política decidida aqui passa a viver. O que falta é o conteúdo dela.

Esta é a decisão com o maior custo de erro dos três ADRs. As outras duas produzem retrabalho; esta produz um incidente.

## O que a Fase 11 quer guardar

| Categoria | Exemplo | Necessário para |
| --- | --- | --- |
| Identidade | UUID, alias observado e histórico | reconciliação, perfil, moderação |
| Vínculo | grupos e nós atribuídos | permissões |
| Moderação | caso, motivo, ator, início, fim, recibo | histórico e auditoria de ação |
| Sessão | primeiro/último acesso, contagem | perfil operacional |
| Rede | endereço IP | ban por IP, detecção de evasão |
| Atividade | chat, coordenadas, inventário | investigação de incidente |

As três primeiras são o núcleo da fase. As três últimas são escolhas, e cada uma tem custo próprio.

O Gate G1 já proíbe, sem exceção: **nenhum segredo, chat, coordenada, mundo, UUID privado ou caminho local entra em Git.** Isso governa o repositório. O que este ADR decide é o que entra no **banco de produção**, que é outra coisa e precisa da sua própria regra.

## Opções

### Opção A — Núcleo mínimo

Persistir só identidade, vínculo e moderação. Sem IP, sem chat, sem coordenadas, sem inventário. Sessão reduzida a primeiro e último acesso.

- Cobre integralmente os itens 2, 3, 4, 5 e 8 da Fase 11.
- A superfície de incidente é pequena: um vazamento expõe UUIDs, nomes e histórico de punição — dados que já são públicos ou semi-públicos num servidor.
- Ban por IP fica impossível; evasão de ban por conta nova não é detectável.
- Investigar um incidente de gameplay depende dos logs do servidor, fora do VoidFall e sem retenção governada.

### Opção B — Núcleo mais rede, com retenção curta

A Opção A mais o endereço IP, retido por janela curta (30–90 dias) e legível apenas com `player.activity.sensitive`, com cada leitura auditada.

- Ban por IP e detecção básica de evasão passam a funcionar.
- IP é dado pessoal em qualquer leitura séria de privacidade, e passa a existir um alvo real no banco.
- Exige política de acesso de verdade, não só uma permissão: quem lê, por quê, e o registro disso.
- A permissão `player.activity.sensitive` já está semeada no RBAC e existe exatamente para isto.

### Opção C — Ampla, com chat e atividade

A Opção B mais chat, coordenadas e eventos de inventário.

- Investigação de incidente fica completa dentro do painel.
- Chat é conteúdo de comunicação privada entre terceiros que não decidiram nada sobre isto. Coordenadas revelam construções e bases. Ambos são o tipo de dado que, vazado, causa dano concreto aos jogadores, não ao operador.
- O volume muda de ordem de grandeza e traz seu próprio problema de retenção, custo e poda.
- O Gate G1 já trata chat e coordenada como categorias a manter fora do Git; guardá-las no banco exige justificar por que a fronteira é diferente.

## Recomendação

**Opção A agora, Opção B como ADR próprio quando houver um caso de evasão real.**

O raciocínio é o mesmo que o resto desta base aplica em toda parte: não coletar o que não se sabe usar. TPS e jogadores online são reportados como `no-approved-provider` em vez de zero; `warn-players` recusa em vez de aproximar; force kill não foi implementado antes de existir runtime. Guardar IP "para o caso de" é a versão de privacidade de anunciar uma capability sem handler.

A Opção C não deveria ser aceita sem uma razão nomeada e um aviso aos jogadores. Chat e coordenadas não são dados do operador sobre a operação — são dados de terceiros sobre terceiros.

### Recorte proposto, se A for aceita

| Dado | Retenção | Quem lê |
| --- | --- | --- |
| UUID e alias atual | enquanto o perfil existir | `players.view` |
| Histórico de alias | enquanto o perfil existir | `players.view` |
| Grupos e nós | enquanto o perfil existir | `players.view` |
| Caso de moderação ativo | enquanto ativo | `players.view` |
| Caso encerrado | 2 anos após o fim | `players.view` |
| Primeiro e último acesso | enquanto o perfil existir | `players.view` |

- **Purga de perfil**: remover um perfil apaga alias, vínculos e sessões, e **anonimiza** casos encerrados preservando motivo, ator e datas — o histórico de moderação é registro da operação, não do jogador, e apagá-lo por completo destruiria a prestação de contas de quem puniu.
- **Auditoria de leitura**: listagem e perfil não são auditados individualmente; leitura sob `player.activity.sensitive` é auditada com ator e motivo. Auditar toda listagem produz volume que ninguém lê, e um log que ninguém lê não é controle.
- **Nada disso entra em Git.** Fixtures de teste usam UUIDs sintéticos e nomes inventados, como o resto da base já faz.

## Consequências, se A for aceita

- a migração de jogadores pode ser escrita, com as colunas limitadas ao recorte acima;
- `PlayerDataPolicyEngine` recebe essa política como conteúdo e passa a ter testes de expiração e purga;
- ban por IP fica fora da Fase 11 e precisa de ADR próprio;
- investigação de incidente continua dependendo dos logs do servidor, cuja retenção segue não governada pelo VoidFall — vale registrar como risco aberto;
- ampliar para IP, chat ou coordenadas exige novo ADR com justificativa nomeada, não uma coluna a mais numa migração.

## Não autorização

Este ADR não autoriza criar tabela, importar jogador, ler `Servidor/workspace/**`, nem coletar qualquer categoria de dado. Ele descreve o recorte que uma decisão futura tornaria implementável.
