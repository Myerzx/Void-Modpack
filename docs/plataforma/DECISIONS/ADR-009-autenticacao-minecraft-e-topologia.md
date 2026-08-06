# ADR-009 — Autenticação Minecraft e identidade de jogador

- Status: **aceita**
- Data: 2026-08-06
- Proprietário: `voidfall-product-owner`
- Responde: ROADMAP pergunta 4
- Desbloqueia: Fase 11 item 3 (importação e reconciliação de identidade)

## Contexto

A Fase 11 persiste perfis e reconcilia identidades **sem confiar em nome**. Uma proposta anterior deste ADR recomendou `online-mode=true`, tratando o modo offline como uma configuração herdada a corrigir.

Essa recomendação estava errada por desconhecer um requisito de produto: **o servidor deve aceitar jogadores sem conta oficial.** Isso não é uma consequência do estado atual, é uma escolha, e ela decide o modo — o que resta a decidir é o que substitui a validação que os serviços oficiais fariam.

### Estado atual, medido

A [auditoria do servidor](../servidor/auditoria.md) de 2026-08-03 encontrou, no perfil real:

| Propriedade | Valor encontrado |
| --- | --- |
| `online-mode` | `false` |
| `white-list` | `false` |
| `enforce-whitelist` | `false` |
| RCON | habilitado, com senha configurada |
| Operadores | 7 |
| Usuários em cache | 7 |

A auditoria classifica a combinação como crítica se o servidor for alcançável por rede não confiável. O achado permanece válido: o que esta decisão remove não é o modo offline, é a **ausência de qualquer autenticação**.

### O que um UUID offline é, e o que não é

Em `online-mode=false` o servidor deriva o UUID do nome (`OfflinePlayer:<nome>`). Ele é estável enquanto o nome não muda e **não prova nada sobre quem digitou aquele nome**. Qualquer pessoa que escolha o nome recebe o mesmo UUID.

Portanto o UUID offline serve como *chave de continuidade local* e nunca como *prova de propriedade*. Tratar os dois como a mesma coisa é o defeito que esta decisão existe para impedir.

## Decisão

1. **`online-mode` permanece `false`**, porque o servidor deve aceitar jogadores sem conta oficial.
2. **Uma camada de autenticação é obrigatória**, integrada ao VoidFall ou fornecida por um mod aprovado pelo Gate G4. Nenhum jogador obtém privilégio antes de autenticar.
3. **Os UUIDs atuais são preservados como identidades locais legadas**, e explicitamente **não** como prova de propriedade de conta.
4. **Operadores reivindicam novamente suas identidades** antes de recuperar privilégios. Os 7 operadores atuais perdem privilégio até a reivindicação.

### O que passa a ser a identidade

A chave estável de um jogador passa a ser uma **identidade emitida pelo VoidFall**, estabelecida pela autenticação. O UUID Minecraft — offline hoje, possivelmente oficial no futuro para quem tiver conta — vira um **vínculo** a essa identidade: observável, revogável e re-vinculável após reivindicação.

Consequência direta para a Fase 11: "reconciliar por UUID sem confiar em nome" passa a ler-se **reconciliar pela identidade reivindicada, sem confiar em nome nem em UUID offline**. O nome nunca foi confiável; o UUID offline é o nome com passos extras, e herdaria a mesma fraqueza se fosse promovido a chave.

## Consequências

### A camada de autenticação precisa de presença dentro do jogo

O Server Agent é outbound-only e não tem presença no mundo: ele disca para o plano de controle e nunca escuta. Autenticar um jogador exige interceptar o login e bloquear ação até a credencial ser aceita — coisa que só acontece dentro do processo do servidor.

O [Forge Bridge](../../../Plataforma/integrations/forge-bridge/) existe, mas hoje serve exclusivamente ao comando `/build` assinado, e seu `PermissionVerifier` é uma interface sem implementação. Uma camada nativa do VoidFall é, portanto, trabalho substancial de Bridge — território da Fase 12.

**Isto sequencia a Fase 11.** As duas saídas:

