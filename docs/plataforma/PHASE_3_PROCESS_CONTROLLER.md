# Controlador de processo da Fase 3

Status: implementado e validado localmente; integração restrita a `@voidfall/minecraft-process`.

## Objetivo do recorte

Adicionar uma camada de orquestração sobre `MinecraftProcessAdapter` para executar `start`, `stop` e `restart` de forma exclusiva, idempotente e observável. O controlador fica vinculado a um único `ProcessLaunchPlan` confiável no construtor; nenhuma requisição operacional recebe executável, argumento, diretório ou texto de console.

Este recorte termina no pacote e nos testes. Ele não cria rota HTTP, job operacional, transporte com o agente, persistência de PID nem conexão com `Servidor/workspace/`.

## Contrato implementado

| Conceito | Regra |
| --- | --- |
| Ação | somente `start`, `stop` ou `restart` |
| Chave idempotente | ASCII restrito, tamanho limitado e comparação exata |
| Plano de lançamento | validado e copiado uma vez no construtor |
| Operação ativa | no máximo uma por controlador |
| Duplicata em voo | mesma chave e ação compartilham a mesma Promise |
| Concorrência diferente | rejeitada como `controller-busy`; não entra em fila |
| Reuso conflitante | mesma chave com ação diferente é rejeitada |
| Histórico | resultados concluídos em memória, com quantidade máxima configurável |
| Timeout | limita a espera por estado observado; nunca promove para kill |
| Eventos | sequência local crescente, timestamps injetáveis e estados observados reais |

## Semântica das ações

### Start

1. observar o adaptador;
2. exigir `offline`;
3. chamar `start()` com o plano interno;
4. observar até `online`;
5. retornar `succeeded`, `timed-out` ou `failed`.

### Stop

1. observar o adaptador;
2. exigir `online`;
3. chamar `requestGracefulStop()`;
4. observar até `offline`;
5. se permanecer `stopping`, retornar timeout sem kill.

### Restart

1. observar e exigir `online`;
2. concluir o stop gracioso e confirmar `offline`;
3. somente então iniciar o novo processo;
4. confirmar `online`;
5. nunca iniciar uma segunda JVM se a parada não tiver sido confirmada.

## Resultados e falhas

Operações aceitas retornam um resultado tipado com ação, chave, outcome, observação final e eventos. Os outcomes implementados são:

- `succeeded`: estado final confirmado;
- `rejected`: precondição de estado não satisfeita;
- `timed-out`: estado esperado não apareceu dentro do limite;
- `failed`: adaptador/runtime lançou erro, sem copiar detalhes sensíveis para o resultado.

Entradas inválidas, controlador ocupado e colisão de chave são erros de requisição anteriores à aceitação. Uma rejeição por estado já aceita é lembrada e repetida para a mesma chave.

## Invariantes de segurança

- nenhuma API genérica de stdin;
- nenhum método de `kill` ou `forceKill`;
- nenhuma interpolação em shell;
- nenhuma fila operacional ilimitada;
- nenhum restart antes de observar `offline`;
- nenhuma confiança em estado desejado como se fosse estado real;
- nenhum erro bruto do sistema em eventos/resultados;
- nenhuma integração com API, banco, agente, RCON ou servidor privado neste recorte.

## Matriz de testes validada

1. start confirma `offline -> starting -> online`;
2. stop confirma `online -> stopping -> offline`;
3. restart confirma stop completo antes de um novo start;
4. duplicata em voo compartilha um único efeito;
5. duplicata concluída retorna o mesmo resultado;
6. chave reutilizada com outra ação é recusada;
7. operação concorrente diferente é recusada sem fila;
8. precondição inválida produz `rejected` sem efeito;
9. timeout permanece sem force kill;
10. erro do adaptador vira falha sanitizada;
11. histórico idempotente permanece limitado;
12. fixture Java comprova restart real somente em diretório temporário.

Os sete cenários específicos do controlador usam um adaptador falso determinístico. Um oitavo teste executa `start -> restart -> stop` contra a fixture Java 17 descartável e confirma duas inicializações de processo. Somados aos testes preexistentes do pacote, `@voidfall/minecraft-process` possui 15 testes aprovados.

## Gate de saída

Build, typecheck, os 15 testes do pacote, o gate integral de 48 testes e `npm audit --omit=dev` estão verdes localmente. O item 2 da Fase 3 só pode ser marcado como concluído após a matriz Ubuntu/Windows também passar. Persistência/reconciliação após reboot permanece um recorte posterior.
