# Fase 11.0: gate de entrada operacional

Status: concluído em 2026-08-05. Nenhuma conexão com Minecraft real, `Launcher/workspace/**` ou `Servidor/workspace/**`.

---

## Parte 1 — auditoria de saída da Fase 10

### 1. Capability de console

**Implementada.** `apps/server-agent/src/console-operation.ts` exporta `createConsoleCommandHandler`, com quatro testes em `console-operation.test.ts`. Ela resolve o comando revisado a partir da operação durável — nunca da rede —, despacha sob o `minecraft-exclusive` e recusa lease de outro servidor ou de outro tipo de job.

A rota não precisou ser desativada. O que **estava** faltando era a instanciação, e é isso que esta fatia resolve: a capability só é anunciada quando existe um adaptador de console *e* um controlador de processo. Sem eles a readiness responde `no-console-adapter-configured` ou `no-process-controller-configured`, o supervisor não a anuncia, e **nenhum job de console pode ser reivindicado** — que é a forma correta de "nenhum job impossível de executar é aceito": não pela rota recusar depois, mas pelo agente nunca pedir.

### 2. Reconciliação de PID órfão

**Existia sem dono.** `ProcessStateRepository.reconcileStale` estava implementado desde a Fase 9.1 e nada o chamava.

Agora tem dono explícito: `AgentRuntime.reconcileOrphanProcessStates()`, executado **no startup, antes de qualquer coisa ser servida**, e depois a cada 60 segundos. O corte é 120 segundos sem observação.

O startup importa tanto quanto o período: a execução anterior deste mesmo agente pode ter morrido deixando um estado que diz "online" com um PID que não existe mais. Servir a primeira requisição contra esse estado seria agir sobre uma informação que o agente já sabe ser falsa.

### 3. Capabilities: no código, registradas e desligadas

| Capability | Handler no código | Registrada no runtime | Situação |
| --- | --- | --- | --- |
| `configuration.apply` | `createConfigurationApplyHandler` (adaptador da classe) | só com raiz **e** guard | serviçável com guard injetado |
| `process.control` | `createProcessControlHandler` | só com controlador | **sem controlador nesta fatia** |
| `console.command` | `createConsoleCommandHandler` | só com adaptador + controlador | **sem adaptador nesta fatia** |
| `backup.create` | `createBackupHandler` | só com repositório + selo | serviçável com config temporária |
| `backup.restore` | `createRestoreHandler` | só com repositório + controlador | **sem controlador nesta fatia** |
| `heartbeat` | — | nunca | servida pelo cliente de identidade, não por lease |
| `artifact.inspect` | — | nunca | pertence ao build worker |
| `artifact.analyze` | — | nunca | pertence ao build worker |
| `process.observe` | — | nunca | sem handler; observação viaja no recibo do controle |
| `process.force-kill` | **nenhum** | nunca | **deliberadamente desligada** |

**Correção de uma afirmação anterior.** O documento da Fase 10.1 dizia que force kill tinha "capability própria" e listava como risco apenas que o `main.ts` não a instanciava. Isso estava errado: a capability existe no contrato, no tipo de operação, no tipo de job e na rota — mas **nunca houve handler no agente**. Não era falta de instanciação, era falta de implementação.

Ela permanece deliberadamente desligada, e a readiness a distingue das demais: `deliberately-disabled`, não `no-handler-implemented`. Matar um servidor pode perder tudo desde o último save; implementar isso antes de o runtime real estar conectado seria construir o gatilho antes de existir a arma.

### 4. `git status` final

Limpo quanto à Fase 10. Nada ficou fora dos commits — a única sujeira era `graphify-out/`, regenerado pelo hook de commit e commitado junto.

---

## Parte 2 — a primeira fatia da Fase 11

### Registro por injeção explícita

`AgentRuntime` recebe tudo: configuração, repositórios, boot id, controlador, adaptador, guard de backup, executor de agendamento e relógio. Não constrói relógio, controlador nem banco próprios.

Isso é o que permite subir o agente inteiro em teste contra diretórios temporários — e é por isso que esses testes provam algo sobre o caminho real de startup, e não sobre um caminho paralelo escrito para eles.

O `main.ts` faz o mínimo que um entry point pode fazer: lê o ambiente, valida, constrói e entrega um sinal.

