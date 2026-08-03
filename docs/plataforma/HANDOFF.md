# Handoff da plataforma

## Estado atual

- Data: 2026-08-03
- Responsável: Codex
- Fase: 1 — planejamento e documentação
- Implementação: não iniciada

## Realizado

- briefing consolidado com as auditorias existentes do launcher e servidor;
- TypeScript escolhido para o plano de controle e Java 17 para a ponte Forge;
- arquitetura, serviços e limites de confiança documentados;
- fluxos de comando, job, build, publicação, launcher, rollback e controle registrados;
- banco, API, permissões, segurança, logs, métricas, implantação e backups planejados;
- estrutura futura do monorepo definida sem criar scaffolding;
- ADRs iniciais criados;
- roadmap, riscos, bloqueios e perguntas pendentes registrados.

## Arquivos centrais

- `docs/plataforma/PROJECT_CONTEXT.md`
- `docs/plataforma/ARCHITECTURE.md`
- `docs/plataforma/UI_INFORMATION_ARCHITECTURE.md`
- `docs/plataforma/MODPACK_BUILD.md`
- `docs/plataforma/LAUNCHER_PROTOCOL.md`
- `docs/plataforma/DATABASE.md`
- `docs/plataforma/API.md`
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

## Problemas encontrados

- o launcher atual não é compatível com o servidor por comparação de JARs;
- proveniência/licença e classificação de lado estão incompletas;
- o runtime possui riscos P0 de autenticação/whitelist/RCON;
- ainda não há decisão de identidade do produto, provedor de permissões ou ambiente de produção.

## Regras de não ação

Não criar apps, instalar dependências, iniciar banco, implementar UI/API/mod ou modificar o runtime até autorização explícita da Fase 2 e resolução dos bloqueios P0 do roadmap.

## Validação da sessão

- documentação verificada por links, headings obrigatórios, termos proibidos e ausência de arquivos executáveis;
- nenhuma configuração, mundo ou dependência do projeto alterada;
- Graphify deve ser atualizado após o commit documental.

## Próxima tarefa recomendada

Revisar com o proprietário as perguntas P0 em `ROADMAP.md`. Depois criar um novo handoff autorizando, ou não, o primeiro pacote de contratos da Fase 2.

## Atualização obrigatória

Substituir ou acrescentar uma seção datada ao final de cada sessão. Nunca apagar riscos não resolvidos; marcar a decisão e apontar para o ADR que os encerrou.
