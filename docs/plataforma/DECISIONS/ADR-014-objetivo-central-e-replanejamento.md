# ADR-014 — Objetivo central do produto e replanejamento das fases

- Status: **aceita**
- Data: 2026-08-06
- Proprietário: `voidfall-product-owner`
- Afeta: ROADMAP, [plano final](../FINAL_IMPLEMENTATION_PLAN.md), e o escopo restante da Fase 11
- Adia: [ADR-009](ADR-009-autenticacao-minecraft-e-topologia.md), [ADR-010](ADR-010-provider-de-permissoes-minecraft.md), [ADR-012](ADR-012-credenciais-e-tickets-de-login.md), [ADR-013](ADR-013-permissoes-tipadas-no-forge-bridge.md)

## Contexto

O plano até aqui tratava a Fase 11 como "jogadores e permissões reais" e a colocava antes do release e do launcher. Isso ordenava o trabalho em torno de operar um servidor com jogadores.

O proprietário esclareceu o objetivo central, e ele é outro:

> O VoidFall é inicialmente um **painel pessoal de construção, configuração e publicação** de servidores e modpacks Minecraft Forge.

O caminho principal do produto é:

1. importar um servidor ou modpack;
2. inventariar mods, versões, dependências, configurações, datapacks, scripts e recursos;
3. alterar essas configurações por uma interface organizada;
4. instalar, remover e atualizar mods com validação e rollback;
5. testar alterações em cópias descartáveis;
6. produzir pacote do servidor, pacote do cliente, manifesto da versão e notas da atualização;
7. exportar um modpack publicável no CurseForge.

Gestão de jogadores **não** está nesse caminho. Autenticação, claims, moderação e LuckPerms não são necessários para entregar nada dos sete itens acima.

## Decisão

### 1. O caminho principal é inventário, configuração, sandbox e release

O replanejamento das fases seguintes gira em torno disso, e não em torno de operar jogadores.

### 2. A persistência de identidade permanece; o resto é adiado

O que já foi entregue e está íntegro fica: identidade, reivindicações, aliases, perfis e casos de moderação persistidos, o contrato tipado de operações de permissão, o núcleo do Bridge e o contrato de `ClaimEvidence`. Tudo com teste e gate verde.

O que **não** continua nesta fase: expandir autenticação, claims, moderação ou LuckPerms. Os ADRs 009, 010, 012 e 013 permanecem **aceitos e válidos** — não foram revertidos nem substituídos. Eles descrevem uma fase posterior de runtime e administração de jogadores, e é lá que serão implementados.

Adiar não é revogar. Um ADR aceito que descreve trabalho não iniciado continua sendo a decisão que vale quando esse trabalho começar.

### 3. Nada no caminho crítico depende de jogador real ou do servidor original

Duas consequências operacionais:

- **Nenhuma dependência nova de identidade ou de dado real de jogador** entra no caminho crítico de inventário, configuração, sandbox ou release;
- **Nenhum boot do servidor original.** Quando um mod precisar ser iniciado para gerar suas configurações, isso acontece exclusivamente em **sandbox descartável**, montada a partir dos mods e arquivos mínimos necessários, sem copiar nem modificar o mundo original.

A segunda já era regra (`Servidor/workspace/**` é imutável); agora é também requisito de arquitetura, não só de disciplina.

### 4. A arquitetura de configuração é híbrida

Nenhuma técnica isolada cobre 195 mods. As camadas, e o que cada uma resolve:

| Camada | O que resolve |
| --- | --- |
| Analisador estático de JAR e metadados | identidade, versão, dependências, lado |
| Descoberta de TOML, JSON, datapacks, scripts e recursos | onde a configuração mora |
| Boot isolado | arquivos que só existem depois de o mod rodar |
| Editor genérico por esquema inferido | edição segura sem semântica conhecida |
| Adaptadores específicos | mods complexos, com categorias e significado |
| Assistência de IA | **somente sugestão**, com confiança explícita e confirmação humana |

A última linha é uma restrição, não um recurso. Uma sugestão aplicada sem confirmação seria exatamente o executor genérico que o resto desta base recusa em toda parte.

### 5. Todo mod é inventariado; o nível de edição é classificado

**Não se presume que um mod possa ser compreendido semanticamente só por analisar seu JAR.** Inventariar é uma coisa; saber o que um campo significa é outra, e confundir as duas produz um editor que corrompe configurações com confiança.

| Nível | Significado |
| --- | --- |
| `FULLY_MANAGED` | esquema e semântica conhecidos |
| `STRUCTURED` | estrutura editável, sem semântica completa |
| `RAW_EDITABLE` | arquivo localizado e editável em modo avançado |
| `UNSUPPORTED` | localizado, mas sem mutação segura |
| `RUNTIME_ONLY` | requer servidor em execução |

`UNSUPPORTED` é um resultado legítimo e frequente, não uma falha do inventário. É o mesmo princípio que faz TPS reportar `no-approved-provider` em vez de zero.

### 6. O caminho vertical vem antes da largura

Primeiro um fio completo, ponta a ponta:

1. importar workspace;
2. detectar um mod;
3. identificar seus arquivos;
4. gerar um formulário;
5. alterar um valor;
6. validar;
7. aplicar em staging;
8. iniciar sandbox;
9. confirmar boot;
10. gerar diff e rollback.

Só depois desse fio genérico entra o **Mine and Slash** como primeiro adaptador completo, organizando configurações e datapacks em categorias — balanceamento, status, spells, talentos, mobs, itens e raridades.

### 7. O construtor de release produz, a partir do estado aprovado

- ZIP do servidor;
- ZIP/estrutura do modpack CurseForge;
- manifesto com hashes e versões;
- relação de mods adicionados, removidos e atualizados;
- relação de configurações, datapacks e scripts alterados;
- changelog automático;
- arquivos exigidos apenas no cliente ou apenas no servidor;
- resultado dos testes de boot;
- rollback para a versão anterior.

## Consequências

- a Fase 11 é **encerrada** com o que está íntegro, e não continua;
- autenticação, claims, moderação e LuckPerms passam para uma fase posterior de runtime e administração de jogadores, com os ADRs 009/010/012/013 preservados como a decisão vigente para quando ela começar;
- o `ClaimEvidence` e o núcleo de permissões do Bridge ficam no repositório como contrato e código testado **sem consumidor**, o que é declarável e não custa nada no caminho novo;
- os gates transversais G1–G4 continuam valendo integralmente, e o G3 ganha reforço: sandbox descartável em vez do runtime original;
- as fases seguintes são renumeradas em torno de inventário, configuração, sandbox, adaptadores e release; nenhuma delas reabre ou reduz um gate P0 existente.

## Não autorização

Este ADR não autoriza iniciar o servidor original, ler ou modificar `Servidor/workspace/**`, publicar no CurseForge, nem aplicar sugestão de IA sem confirmação humana.