### Validação de configuração no startup

Toda a configuração vem do ambiente, nunca do plano de controle. Um agente que recebesse raiz de repositório, chaves ou diretórios de origem pela rede seria um movedor de arquivos por controle remoto.

A distinção que a validação preserva:

- **ausente** desliga uma capability — é uma escolha do operador;
- **malformado** recusa o startup — é um erro.

Tratar um erro de digitação como escolha é como uma capability some silenciosamente de uma instalação. Por isso um grupo meio configurado (raiz de arquivos sem raiz de revisões, backup sem chave de selo) **recusa subir** em vez de subir sem aquela capability.

Todos os problemas são coletados numa passagem só: quem conserta uma instalação deve ver tudo que está errado de uma vez, não descobrir o próximo defeito no próximo restart.

A mensagem de erro nomeia a variável e o código do defeito, **nunca o valor** — um log de startup é o último lugar onde uma chave privada deve aparecer. Há teste para isso.

Chaves chegam em base64 pelo ambiente, não como caminho para um arquivo no repositório: não existe arquivo que um commit descuidado possa adicionar.

### Readiness por capability

Uma capability é anunciada **apenas quando todas as suas dependências existem**. O supervisor reivindica trabalho exatamente para o que anuncia, então anunciar algo cujo repositório ou controlador falta significa reivindicar um job que só pode falhar — e um job que falha por um motivo que o agente já conhecia é um job que nunca deveria ter sido entregue.

O mapa de handlers é **derivado** da readiness, não montado ao lado dela. Manter duas listas em sincronia à mão é como um agente acaba reivindicando trabalho que não sabe servir.

Toda capability indisponível carrega um motivo. "Indisponível" sem causa é indistinguível de um defeito, e o operador não tem o que fazer com isso.

Um caso vale destacar: `backup.restore` exige controlador **mesmo tendo repositório**, porque restaurar materializa um mundo e depois o inicia para verificar. Sem controlador a verificação não roda, e uma restauração não verificada é uma que ninguém sabe o resultado. Melhor indisponível do que anunciada numa forma que sempre termina em "não verificado".

### Raízes, repositório e chaves

Somente diretórios temporários. As raízes autorizadas, o repositório de backup, a área isolada de restauração e o mundo de origem são todos criados por `mkdtemp` nos testes; nenhuma configuração aponta para diretório real. As chaves são injetadas pelo ambiente e nunca versionadas.

### Coletores

Ligados: memória do host, disco do host, load, e o processo observado quando existe. O que não é mensurável é reportado como indisponível **com motivo**, nunca omitido — um gráfico não distingue "sem dado" de "zero", e só um dos dois significa que está tudo bem.

- `host.load.1m` no Windows: o sistema reporta zero em vez de uma média. Zero como "medido" seria uma linha reta saudável que não significa nada, então vira `collector-failed`.
- Processo com servidor parado: `server-offline`, que é um fato sobre o servidor, não uma falha do coletor.
- JVM: `not-collected`. Ler a JVM de outro processo exige instrumentação que este agente não anexa, e derivar heap do RSS seria inventar.
- **TPS, MSPT e jogadores online: `no-approved-provider`, toda vez.** Continuam indisponíveis enquanto não houver provider real.

Um coletor nunca lança. Derrubar o loop inteiro porque uma chamada de sistema de arquivos falhou seria pior do que reportar aquela leitura como indisponível.

### Loop do agendador

- **Lease:** renovado a cada passo, então um backup longo não parece abandonado enquanto trabalha.
- **Deduplicação:** pelo índice único `(schedule_id, scheduled_for)`. Dois agentes acordando juntos não podem ambos achar que ganharam.
- **Recuperação após queda:** execuções cujo lease venceu são **encerradas como falha**, não retomadas. Uma execução que morreu num passo desconhecido pode tê-lo meio aplicado, e retomar de um índice que o processo morto nunca confirmou é como um restart roda o mesmo restart duas vezes.
- **Janelas perdidas:** registradas como puladas, nunca executadas. Rodar a janela de ontem agora reiniciaria um servidor vivo numa hora que ninguém escolheu.
- **Encerramento limpo:** execuções ainda em mãos são encerradas como `agent-shutdown` em vez de segurarem o lease até vencer. É a diferença entre um restart que retoma em segundos e um que espera quinze minutos.

