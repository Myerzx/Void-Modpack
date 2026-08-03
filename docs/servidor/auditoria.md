# Auditoria do servidor

Data da auditoria: 3 de agosto de 2026.

## Resultado executivo

O runtime original foi preservado integralmente no workspace ignorado. A análise confirma um servidor Forge 1.20.1 funcional em uma execução histórica, com forte dependência de conteúdo orientado a dados e personalizações locais. A publicação está bloqueada por segurança, compatibilidade do cliente e direitos de distribuição.

## Evidências

| Área | Evidência observada |
| --- | --- |
| Runtime | Minecraft 1.20.1, Forge 1.20.1-47.4.4 e Java 17 |
| Inicialização | Último log analisado contém boot concluído em 55,355 s |
| Mods | 195 entradas: 181 ativas, 12 desativadas e 2 cópias/outros |
| Customizações | 3 stubs ativos e 17 arquivos classificados preliminarmente como locais ou alterados |
| Dados | 62.131 arquivos e 30.662.708.701 bytes |
| Mundo | Aproximadamente 9,35 GB, com a maior parte em dimensões |
| Histórico | 16 relatórios de crash presentes no material bruto |
| Acesso | 7 operadores e 7 usuários em cache; identidades não foram exportadas |

A classificação de arquivo local/alterado é heurística por nome e deve ser confirmada antes de qualquer release.

## Riscos priorizados

| Prioridade | Bloqueio | Decisão necessária |
| --- | --- | --- |
| P0 | Autenticação offline, whitelist desabilitada e RCON habilitado | Aplicar o baseline seguro e rotacionar o segredo antes de expor qualquer porta |
| P0 | O launcher publicado compartilha somente 11 dos 181 JARs ativos do servidor | Produzir um cliente compatível ou redefinir explicitamente qual modpack será publicado |
| P0 | Mods, datapacks, stubs, patches e mídia não possuem uma matriz pública completa de origem/licença | Resolver proveniência e permissão de redistribuição arquivo a arquivo |
| P1 | O script Windows reinicia indefinidamente após encerramentos | Separar parada intencional, falha e política de reinício supervisionado |
| P1 | Mundo, backups, mapas e exportações ocupam dezenas de gigabytes | Definir retenção, backup externo, teste de restauração e artefatos de release mínimos |
| P1 | Há 16 crash reports históricos | Classificar por causa/versão e executar smoke tests em instalação limpa |

## O que não foi publicado

O Git não recebe mundo, seed, endereços, credenciais, UUIDs, nomes de jogadores, listas de acesso, logs, crash reports, binários, JARs, bibliotecas geradas ou metadados privados de launcher. Os catálogos públicos registram apenas nomes técnicos, hashes, tamanhos, contagens e decisões pendentes.
