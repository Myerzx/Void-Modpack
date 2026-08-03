# Roadmap, riscos e perguntas

## Fase 1 — planejamento

Status: concluída e aceita em 2026-08-03.

- [x] arquitetura e diagrama de serviços;
- [x] fluxo seguro de `/atualizar-modpack`;
- [x] fluxo de build, publicação atômica e rollback;
- [x] modelo inicial do banco e fila;
- [x] estrutura futura do monorepo;
- [x] formato inicial do manifesto;
- [x] autenticação, permissões e auditoria;
- [x] logs, métricas e fontes reais;
- [x] implantação, backups e recuperação;
- [x] backlog, riscos e perguntas;
- [x] ADRs e handoff;
- [x] nenhum código de aplicação implementado.

## Bloqueios e gates da Fase 2

O proprietário autorizou o início da Fase 2 com uma fatia que não depende dos P0 ainda abertos: toolchain e contratos sem efeitos externos. Cada P0 não resolvido continua bloqueando a capacidade relacionada e, em especial, qualquer publicação stable ou controle real do Minecraft.

### P0

1. [x] Identidade oficial definida como **VoidFall** no [ADR-006](DECISIONS/ADR-006-identidade-e-inicio-da-fase-2.md).
2. [ ] Escolher qual cliente será a base, porque o launcher atual só coincide com 11 dos 181 JARs do servidor.
3. [ ] Resolver origem, licença e permissão de distribuição dos mods, datapacks, stubs, patches e mídia.
4. [ ] Definir o modelo real de autenticação Minecraft (online mode direto ou proxy autenticador protegido).
5. [ ] Rotacionar o segredo RCON histórico e decidir se RCON será removido da arquitetura.

### P1

1. Escolher o provedor de permissões Forge após analisar o conjunto de mods.
2. Definir backend de artifacts/backups e limites de armazenamento.
3. Definir política de aprovação: candidato manual ou autopromoção em canais não estáveis.
4. Definir retenção de chat, coordenadas, IP administrativo, logs e auditoria.
5. Definir ambientes Windows/Linux oficialmente suportados.

## Fase 2 — fundação

1. [x] Criar monorepo e toolchain fixada.
2. [x] Implementar os cinco contratos compartilhados iniciais, schemas portáteis e testes de entrada.
3. [x] Criar PostgreSQL, migrações e repositórios.
4. [x] Implementar Control API mínima, autenticação, sessões, RBAC e auditoria.
5. [x] Implementar job queue transacional e worker de teste inofensivo.
6. [x] Implementar registro/heartbeat do agente sem controle de processo.
7. [x] Criar dashboard somente leitura com dados simulados claramente marcados e fixtures, não métricas falsas.
8. [x] Ampliar testes de contrato e segurança conforme cada novo trust boundary.

Status: concluída em 2026-08-03. O gate passou com autenticação, autorização, auditoria, fila e identidade do agente cobertas por testes. Consulte [Validação da Fase 2](PHASE_2_VALIDATION.md).

## Fase 3 — controle do Minecraft

1. Adaptadores Windows/Linux de processo — **em validação CI**: runtime, PID, ambiente mínimo, saída limitada e stop gracioso implementados; falta confirmar a matriz Ubuntu/Windows no GitHub.
2. Estado observado, start, stop e restart seguro — **em andamento**: estado, start e stop isolados concluídos; restart e orquestração ainda pendentes.
3. Console de leitura e comandos em allowlist.
4. Métricas de host/processo e fonte exibida.
5. Backup consistente e restore em ambiente isolado.
6. Configurações básicas com revisão anterior.

Gate: force kill e restore permanecem desabilitados até testes de falha e recuperação.

Recorte atual: `@voidfall/minecraft-process` chama `spawn` somente por plano validado, com `shell: false`, ambiente mínimo e fixture Java em diretório temporário. Não toca no servidor e não está conectado à Control API ou ao agente.

## Fase 4 — mods, arquivos e schemas