Se o lease for tomado no meio da execução, o loop **para** em vez de continuar agindo sobre algo que não possui mais.

---

## Parte 3 — o laço de trabalho conectado

A Fase 11.0 fechou com o supervisor existindo e nada o ligando ao transporte. Esta parte liga.

### Anunciado e registrado deixam de divergir

`configuration.apply` era o único caso em que o runtime anunciava uma capability sem registrar handler para ela: a implementação era uma classe que fala comandos, e o supervisor fala leases. O agente teria reivindicado um job de configuração e depois o recusado como `unsupported-parameters` — exatamente o resultado que a readiness existe para evitar.

`createConfigurationApplyHandler` é o adaptador. Ele lê o comando **do job durável**, nunca do lease, do mesmo jeito que o console lê seu literal revisado. O lease nomeia um job e um servidor; os valores revisados foram gravados quando o pedido de um operador autorizado foi aceito, e é esse registro que se aplica. Nada que chegue na resposta do claim seleciona arquivo, raiz ou valor.

O tipo do job é reconferido contra o lease, e a operação armazenada contra o tipo do job. Os três são escritos em momentos diferentes; aplicar um comando cujo job discorda do lease que o entregou seria confiar em qualquer um dos dois que tivesse sido lido por último.

O teste que garante isso passou a exigir **igualdade nos dois sentidos** entre anunciado e registrado, não mais contenção com uma exceção documentada.

### `configuration.apply` exige guard

Reescrever um arquivo de configuração que um servidor vivo mantém aberto é como um mundo volta com metade de uma configuração. A capability agora só é anunciada quando existe o guard de acesso exclusivo offline — simétrico ao que os backups já exigiam — e a readiness distingue três defeitos porque são três consertos diferentes: `no-authorized-root-configured`, `no-configuration-guard-configured`, `no-reviewed-resource-authorized`.

Como esta fatia não constrói guard nenhum, `configuration.apply` fica indisponível em produção **com motivo**, em vez de anunciada sem handler.

### Um processo, um boot id

O supervisor recebe o boot id do runtime em vez de gerar o seu. Um recibo cujo boot id não batesse com o estado de processo e com as linhas de console da mesma execução não correlacionaria com nada.

### Não reivindicar é um estado com nome

O supervisor só é construído quando há identidade, transporte **e** pelo menos um handler. Quando não há, o startup registra `work-loop-skipped` com o motivo (`no-transport-configured` ou `no-capability-handler`): um agente que silenciosamente nunca disca é indistinguível de um cujo plano de controle sumiu, e só um dos dois é algo que o operador pode consertar.

Os dois laços — agendador e trabalho — tomam o mesmo `AbortSignal`, então um desligamento para o agente inteiro em vez de deixar um laço reivindicando jobs que o outro não pode mais liquidar.

### Chave de assinatura validada no startup

A PEM passou a ser lida e conferida como Ed25519 pelo carregador de configuração (`not-an-ed25519-private-key`). Uma chave RSA carrega bem e depois não assina nada que este protocolo aceite; descobrir isso no startup é melhor do que descobrir no primeiro claim recusado, cuja resposta não nomeia nada disso.

O `keyId` é uma impressão digital da chave pública, não uma variável. Não há mais uma variável para errar, e rotacionar a chave muda o identificador por construção — um id que o operador define à mão é um id que pode sobreviver à chave que ele nomeia.

---

## Parte 4 — agendamento durável, alertas e retenção

### O agendador deixa de ser inerte

`schedulerEnabled=true` sem executor injetado construía **nenhum** loop: as janelas simplesmente nunca eram reivindicadas, o que é indistinguível de um agendador sem nada vencido. Agora um agendador habilitado sempre recebe executor — o injetado, ou `createDurableScheduleExecutor`.

O executor não faz o trabalho. Ele enfileira **a mesma operação durável** que a API de controle enfileiraria se um operador pedisse, e espera ela liquidar. O lock exclusivo, a idempotência, a regra de um-em-voo e o recibo já existem naquele caminho; um agendador que passasse por fora seria um segundo jeito de iniciar um servidor sem nenhuma dessas propriedades.

A espera é o ponto. Reportar o passo como concluído no instante em que o job foi enfileirado registraria "o restart noturno terminou" para um restart que ainda nem foi tentado, e `postRestartVerified` estaria afirmando um boot que ninguém observou.

