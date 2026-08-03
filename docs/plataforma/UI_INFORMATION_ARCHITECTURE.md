# Arquitetura de informação do painel

Status: planejamento de UX. Não há layout, componente ou identidade visual implementados.

## Direção

Painel administrativo responsivo, original e orientado a operação. Pode buscar a simplicidade de ferramentas conhecidas, mas não reutiliza marca, composição, aparência ou componentes de terceiros.

- desktop primeiro para produtividade;
- navegação lateral compacta e cabeçalho curto;
- densidade moderada, com tabelas/listas para volume;
- cards apenas para indicadores resumidos e alertas;
- cores reservadas a estado, severidade e ação;
- ações destrutivas nunca competem visualmente com a ação principal;
- fonte, horário e qualidade visíveis em métricas.

## Navegação principal

1. Visão geral
2. Servidor
3. Console
4. Jogadores
5. Mods
6. Modpack e launcher
7. Arquivos
8. Backups
9. Agendamentos
10. Desempenho
11. Logs e alertas
12. Segurança
13. Usuários do painel
14. Auditoria
15. Documentação

Itens aparecem conforme permissão. Ocultar item não substitui autorização da API.

## Cabeçalho global

- seletor de instância;
- estado observado do servidor;
- release/canal atual;
- jobs ativos;
- alertas críticos;
- menu da sessão.

Start/stop/restart pertencem à área Servidor e a um controle compacto global somente quando a permissão permitir. `Force kill` fica no menu de risco da página detalhada.

## Visão geral

Informação imediata:

- estado real e há quanto tempo foi observado;
- jogadores online/máximo;
- Minecraft, loader, modpack e agente;
- CPU, RAM, disco, TPS e MSPT com fonte/horário;
- build, backup, alerta e agendamento mais relevantes.

Ações primárias: abrir servidor ou acompanhar job ativo. Ações secundárias: novo backup e solicitar build. Histórico completo fica nas páginas específicas.

Estados obrigatórios: offline, iniciando, online, parando, reiniciando, degradado, sem agente e erro. “Solicitado online” e “observado online” não são fundidos.

## Padrão de telas operacionais

Cada domínio usa três superfícies:

1. **Lista:** busca, filtros, status e quick actions.
2. **Detalhe/drawer:** evidência, dependências, histórico e ações contextuais.
3. **Edição/modal:** alteração controlada com validação e impacto.

Filtros ficam em uma faixa compacta: busca primeiro, filtros relacionados, limpar e atualizar como ações secundárias. Menus de linhas usam camada flutuante fora do container rolável.

## Servidor

Resumo no topo: estado, processo, uptime, versão, memória e última transição.

- ação primária depende do estado: iniciar, parar ou acompanhar transição;
- restart é secundário;
- save world e manutenção ficam em operações;
- force kill exige menu “Mais”, motivo, confirmação reforçada e permissão própria;
- configuração crítica mostra valor atual, revisão e necessidade de restart.

## Console

- stream central com timestamps, origem, nível e busca;
- filtros por fonte/nível sem reprocessar o arquivo original;
- auto-scroll pausável;
- composer de comando separado do terminal do SO;
- comandos frequentes permitidos podem ter sugestões, nunca execução automática;
- warnings/erros destacam severidade sem ocultar contexto;
- limpar afeta somente a visualização.

## Jogadores

Lista densa: nome atual, UUID abreviado, estado, grupo, ping, último acesso e punição ativa. Clique abre drawer com aliases, atividade e ações.

Kick, mute e mensagem são ações moderadas. Ban, grupo, teleport e inventário exigem permissão/motivo conforme política. Coordenadas e chat aparecem somente para papéis autorizados e com indicador de sensibilidade.

## Mods

Tabela principal: nome/arquivo, versão, lado, obrigatoriedade, origem/licença, estado, hash curto e conflitos.

- ação primária: revisar item pendente;
- adicionar/atualizar cria candidato, não altera produção diretamente;
- filtros rápidos: `unknown`, licença pendente, conflito, client, server, both;
- detalhe agrupa metadata, dependências, releases, configurações e erros;
- diferença entre “detectado” e “aprovado” fica visualmente explícita.

## Modpack e launcher

Superfícies:

- builds em tabela com estágio, progresso, solicitante, duração e resultado;
- releases imutáveis e canais;
- diff entre versões;
- catálogo e bloqueios;
- promoção/rollback com revisão esperada;
- compatibilidade cliente-servidor.

Solicitar build é a ação primária. Aprovar/promover aparece somente em candidato válido e para quem possui permissão separada.

## Arquivos

Navegação começa em raízes lógicas autorizadas, não no filesystem do host. Breadcrumb nunca aceita path livre.

- editor somente para formatos permitidos;
- revisão atual e diff antes de salvar;
- upload vai para quarantine;
- mover/excluir/substituir exigem impacto e rollback disponível;
- symlink/junction e arquivo protegido aparecem como não editáveis.

## Backups e agendamentos

Backups: tipo, escopo, estado, tamanho, hash, retenção e restore testado. Criar backup é primário; restore é ação de risco no detalhe.

Agendamentos: próxima execução, timezone, avisos, política de concorrência e última execução. O formulário apresenta uma linha do tempo dos avisos antes de salvar.

## Desempenho

- valores atuais no topo;
- gráficos somente quando há série real;
- fonte e atualização em tooltip/legenda persistente;
- `unavailable` não vira zero;
- estimativa usa estilo e rótulo distintos;
- GPU some quando não existe fonte real.

## Logs, segurança e auditoria

Logs usam lista agrupada por fingerprint e filtros compactos. Detalhe contém stack, ocorrências, versão e hipótese marcada.

Segurança mostra agentes, sessões, bloqueios, chaves/certificados por identificador, configuração de acesso e findings; nunca revela segredo.

Auditoria é uma tabela append-only por ator, ação, recurso, resultado e correlação. Antes/depois redigidos ficam no detalhe.

## Responsividade e acessibilidade

- em telas estreitas, esconder colunas secundárias antes das ações;
- manter estado, nome e ação principal visíveis;
- ações de linha permanecem acessíveis por menu;
- console e tabelas usam áreas roláveis próprias;
- foco, hover, disabled, loading, empty, error e stale são desenhados explicitamente;
- navegação por teclado e leitores de tela faz parte do gate de implementação;
- não depender apenas de cor para estado/severidade.

## Critérios para futuros protótipos

- operador identifica estado e próxima ação em poucos segundos;
- mais informação útil por viewport sem sacrificar legibilidade;
- ação primária é inequívoca;
- ação destrutiva exige contexto e confirmação proporcional;
- ausência/staleness de dados é honesta;
- telas com listas preservam contexto ao abrir detalhes;
- o design continua original e não replica Aternos ou outro painel.
