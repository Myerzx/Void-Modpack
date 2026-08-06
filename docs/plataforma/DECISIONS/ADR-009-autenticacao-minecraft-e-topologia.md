# ADR-009 — Autenticação Minecraft e topologia de acesso

- Status: **proposta** — aguarda decisão do proprietário
- Data: 2026-08-06
- Proprietário: `voidfall-product-owner`
- Responde: ROADMAP pergunta 4
- Bloqueia: Fase 11 itens 1 e 3 (importação e reconciliação por UUID)

## Contexto

A Fase 11 persiste perfis de jogador e reconcilia identidades **por UUID, sem confiar em nome**. Essa regra só é implementável depois de decidir de onde o UUID vem, porque os dois modos de operação produzem UUIDs diferentes para a mesma pessoa:

- **online-mode=true**: o servidor valida a sessão contra os serviços oficiais e recebe o UUID da conta. É estável, global e sobrevive a troca de nome.
- **online-mode=false**: o servidor gera um UUID offline determinístico a partir do nome (`OfflinePlayer:<nome>`). Trocar de nome cria uma pessoa nova; dois servidores diferentes concordam por acaso, não por identidade.

Persistir a segunda forma acreditando que é a primeira não erra às vezes — erra sempre, e o dado errado fica gravado. Reconciliar por UUID sob a suposição errada é pior do que não reconciliar.

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

A auditoria classifica a combinação como crítica se o servidor for alcançável por rede não confiável, e já recomenda `online-mode=true` com whitelist para implantação direta, ou documentar a topologia de proxy antes de considerar modo offline.

**Portanto os UUIDs dos 7 usuários em cache são, hoje, UUIDs offline.** Qualquer importação futura precisa saber disso.

### Restrição técnica: proxies e Forge 1.20.1

Velocity **não** suporta nativamente servidores Forge entre 1.13 e 1.20.1 — o suporte começa acima de 1.20.2 e as versões intermediárias não estão planejadas ([PaperMC](https://docs.papermc.io/velocity/server-compatibility/)). Para 1.20.1 a topologia de proxy exige um intermediário adicional:

- o plugin **Ambassador** no proxy, ou
- o mod **Proxy-Compatible-Forge** / **NeoVelocity** no backend, implementando o modern forwarding do Velocity.

Todos exigem `online-mode=false` no backend, delegando a autenticação ao proxy. Ou seja: **a topologia de proxy reproduz exatamente a configuração que a auditoria hoje classifica como crítica** — a diferença é que passa a ser deliberada, com o backend inacessível de fora e um mod a mais no caminho da autenticação.

## Opções

### Opção A — Direto, online-mode

`online-mode=true`, `white-list=true`, `enforce-whitelist=true`, sem proxy.

- UUIDs oficiais, estáveis, sobrevivem a troca de nome.
- Zero mod novo no caminho da autenticação.
- Fecha o achado crítico da auditoria pela via mais curta.
- Os 7 UUIDs offline em cache **não migram**: são identidades diferentes e precisam ser reconstruídos, com whitelist e bans refeitos.
- Um único servidor. Múltiplas instâncias no MVP ficariam sem porta de entrada comum (ROADMAP pergunta 13).

### Opção B — Proxy autenticador (Velocity + Ambassador ou PCF)

Proxy em online-mode, backend em `online-mode=false` com forwarding assinado, backend fechado por firewall.

- UUIDs oficiais também, encaminhados pelo proxy.
- Abre caminho para múltiplas instâncias e uma porta única.
- Acrescenta **dois** componentes no caminho de autenticação (proxy e shim), ambos fora do catálogo revisado, ambos com licença e proveniência a decidir pelo Gate G4.
- O backend fica literalmente em modo offline: se o firewall falhar ou o forwarding secret vazar, qualquer identidade entra. O `enforce-whitelist` do backend deixa de ser a última linha.
- O shim para 1.20.1 é software de terceiro no caminho crítico de login, e a busca já mostra incompatibilidades conhecidas entre ele e mods de permissão.

### Opção C — Manter offline, com whitelist e rede fechada

`online-mode=false`, `white-list=true`, `enforce-whitelist=true`, acesso só por LAN ou VPN.

- Nada muda para os 7 usuários existentes; a identidade atual é preservada.
- Não exige mod nem proxy.
- A identidade continua sendo o **nome**, não a conta: trocar de nome cria outra pessoa, e a regra "reconciliar por UUID sem confiar em nome" vira uma ficção — o UUID *é* o nome, com passos extras.
- Não fecha o achado crítico; apenas o move para depender inteiramente da camada de rede.

## Recomendação

**Opção A.** É a única em que o UUID significa o que a Fase 11 assume que significa, sem acrescentar componente de terceiro ao caminho de login. As perguntas 10 (exposição do painel) e 13 (múltiplas instâncias) do ROADMAP continuam em aberto, e nenhuma delas exige proxy no MVP; se a resposta a 13 virar "sim", a Opção B passa a ser um ADR próprio com migração, não uma extensão silenciosa deste.

A perda dos 7 UUIDs offline é real e vale registrar como custo aceito: eles não são identidades de conta, são derivações de nome, e importá-los como se fossem contas contaminaria a base de perfis desde o primeiro registro.

## Consequências, se A for aceita

- a importação da Fase 11 trata os 7 UUIDs em cache como **não migráveis** e exige reconstrução explícita de whitelist, operadores e bans;
- perfis persistidos guardam o UUID oficial como chave, e o nome apenas como alias observado com histórico;
- a reconciliação por UUID passa a ser implementável como especificada;
- RCON continua sendo superfície administrativa separada e permanece a ser revisada;
- múltiplas instâncias, se decididas depois, exigem novo ADR com plano de migração de identidade.

## Não autorização

Este ADR não autoriza alterar o servidor real, iniciar processo, editar `Servidor/workspace/**`, importar jogadores, nem persistir dado pessoal. A persistência é gated pelo [ADR-011](ADR-011-dados-de-jogador-e-retencao.md).
