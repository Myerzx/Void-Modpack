# Fase 9.2: transporte real Control API ↔ Server Agent

Status: concluída tecnicamente em isolamento em 2026-08-05.

## Resultado

O agente disca para o plano de controle, reserva trabalho sob lease e reporta o resultado. **Nada abre conexão para o agente**, então nenhuma porta de entrada precisa existir no host do servidor.

Esta fatia não conecta o runtime Minecraft. O handler exercitado de ponta a ponta observa um ciclo de vida e retorna; nada aqui inicia, para ou sinaliza processo.

## Três lacunas que a fase fecha

### Uma identidade podia ser retirada

`agent_credentials` guarda o histórico. A rotação **substitui em vez de editar**, então um fingerprint superado nunca mais autentica e a história continua auditável. Um índice único parcial garante exatamente uma credencial ativa por agente, e a revogação retira credencial e concessões juntas.

### Uma capacidade era anunciada, não concedida

Antes, a capacidade ficava na linha do agente — anunciar era o mesmo que estar autorizado. Agora a concessão é linha própria, revogável sem tocar na identidade. Um claim confere a **concessão** e também os tipos de job que aquela capacidade pode servir: uma capacidade concedida ainda não permite reivindicar trabalho não relacionado.

### Trabalho perdido ficava preso para sempre

`lease()` só seleciona `status = 'queued'`, então um job deixado em `running` por um agente que caiu nunca voltava. `reclaimExpiredLeases` liquida o lease expirado e:

- devolve o job à fila enquanto houver tentativa;
- falha o job de vez quando o orçamento acabou — nunca repete além do limite;
- nunca deixa job preso em `running`;
- é idempotente quando roda de novo.

## Atomicidade do claim

`claimWork` reserva o job **e** grava o lease na mesma transação. Reservar em separado deixaria uma janela em que uma queda estranha um job em `running` sem linha de lease — e o reclaim jamais o acharia, porque ele procura por leases expirados.

## Sem polling agressivo

Resposta vazia é a resposta normal de ocioso e carrega o intervalo que o agente deve esperar. Em falha o supervisor recua geometricamente até um teto, reseta quando a API responde de novo, e encerra limpo no sinal de abort. Um `bootId` novo por execução torna um restart visível ao plano de controle.

Uma capacidade sem handler é **recusada explicitamente**. Improvisar seria exatamente o executor genérico que este protocolo existe para evitar.

## Defeito encontrado pelo E2E

A rota de resultado liquidava o lease **antes** de conferir se o resultado nomeava o job que aquele lease cobre. Um resultado com job errado consumia o lease e abandonava o trabalho real. A conferência passou para dentro da mesma transação, antes de qualquer escrita, com código próprio (`lease-job-mismatch`).

## Cenários de queda comprovados

| Cenário | Comportamento provado |
| --- | --- |
| Identidade revogada | recusada mesmo com assinatura válida |
| Envelope reenviado | recusado pelo nonce de uso único |
| Agente cai com lease aberto | lease expira, job volta à fila, execução seguinte conclui |
| Orçamento de tentativas esgotado | job falha de vez, não é reexecutado |
| API fora do ar | backoff geométrico, recuperação e progresso quando volta |
| Resultado duplicado | recusado |
| Resultado com job errado | recusado antes de escrever |
| Capacidade não concedida | recusada e auditada como `denied` |

## Limites mantidos

1. O protocolo é outbound-only; nada disca para o agente.
2. Nenhum payload carrega comando, caminho, raiz ou plano de execução — só referência opaca que a capacidade resolve de configuração local confiável.
3. Não existe segunda máquina de estados: a fila de jobs continua sendo a autoridade, e o lease apenas registra quem a segura.
4. Nenhuma escrita dupla fora de transação.
5. O runtime Minecraft privado não foi conectado.

## Riscos abertos após a Fase 9.2

- nada executa `reclaimExpiredLeases` periodicamente; ele existe e é testado, mas depende de um agendador que a fase não criou;
- o despachante de outbox continua sem processo que o rode;
- a verificação de transporte segue injetada: mTLS real, rotação de certificado no host e supervisor de processo do agente continuam operação, não código;
- só `artifact.inspect`, `artifact.analyze` e `configuration.apply` têm tipos de job mapeados; `process.observe` é capacidade declarada sem trabalho reivindicável;
- o `main.ts` do agente ainda não instancia o supervisor: a fase entrega a peça e os testes, não o processo de produção.
