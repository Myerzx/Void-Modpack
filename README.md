# VoidFall

Repositório de trabalho para organizar cliente, servidor e a futura plataforma de gerenciamento de um modpack Minecraft 1.20.1 Forge de forma reproduzível e independente de launcher.

## Estrutura

- `Launcher/`: fonte do pacote cliente, catálogo, ferramentas de build e perfil bruto ignorado.
- `Servidor/`: catálogos, templates, ferramentas e futuro pacote dedicado; o runtime bruto fica ignorado.
- `Plataforma/`: monorepo do painel, agentes e atualização; a Fase 4 iniciou o inventário e catálogo reconciliado em pacote isolado, sem conexão operacional.
- `docs/launcher/`: auditoria, arquitetura, portabilidade, ativos e processo de release do cliente.
- `docs/servidor/`: auditoria, segurança, operação, compatibilidade e releases do servidor.
- `docs/modpack/`: base compacta por `mod_id`, dependências, riscos, versões, configurações e mapas Mermaid.
- `docs/plataforma/`: arquitetura, contratos, dados, segurança, roadmap, ADRs e handoff do novo sistema.
- `docs/agentes/`: limites de atuação para Codex, Claude e outros agentes.
- `docs/graphify/`: instalação, atualização automática e operação do mapa de conhecimento.
- `graphify-out/`: mapa persistente do repositório, gerado pelo Graphify.

## Estado atual

Os materiais originais do cliente e do servidor estão preservados em seus respectivos `workspace/` e não entram no Git. As pastas canônicas são pontos de partida auditáveis, não releases aprovadas.

O launcher atualmente documentado e o servidor recém-auditado representam conjuntos diferentes: apenas 11 dos 181 JARs ativos do servidor aparecem com o mesmo nome no launcher. Consulte [a documentação do launcher](docs/launcher/README.md) e [a documentação do servidor](docs/servidor/README.md) antes de publicar qualquer release.

A plataforma concluiu tecnicamente as Fases 2–6 em isolamento. Antes da Fase 7, a [base técnica do modpack](docs/modpack/index.md) mapeia 299 componentes, 298 artefatos e 737 relações declaradas. A Fase 7 permanece sem implementação até escolher explicitamente um dos schemas candidatos e resolver as divergências ativas entre cliente e servidor.

O Graphify está integrado ao Git e ao Windows. Consulte [a operação do Graphify](docs/graphify/README.md) para iniciar, verificar ou remover o salvamento automático.
