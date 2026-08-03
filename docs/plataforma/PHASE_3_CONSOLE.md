# Console limitado da Fase 3

Status: implementado e validado localmente; integração restrita a `@voidfall/minecraft-process`.

## Objetivo do recorte

Adicionar uma visão de leitura limitada da saída capturada e um catálogo mínimo de comandos Minecraft sem criar terminal genérico. O recorte termina no runtime, adaptadores e testes contra a fixture Java descartável. Não cria rota, job, transporte com o agente, auditoria persistente, RCON ou conexão com `Servidor/workspace/`.

## Separação de responsabilidades

| Camada | Responsabilidade |
| --- | --- |
| `console.ts` | IDs permitidos, mapeamento para literais fixos e transformação segura da saída |
| `runtime.ts` | handle aceita somente um ID tipado, nunca texto de stdin |
| `node-runtime.ts` | escreve o literal interno correspondente e mantém `stop\n` separado |
| `adapter.ts` | exige estado `online`, impede efeitos concorrentes e emite recibo de despacho |
| fixture/testes | comprovam os literais, limites, estado e ausência de console genérico |

## Leitura do console

A fonte continua sendo a cauda em memória de `ProcessOutputSnapshot`; nenhum arquivo de log é aberto. A visão de console:

- separa stdout e stderr;
- normaliza quebras de linha;
- remove ANSI e caracteres de controle não imprimíveis;
- limita a quantidade de linhas por stream;
- limita caracteres por linha sem quebrar pares Unicode;
- informa truncamento herdado do limite em bytes, descarte de linhas e corte de linha;
- usa limites definidos na configuração confiável do adaptador;
- retorna arrays e objetos congelados.

A leitura é um snapshot, não um stream com cursor e não promete correlação entre um comando e uma linha de resposta. Redação de chat, IP, coordenadas e segredos continua obrigatória antes de qualquer exposição por API.

## Catálogo inicial de comandos

| ID público interno | Literal privado | Motivo |
| --- | --- | --- |
| `list-players` | `list\n` | consulta sem argumentos e sem mutação |
| `save-all` | `save-all flush\n` | base explícita para consistência de backup futuro |

O chamador fornece apenas o ID. O runtime valida novamente o valor em execução antes de escolher o literal. `stop` não pertence ao catálogo: permanece acessível somente por `requestGracefulStop()` e pelo controlador de ciclo de vida.

Não entram neste recorte comandos com texto ou alvo variável, incluindo `say`, `tellraw`, `execute`, `kick`, `ban`, `op`, `deop`, `whitelist add/remove`, `reload` e comandos de mods.

## Semântica de despacho

1. validar o ID permitido no adaptador;
2. adquirir exclusão imediata para o efeito;
3. observar o adaptador e exigir `online` com um handle ativo;
4. revalidar o ID no runtime;
5. escrever exatamente um literal terminado por LF;
6. retornar um recibo de despacho, sem afirmar que o servidor processou o comando;
7. liberar a exclusão.

Start, stop e comando não podem executar seus efeitos simultaneamente no mesmo adaptador. Uma segunda operação é rejeitada; não existe fila. Leitura e inspeção permanecem sem efeito e podem ocorrer durante observação.

## Invariantes de segurança

- nenhuma função pública aceita texto de comando;
- nenhum argumento, jogador, seletor, caminho ou fragmento JSON é aceito;
- nenhum `write`, `send`, `stdin` ou `execute(string)` genérico é exposto;
- todos os literais são constantes versionadas no pacote;
- `stop` não pode ser despachado pelo catálogo;
- comando exige estado observado `online`;
- falha de escrita não é convertida em sucesso;
- não existe retry automático, fila, kill, RCON ou shell;
- idempotência durável e auditoria são gates obrigatórios antes de integração externa.

## Matriz de testes validada

1. catálogo aceita somente os dois IDs conhecidos;
2. cada ID produz exatamente o literal esperado com um único LF;
3. valor desconhecido, CR/LF e texto arbitrário são recusados em runtime;
4. snapshot remove ANSI/controles e preserva Unicode válido;
5. snapshot limita linhas e caracteres, sinalizando truncamento;
6. comando é recusado fora de `online` e sem efeito;
7. efeitos concorrentes são recusados sem fila;
8. fixture Java responde a `list` e `save-all flush`;
9. parada graciosa continua usando somente `stop`;
10. interfaces continuam sem kill, force kill ou stdin genérico.

Cinco testes novos cobrem esses cenários: três validam catálogo, sanitização e limites; um usa handle/runtime falsos para estado e concorrência; um executa os dois comandos contra a fixture Java 17. Somados aos testes anteriores, o pacote possui 20 testes e o monorepo possui 53 testes aprovados localmente.

## Gate de saída

Build, typecheck, os 20 testes do pacote, o gate integral de 53 testes e `npm audit --omit=dev` estão verdes localmente. O item 3 da Fase 3 só pode ser concluído após a matriz Ubuntu/Windows também passar. Integração com controlador externo, API, agente, banco, UI e servidor privado permanece bloqueada.
