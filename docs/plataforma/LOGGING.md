# Logs, auditoria e métricas

## Princípios

- log operacional explica o que o sistema observou;
- auditoria prova quem solicitou uma ação e seu resultado;
- métrica mede comportamento ao longo do tempo;
- nenhum dos três armazena segredo;
- hipótese de causa é marcada como hipótese, nunca como solução confirmada.

## Logs estruturados

Aplicações TypeScript emitem JSON com:

`timestamp`, `level`, `service`, `environment`, `event`, `message`, `correlationId`, `jobId`, `serverInstanceId`, `buildId`, `durationMs`, `errorCode` e metadados redigidos.

Níveis: `debug`, `info`, `warn`, `error`, `critical`. `debug` fica desabilitado por padrão em produção ou usa amostragem.

Categorias:

- servidor/startup/shutdown;
- console, loader, mods, rede e mundo;
- build, launcher e artifacts;
- backup/restore;
- autenticação, autorização e segurança;
- painel, API, agente, worker e banco;
- schedules e jobs.

## Console Minecraft

O agente lê stdout/stderr do processo sem transformar cada linha em comando. O painel recebe stream autenticado com cursor. “Limpar” remove somente o buffer visual; o arquivo original segue a retenção configurada.

Comandos enviados geram auditoria separada com usuário, comando redigido quando necessário, instância, horário e resultado. Segredos nunca devem ser enviados pelo console do painel.

## Agrupamento de erros

Fingerprint normalizado por serviço, error code, tipo da exceção e frames estáveis. Valores voláteis como UUID, horário e coordenadas são removidos antes do hash.

Cada grupo informa primeira/última ocorrência, contagem, versão, estágio, mod possivelmente relacionado e status `new`, `investigating`, `resolved` ou `ignored`. Relação com mod é `confirmed`, `suspected` ou `unknown`.

## Atividade de jogadores

Quando a ponte/mod fornecer com base legal e política aprovada:

- login/logout, chat, comandos, teleporte, morte, kick e ban;
- mudança de gamemode, permissão e dimensão;
- coordenadas do mundo e ações administrativas.

UUID é a identidade. Coordenadas são localização virtual. Chat e coordenadas têm acesso e retenção restritos; não entram no pacote, build ou logs públicos.

## Auditoria

Eventos administrativos são append-only e incluem ator, ação, recurso, antes/depois redigidos, motivo, resultado, IP administrativo quando apropriado e correlação.

Eventos mínimos: login, acesso negado, start/stop/restart/force kill, comando, arquivo, mod, configuração, jogador, permissão, backup/restore, build/publish/rollback e usuário/papel.

Para detectar adulteração, cada evento poderá encadear hash do evento anterior por partição e ser exportado periodicamente para storage imutável. Isso não substitui controle de acesso ao banco.

## Métricas reais

| Métrica | Fonte primária | Qualidade |
| --- | --- | --- |
| CPU/RAM/disco/rede do host | API do SO/cgroup | real |
| CPU/RAM/threads do Java | processo observado pelo agente | real |
| heap/non-heap/GC | JMX ou bridge JVM | real |
| TPS/MSPT/entidades/chunks | Forge Bridge/mod de telemetria | real |
| jogadores/ping | servidor/bridge | real quando disponível |
| espaço de storage | backend de storage | real |
| progresso do build | eventos do worker | calculado a partir de etapas reais |
| GPU | driver oficial/ferramenta disponível | real ou unavailable |

Cada amostra inclui `source`, `collectedAt`, `unit` e `quality`: `real`, `calculated`, `estimated` ou `unavailable`. Estimativa nunca aparece com o mesmo tratamento visual de valor real.

## Retenção inicial a confirmar

- console e logs detalhados: retenção curta configurável;
- índices e grupos de erro: retenção média;
- auditoria administrativa: retenção longa;
- chat/coordenadas/IP: mínima necessária e acesso restrito;
- métricas de alta resolução: curta, com agregações posteriores;
- logs frios: object storage com expiração.

Prazos exatos dependem da finalidade, volume, política de privacidade e legislação aplicável; permanecem pergunta aberta.
