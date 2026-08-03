# Plataforma VoidFall

Esta documentação define a plataforma de gerenciamento do servidor e atualização do modpack VoidFall. A Fase 1 registrou o plano; a Fase 2 implementou e validou a fundação; os itens 1 a 5 da Fase 3 foram concluídos e o item 6 está validado localmente, todos em recortes sem integração operacional.

## Ordem de leitura

1. [Contexto do projeto](PROJECT_CONTEXT.md)
2. [Arquitetura](ARCHITECTURE.md)
3. [Arquitetura de informação do painel](UI_INFORMATION_ARCHITECTURE.md)
4. [Build do modpack](MODPACK_BUILD.md)
5. [Protocolo do launcher](LAUNCHER_PROTOCOL.md)
6. [Modelo de dados](DATABASE.md)
7. [Contratos de API](API.md)
8. [Contratos compartilhados](CONTRACTS.md)
9. [Segurança](SECURITY.md)
10. [Permissões](PERMISSIONS.md)
11. [Logs e métricas](LOGGING.md)
12. [Implantação e operação](DEPLOYMENT.md)
13. [Roadmap](ROADMAP.md)
14. [Handoff](HANDOFF.md)
15. [Decisões arquiteturais](DECISIONS/)
16. [Validação da Fase 2](PHASE_2_VALIDATION.md)
17. [Adaptadores de processo da Fase 3](PHASE_3_PROCESS_ADAPTERS.md)
18. [Controlador de processo da Fase 3](PHASE_3_PROCESS_CONTROLLER.md)
19. [Console limitado da Fase 3](PHASE_3_CONSOLE.md)
20. [Métricas limitadas da Fase 3](PHASE_3_METRICS.md)
21. [Backup consistente e restore isolado da Fase 3](PHASE_3_BACKUP_RESTORE.md)
22. [Configurações básicas e revisões da Fase 3](PHASE_3_CONFIGURATION_REVISIONS.md)

## Resultado da Fase 1

- linguagem e limites dos componentes definidos;
- fluxos do comando, build, publicação, rollback e atualização descritos;
- modelo inicial de dados e APIs planejados;
- autenticação, autorização, auditoria, arquivos e isolamento especificados;
- estratégia de logs, métricas, backups e implantação registrada;
- backlog, riscos e perguntas pendentes explícitos.

## Estado atual

- identidade oficial: **VoidFall**;
- Fase 2 concluída: contratos, PostgreSQL, migrações, autenticação, sessões, RBAC, auditoria, fila, worker `noop`, registro/heartbeat e dashboard de demonstração;
- Fase 3 em andamento: processo, console, métricas, backup consistente e restore isolado estão validados; configurações básicas com revisão anterior estão implementadas localmente e aguardam a matriz Windows/Linux;
- não existe execução de processo, console, backup, restore, configuração ou controle do Minecraft ligado à API;
- os P0 não resolvidos no [roadmap](ROADMAP.md) continuam bloqueando as capacidades relacionadas.

Documentação e schemas não representam certificação de segurança. Cada nova capacidade precisa satisfazer seus gates, testes e ADRs aplicáveis.
