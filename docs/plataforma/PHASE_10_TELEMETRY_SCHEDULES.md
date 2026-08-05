# Fases 10.4 e 10.5: métricas, logs, alertas e agendamentos

Status: concluídas tecnicamente em isolamento em 2026-08-05.

---

## Fase 10.4 — métricas, logs e alertas

### Todo valor diz de onde veio e quanto vale

Esta plataforma mede o host, o processo e a JVM. Ela **não** consegue ver dentro de um servidor Minecraft rodando sem um provider aprovado no jogo — e TPS/MSPT são exatamente os números que um operador mais quer.

Um painel mostrando uma taxa de tick plausível que ninguém mediu seria pior do que um painel que não mostra nada. Então `unavailable` é uma leitura de primeira classe, com fonte própria (`none`) e motivo (`no-approved-provider`), e não um buraco a ser preenchido com estimativa.

Uma leitura carrega **um valor ou um motivo para não ter um**, nunca um padrão fazendo as vezes de valor. O contrato recusa "os dois" e "nenhum". O contrato recusa qualquer fonte que não seja um provider aprovado alegando ter medido tempo de tick, e o **banco recusa a mesma linha de saída** — nenhum bug de coletor e nenhum escritor futuro consegue colocar um número inventado num gráfico.

O provider no jogo **não foi conectado**: exigiria o Forge Bridge, que permanece desligado. Portanto TPS, MSPT e contagem de jogadores voltam como indisponíveis em toda requisição, com o motivo.

### Qualidade não tira média

Um bucket vale o que vale seu pior insumo. Misturar uma leitura obsoleta em cinquenta e nove medidas e chamar o resultado de medido é precisamente como um número velho é apresentado como atual.

Leituras sem valor são **descartadas**, não contadas como zero: um vazio na medição não é uma medição de nada, e a média com zeros reportaria memória saudável exatamente quando o coletor parou de funcionar.

Buckets guardam quantas amostras os formaram, então um bucket de três leituras não é lido com a mesma confiança de um de sessenta. Uma janela reportada duas vezes é **fundida** na linha existente, não inserida de novo — o que dobraria toda média lida dali.

### Alertas

Uma leitura indisponível **nunca** fecha um alerta. Um coletor que parou de funcionar é indistinguível de um disco que parou de encher, e tratar o silêncio como boa notícia é como um disco cheio passa despercebido.

Um alerta aberto por tipo por servidor, garantido por índice único parcial. Um coletor rodando a cada trinta segundos enterraria o único alerta que o operador precisava ver sob cópias dele mesmo.

Todo alerta nomeia a leitura que o levantou; sem isso o operador tem um selo vermelho e nenhuma forma de conferir se ainda é verdade.

### Logs estruturados

Mil cópias de uma exceção são um problema, e lê-las como mil é como o outro problema da mesma janela passa despercebido. O agrupamento dobra ocorrências sobre uma impressão digital estável, calculada sobre a mensagem **com as partes variáveis removidas** — identificadores, números, endereços, caminhos, carimbos de tempo. Duas ocorrências da mesma falha diferem exatamente nessas partes.

A mesma normalização **redige**, porque uma mensagem agrupada aparece numa tela e uma linha de log é um dos lugares mais prováveis para um segredo aparecer. Segredos são mascarados **antes** de os números serem colapsados; na ordem inversa, um token feito de dígitos viraria `<n>` e pareceria inofensivo.

---

## Fase 10.5 — agendamentos

### Um plano tipado, nunca um script

Os passos vêm de um catálogo fechado com parâmetros declarados: avisar jogadores, verificar manutenção, backup, restart. Nenhuma rota aceita comando, caminho ou executável — um agendador que aceitasse uma string de comando seria uma forma de rodar trabalho arbitrário num timer, que é no que um agendador se transforma se ninguém o impedir.

A **ordem carrega significado** e é validada: avisar, verificar, backup, restart. Um backup depois do restart capturaria o mundo que o restart produziu, não o que o operador queria preservar antes de mexer. Um aviso preso a nada que perturbe jogadores é ruído, e treina as pessoas a ignorar os avisos que importam.

### Fuso horário explícito e obrigatório

"Restart às 04:00" não significa nada sem fuso. Um servidor cujos operadores estão em São Paulo e cujo host roda em UTC reiniciaria no horário de pico, e o defeito só apareceria duas vezes por ano quando uma transição de horário de verão o movesse de novo.

O cálculo caminha dia a dia **no fuso alvo**, não somando blocos de 24 horas: um dia nem sempre tem 24 horas, e somar blocos fixos desloca o horário local em uma hora e o mantém deslocado.

