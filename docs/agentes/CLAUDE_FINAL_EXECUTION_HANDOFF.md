# Handoff de execução final para Claude

Este documento é a instrução operacional para continuar a implementação da VoidFall a partir da Fase 7.3 e percorrer todo o planejamento restante. Ele não substitui o plano canônico: checkboxes, gates e critérios de conclusão pertencem a [`FINAL_IMPLEMENTATION_PLAN.md`](../plataforma/FINAL_IMPLEMENTATION_PLAN.md). Se houver divergência, prevalecem, nesta ordem, a solicitação atual do proprietário, os arquivos `AGENTS.md` aplicáveis, os ADRs aceitos e o plano canônico.

## Objetivo confiado ao Claude

Continuar da primeira fatia ainda aberta, **Fase 7.3**, e executar sequencialmente as Fases 8–13. Trabalhar com autonomia em tudo que for tecnicamente autorizado dentro do repositório, uma fatia numerada por vez, até:

1. concluir todos os itens e gates que possam ser comprovados com fixtures, serviços isolados e ambientes de integração autorizados; ou
2. alcançar uma decisão, credencial, acesso operacional, smoke test real ou aceite que somente o proprietário possa fornecer.

Não confundir “executar todo o planejamento” com autorização irrestrita. Quando um gate depender do proprietário ou de infraestrutura externa, preparar o máximo seguro, documentar exatamente o que falta e pedir somente a decisão necessária. Nunca inventar aceite, provider, segredo, licença, compatibilidade ou resultado de smoke test.

## Snapshot de partida

