# Plataforma VoidFall

Esta documentação define a plataforma de gerenciamento do servidor e atualização do modpack VoidFall. A Fase 1 registrou o plano; as Fases 2 a 6 implementaram fundação, controle isolado, catálogo/arquivos, release/launcher e governança de jogadores/auditoria sem integração com os runtimes privados.

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
14. [Plano de implementação das fases finais](FINAL_IMPLEMENTATION_PLAN.md)
15. [Handoff](HANDOFF.md)
16. [Decisões arquiteturais](DECISIONS/)
17. [Validação da Fase 2](PHASE_2_VALIDATION.md)
18. [Adaptadores de processo da Fase 3](PHASE_3_PROCESS_ADAPTERS.md)
19. [Controlador de processo da Fase 3](PHASE_3_PROCESS_CONTROLLER.md)
20. [Console limitado da Fase 3](PHASE_3_CONSOLE.md)
21. [Métricas limitadas da Fase 3](PHASE_3_METRICS.md)
22. [Backup consistente e restore isolado da Fase 3](PHASE_3_BACKUP_RESTORE.md)
23. [Configurações básicas e revisões da Fase 3](PHASE_3_CONFIGURATION_REVISIONS.md)
24. [Inventário e catálogo reconciliado da Fase 4](PHASE_4_INVENTORY_CATALOG.md)
25. [Conclusão da Fase 4: catálogo, artefatos, arquivos e schemas](PHASE_4_COMPLETION.md)
26. [Execução da Fase 5: build, launcher e Bridge](PHASE_5_EXECUTION.md)
27. [Fase 6: jogadores, privacidade e auditoria](PHASE_6_PLAYERS_AUDIT.md)

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
- Fase 3 concluída em isolamento: processo, console, métricas, backup consistente, restore isolado e configurações básicas com revisão anterior passaram na matriz Windows/Linux;
- Fase 4 concluída em isolamento: inventário, classificação revisável, quarentena, arquivos autorizados, schemas genéricos e análise de conflitos passaram no gate local e na matriz Windows/Linux;
- Fase 5 tecnicamente concluída em isolamento: worker por referência, build/sanitização, assinatura, storage imutável, canais, Launcher API, planner portátil, rollback e Bridge Java passaram no gate local e na matriz Windows/Linux;
- Fase 6 tecnicamente concluída em isolamento: perfis/aliases por UUID, bindings de grupos Minecraft, moderação tipada, política deny-by-default e auditoria encadeada/exportável passaram no gate local e na matriz Windows/Linux;
- nenhum arquivo, chat, coordenada ou estado de jogador do servidor privado foi importado e nenhum provider/executor real foi conectado;
- não existe execução de processo, console, backup, restore, configuração ou controle do Minecraft ligado à API;
- `stable`, o adapter Forge real e `/atualizar-modpack` permanecem desabilitados até os gates P0 do cliente e da distribuição;
- os P0 não resolvidos no [roadmap](ROADMAP.md) continuam bloqueando as capacidades relacionadas.
- as fases necessárias para transformar os pacotes isolados em painel operacional e release certificada estão ordenadas no [plano final](FINAL_IMPLEMENTATION_PLAN.md).

Documentação e schemas não representam certificação de segurança. Cada nova capacidade precisa satisfazer seus gates, testes e ADRs aplicáveis.
