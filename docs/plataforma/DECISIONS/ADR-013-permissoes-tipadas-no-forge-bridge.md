# ADR-013 — Capacidade tipada de permissões no Forge Bridge

- Status: **aceita**
- Data: 2026-08-06
- Proprietário: `voidfall-product-owner`
- Resolve: pendência registrada no [ADR-010](ADR-010-provider-de-permissoes-minecraft.md)
- Desbloqueia: Fase 11 itens 4 e 5 (provider deny-by-default, executor tipado)

## Contexto

O [ADR-010](ADR-010-provider-de-permissoes-minecraft.md) pôs o LuckPerms como provider e fonte de verdade, com o VoidFall enviando operações duráveis e sem manter segunda fonte editável. Deixou aberto **por qual caminho** uma operação chega ao LuckPerms, com duas saídas: ampliar o catálogo de console, ou usar o Forge Bridge.

O catálogo de `console.command` é fechado a **literais revisados sem argumento** — hoje `list-players` e `save-all`. Comandos do LuckPerms levam jogador, grupo, nó e contexto.

## Decisão

**O catálogo de console não é ampliado.** Ele continua fechado a literais sem argumento.

A mutação acontece por uma **capacidade tipada no Forge Bridge**, chamando a API oficial do LuckPerms.

O fluxo é:

```
VoidFall → job durável assinado → agente → Forge Bridge → API do LuckPerms
```

Ampliar o catálogo teria transformado o console num executor parametrizado — exatamente o que o protocolo do agente existe para evitar. Um argumento vindo do plano de controle e concatenado num comando é a forma como um canal tipado vira um shell com etapas extras. Uma capacidade tipada com um conjunto fechado de operações não tem essa propriedade: não há string de comando, e o que atravessa a fronteira são campos nomeados.

### Operações iniciais

Um conjunto explícito e limitado. Nada fora dele é executável.

| Operação | Efeito |
| --- | --- |
| `USER_GROUP_ADD` | acrescenta o usuário a um grupo |
| `USER_GROUP_REMOVE` | remove o usuário de um grupo |
| `USER_NODE_SET` | define um nó no usuário |
| `USER_NODE_UNSET` | remove um nó do usuário |

Cada operação carrega:

- **id idempotente** — um replay honesto encontra o resultado original, nunca um segundo efeito;
- **identidade VoidFall** — a quem a operação se refere, na chave que o [ADR-009](ADR-009-autenticacao-minecraft-e-topologia.md) tornou estável;
- **reivindicação esperada** — contra qual reivindicação ativa a operação foi decidida;
- **ator** e **razão** — quem pediu e por quê;
- **emissão** e **expiração** — uma operação velha não é executada tarde.

### O Bridge nunca confia em nome nem em UUID da tela

Esta é a regra central e a razão de a identidade VoidFall existir.

O Bridge recebe a identidade, **resolve a reivindicação ativa**, e só então obtém o **UUID offline atual**. Nome e UUID vindos da tela são ignorados como entrada.

Sem isso a cadeia inteira do ADR-009 seria decorativa: um UUID offline é derivado do nome, então aceitá-lo da tela permitiria operar sobre qualquer identidade escolhendo o nome certo — o exato ataque que a reivindicação existe para fechar. A operação carrega a reivindicação **esperada** justamente para que uma divergência entre o que a tela viu e o que está ativo agora seja detectada e recusada, em vez de aplicada na pessoa errada.

### Leitura tipada, com origem e instante

O Bridge também expõe **leitura tipada** do estado do LuckPerms, carregando origem e instante observados.

Depois de uma mutação, o Bridge **relê o provider e devolve o snapshot efetivo**. O que a tela mostra passa a ser o que o provider respondeu depois da escrita, não o que o VoidFall pediu — a diferença entre as duas coisas é onde moram os defeitos que ninguém vê.

O VoidFall continua **sem possuir** grupos ou nós. Ele apresenta a leitura.

### Troca de nome: rebind transacional

Trocar de nome muda o UUID offline. Isso exige **operação própria**, não uma sequência de comandos independentes:

1. copiar as permissões do UUID offline antigo para o novo;
2. **verificar** o resultado;
3. remover os privilégios antigos;
4. **só então** revogar a reivindicação anterior.

Como sequência solta, cada passo pode falhar sozinho e deixar um estado que ninguém escolheu: permissões em dois UUIDs, ou em nenhum, ou uma reivindicação revogada antes de a cópia existir. A ordem acima é escolhida para que qualquer interrupção deixe o **estado antigo intacto** — a revogação é o último ato, e até ela acontecer a identidade anterior continua sendo a válida.

### O `PermissionVerifier` só depois do login

Permissão é consultada **somente depois da autenticação e da conclusão do login**, quando a sessão já está associada à identidade e ao UUID final.

Isso fecha, por desenho, o defeito de pré-login relatado no LuckPerms para Forge 1.20.1 — em que o UUID no pré-login ainda não é o definitivo. Sob autenticação offline com reivindicação, o instante em que o UUID passa a ser confiável é depois do login, e resolver permissão antes disso significaria resolvê-la para uma identidade que ainda não foi estabelecida.

### Validação de handler no boot, e indisponibilidade com motivo

No boot, o Bridge **valida explicitamente que o handler de permissão ativo é o esperado**. Se algum outro mod registrou o seu, o comportamento mudaria em silêncio.

A capability fica **indisponível com motivo nomeado** quando LuckPerms, o handler, a autenticação ou o Bridge não estiverem prontos. É a mesma regra da readiness da Fase 11.0, pelo mesmo motivo: anunciar capacidade cuja dependência não existe é reivindicar trabalho que só pode falhar.

## Consequências

- `console.command` permanece fechado, e essa recusa passa a ser decisão registrada em vez de limitação;
- o núcleo Java do Bridge é Java 17 puro, compilado por `javac` sem dependência externa; portanto a API do LuckPerms entra por **interface**, como `PermissionVerifier` já entra, e a ligação concreta vive na camada de mod;
- `ModerationExecutor` e `MinecraftPermissionProvider` ganham caminho de implementação;
- kick, ban, mute e whitelist **não** estão nas quatro operações iniciais e continuam sem executor — ampliar o conjunto é decisão própria;
- o agente ganha uma capability nova, sujeita à mesma regra de readiness: anunciada só quando Bridge, LuckPerms e handler existirem;
- a operação depende da reivindicação, portanto depende do [ADR-012](ADR-012-credenciais-e-tickets-de-login.md): sem login não há reivindicação ativa, e sem reivindicação ativa não há operação;
- LuckPerms continua sujeito ao Gate G4 e ao teste de boot com o pack completo, conforme o ADR-010.

## Não autorização

Este ADR não autoriza instalar LuckPerms, adicionar mod ao pack, executar mutação no servidor real, nem ampliar as quatro operações iniciais.
