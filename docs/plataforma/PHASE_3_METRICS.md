# Métricas limitadas da Fase 3

Status: contrato planejado; implementação restrita a `@voidfall/minecraft-process`.

## Objetivo do recorte

Produzir um snapshot honesto de métricas básicas do host e do processo gerenciado, sempre com fonte, horário, unidade e qualidade. O recorte termina no pacote e nos testes contra provedores falsos e a fixture Java descartável. Não cria séries temporais, rota, job, transporte com agente, tela dinâmica nem conexão com `Servidor/workspace/`.

## Modelo de cada valor

Um valor disponível contém:

- `status: available`;
- valor numérico finito e não negativo;
- `unit` explícita;
- `quality: real` ou `calculated`;
- `source` fixa e revisada;
- `collectedAt` em UTC.

Um valor não disponível contém:

- `status: unavailable`;
- a mesma unidade esperada;
- `quality: unavailable`;
- fonte que explica o limite;
- horário da tentativa;
- motivo tipado, nunca `0`, `null` ambíguo ou número simulado.

## Métricas do host

| Métrica | Fonte | Qualidade | Unidade |
| --- | --- | --- | --- |
| memória total | `node:os` | real | bytes |
| memória livre | `node:os` | real | bytes |
| memória usada | diferença total - livre | calculated | bytes |
| uptime do host | `node:os` | real | seconds |
| CPUs disponíveis ao processo | `node:os.availableParallelism` | real | count |

O provedor valida números finitos, limites inteiros onde aplicável e `free <= total`. Esses dados descrevem a visão fornecida por Node/OS; não prometem representar limites de container/cgroup que a fonte não exponha.

## Métricas do processo gerenciado

O adaptador registra o instante em que o runtime confirma o spawn. Cada leitura chama `inspect()` antes de montar o snapshot e inclui separadamente o estado observado, sua fonte e seu timestamp.

| Métrica | Disponibilidade | Fonte/qualidade |
| --- | --- | --- |
| PID | `starting`, `online` ou `stopping` com handle | `process-adapter`, real |
| uptime gerenciado | enquanto o handle está ativo | `process-adapter:derived`, calculated |
| CPU da JVM | indisponível neste recorte | `portable-runtime`, unavailable |
| RSS da JVM | indisponível neste recorte | `portable-runtime`, unavailable |

Quando não há processo, PID e uptime usam motivo `not-running`, `process-error` ou `not-observed` conforme o estado. CPU/RSS nunca usam valores do processo do agente, do painel ou da máquina como substitutos da JVM.

## Dados deliberadamente ausentes

- load average, por não ter semântica equivalente no Windows;
- disco e rede, porque ainda não há raiz/iface autorizada e reconciliada;
- CPU/RSS da JVM, porque Node não fornece isso de forma portátil para o child process;
- heap, non-heap, GC e threads, que exigem JMX ou Forge Bridge;
- TPS, MSPT, chunks, entidades e jogadores, que exigem telemetria do Minecraft;
- GPU, temperatura e métricas obtidas por shell ou executáveis externos.

Adicionar qualquer uma dessas fontes exige contrato próprio, disponibilidade explícita e testes Windows/Linux. Nenhum comando do SO será montado para preencher lacunas.

## Invariantes

- snapshot somente leitura e profundamente congelado;
- uma chamada usa um único `collectedAt` para os valores gerados;
- estado mantém o `observedAt` original do adaptador;
- fonte e qualidade não são fornecidas pelo chamador externo;
- relógio inválido ou regressivo é recusado;
- amostra do host inválida é recusada, não normalizada silenciosamente;
- ausência nunca aparece como zero;
- nenhuma leitura acessa mundo, logs, configs, JAR ou diretório privado;
- nenhuma integração com API, banco, agente ou painel neste recorte.

## Matriz de testes planejada

1. provedor Node retorna memória, uptime e CPUs com valores válidos;
2. amostra determinística preserva fonte, unidade, horário e qualidade;
3. memória usada é calculada sem produzir valor negativo;
4. NaN, infinito, negativos, CPUs fracionárias e `free > total` são recusados;
5. estado offline produz métricas de processo indisponíveis, não zero;
6. processo ativo expõe PID e uptime calculado;
7. CPU/RSS permanecem indisponíveis mesmo com processo ativo;
8. relógio anterior ao spawn é recusado;
9. fixture Java comprova transição `not-running -> available -> not-running`;
10. snapshot não expõe comando, path, ambiente, stdout ou dado privado.

## Gate de saída

O item 4 da Fase 3 só pode ser concluído após build, typecheck, gate integral, auditoria de runtime e matriz Ubuntu/Windows verdes. Persistência, agregação, alertas e exibição no painel permanecem recortes posteriores.
