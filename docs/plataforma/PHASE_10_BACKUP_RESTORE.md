# Fase 10.3: backups e restore

Status: concluída tecnicamente em isolamento em 2026-08-05.

## Backend escolhido: repositório local no host do agente

O repositório de bytes fica no host do agente, como configuração local confiável — o mesmo lugar de onde já vêm plano de execução e diretórios. Um backend de objeto **não** foi ligado: exigiria credencial e endpoint atravessando o plano de controle, que é exatamente o que nenhum contrato desta plataforma carrega.

O que o plano de controle guarda é o **catálogo**: quais backups foram pedidos, quais concluíram, o tamanho, e quais chaves selaram e cifraram cada um — por identificador. Nenhuma linha guarda caminho, endpoint ou material de chave.

## Integridade autenticada, não apenas hash

Um manifesto cheio de SHA-256 detecta corrupção e nada além disso. Ele **atesta a si mesmo**: quem consegue escrever no repositório reescreve o payload *e* o digest, e toda checagem continua passando.

O selo é um HMAC-SHA256 sobre os bytes do manifesto, com chave que nunca vive no repositório. O atacante continua conseguindo produzir bytes consistentes, mas não uma afirmação válida. Existe um teste que executa exatamente essa reescrita coordenada e prova que ela é recusada.

A chave de selo é **obrigatória**, o que quebrou toda construção existente de propósito: um repositório sem ela guarda manifestos que não valem nada.

Verificação confere o selo **primeiro** e o payload depois. Um manifesto adulterado é recusado antes de qualquer byte que ele descreve ser lido, então ele não consegue direcionar a verificação para arquivos de sua escolha. O `backupId` entra na entrada do MAC, de modo que um selo válido não pode ser copiado de um snapshot para outro.

## Criptografia em repouso

AES-256-GCM, um nonce aleatório por arquivo. Um backup guarda o mundo inteiro e todo arquivo de configuração; sobrevive ao servidor, é movido para outras mídias, e é o que um disco roubado de fato entrega.

O manifesto guarda o digest do **texto claro**. Assim a verificação prova que o backup ainda restaura para os mesmos bytes, e não apenas que o texto cifrado está intacto — que é uma afirmação bem mais fraca, e é a única que sobraria num backup cifrado mas não verificável.

Restaurar **decifra**, não copia: colocar texto cifrado onde um servidor espera seu mundo seria uma restauração que "deu certo".

"Não cifrado" é registrado explicitamente como `null`, para não se confundir com um manifesto escrito antes de a criptografia existir.

## Quotas e retenção

A quota é conferida **antes** da cópia. Conferir depois significa que o disco já contém os bytes que a quota existe para impedir, e o único remédio restante seria apagar algo.

A retenção nunca libera o backup mais novo que sobrou, diga o que disser a política, e recusa de saída propor esvaziar um repositório: uma regra capaz disso transforma uma configuração errada em perda total. Ela roda depois de um backup bem-sucedido — o momento em que o repositório cresceu é o momento de conferi-lo.

## Restore: pré-condições reais

Restaurar não é o inverso de fazer backup no que diz respeito a autoridade. Tirar uma cópia é seguro; devolvê-la destrói tudo que o mundo virou desde então. Por isso restore tem permissão própria, tipo de operação próprio, capability própria, e exige:

- `acknowledgesDataLoss: true` explícito, **sem valor padrão**;
- a **parada** do servidor que ele sucede, existindo, pertencendo ao mesmo servidor e tendo **de fato concluído** — uma restauração sobre um mundo que o servidor ainda mantém aberto corrompe a cópia e o que ela substituiu;
- um backup em estado `available` — o banco recusa chamar um backup de disponível antes de seus totais e selo estarem gravados, então "ninguém mediu" e "está pronto" não podem ser a mesma linha.

O snapshot alvo viaja na **operação durável**, não no payload do job — pelo mesmo motivo do comando de console: um agente que lesse seu alvo do payload estaria recebendo direção pela rede. A capability reconfere no momento de executar, porque a rota decidiu minutos antes e a retenção pode ter podado o snapshot desde então.

A troca é atômica: o serviço materializa em um pai isolado e promove por `rename`. Nada é escrito por cima de um mundo vivo em nenhum momento.

### Boot de verificação

Quando um controlador está disponível, a capability inicia o servidor após a troca e exige observá-lo em `online`. Se os bytes estão no disco mas o servidor não sobe, o resultado é **falha** — reportar sucesso entregaria ao operador uma restauração que ninguém consegue usar. Sem controlador, a capability reporta `unknown` em vez de alegar uma verificação que não rodou.

## Ensaio de disaster recovery

O ensaio existe como teste, para não apodrecer. Ele perde o mundo inteiro e o recupera de um snapshot selado e cifrado, comparando byte a byte o que voltou com o que se perdeu. Passos: backup com o servidor parado → **verificação antes de precisar** → destruição do mundo → restauração em área isolada → comparação.

Três falhas são ensaiadas junto, porque um ensaio que só prova o caso bom prova a coisa menos interessante:

1. **o repositório sobreviveu e a chave não** — os bytes estão intactos e completamente inúteis; é a falha que um repositório cifrado torna possível e precisa ser ensaiada;
2. **alguém editou o repositório** — o selo pega antes de um único byte chegar à área de recuperação;
3. **o destino está ocupado** — recusa, em vez de fundir um mundo antigo com o que já estava lá.

## Limites mantidos

1. Nenhum contrato, payload ou rota carrega caminho, endpoint de armazenamento ou material de chave.
2. O Forge Bridge continua desligado; a consistência é a janela offline exclusiva, não um protocolo online.
3. Nada é sobrescrito: nem snapshot, nem destino de restauração.
4. Nenhum repositório real foi configurado e nenhum mundo real foi copiado.

## Riscos abertos após a Fase 10.3

- as capabilities existem e são testadas, mas o `main.ts` do agente ainda não as instancia: ligar repositório, chaves e diretórios de origem é operação, não código;
- `backups.restore` continua concedida ao papel `administrator` pela política de fases anteriores; dado que restaurar destrói dados, restringir a `owner` como o force kill é decisão pendente do operador;
- a poda de retenção roda após um backup bem-sucedido; um repositório que pare de receber backups não é podado por nada;
- o backend de objeto não foi ligado, então não há cópia fora do host;
- o boot de verificação depende de um controlador que a Fase 10.1 deixou sem instanciar.
