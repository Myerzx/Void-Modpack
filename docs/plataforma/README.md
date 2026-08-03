# Planejamento da plataforma

Esta documentação define a futura plataforma de gerenciamento do servidor e atualização do modpack. Ela foi escrita antes da implementação para que Codex, Claude, outras IAs e desenvolvedores compartilhem o mesmo contexto.

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

Nenhum item desta pasta representa software executável ou certificação de segurança. A Fase 2 só começa após aprovação das decisões pendentes do [roadmap](ROADMAP.md).
