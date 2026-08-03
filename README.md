# VoidFall

Repositório de trabalho do modpack VoidFall. A fase atual organiza e documenta o cliente/launcher; o servidor fica reservado para a próxima fase.

## Estrutura

- `Launcher/`: fonte do pacote cliente, catálogo, ferramentas de build e perfil bruto ignorado.
- `Servidor/`: escopo reservado; ainda não contém a implementação do servidor.
- `docs/launcher/`: auditoria, arquitetura, portabilidade, ativos e processo de release.
- `docs/agentes/`: limites de atuação para Codex, Claude e outros agentes.
- `docs/graphify/`: instalação, atualização automática e operação do mapa de conhecimento.
- `graphify-out/`: mapa persistente do repositório, gerado pelo Graphify.

## Estado atual

O material original foi preservado em `Launcher/workspace/profile-original/` e não entra no Git. A fonte limpa em `Launcher/pack/` é um ponto de partida auditável, não uma release aprovada: o perfil original contém divergência de manifesto, datapacks herdados incompatíveis e ativos com licença ainda não confirmada.

Consulte [a documentação do launcher](docs/launcher/README.md) antes de publicar uma release.

O Graphify está integrado ao Git e ao Windows. Consulte [a operação do Graphify](docs/graphify/README.md) para iniciar, verificar ou remover o salvamento automático.
