# Fase 10.1: processo e console

Status: concluída tecnicamente em isolamento em 2026-08-05.

## Resultado

Toda mutação de processo percorre o mesmo caminho: RBAC → operação durável → job → capability do agente sob o lock compartilhado → recibo. Nenhuma rota toca em processo diretamente, e nenhuma aceita caminho, executável ou texto livre de comando.

O runtime Minecraft privado **não foi conectado**. Os testes provam o lado do plano de controle; a execução real depende de configuração local confiável no host.

## O lock compartilhado passa a ser consumido

A capability `process.control` toma o `minecraft-exclusive` — **o mesmo lock que a configuração já tomava**. Antes ele existia e ninguém de processo o usava, então um start podia correr contra um apply de configuração. Agora uma operação em um servidor exclui as outras, e não apenas outra ação de processo.

## Permissão por ação

Cada ação carrega a própria permissão. Ter `server.control.start` nunca implica autoridade para parar. A operação é aceita **antes** de existir qualquer job, então uma segunda requisição é recusada antes de haver o que executar duas vezes.

## Force kill é outro fluxo, não uma flag

Rota própria, permissão própria (`server.control.force`, que nem `administrator` tem), tipo de operação próprio, tipo de job próprio e **capability própria** — ter controle comum nunca implica autoridade para matar.

Além disso ele exige:

- a parada graciosa que ele sucede, existindo e pertencendo ao mesmo servidor;
- que essa parada tenha **de fato falhado** — um kill nunca é a primeira coisa tentada;
- `acknowledgesDataLoss: true` explícito, **sem valor padrão**, porque matar um servidor pode perder tudo desde o último save.

## Console

Armazenamento append-only por sequência. O cursor é uma sequência, nunca um offset, então continua válido enquanto a retenção apaga atrás dele — e a página informa a sequência mais antiga retida, para que um leitor que ficou para trás saiba que perdeu linhas em vez de supor que está em dia.

Uma sequência **nunca é reusada**, mesmo depois de a retenção apagar todas as linhas, de modo que um cursor velho não case com outra linha.

A redação acontece **na entrada**, não na leitura: um segredo que chegasse ao armazenamento em claro sobreviveria a qualquer política de leitura posterior. Endereços, qualquer coisa que se anuncie como senha ou token, e caminhos de sistema são mascarados. O redator substitui e compara em vez de testar antes, porque uma regex global avança o próprio `lastIndex` no `test`.

Append e poda compartilham uma transação: podar em separado deixaria uma janela em que uma queda mantém um console ilimitado.

O catálogo de comandos continua fechado e é publicado pela API, para que um cliente não precise adivinhá-lo.

## Lacuna fechada da Fase 9.2

Um lease nomeava a capability mas não o tipo de job — e uma capability pode servir vários. O agente não conseguia distinguir um stop de um restart e teria que adivinhar o que lhe foi pedido. O lease passou a carregar o tipo de job, e o contrato recusa um par que aquela capability não pode servir.

## Limites mantidos

1. Nenhum contrato ou payload carrega plano de execução, executável, diretório ou comando livre.
2. Force kill nunca é alcançável passando uma flag para stop.
3. O console é limitado, redigido e retido; nada é ilimitado.
4. O runtime Minecraft privado não foi conectado.

## Riscos abertos após a Fase 10.1

- a capability existe e é testada, mas o `main.ts` do agente ainda não a instancia: ligar o processo real é operação, não código;
- a reconciliação de PID órfão usa o `reconcileStale` da Fase 9.1, que continua sem agendador;
- o timeout da requisição limita a espera, não o processo: uma operação que estoura fica observada como excedida e o processo exatamente como estava;
- o comando de console é aceito e enfileirado, mas nenhuma capability de console foi implementada ainda — só o tipo e a concessão existem;
- a captura de console acontece ao fim da operação; não há streaming contínuo enquanto o servidor roda.
