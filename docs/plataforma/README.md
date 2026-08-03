# Plataforma VoidFall

Esta documentação define a plataforma de gerenciamento do servidor e atualização do modpack VoidFall. A Fase 1 registrou o plano antes da implementação; a Fase 2 começou com uma fundação restrita a toolchain e contratos compartilhados, para que Codex, Claude, outras IAs e desenvolvedores continuem com o mesmo contexto.

## Ordem de leitura

1. [Contexto do projeto](PROJECT_CONTEXT.md)
2. [Arquitetura](ARCHITECTURE.md)
3. [Arquitetura de informação do painel](UI_INFORMATION_ARCHITECTURE.md)
4. [Build do modpack](MODPACK_BUILD.md)
5. [Protocolo do launcher](LAUNCHER_PROTOCOL.md)
6. [Modelo de dados](DATABASE.md)
7. [Contratos de API](API.md)
8. [Segurança](SECURITY.md)
9. [Permissões](PERMISSIONS.md)
10. [Logs e métricas](LOGGING.md)
11. [Implantação e operação](DEPLOYMENT.md)
12. [Roadmap](ROADMAP.md)
13. [Handoff](HANDOFF.md)
14. [Decisões arquiteturais](DECISIONS/)

## Resultado da Fase 1

- linguagem e limites dos componentes definidos;
- fluxos do comando, build, publicação, rollback e atualização descritos;
- modelo inicial de dados e APIs planejados;
- autenticação, autorização, auditoria, arquivos e isolamento especificados;
- estratégia de logs, métricas, backups e implantação registrada;
- backlog, riscos e perguntas pendentes explícitos.

## Estado da Fase 2

- identidade oficial: **VoidFall**;
- primeiro recorte autorizado: workspace TypeScript e `@voidfall/contracts`;
- nenhum serviço, interface, banco, agente, worker ou controle do Minecraft está autorizado por esse recorte;
- os P0 não resolvidos no [roadmap](ROADMAP.md) continuam bloqueando as capacidades relacionadas.

Documentação e schemas não representam certificação de segurança. Cada nova capacidade precisa satisfazer seus gates, testes e ADRs aplicáveis.