- Data do handoff: 2026-08-04.
- Branch: `main`.
- Commit remoto confirmado no momento deste handoff: `fec6c56` — `chore(graphify): index phase 7.2 CI handoff`.
- Fases 2–6 e recortes 7.0–7.2: tecnicamente concluídos em isolamento.
- Próxima fatia: **7.3 — API, agente e painel da configuração OpenLoader**.
- Schema aprovado: `openloader_advanced_options_v1`, restrito a `config/openloader/advanced_options.json` e aos booleanos `dataPacks.enabled` e `resourcePacks.enabled`; `additionalFolders` continua vazio.
- Persistência já disponível: schemas, recursos, revisões, estados, auditoria e lock `minecraft-exclusive` em PostgreSQL/PGlite.
- Serviço já disponível: `PersistentConfigurationService`, com aplicação, falha e rollback testados apenas em diretórios temporários.
- CI da implementação da Fase 7.2: [execução 30952093047](https://github.com/Myerzx/Void-Modpack/actions/runs/30952093047).
- CI da ponta final deste handoff: [execução 30952566022](https://github.com/Myerzx/Void-Modpack/actions/runs/30952566022), aprovada em Windows e Ubuntu.
- Baseline local da Fase 7.2: 194 testes descobertos, 192 executados no Windows e dois sockets Unix ignorados; `npm audit --omit=dev` sem vulnerabilidades de runtime.
- Graphify após indexar este handoff: 3.042 nós e 5.135 relações, incluindo 29 nós do documento e cinco da memória da consulta. Não há endpoint ausente nem relação duplicada. As duas autociclagens SQL conhecidas estão documentadas no handoff da plataforma; uma é a FK legítima de rollback e a outra é atribuição do extrator.
- Nenhum runtime privado foi conectado, lido ou modificado pela Fase 7.2.

Este snapshot é histórico. Antes de agir, conferir o estado real; não assumir que `fec6c56` ainda é a ponta se houver commits posteriores.

## Alteração local que não pertence ao planejamento

No momento deste handoff existe uma alteração preexistente e deliberadamente não commitada em:

`Plataforma/apps/panel-web/next-env.d.ts`

O diff esperado troca a referência gerada de `./.next/types/routes.d.ts` para `./.next/dev/types/routes.d.ts`. Essa alteração pertence ao usuário e deve permanecer fora de **todos** os commits deste planejamento.

Antes de cada build do painel, registrar o diff atual desse arquivo. O Next pode regenerá-lo; depois do build, restaurar exatamente o conteúdo preexistente e confirmar com `git diff`. Nunca usar `git stash`, `git checkout --`, `git restore`, reset ou commit amplo de forma que apague ou absorva essa alteração. Também preservar qualquer nova alteração alheia encontrada no worktree.

## Leitura obrigatória no início de cada sessão

Executar a partir da raiz real do repositório:

```powershell
git status --short --branch
git log -12 --oneline
Get-Content -Raw AGENTS.md
Get-Content -Raw Plataforma/AGENTS.md
Get-Content -Raw docs/plataforma/FINAL_IMPLEMENTATION_PLAN.md
Get-Content -Raw docs/plataforma/HANDOFF.md
Get-Content -Raw docs/agentes/CLAUDE_FINAL_EXECUTION_HANDOFF.md
```

Depois:

1. ler o documento específico da fase anterior e os documentos arquiteturais ligados à fatia;
2. rodar `graphify reflect --if-stale` e ler `graphify-out/reflections/LESSONS.md`;
3. consultar `graphify query` sobre a fatia antes de analisar arquivos por busca textual;
4. usar `graphify path` ou `graphify explain` quando uma dependência ou trust boundary não estiver clara;
5. inspecionar os arquivos-alvo e testes existentes antes de editar.

Não ler `GRAPH_REPORT.md` inteiro para uma pergunta focal se `query`, `path` ou `explain` forem suficientes.

## Fronteiras que nunca podem ser atravessadas silenciosamente

### Runtimes e dados privados

- Não ler, varrer, executar, modificar, copiar, comparar ou usar como fixture `Launcher/workspace/**` ou `Servidor/workspace/**`.
- Isso inclui `Servidor/workspace/server-original/config/openloader/**`: o caminho privado ajudou o proprietário a escolher o OpenLoader, mas não é fonte operacional autorizada para esta implementação.
- Não abrir JARs privados, mundos, logs, crash reports, identidades, tokens, endereços, seeds, chat ou coordenadas.
- Usar apenas fixtures versionadas/sanitizadas, PGlite, PostgreSQL de teste e diretórios temporários do sistema.

### Operações e execução

- Não expor shell, comando livre, executável, argumentos, cwd, path absoluto ou schema fornecido pelo usuário.
- Toda mutação precisa de contrato estreito, autenticação, RBAC, ator, motivo, idempotência, lock aplicável, auditoria e recibo sanitizado.
- O Server Agent executa somente operações tipadas e allowlisted; IDs atravessam a fronteira, enquanto roots, paths e adapters vêm de configuração confiável local.
- Não iniciar, parar ou reiniciar o Minecraft real; não habilitar RCON; não trocar mundo ativo; não executar restore operacional.
- Não coletar dados reais de jogador, chat, atividade ou coordenadas sem política aceita.

### Distribuição e produção

- Não publicar ou promover `stable` enquanto os gates de distribuição e smoke test estiverem abertos.
- Não instalar o Forge Bridge nem registrar/habilitar `/atualizar-modpack` antes dos gates próprios.
- Não criar ou usar credenciais reais, secret store, infraestrutura de produção ou acesso externo sem autorização explícita.
- Diferenças nominais de versão que funcionam no jogo são evidência para smoke test e decisão humana; não bloquear o desenvolvimento isolado apenas por elas. Ao mesmo tempo, nunca converter `unknown` em “compatível” nem usá-las para liberar `stable` sem teste registrado.

## Primeira missão: Fase 7.3

Não repetir nem reescrever as Fases 7.0–7.2. Reutilizar o que já existe e executar a Fase 7.3 nesta ordem técnica:

### 1. Contratos públicos de configuração

- Criar contratos versionados e JSON Schemas para listar schemas/recursos autorizados, consultar valores/revisões com redação, validar sem aplicar, solicitar aplicação e solicitar rollback.
- Fixar IDs, enumerações, limites e estados; proibir payload extensível e paths públicos.
- Aplicação deve exigir hash/versão esperados, chave de idempotência, ator e motivo conforme a fronteira existente.
- Respostas e erros não podem expor root, path absoluto, valor secreto, bytes de revisão ou detalhes internos.
- Atualizar exports e testes de contratos antes de ligar consumidores.

Arquivos iniciais a inspecionar:

- `Plataforma/packages/contracts/src/**`;
- `Plataforma/packages/contracts/test/contracts.test.ts`;
- `docs/plataforma/CONTRACTS.md`;
- `docs/plataforma/API.md`.

### 2. Orquestração durável e autorização

- Reutilizar `ConfigurationRepository`, `OperationalLockRepository`, `PersistentConfigurationService`, jobs e auditoria existentes.
- Não criar uma segunda fonte de verdade nem duplicar a máquina de estados da Fase 7.2.
- Persistir/reutilizar idempotência pública e correlação de job sem dual write; definir transações e estados de falha explicitamente.
- Estender RBAC com menor privilégio e testes de negação, mantendo permissões do painel separadas das permissões Minecraft.

Arquivos iniciais a inspecionar:

- `Plataforma/packages/database/src/configuration-repositories.ts`;
- `Plataforma/packages/database/src/repositories.ts`;
- `Plataforma/packages/database/migrations/**`;
- `Plataforma/packages/server-configuration/src/persistent-service.ts`;
- `Plataforma/apps/control-api/src/app.ts`.

### 3. Control API

- Implementar exatamente os `GET` e `POST` previstos em 7.3, com autenticação, CSRF quando aplicável, RBAC, rate limit e validação nos dois lados da fronteira.
- `POST validate` não pode aplicar nem produzir revisão operacional falsa.
- `POST apply` deve enfileirar/correlacionar operação tipada e respeitar hash esperado/idempotência.
- `POST rollback` só aceita revisão elegível do mesmo recurso/servidor.
- Testar sucesso, negação, replay idempotente, concorrência obsoleta, recurso/schema desconhecido, falha do agente e sanitização.

### 4. Server Agent

- Adicionar uma capability e envelope específicos para configuração, sem operação genérica.
- Resolver root, recurso, codec e path apenas pelo registro confiável local.
- Manter comunicação outbound-only e validar assinatura, nonce/lease/replay conforme o contrato vigente.
- Para 7.3, executar apenas contra diretório temporário de integração; o runtime Minecraft privado continua desconectado.

Arquivos iniciais a inspecionar:

- `Plataforma/apps/server-agent/src/agent-client.ts`;
- `Plataforma/packages/contracts/src/agent-envelope.ts`;
- `Plataforma/packages/configuration-schemas/src/trusted-registry.ts`;
- `Plataforma/packages/server-configuration/src/reviewed-resource.ts`.

### 5. Painel

- Substituir fixture apenas no fluxo de configuração implementado; não apresentar outras áreas simuladas como reais.
- Exibir schema/recurso permitido, valores editáveis, diff seguro, hash/revisão, necessidade de restart e estados loading/vazio/negado/conflito/falha/sucesso.
- Não exibir path absoluto, valor redigido, segredo ou ação sem permissão.
- Manter qualquer mutação perigosa indisponível.
- Preservar integralmente a alteração local de `next-env.d.ts` descrita acima.

Arquivos iniciais a inspecionar:

- `Plataforma/apps/panel-web/app/**`;
- `Plataforma/apps/panel-web/lib/**`;
- `Plataforma/apps/panel-web/test/**`;
- `docs/plataforma/UI_INFORMATION_ARCHITECTURE.md`.

### 6. E2E e gate da Fase 7

O E2E precisa provar, em diretório temporário:

`painel → API → job/agente → PersistentConfigurationService → filesystem isolado → auditoria`

Cobrir validação sem efeito, aplicação, replay idempotente, hash obsoleto, concorrência, falha sanitizada, restart apenas como metadata e rollback. Provar também que formato não registrado, path público e recurso desconhecido são negados.

Não iniciar a Fase 8 até o critério de conclusão da Fase 7 estar integralmente marcado, documentado e aprovado pela CI Windows/Linux.

## Ordem das fases restantes

Os detalhes e checkboxes ficam no plano canônico. A sequência abaixo serve como navegação e não autoriza pular gates.

| Ordem | Fatia | Resultado exigido antes de avançar |
| --- | --- | --- |
| 1 | 7.3 | configuração OpenLoader atravessa painel/API/job/agente/filesystem temporário/auditoria com rollback |
| 2 | 8.1 | inspeção ZIP/JAR limitada, sem carregar classes ou executar artefato |
| 3 | 8.2 | issues contextuais estáveis, com `unknown` bloqueante e evidência |
| 4 | 8.3 | quarentena, análise, decisão humana e jobs persistidos; aprovação não instala |
| 5 | 8.4 | painel mostra incompatibilidades reais; instalação permanece ausente/desabilitada |
| 6 | 9.1 | comandos, idempotência, locks, PID, recibos, catálogos e jobs duráveis sem dual write |
| 7 | 9.2 | transporte API↔Agent autenticado, outbound-only, revogável e com replay protection |
| 8 | 9.3 | painel mínimo dinâmico sem fixtures nas áreas implementadas |
| 9 | 10.1–10.5 | processo, console, arquivos, backups, métricas, logs, alertas e agenda sob RBAC/job/lock/auditoria |
| 10 | 11 | jogadores por UUID, providers aprovados, moderação tipada e política de dados aplicada |
| 11 | 12.1–12.4 | build, assinatura, launcher, Bridge e release candidata certificados; `stable` ainda depende dos gates |
| 12 | 13.1–13.4 | decisões finais, deploy, segurança, recuperação, aceite do proprietário e somente então `stable` |

Ao concluir uma fatia, atualizar o checkbox correspondente no plano. Não marcar itens futuros por inferência nem declarar uma fase concluída apenas porque compila.

## Decisões que exigem o proprietário

Claude pode pesquisar opções e preparar um ADR proposto, mas não pode marcar como aceita, implementar integração real dependente ou escolher silenciosamente:

- cliente-base canônico;
- topologia oficial de autenticação Minecraft/proxy;
- provider real de permissões e capacidades Forge;
- política, finalidade, retenção, acesso e responsáveis por dados sensíveis;
- exposição do painel por internet, VPN ou LAN;
- backend de object storage, retenção e criptografia;
- sistema operacional/topologia oficial de produção;
- launchers e instâncias inicialmente suportados;
- guardiões das chaves Ed25519, aprovadores de `stable` e rollback;
- licença/origem/distribuição quando a evidência não estiver registrada;
- autorização para qualquer smoke test ou operação contra runtime real.

Ao encontrar uma dessas decisões:

1. concluir antes todo trabalho isolado que não dependa dela;
2. registrar alternativas, consequências, recomendação e migração em ADR proposto quando apropriado;
3. manter o item desmarcado e a integração deny-by-default;
4. atualizar o handoff com a pergunta exata;
5. pedir a decisão ao proprietário sem assumir consentimento.

## Ciclo obrigatório de cada fatia

1. Confirmar worktree e registrar alterações preexistentes.
2. Consultar Graphify e ler código/testes/documentos do escopo.
3. Identificar contrato, trust boundaries, autorização e estado persistido.
4. Escrever ou atualizar os testes que demonstram o comportamento e as negações.
5. Implementar somente a fatia atual.
6. Rodar build/typecheck/test dos workspaces afetados.
7. Revisar segurança: autenticação, RBAC, CSRF, rate limit, idempotência, replay, paths, segredos, limites e auditoria conforme aplicável.
8. Atualizar documento da fase, `ROADMAP.md`, `HANDOFF.md`, `Plataforma/README.md` e `Plataforma/AGENTS.md` quando o estado ou próximo recorte mudar.
9. Rodar `git diff --check` e revisar cada arquivo a ser staged.
10. Criar commits técnicos separados em inglês.
11. Rodar o gate completo ao encerrar a fatia/fase.
12. Executar `graphify update .`, consultar o fluxo alterado e versionar os outputs relevantes em commit próprio.
13. Enviar `main` com `git push origin main`, nunca force push.
14. Acompanhar a CI Windows/Linux até conclusão. Se falhar, diagnosticar, corrigir no mesmo escopo, revalidar e enviar novo commit.
15. Entregar o relatório de sessão no formato definido abaixo.

Se a sessão terminar no meio de uma fatia, não marcar conclusão. Deixar commits coerentes apenas para partes realmente completas e registrar o próximo passo exato.

## Divisão de commits

Usar Conventional Commits técnicos em inglês e separar, conforme aplicável:

- `feat(contracts): ...` — contratos e JSON Schemas;
- `feat(database): ...` — migration e repositórios;
- `feat(configuration): ...` — domínio/serviço;
- `feat(server-agent): ...` ou `feat(worker): ...` — integração tipada;
- `feat(control-api): ...` — endpoints, autorização e handlers;
- `feat(panel): ...` — UI e fluxo cliente;
- `test(...): ...` — corpus/fixtures quando constituírem recorte independente;
- `docs(platform): ...` — plano, roadmap, ADR e handoff;
- `chore(graphify): ...` — índice e memória do grafo.

Stagear somente paths/hunks pertencentes ao commit. Não usar `git add .` enquanto houver alterações preexistentes ou geradas fora do escopo. Não reescrever histórico remoto e não usar force push.

## Validação

### Baseline no início de uma fase

```powershell
Set-Location Plataforma
npm ci
npm run check
npm audit --omit=dev
Set-Location ..
```

Registrar separadamente qualquer falha preexistente antes de editar.

### Workspaces iniciais da Fase 7.3

Para cada workspace alterado, executar os scripts aplicáveis:

```powershell
Set-Location Plataforma
npm run build --workspace @voidfall/contracts
npm run typecheck --workspace @voidfall/contracts
npm run test --workspace @voidfall/contracts

npm run build --workspace @voidfall/database
npm run typecheck --workspace @voidfall/database
npm run test --workspace @voidfall/database

npm run build --workspace @voidfall/server-configuration
npm run typecheck --workspace @voidfall/server-configuration
npm run test --workspace @voidfall/server-configuration

npm run build --workspace @voidfall/control-api
npm run typecheck --workspace @voidfall/control-api
npm run test --workspace @voidfall/control-api

npm run build --workspace @voidfall/server-agent
npm run typecheck --workspace @voidfall/server-agent
npm run test --workspace @voidfall/server-agent

npm run build --workspace @voidfall/panel-web
npm run typecheck --workspace @voidfall/panel-web
npm run test --workspace @voidfall/panel-web
Set-Location ..
```

Executar apenas os blocos afetados durante a iteração; no gate final, rodar `npm run check` completo.

### Validadores de repositório

```powershell
$python = (Get-Content graphify-out/.graphify_python -Raw).Trim()
& $python tools/modpack/validate_modpack_docs.py
& .\Servidor\tools\Test-ServerDocumentation.ps1
git diff --check
```

Rodar também `Launcher/tools/Test-LauncherPack.ps1` se — e somente se — uma tarefa de launcher autorizada alterar seu escopo público. Mudanças de servidor e launcher continuam em commits separados.

### Gate de CI

Depois do push:

```powershell
gh run list --branch main --limit 5
gh run watch <RUN_ID> --exit-status --interval 10
```

Confirmar individualmente `ubuntu-latest` e `windows-latest`. Não registrar CI como aprovada antes da conclusão real.

## Atualização documental de cada recorte

Registrar, no mínimo:

- resultado implementado e limites mantidos;
- contratos, migrations, serviços, endpoints e telas alterados;
- casos de teste e números finais;
- CI com link e sistemas aprovados;
- riscos novos e riscos ainda abertos;
- decisões aceitas ou explicitamente pendentes;
- commits do recorte;
- próximo item exato do plano;
- confirmação de que os runtimes privados não foram lidos nem modificados.

Não apagar riscos antigos apenas porque a implementação avançou. Corrigir afirmações obsoletas quando uma fase realmente resolver o risco.

## Formato obrigatório do relatório de sessão

```text
Fase/item:
Resultado:
Arquivos principais:
Contratos/migrations:
Validação focal:
Gate completo:
CI Windows/Linux:
Segurança e dados privados:
Commits:
Graphify:
Riscos ou decisões pendentes:
Próximo item exato:
Worktree restante:
```

O campo “Worktree restante” deve listar explicitamente qualquer arquivo modificado não commitado e confirmar que `Plataforma/apps/panel-web/next-env.d.ts` permaneceu fora dos commits enquanto continuar sendo uma alteração do usuário.

## Instrução curta para iniciar o Claude

Se este documento for enviado como referência, a solicitação inicial pode ser:

> Leia integralmente `AGENTS.md`, `Plataforma/AGENTS.md`, `docs/agentes/CLAUDE_FINAL_EXECUTION_HANDOFF.md`, `docs/plataforma/FINAL_IMPLEMENTATION_PLAN.md` e `docs/plataforma/HANDOFF.md`. Consulte o Graphify antes da arquitetura. Continue a VoidFall pela Fase 7.3 e depois execute sequencialmente todo o plano restante, uma fatia numerada por vez, respeitando gates e pontos de decisão. Preserve qualquer dirty work, especialmente `Plataforma/apps/panel-web/next-env.d.ts`; não leia nem modifique runtimes privados. Valide, atualize documentação/Graphify, crie commits técnicos separados, envie `main`, acompanhe a CI Windows/Linux e entregue o relatório obrigatório a cada recorte. Quando uma decisão ou acesso do proprietário for indispensável, conclua primeiro todo trabalho isolado possível e peça somente a autorização exata; não invente aceite nem ultrapasse o gate.
