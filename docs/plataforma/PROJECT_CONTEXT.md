# Contexto do projeto

## Identidade oficial

- nome público: **VoidFall**;
- identificador estável: `voidfall`;
- namespace de pacotes internos: `@voidfall/*`;
- a decisão está registrada no [ADR-006](DECISIONS/ADR-006-identidade-e-inicio-da-fase-2.md).

## Objetivo

Criar uma plataforma própria para administrar o servidor Minecraft Forge, gerar versões reproduzíveis do modpack e oferecer um protocolo seguro de atualização para clientes, sem depender de acesso manual às pastas do servidor.

## Estado conhecido do repositório

- o cliente e o servidor são fontes separadas;
- o servidor auditado usa Minecraft 1.20.1, Forge 1.20.1-47.4.4 e Java 17;
- o servidor possui 181 JARs ativos;
- o launcher atualmente documentado possui 23 JARs ativos e apenas 11 nomes coincidem com o servidor;
- uma exportação privada de cliente possui 220 JARs e 178 coincidem com o servidor;
- origem, licença e lado de várias dependências ainda não foram aprovados;
- o runtime privado apresenta modo offline, whitelist desabilitada e RCON habilitado;
- mundo, jogadores, credenciais, logs e binários permanecem fora do Git.

Esses fatos impedem que a plataforma trate o diretório vivo do servidor como fonte pronta do cliente.

## Escopo atual

A Fase 2 está concluída e inclui monorepo TypeScript, contratos, PostgreSQL/PGlite de teste, migrações, repositórios, Control API, autenticação, sessões, RBAC, auditoria, worker `system.noop`, cliente de agente e dashboard estático de demonstração. A Fase 3 começou por planos de lançamento Windows/Linux e uma máquina de estados puramente determinística. Ainda não há execução de processo, controle do runtime, console, backup, launcher próprio ou mod Forge.

## Decisões já tomadas

- TypeScript estrito no plano de controle.
- Java 17 apenas na ponte instalada no Forge.
- PostgreSQL para estado transacional, auditoria e fila inicial.
- armazenamento de objetos/arquivos para pacotes, backups e logs grandes.
- contratos versionados e validados entre todos os serviços.
- publicação imutável e atômica; rollback move um ponteiro, não reconstrói arquivos.
- o comando `/atualizar-modpack` solicita um job; não executa shell nem garante promoção automática.
- grupos do Minecraft e papéis do painel são domínios distintos.
- `player` é o grupo padrão de todo jogador novo.

## Restrições que não podem ser quebradas

1. Não copiar o servidor inteiro para formar o cliente.
2. Não publicar arquivo com lado, origem, licença ou dependência desconhecidos.
3. Não expor terminal do sistema a usuários comuns.
4. Não concatenar entrada em comandos do sistema operacional.
5. Não permitir leitura ou escrita fora de raízes autorizadas.
6. Não apagar arquivo local do jogador que não seja gerenciado pelo manifesto.
7. Não armazenar segredo em manifesto, log, auditoria ou Git.
8. Não inventar métricas, causa de erro ou compatibilidade.
9. Não substituir uma release válida durante o build.
10. Não alterar ADR silenciosamente.

## Prioridades

1. Segurança e separação de privilégios.
2. Reprodutibilidade e rollback.
3. Compatibilidade verificável entre cliente e servidor.
4. Observabilidade e auditoria.
5. Interface simples sem esconder risco operacional.

## Vocabulário

- **Control API:** API administrativa central.
- **Server Agent:** serviço com privilégios mínimos próximo ao processo Minecraft.
- **Forge Bridge:** mod Java que valida comandos e emite eventos do jogo.
- **Build Worker:** processo isolado que monta e valida releases.
- **Launcher API:** superfície pública e somente leitura para canais e manifestos.
- **Catálogo canônico:** lista revisada de arquivos, origem, hash, lado e distribuição.
- **Build:** execução que produz um candidato.
- **Release:** candidato aprovado e imutável.
- **Promoção:** alteração atômica do canal para apontar a uma release.
- **Job:** tarefa durável com lease, progresso, cancelamento e resultado.

## Fora do escopo inicial

- terminal operacional genérico;
- edição visual específica para cada mod;
- atualização automática de mods por scraping;
- descoberta automática de compatibilidade por execução de JAR desconhecido;
- multi-tenant e múltiplas regiões;
- aplicativo desktop;
- localização física de jogadores.
