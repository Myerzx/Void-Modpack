# Documentação do servidor

Esta seção registra o estado auditado do servidor **The Casket of Reveries 2.0.26** sem publicar o runtime bruto, credenciais, dados de jogadores ou conteúdo persistente do mundo.

## Leitura recomendada

1. [Auditoria](auditoria.md): fatos observados, riscos e prioridades.
2. [Arquitetura](arquitetura.md): camadas do runtime e estrutura canônica do repositório.
3. [Compatibilidade do cliente](compatibilidade-cliente.md): comparação objetiva entre servidor e clientes conhecidos.
4. [Segurança](seguranca.md): estado encontrado e baseline para publicação.
5. [Operação](operacao.md): boot, parada, backup e restauração.
6. [Sistemas customizados](sistemas-customizados.md): OpenLoader, KubeJS, patch local e stubs.
7. [Releases](releases.md): artefatos, gates e testes obrigatórios.

Os inventários reproduzíveis ficam em [`inventario/`](inventario/) e em `Servidor/catalog/`. O material original permanece somente em `Servidor/workspace/server-original/`, ignorado pelo Git e tratado como evidência imutável.

## Perfil auditado

- Minecraft 1.20.1;
- Forge 1.20.1-47.4.4;
- Java 17;
- heap máximo configurado em 8 GB;
- 181 JARs ativos, 12 desativados e 2 cópias/outros;
- 62.131 arquivos, totalizando 30.662.708.701 bytes.

Esse perfil possui evidência histórica de boot, mas ainda não é uma release reproduzível nem segura para exposição pública.
