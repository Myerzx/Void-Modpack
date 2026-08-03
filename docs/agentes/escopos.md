# Escopos de agentes

## Coordenador

Atua na raiz, mantém o plano, resolve dependências entre cliente, documentação, Graphify e futuramente servidor. Não executa mudanças de conteúdo sem um dono de pasta claro.

## Agente do launcher

- Pode editar `Launcher/pack`, `Launcher/catalog`, `Launcher/tools` e `docs/launcher`.
- Não pode editar `Launcher/workspace`.
- Deve validar e commitar apenas arquivos do cliente.

## Agente de ativos/UI

- Atua em `Launcher/pack/overrides/config/fancymenu` e na documentação de licenças.
- Deve verificar todas as referências `[source:local]`.
- Não pode adicionar mídia sem origem/licença registrada.

## Agente de compatibilidade/release

- Atua em `Launcher/platforms`, scripts de build e runbooks.
- Não altera gameplay para fazer uma exportação passar.
- Registra separadamente resultado de importação e resultado de execução.

## Agente do servidor

Fica inativo nesta fase. Quando ativado, atua somente em `Servidor/**` e documentação própria. Qualquer arquivo compartilhado com o cliente exige handoff explícito ao coordenador.

## Handoff mínimo

Cada agente deve informar:

- objetivo e escopo exato;
- arquivos alterados;
- validações executadas;
- riscos/dívidas restantes;
- commit criado e ponto de continuação.