- **Mod aprovado pelo Gate G4 agora**, com o VoidFall consumindo o resultado. Destrava a Fase 11 sem esperar a Fase 12.
- **Camada nativa no Bridge**, que adia a moderação real da Fase 11 até a Bridge existir.

Candidatos server-side para Forge 1.20.1 levantados, **não revisados e não aprovados**: [SAuth](https://modrinth.com/mod/sauth) (`/register`, `/login`, credenciais em `config/serverreg/users.json`), ServerAuth e Player Safe Login. [Simple Login](https://www.curseforge.com/minecraft/mc-mods/simple-login) foi descartado por desenho: guarda a senha no cliente e a envia automaticamente ao entrar, o que é conveniência, não autenticação, e ainda exige mod no cliente.

### Onde a credencial mora é uma decisão que falta

Uma camada de autenticação implica um verificador de senha em algum lugar. Isso é uma categoria de dado que o [ADR-011](ADR-011-dados-de-jogador-e-retencao.md) **não** contempla — o núcleo mínimo é identidade, vínculo e moderação, e nenhum dos três é credencial.

Não vou resolver isso por dedução. As duas opções têm consequências diferentes e ambas precisam de decisão explícita:

- **credencial no mod**: o VoidFall nunca vê senha nem verificador; ganha uma segunda fonte de identidade a conciliar;
- **credencial no VoidFall**: fonte única, mas exige emenda ao ADR-011 com algoritmo de derivação, rotação e política de acesso.

Enquanto isso não for decidido, nenhuma tabela de credencial é criada.

### Requisito de revisão para qualquer mod candidato

O Gate G4 já exige lado, origem, licença, hash e dependências. Para um mod de autenticação, acrescentar:

- **derivação de senha**: SHA-256 puro não é hash de senha — é rápido e, sem sal por usuário, quebra em massa. O candidato precisa usar uma função de derivação com custo (Argon2, scrypt ou bcrypt) ou ser rejeitado;
- **onde a credencial é gravada**, e se esse caminho é coberto pela retenção e pelas regras de Git;
- **o que acontece antes do login**: movimento, chat, quebra de bloco e interação precisam estar bloqueados, não apenas desencorajados;
- **interação com o pré-login do LuckPerms** descrita no [ADR-010](ADR-010-provider-de-permissoes-minecraft.md).

### Rede continua sendo camada, não substituto

`white-list` e `enforce-whitelist` permanecem ferramentas disponíveis, mas em modo offline a whitelist filtra **nomes**, e nome não é identidade — ela vale como redução de superfície, nunca como controle de acesso. RCON continua superfície administrativa separada e ainda a ser revisada.

Fica em aberto, e não é decidido aqui: se o registro é livre ou por convite. Um servidor que aceita jogadores sem conta oficial e permite registro livre aceita, na prática, qualquer pessoa que alcance a porta.

### Migração das identidades atuais

- os 7 UUIDs em cache entram como **identidades locais legadas**, marcadas como não reivindicadas;
- nenhuma delas concede privilégio;
- `ops.json` deixa de ser fonte de autoridade para o VoidFall; os 7 operadores reivindicam antes de recuperar;
- uma identidade legada reivindicada preserva histórico, alias e casos de moderação, agora ancorados na identidade emitida;
- uma identidade legada nunca reivindicada permanece como registro histórico e não é promovida por inatividade.

## Não autorização

Este ADR não autoriza adicionar mod ao pack, alterar o servidor real, iniciar processo, editar `Servidor/workspace/**`, criar tabela de credencial, nem persistir dado pessoal — este último segue gated pelo [ADR-011](ADR-011-dados-de-jogador-e-retencao.md).

## Histórico

A primeira versão desta proposta recomendava `online-mode=true` com perda dos UUIDs offline. O proprietário rejeitou a recomendação em 2026-08-06 por um requisito de produto que a proposta desconhecia — aceitar jogadores sem conta oficial — e substituiu a validação oficial por uma camada de autenticação obrigatória com reivindicação de identidade. A proposta não chegou a ser aceita, então foi reescrita em vez de superada.
