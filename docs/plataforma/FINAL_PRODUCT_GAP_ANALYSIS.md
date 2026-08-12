# Análise de lacunas para o produto final VoidFall

Data da análise: **2026-08-11**.

## Resultado executivo

O VoidFall agora possui um **programa Windows portátil de QA funcional**: o ZIP contém Electron, Control API, painel, PGlite, migrations e dependências; ele foi extraído e executado fora do checkout, preservou o estado após reabrir e recusou uma segunda instância. O painel desktop foi consolidado no mesmo shell e validado em 1440×900 e 900×650 sem overflow horizontal.

Isso ainda não equivale a um produto público final. Assinatura, instalador, canal de atualização, licenças de distribuição do modpack e certificações reais de jogo dependem de decisões ou evidências que não podem ser inventadas pelo código.

## Estado por resultado

| Resultado | Estado | Evidência ou lacuna |
|---|---|---|
| Aplicativo Windows portátil para QA | concluído | ZIP x64, hash, inventário de dependências e smoke externo reexecutável por `npm run desktop:qa` |
| Interface desktop responsiva | concluído no escopo desktop | shell comum, trilho compacto, grids adaptativos e tabelas com rolagem; 1440×900 e 900×650 validados |
| Persistência local | concluída para QA | PGlite no diretório do usuário, migrations e reabertura com o mesmo estado aprovadas |
| Isolamento do renderer | concluído | sandbox, sem Node/preload, navegação loopback restrita e sessão HttpOnly |
| Instalador Windows final | bloqueado por decisão | formato, ícone, publisher, metadados e UX de instalação/desinstalação ainda não escolhidos |
| Assinatura e reputação do executável | bloqueado externamente | exige identidade do publisher e certificado de code signing; o ZIP atual é não assinado |
| Atualização e rollback do aplicativo | pendente | canal, assinatura de update, promoção atômica e estratégia de rollback ainda não aprovados |
| Distribuição pública do modpack | bloqueada | catálogo ainda precisa de origem, licença e decisão de distribuição completas; `stable` continua fechado |
| Certificação real de jogo | bloqueada por evidência | faltam importação limpa, launch, resource pack, mundo novo, multiplayer, restart, backup e restore registrados |
| Gerenciador completo no painel | parcial | lifecycle, console, configurações, análise e release existem; integrações listadas abaixo ainda faltam |

## Trabalho restante por prioridade

### P0 — necessário antes de distribuir o programa

1. Escolher o instalador e fechar nome, ícone, versão, publisher, licença e informações de suporte.
2. Adquirir e proteger a identidade de assinatura; assinar executável e instalador.
3. Repetir instalação, primeira abertura, reabertura, atualização e desinstalação em uma máquina Windows limpa ou VM descartável.
4. Definir canal de publicação, assinatura dos updates, promoção, rollback e resposta a versão defeituosa.
5. Produzir SBOM/licenças revisadas e aprovar juridicamente as dependências e os assets que serão redistribuídos.

### P0 — necessário antes de publicar o modpack ou operar um servidor final

1. Escolher explicitamente o cliente-base canônico e os launchers suportados.
2. Completar origem, hash, lado, licença e decisão de distribuição de cada artefato externo.
3. Resolver os bloqueios P0 documentados nas auditorias de launcher e servidor, sem ativar bypass.
4. Registrar smoke real de importação, launch, resource pack, mundo novo, multiplayer, restart, backup e restore com a release exata.
5. Aprovar autenticação Minecraft, whitelist, rede/firewall, secrets e topologia operacional.

### Funcionalidade ainda parcial do gerenciador

1. Expor no painel somente leitura/status da última observação de datapacks; manter edição e grant da capability separados.
2. Concluir restore com boot da cópia isolada e prova de restauração antes de qualquer troca do mundo ativo; criação de backup cifrado já usa lock durável e passou smoke real.
3. Completar rollback operacional de `artifact.install`; o caminho aprovado de staging, integridade e operação durável já está ligado.
4. Completar mundo, jogadores, permissões Minecraft e moderação apenas depois de providers, política e auditoria correspondentes.
5. Definir reconciliação e reanexação segura quando uma JVM continua viva após reinício do agente.
6. Converter estados indisponíveis do painel em capacidades reais somente quando os gates do backend estiverem aprovados.

### Produção e manutenção

1. Definir se a primeira produção usa Windows ou Linux e se a Control API permanece estritamente local.
2. Para acesso em rede, implantar TLS/reverse proxy, autenticação adequada, rotação de secrets e política de exposição; a porta loopback atual não deve ser aberta diretamente.
3. Escolher PostgreSQL/object storage/backup externos quando o escopo deixar de ser pessoal/local.
4. Automatizar E2E do instalador e smoke do aplicativo em CI/VM Windows, além do smoke local atual.
5. Definir telemetria, crash reporting, suporte, retenção e privacidade antes de coletar dados.

## O que já pode ser usado

- O ZIP em `Plataforma/apps/desktop/out/make/zip/win32/x64/` pode ser usado para QA local no Windows.
- O comando `npm run desktop:qa` reconstrói o artefato e repete a prova externa.
- O painel pode operar como frontend desktop a partir de 900×620; mobile continua fora do recorte solicitado.
- Nenhuma opção acima autoriza publicação pública, ativação do canal `stable` ou distribuição de JARs sem licença.

## Próxima sequência recomendada

1. Implementar a tela somente leitura da observação de datapacks, pois o backend e os contratos já existem e o recorte não amplia poder destrutivo.
2. Em paralelo de produto, obter as quatro decisões externas: instalador, identidade de assinatura, identidade visual/licença e cliente-base canônico.
3. Com essas decisões, gerar o primeiro instalador assinado e validá-lo em Windows limpo.
4. Depois, concluir restore isolado e rollback de `artifact.install` em fatias separadas, cada uma com operação durável, auditoria e smoke real.

## Definição objetiva de “final”

O produto só deve ser chamado de final quando o instalador assinado puder instalar, abrir, persistir, atualizar, voltar à versão anterior e desinstalar em máquina limpa; o painel não expuser ações sem backend seguro correspondente; uma release canônica do modpack passar todos os gates de licença e jogo; e backup/restore tiver prova recuperável. Até lá, o nome correto do artefato atual é **VoidFall Windows portátil de QA 0.1.0**.
