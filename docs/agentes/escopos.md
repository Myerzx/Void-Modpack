# Escopos de agentes

## Coordenador

Atua na raiz, mantém o plano e resolve dependências entre cliente, servidor, plataforma, documentação e Graphify. Não executa mudanças de conteúdo sem um dono de pasta claro.

## Agente do launcher

- Pode editar `Launcher/pack`, `Launcher/catalog`, `Launcher/tools` e `docs/launcher`.
- Não pode editar `Launcher/workspace`.
- Deve validar e commitar apenas arquivos do cliente.

## Agente de ativos/UI

- Atua em `Launcher/pack/overrides/config/fancymenu` e na documentação de licenças.
- Deve verificar todas as referências `[source:local]`.
- Não pode adicionar mídia sem origem/licença registrada.

## Agente de compatibilidade/release

- Atua em `Launcher/platforms`, scripts de build e runbooks.
- Não altera gameplay para fazer uma exportação passar.
- Registra separadamente resultado de importação e resultado de execução.

## Agente do servidor

- Pode editar `Servidor/catalog`, `Servidor/templates`, `Servidor/tools`, `Servidor/pack`, `Servidor/source` e `docs/servidor`.
- Não pode editar, publicar ou versionar `Servidor/workspace`.
- Deve tratar mundo, identidades, credenciais, seed, endereços, logs e binários como privados.
- Deve validar e commitar separadamente do cliente.
- Qualquer arquivo compartilhado com o cliente exige handoff explícito ao coordenador.

## Coordenador da plataforma

- Atua em `Plataforma/README.md`, `Plataforma/AGENTS.md` e `docs/plataforma` durante a Fase 1.
- Não cria aplicações, dependências, banco, migrações, UI, API ou ponte Forge sem autorização explícita da Fase 2.
- Resolve contratos entre painel, API, agente, worker, launcher e servidor.
- Exige ADR para mudar linguagem, persistência, comunicação, manifesto ou fonte canônica.

## Agente de contratos e dados

- Atua futuramente em `Plataforma/packages/contracts`, `Plataforma/packages/database`, `docs/plataforma/API.md` e `DATABASE.md`.
- Não acessa o runtime do servidor nem implementa operações de processo.
- Mantém compatibilidade versionada, migrations e testes de contrato.

## Agente do painel

- Atua futuramente em `Plataforma/apps/panel-web` e na arquitetura de informação aprovada.
- Consome APIs; nunca acessa arquivos, RCON ou processo Minecraft diretamente.
- Não inventa métricas nem esconde fonte/qualidade de valores.

## Agente do servidor local

- Atua futuramente em `server-agent` e `forge-bridge` com handoff entre TypeScript e Java.
- Implementa apenas operações tipadas e allowlisted.
- Não publica release, não aceita shell arbitrário e não amplia permissões do host.

## Agente de build/release

- Atua futuramente em `build-worker`, manifesto, validação e storage.
- Usa catálogo aprovado; não copia o runtime inteiro.
- Interrompe stable quando lado, licença, origem ou dependência são desconhecidos.

## Agente de segurança

- Revisa limites de confiança, autenticação, paths, uploads, assinatura e redação.
- Pode bloquear um gate; não implementa exceção silenciosa para fazer testes passarem.
- Registra findings e mudanças de decisão no handoff/ADR.

## Handoff mínimo

Cada agente deve informar:

- objetivo e escopo exato;
- arquivos alterados;
- validações executadas;
- riscos/dívidas restantes;
- commit criado e ponto de continuação.

## Continuação das fases finais

O handoff operacional para o Claude continuar da Fase 7.3 até a Fase 13 está em [`CLAUDE_FINAL_EXECUTION_HANDOFF.md`](CLAUDE_FINAL_EXECUTION_HANDOFF.md). O arquivo orienta execução, gates, validação, commits e pontos que exigem decisão do proprietário; o planejamento canônico permanece em [`FINAL_IMPLEMENTATION_PLAN.md`](../plataforma/FINAL_IMPLEMENTATION_PLAN.md).
