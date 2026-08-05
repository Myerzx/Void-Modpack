# Fase 9.1: contratos operacionais e persistência

Status: concluída tecnicamente em isolamento em 2026-08-05; gate local aprovado e [matriz Windows/Linux 30989284065](https://github.com/Myerzx/Void-Modpack/actions/runs/30989284065) aprovada nos dois sistemas.

## Resultado

Até aqui uma operação vivia na memória de um adaptador: o histórico idempotente, a exclusão mútua e o PID observado morriam junto com o processo. A Fase 9.1 dá memória durável a esses mesmos fatos.

Nenhuma coluna, rota ou contrato desta fatia carrega plano de execução, caminho, diretório de trabalho ou texto de comando. Uma operação é nomeada por um *kind* revisado; um recibo relata o que foi observado, nunca como foi produzido.

**Esta fatia não executa nada.** Ela dá memória ao núcleo operacional; o transporte que de fato roda uma operação é da Fase 9.2.

## Três propriedades que sobrevivem a um restart

### Idempotência

A chave é única na tabela e vem acompanhada de um **fingerprint dos campos estáveis** do pedido:

- mesma chave, mesmo fingerprint → replay honesto, devolve a operação original;
- mesma chave, fingerprint diferente → `idempotency-conflict`, nunca uma segunda execução.

Nada volátil entra no fingerprint. Um timestamp, um identificador gerado ou um nonce fariam um replay honesto parecer um pedido diferente e o transformariam em conflito — exatamente a falha que o fingerprint existe para evitar.

### Exclusão mútua

```sql
CREATE UNIQUE INDEX server_operations_in_flight_idx
  ON server_operations (server_instance_id)
  WHERE status IN ('accepted', 'running');
```

Um índice único parcial permite **no máximo uma operação em voo por servidor**. O banco é o árbitro, não uma leitura anterior: duas chamadas concorrentes não conseguem ambas colocar o servidor em operação, e a garantia sobrevive à queda da API ou do agente.

### Estado observado e PID

`server_process_states` guarda o ciclo de vida, o PID e o `boot_id` que o identifica. Um PID só significa alguma coisa junto do boot a que pertence — sem isso, depois de um restart, um PID antigo poderia ser confundido com um processo vivo.

A reconciliação é deliberadamente pessimista: uma observação que ninguém está mais acompanhando vira `unknown` e perde o PID. O processo pode muito bem continuar rodando; dizer **desconhecido** é a única resposta honesta até um agente olhar de novo.

## Outbox sem dual write

O evento é escrito **na mesma transação** da mudança de estado que ele descreve. Não existe dual write: um evento não pode descrever um estado que nunca comitou, e um estado comitado não perde seu evento.

A entrega é marcada em separado, depois de acontecer — logo a garantia é **at-least-once** e o consumidor precisa tolerar repetição, que é o motivo de todo evento carregar um `eventId` estável. Marcar como publicado antes de entregar seria a única forma de perder um evento em silêncio.

Um teste prova o contrário do caminho feliz: quando a mudança de estado falha, a contagem de eventos pendentes não muda.

## Correlação

Um `correlationId` atravessa operação, job durável e cadeia de auditoria. `GET /api/v1/correlations/:correlationId` devolve os três de uma vez, para que um operador siga um pedido inteiro em vez de deduzir por timestamps. A rota expõe eventos de auditoria, então fica atrás de `audit.view`, não de `server.view`.

## Paginação e limites

Toda listagem administrativa é limitada e filtrável. O limite é validado na rota **e** novamente no repositório, de modo que nenhum chamador — inclusive um futuro chamador interno — consiga pedir varredura ilimitada da cadeia de auditoria.

Um limite acima do máximo é **recusado com 400**, não silenciosamente reduzido: um pedido que o chamador não pode ter é melhor negado do que atendido por outra coisa.

## Catálogo de mods persistido

`mod-catalog` era um domínio puro: uma reconciliação podia ser calculada mas nunca lembrada, então cada restart perdia a revisão humana que a produziu. A entrada revisada agora é guardada inteira e validada contra o contrato público; as colunas ao lado existem para indexar e impor concorrência, nunca para virar uma segunda fonte de verdade.

Toda mudança nomeia ator e motivo, sobre a versão que o chamador leu — uma classificação decidida contra uma entrada obsoleta perde em vez de sobrescrever uma revisão mais nova. E a identidade de conteúdo é única por servidor, então os mesmos bytes não podem ser catalogados sob dois identificadores lógicos.

## Três defeitos encontrados e corrigidos

1. **Paginação nunca funcionou por query string.** A API roda o validador com `coerceTypes: false`, então um `limit=1` chegava como string e falhava contra `Type.Integer`. A rota de artefatos da Fase 8.3 tinha o mesmo defeito latente — nenhum teste passava `limit` por query. Agora o parâmetro é declarado como dígitos e convertido explicitamente, com regressão nas duas rotas.
2. **Uma edição por script removeu métodos do `AuditRepository`.** Um marcador de fim de bloco casou com a chave de fechamento da classe e levou junto `listChain`, `verifyPartition`, `exportPartition` e `#lastSequence`. Os testes com `tsx` não pegaram porque `tsx` não typecheca; `tsc --noEmit` pegou. Os métodos foram restaurados do HEAD e o diff conferido linha a linha.
3. **A tabela do catálogo nasceu morta.** A migration criou `mod_catalog_entries` e o checkbox "persistir catálogos" foi marcado, mas nenhum código TypeScript referenciava a tabela — o catálogo continuava só em memória. O `ModCatalogRepository` foi implementado com concorrência otimista, identidade de conteúdo única e paginação, e o checkbox passou a ser verdadeiro. Um export morto, `AdministrativePageQuerySchema`, também foi removido: ele declarava inteiros que jamais casariam com uma query string nesta API e enganaria o próximo chamador.

## Limites mantidos

1. Nenhuma rota desta fatia muta estado operacional; ela só lê.
2. Nenhum contrato, coluna ou resposta carrega caminho, plano de execução ou texto de comando.
3. O runtime Minecraft privado não foi conectado.
4. O PID é registrado para reconciliação; nada no plano de controle o sinaliza.

## Riscos abertos após a Fase 9.1

- a reconciliação de estado obsoleto é uma varredura por corte de tempo e precisa de um agendador; nada a executa periodicamente ainda;
- o despachante de outbox existe como repositório (claim/lease/mark), mas nenhum processo o roda: os eventos acumulam até a Fase 9.2 dar-lhes destino;
- `server_operations` não está ligada aos adaptadores de processo; a Fase 9.2 é quem faz uma operação aceita virar trabalho real;
- o lock `operational_locks` continua compartilhável mas ainda só é consumido pela configuração;
- o catálogo revisado é persistido pelo repositório, mas o pacote puro `mod-catalog` ainda calcula reconciliação sem ler ou escrever essa tabela; ligar os dois é trabalho da fase que der operação ao catálogo;
- a lista de auditoria pagina por `offset`, o que fica caro em partições muito grandes; um cursor por sequência é o próximo passo natural.