1. Inventário e catálogo reconciliado.
2. Classificação manual por lado e distribuição.
3. Upload em quarantine e validação segura.
4. File manager em raízes autorizadas.
5. Schemas genéricos de configuração e histórico.
6. Dependências, duplicatas e conflitos.

## Fase 5 — build e launcher

1. Worker isolado e staging reproduzível.
2. Sanitização e gates.
3. Manifesto assinado e artifacts imutáveis.
4. Launcher API e canais.
5. Adaptador de cliente/launcher escolhido.
6. Publicação, promoção e rollback.
7. Forge Bridge e `/atualizar-modpack`.

Gate: o comando só é habilitado após cliente compatível e cadeia de distribuição aprovados.

## Fase 6 — jogadores e auditoria

1. Perfis por UUID e aliases.
2. Integração de permissões.
3. Moderação e punições.
4. Atividade, chat e coordenadas sob política de privacidade.
5. Auditoria encadeada/exportável.

## Fase 7 — configurações específicas

Somente após inventário completo e seleção dos mods suportados. Cada schema específico exige proprietário, versão, teste, validação, rollback e indicação de restart.

## Riscos técnicos

| Risco | Impacto | Mitigação planejada |
| --- | --- | --- |
| cliente e servidor divergentes | release não inicia/conecta | catálogo comum e smoke test real |
| classificação errada de lado | crash ou vazamento | `unknown` bloqueia stable e revisão manual |
| licença ausente | remoção/reclamação | provenance e decisão por arquivo |
| agente comprometido | controle do host | escopo mínimo, identidade por instância e allowlist |
| path traversal/junction | leitura/escrita externa | canonicalização e testes cross-platform |
| build não reproduzível | hash/release imprevisível | inputs imutáveis, ordem canônica e ambiente fixado |
| mundo inconsistente | perda de dados | protocolo save/snapshot e restore testado |
| log com segredo/dado pessoal | incidente de segurança | redação, retenção e acesso restrito |
| chave de assinatura comprometida | update malicioso | cofre, rotação, revogação e chave pública fixada |
| queue job duplicado | dupla operação destrutiva | idempotência, lease e efeitos deduplicados |
| plugin/mod de permissão incompatível | privilégio incorreto | adapter e teste no Forge real |
| disco cheio | crash/build/backup falho | quotas, preflight e alertas |

## Perguntas pendentes

1. [Respondida] O nome oficial é **VoidFall**. O versionamento de releases permanece SemVer e o schema possui versão própria.
2. O cliente privado de 220 JARs será a base ou será reconstruído do catálogo?
3. Quais launchers precisam ser suportados no primeiro release?
4. O servidor usará autenticação oficial direta ou proxy? Qual topologia?
5. Qual mod de permissões já existe ou pode ser introduzido sem conflito?
6. A produção inicial continuará em Windows ou migrará para Linux?
7. Onde artifacts e backups serão armazenados e qual orçamento/retention?
8. Quem pode aprovar/promover stable e rollback? Exige duas pessoas?
9. Quais dados de jogador podem ser armazenados e por quanto tempo?
10. O painel será acessível pela internet, VPN ou somente LAN?
11. Qual política para mods extras/opcionais no cliente?
12. O launcher será apenas protocolo/adaptadores ou aplicativo próprio no futuro?
13. Há necessidade real de múltiplos servidores/instâncias no MVP?
14. Quais testes de gameplay definem uma release compatível?
15. Quais componentes locais possuem autoria/licença para entrar em `Servidor/source`?

## Histórico do primeiro recorte da Fase 2

O primeiro recorte criou toolchain e contratos versionados (`Job`, `AgentEnvelope`, `ModCatalogEntry`, `ReleaseManifest`, `AuditEvent`) sem efeitos externos. Recortes posteriores, autorizados pelo proprietário, completaram a fundação. Os P0 remanescentes continuam gates obrigatórios para as capacidades relacionadas.