Dois casos de transição são tratados explicitamente porque não têm resposta certa, apenas escolha certa:

- **a hora não existe** (relógio pulou por cima de 02:30) — a execução vai para o primeiro instante que existe, para que um restart noturno não seja silenciosamente pulado uma vez por ano;
- **a hora acontece duas vezes** (relógio voltou) — vale a primeira ocorrência, então a execução acontece uma vez e mais cedo.

O próximo instante é **calculado e armazenado**: o operador precisa ver quando a janela vai de fato cair antes de concordar com ela, e o instante guardado é o mesmo que o agendador vai reivindicar.

### Deduplicação, lease e recuperação

Uma execução pertence a uma **ocorrência**, identificada pelo instante para o qual foi agendada — não por quando algum agendador reparou nela. Um índice único sobre `(schedule_id, scheduled_for)` faz a deduplicação ser trabalho do banco, não da contabilidade do agendador: dois agendadores acordando juntos não podem ambos achar que ganharam.

Reivindicações **expiram**. Um agendador que morre no meio libera a sua por decurso, não por algo que teria de fazer na descida — que é justamente o que não se pode contar dele, já que morreu. Uma reivindicação vencida pode ser assumida, e a assunção é outra instrução condicional em vez de apagar-e-inserir, que deixaria uma janela em que a ocorrência não tem dono.

Ocorrências perdidas enquanto nada rodava são **reportadas, nunca executadas**: rodar a janela de ontem agora reiniciaria um servidor vivo numa hora que ninguém escolheu.

### Verificação pós-restart

Uma execução que reiniciou e reporta sucesso precisa ter visto o servidor voltar. Caso contrário, "sucesso" significa apenas que o comando foi enviado. O contrato e uma constraint de tabela exigem isso independentemente.

Uma execução **pulada** — a verificação de manutenção disse que agora não era hora — é encerrada, não é falha. É um fato que vale registrar.

---

---

## Critérios de conclusão da Fase 10

O plano fixa três critérios para a fase inteira. Onde cada um está:

**1. Toda operação passa por RBAC, job, agente, lock, auditoria e recibo.**
Vale para processo (10.1), arquivos (10.2), backup e restore (10.3). Todas atravessam permissão própria, operação durável com idempotência e regra de uma-em-voo, job enfileirado, capability do agente sob o `minecraft-exclusive`, evento de auditoria e recibo. Agendamentos (10.5) enfileiram por meio dessas mesmas operações quando o loop existir — hoje o armazenamento e a deduplicação existem e nada os aciona.

**2. Backup e restore completam um ensaio em ambiente isolado.**
Cumprido. O ensaio roda como teste (`disaster-recovery-rehearsal.test.ts`) contra diretórios temporários: perde o mundo, recupera de snapshot selado e cifrado, compara byte a byte, e ensaia perda de chave, adulteração e destino ocupado.

**3. O painel não apresenta métrica simulada como real.**
Cumprido, e por dois caminhos independentes. O painel rotula os próprios dados — "Esta tela usa fixtures locais e não representa o estado do servidor real", com a grade de indicadores anunciada como *Indicadores simulados*. E o caminho real recusa fabricar: contrato e banco rejeitam qualquer fonte que não seja um provider aprovado alegando ter medido TPS/MSPT, e a API responde `unavailable` com motivo. O painel ainda **não consome** as rotas reais; quando consumir, o que ele receber já vem com fonte e qualidade.

---

## Limites mantidos

1. Nenhum contrato, rota ou coluna carrega comando, caminho ou executável.
2. Nenhum número é inventado: o que ninguém mediu é reportado como indisponível, com motivo.
3. O provider no jogo e o Forge Bridge continuam desligados.
4. Nenhum agendador foi ligado; nenhuma janela de manutenção real executou.

## Riscos abertos após as Fases 10.4 e 10.5

- não há coletor rodando: as rotas servem o que for gravado, e nada grava ainda — ligar a coleta no agente é operação;
- a poda de retenção de buckets existe como método e não tem agendador que a chame;
- o loop do agendador em si não foi escrito: o armazenamento, a deduplicação, o lease e a recuperação existem e são testados, mas nada os aciona periodicamente;
- os passos do agendamento ainda não enfileiram as operações duráveis correspondentes das Fases 10.1 e 10.3;
- os alertas são avaliados por funções puras testadas, mas nada os avalia periodicamente nem notifica ninguém;
- `game.players.online` fica indisponível junto com TPS/MSPT, embora em princípio pudesse vir de outra fonte aprovada no futuro.