O identificador do que se enfileira vem do run **e da posição do passo** — daí `stepIndex` no contrato do executor. Derivado só do run, dois passos de backup no mesmo agendamento colidiriam num nome; aleatório, um replay honesto viraria um segundo snapshot.

Quando a operação não liquida dentro da janela, o passo falha como `operation-did-not-settle`, nunca como um dos dois desfechos. A operação continua lá fora; o que o run registra é que ninguém a viu terminar, que é a única coisa efetivamente sabida.

### Dois passos recusados, com nome

- **`warn-players`:** o catálogo revisado de console tem `list-players` e `save-all` e nada que fale com jogadores. Quem escreveu o agendamento pediu um aviso antes da interrupção; rodar a interrupção sem ele não é o agendamento que essa pessoa escreveu. Falha com `no-approved-broadcast-command`.
- **`maintenance-check`:** jogadores online continua `no-approved-provider`. Uma guarda que não pode ser avaliada não é uma guarda que passou, e tratá-la assim reiniciaria um servidor povoado. Falha com `no-approved-player-provider`.

Ambos param o run em vez de o deixarem seguir. E uma operação já em voo faz o passo ceder (`operation-in-flight`) em vez de a pré-emptar: um restart agendado que passasse por cima do restore de um operador seria o agendamento causando dano num timer.

### Alertas com dono

`evaluateAlerts` e `reconcileAlerts` eram funções puras que nada acionava. Agora rodam **na mesma amostra** que vira métrica — avaliar contra uma segunda amostra levantaria um alerta nomeando um número que não é o número armazenado, e quem fosse conferir a métrica encontraria outra.

O agente decide três dos cinco tipos: `disk.low`, `memory.low` e `server.crashed`. Os outros dois não são dele:

- `agent.offline` — um agente que parou de reportar não pode avaliar a própria ausência, e um rodando limparia o alerta todo ciclo;
- `job.failed` — conta falhas que ninguém reconheceu, e o reconhecimento acontece no painel; daqui a contagem só cresce, então o alerta abriria uma vez e nunca seria resolvível.

Candidatos **e** alertas abertos são filtrados pelo mesmo conjunto. Passar todos os abertos produzindo só alguns tipos de candidato resolveria alertas do plano de controle na força de este agente não ter olhado para eles.

`server.crashed` só sai de um estado não obsoleto: um estado que ninguém observou é evidência sobre o observador, não sobre o servidor.

### Retenção com quem a acione

`pruneRetention()` roda de hora em hora além de após cada backup. Um repositório que parou de crescer continua com expirações vencendo; um agente que só podasse quando algo novo chegasse guardaria para sempre os últimos snapshots de um servidor parado. Métricas e backups são podados independentemente — um erro de disco num não é motivo para parar de aparar o outro.

---

## Limites mantidos

1. Nenhum processo Minecraft é iniciado; controlador e adaptador de console não são construídos.
2. `Launcher/workspace/**` e `Servidor/workspace/**` não foram lidos, escritos nem referenciados.
3. Toda raiz e todo repositório em teste são diretórios temporários.
4. Chaves vêm do ambiente em base64; nenhuma está no Git.
5. Force kill continua sem implementação, por decisão registrada.

## Riscos restantes

- **nenhum guard de acesso exclusivo offline é construído**, então em produção o agente sobe anunciando **nada** e registra `work-loop-skipped: no-capability-handler`. O laço de trabalho está ligado; o que falta é a primeira capability com dependências reais, e todo guard real depende do controlador de processo;
- pelo mesmo motivo, o executor de agendamento enfileira operações que **nenhuma capability anunciada pode servir** nesta fatia: o passo espera e termina em `operation-did-not-settle`. Enfileirar e esperar está correto; o que falta do outro lado é `process.control`;
- `warn-players` e `maintenance-check` continuam sem provider aprovado e recusam por decisão registrada, não por defeito;
- não há endpoint HTTP de readiness; ela é calculada e registrada no log de startup;
- `agent.offline` e `job.failed` continuam sem quem os avalie: pertencem ao plano de controle, e nada lá os aciona ainda;
- o agente não envia heartbeat: `main.ts` constrói o transporte de trabalho, não o cliente de identidade.
