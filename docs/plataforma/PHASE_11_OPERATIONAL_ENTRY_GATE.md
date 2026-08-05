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
| `configuration.apply` | `ConfigurationOperationCapability` (classe, não lease handler) | anunciada com raiz configurada | serviçável |
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

## Limites mantidos

1. Nenhum processo Minecraft é iniciado; controlador e adaptador de console não são construídos.
2. `Launcher/workspace/**` e `Servidor/workspace/**` não foram lidos, escritos nem referenciados.
3. Toda raiz e todo repositório em teste são diretórios temporários.
4. Chaves vêm do ambiente em base64; nenhuma está no Git.
5. Force kill continua sem implementação, por decisão registrada.

## Riscos restantes

- o supervisor existe e o runtime produz seu mapa de handlers, mas **nada conecta o supervisor ao transporte** ainda: `main.ts` sobe o runtime, a reconciliação, os coletores e o agendador, e não roda o laço de claim;
- `configuration.apply` é anunciada quando há raiz configurada, mas sua implementação é uma classe e não um `LeaseHandler` — falta um adaptador para ela entrar no mapa;
- o executor de passos do agendamento é injetado e não tem implementação padrão: um agendamento com `backup` ou `restart` não enfileira as operações duráveis das Fases 10.1 e 10.3;
- não há endpoint HTTP de readiness; ela é calculada e registrada no log de startup;
- a poda de retenção de métricas e de backups continua sem quem a chame periodicamente;
- alertas continuam avaliáveis por funções puras que nada aciona.
