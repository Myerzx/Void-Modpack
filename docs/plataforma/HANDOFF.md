# Handoff da plataforma

## Estado atual

- Data: 2026-08-03
- Responsável: Codex
- Fase: 2 — fundação
- Implementação: toolchain e contratos compartilhados concluídos; aplicações não iniciadas

## Realizado

- briefing consolidado com as auditorias existentes do launcher e servidor;
- TypeScript escolhido para o plano de controle e Java 17 para a ponte Forge;
- arquitetura, serviços e limites de confiança documentados;
- fluxos de comando, job, build, publicação, launcher, rollback e controle registrados;
- banco, API, permissões, segurança, logs, métricas, implantação e backups planejados;
- estrutura futura do monorepo definida sem criar scaffolding;
- ADRs iniciais criados;
- roadmap, riscos, bloqueios e perguntas pendentes registrados.
- identidade oficial definida como VoidFall no ADR-006;
- npm workspace e TypeScript Project References criados;
- contratos `Job`, `AgentEnvelope`, `ModCatalogEntry`, `ReleaseManifest` e `AuditEvent` implementados;
- schemas JSON portáteis, validação estrutural/semântica e testes adicionados.

## Arquivos centrais

- `docs/plataforma/PROJECT_CONTEXT.md`
- `docs/plataforma/ARCHITECTURE.md`
- `docs/plataforma/UI_INFORMATION_ARCHITECTURE.md`
- `docs/plataforma/MODPACK_BUILD.md`
- `docs/plataforma/LAUNCHER_PROTOCOL.md`
- `docs/plataforma/DATABASE.md`
- `docs/plataforma/API.md`
- `docs/plataforma/CONTRACTS.md`
- `docs/plataforma/SECURITY.md`
- `docs/plataforma/PERMISSIONS.md`
- `docs/plataforma/LOGGING.md`
- `docs/plataforma/DEPLOYMENT.md`
- `docs/plataforma/ROADMAP.md`
- `docs/plataforma/DECISIONS/`

## Decisões

1. Monorepo TypeScript estrito para painel e serviços.
2. Java 17 somente onde a integração Forge exige.
3. PostgreSQL como estado transacional e fila inicial.
4. Artifacts, backups e logs grandes fora do banco.
5. Agente inicia comunicação autenticada; API não controla o host por shell.
6. Manifestos assinados e releases imutáveis.
7. Catálogo aprovado é fonte do cliente; runtime é evidência.
8. Solicitar build e promover stable são permissões separadas.
9. A identidade oficial é VoidFall, com ID `voidfall` e namespace `@voidfall/*`.
10. A abertura da Fase 2 não autoriza serviços nem efeitos externos; o recorte atual termina nos contratos.

## Problemas encontrados

- o launcher atual não é compatível com o servidor por comparação de JARs;
- proveniência/licença e classificação de lado estão incompletas;
- o runtime possui riscos P0 de autenticação/whitelist/RCON;
- ainda não há decisão de cliente canônico, provedor de permissões ou ambiente de produção;
- autenticação Minecraft, licença/distribuição e futuro do RCON continuam P0;
- verificação criptográfica, canonicalização JSON e identidade mTLS ainda não foram implementadas.

## Regras de não ação

Não criar apps, banco, migrações, UI, API, agente, worker, mod ou adaptadores operacionais sem nova tarefa delimitada. Não modificar launcher, servidor privado ou runtime a partir deste handoff. Tipos de operação existentes nos contratos não são autorização de execução.

## Validação da sessão

- `npm ci`: lockfile instalável;
- `npm run check`: typecheck, 13 testes aprovados e cinco JSON Schemas gerados;
- `npm pack --workspace @voidfall/contracts --dry-run`: pacote contém código, tipos e os cinco schemas, sem cache de compilação;
- nenhum serviço, configuração Minecraft, mundo, launcher ou runtime do servidor foi alterado;
- Graphify atualizado ao final da sessão.

## Próxima tarefa recomendada

Escolher o próximo recorte somente após uma decisão explícita. A opção de menor risco é ampliar fixtures e formalizar schemas específicos de payload; PostgreSQL/API/agente continuam tarefas separadas. Os quatro P0 abertos devem ser resolvidos antes das capacidades dependentes.

## Atualização obrigatória

Substituir ou acrescentar uma seção datada ao final de cada sessão. Nunca apagar riscos não resolvidos; marcar a decisão e apontar para o ADR que os encerrou.

## Sessão 2026-08-03 — abertura da Fase 2

- autorização recebida: VoidFall como identidade oficial e início da nova fase;
- recorte executado: identidade, toolchain e contratos sem efeitos externos;
- commits base: `3919d11` (identidade/fase), `f9aa1d8` (toolchain/contratos) e `b941d04` (build limpo reproduzível);
- resultado: fundação reproduzível e validada, com gates operacionais preservados.
