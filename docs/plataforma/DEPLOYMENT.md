# Implantação e operação

## Ambientes

| Ambiente | Finalidade | Dados reais |
| --- | --- | --- |
| local | desenvolvimento e contratos | proibidos |
| test | integração com servidor descartável | proibidos |
| staging | release candidate e smoke tests | cópia sanitizada/isolada quando autorizada |
| production | operação real | acesso mínimo e auditado |

## Topologia inicial

- reverse proxy encerra TLS e aplica limites básicos;
- Panel Web, Control API e Launcher API rodam sem privilégios administrativos;
- PostgreSQL fica em rede privada;
- Server Agent roda próximo ao Minecraft com usuário de serviço dedicado;
- Forge Bridge comunica apenas com loopback/IPC local;
- Build Worker roda isolado e sem escrita no runtime;
- artifacts/backups usam backend de storage separado;
- serviços iniciam por supervisor (`systemd` no Linux ou serviço equivalente no Windows), nunca por loop infinito cego.

Minecraft pode permanecer nativo no host. Containerizar o jogo não é requisito; o worker de build deve receber isolamento mais forte por processar arquivos.

### Estado implementado

- o Panel Web é exportado estaticamente para `apps/panel-web/out` e pode ser servido pelo reverse proxy sem um processo Next.js em produção;
- **local**, `npm run panel` sobe o ambiente inteiro sem proxy: a própria Control API serve o export na mesma origem, o banco é PGlite persistido em `Plataforma/.voidfall/`, e o primeiro dono é gerado e impresso uma vez. Escuta só loopback e recusa `NODE_ENV=production` — ver [PAINEL_LOCAL.md](PAINEL_LOCAL.md);
- em produção nada disso vale: `PostgresDatabase` sobre servidor real, painel servido pelo proxy, e a API sem `panelExportRoot`;
- a Control API e o worker possuem entrypoints, mas ainda não há manifesto de serviço/produção;
- o agente implementa apenas o cliente de registro/heartbeat; o transporte mTLS real e o supervisor ainda precisam ser integrados;
- nenhum componente deve ser apontado para o runtime privado nesta etapa.

## Compatibilidade de sistema operacional

O ambiente auditado é Windows, mas a arquitetura mantém adaptadores de processo e filesystem para Windows e Linux. Comportamentos que exigem teste nos dois lados:

- rename atômico e arquivo em uso;
- junction, symlink, hardlink e dispositivos reservados;
- sinal de parada/kill;
- ocultação de janela de subprocesso;
- permissões e usuários de serviço;
- paths longos e case sensitivity;
- snapshots e consistência de backup.

## Configuração e segredos

- configuração não secreta por arquivo validado/variável;
- segredo por cofre ou secret manager do ambiente;
- validação fail-fast no boot;
- exemplos versionados sem valores reais;
- rotação sem rebuild de imagem;
- configuração crítica versionada com rollback e auditoria.

O primeiro núcleo implementado, `@voidfall/server-configuration`, é mais restrito: trabalha somente com recursos Java Properties registrados, exige guarda offline injetada, lock local e hash atual esperado, e publica a revisão anterior antes de substituir o arquivo por `rename` no mesmo diretório. Rollback também cria revisão. A implementação atual usa apenas diretórios temporários; não existe registro operacional de recursos, storage protegido, agente, auditoria ou restart automático.

## Processo de deploy futuro

1. CI executa lint, typecheck, testes, contratos e scanner de segredo.
2. Gera imagens/pacotes com versão e provenance.
3. Aplica migração compatível antes da nova aplicação quando necessário.
4. Implanta em staging e executa smoke tests.
5. Requer aprovação para produção.
6. Atualiza serviços em ordem compatível com contratos.
7. Verifica health, readiness, jobs, WebSocket e agente.
8. Mantém versão anterior disponível para rollback.

## Backups

### Mundo

Estratégia portátil mínima:

1. avisar jogadores;
2. executar `save-off`;
3. executar `save-all flush` e confirmar conclusão;
4. criar cópia/snapshot consistente;
5. executar `save-on` em bloco de recuperação mesmo se a cópia falhar;
6. gerar hash e metadados;
7. testar restauração em ambiente isolado.

Snapshots de volume podem substituir a cópia quando a consistência for demonstrada e documentada.

O primeiro adaptador local implementado usa uma estratégia mais restrita: `offline-exclusive-v1`. `@voidfall/server-backup` só inicia a cópia dentro de uma guarda confiável injetada, publica o snapshot por staging e `rename`, e restaura apenas para um diretório novo e isolado. A implementação atual é testada em diretórios temporários e não está conectada ao agente ou ao mundo privado. O fluxo online com `save-off`/`save-on` acima continua desabilitado até existir confirmação real do console e exclusão durável compartilhada com start/stop.

### Plataforma

PostgreSQL, chaves públicas, configuração e metadata de storage têm políticas próprias. Chaves privadas de assinatura e credenciais exigem backup cifrado e procedimento de recuperação separado.

## Health checks

- `liveness`: processo responde sem dependência externa pesada;
- `readiness`: serviço pode aceitar trabalho de forma segura;
- agente: heartbeat, versão, capacidades e estado observado;
- Minecraft: processo, conclusão de boot e consulta interna quando disponível;
- worker: capacidade, lease e espaço temporário;
- storage/database: verificação mínima com timeout.

## Recuperação

Runbooks obrigatórios antes da produção:

- banco indisponível;
- agente offline;
- Minecraft travado;
- build preso/lease expirado;
- storage indisponível;
- manifesto/chave comprometido;
- rollback de release;
- restore de mundo;
- perda de sessão/chave do agente;
- disco cheio.

## Reverse proxy

O painel auto-hospedado não será exposto diretamente. O proxy aplica TLS, limites de corpo/conexão, rate limit, timeouts e proteção contra requests malformadas; WebSocket precisa de configuração explícita. O próprio serviço continua validando autenticação e payload — o proxy não substitui controles da aplicação.
