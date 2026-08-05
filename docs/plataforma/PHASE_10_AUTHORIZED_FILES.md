# Fase 10.2: arquivos e configurações

Status: concluída tecnicamente em isolamento em 2026-08-05.

## Resultado

Descoberta, revisão e mutação acontecem apenas dentro de raízes que a instalação declarou. Uma requisição nomeia a raiz por **identificador** e um caminho relativo a ela; nada aceita diretório, unidade, URL ou arquivo compactado, e nenhuma resposta carrega caminho absoluto — um chamador não alcança fora da política nem descobre o layout do host lendo um erro.

Nenhuma raiz real foi configurada. Os testes provam o comportamento contra diretórios temporários; ligar uma raiz de produção é operação, não código.

## Três regras valem para todas as mutações

1. **Nada é sobrescrito.** Um destino que já existe é conflito, nunca substituição silenciosa. Não há sequência de chamadas que destrua um arquivo que o chamador não nomeou.
2. **O que se perde é preservado antes.** Toda etapa destrutiva publica os bytes como revisão imutável *antes* da perda, então uma queda no meio cai em "revisão existe, arquivo intacto" — nunca no contrário.
3. **A mutação fica dentro de uma raiz.** Atravessar raízes deixaria escapar a política de uma raiz estrita movendo o arquivo para uma permissiva.

Renomear não é operação separada: é o caso em que origem e destino compartilham o pai. As guardas e os modos de falha são idênticos, e duplicar a operação só duplicaria o que pode divergir.

## O resolvedor que faltava

`#target` só resolvia caminho que **já existe** — ele faz `lstat` na entrada final. Um destino precisa exatamente das mesmas guardas aplicadas ao pai (diretório canônico, sem componente linkado, contido na raiz) e da conclusão oposta sobre si: `#targetForNew` exige que a entrada final **não** exista.

O pai precisa existir. Uma mutação nunca cria a árvore em que escreve.

## Proteção contra link, junction e alias

A criação usa `O_EXCL`: quem decide a corrida entre dois creates é o sistema de arquivos, não uma checagem de existência anterior. Somam-se a isso as guardas que a fase anterior já tinha e que passam a valer para o conjunto todo — recusa de symlink e junction em qualquer componente, recusa de hardlink (`nlink !== 1`), comparação `dev`/`ino` entre o caminho e seu `realpath`, e recusa de qualquer entrada que não seja arquivo simples.

No contrato, barra invertida e dois-pontos são recusados de saída, sem tentativa de normalizar. Essa única escolha torna `C:\...`, `\\servidor\compartilhamento` e um fluxo alternativo NTFS (`arquivo.properties:$DATA`) **inexprimíveis em qualquer plataforma** — inclusive naquelas onde hoje não significam nada e passariam despercebidos em revisão.

Forma sozinha não pega um nome que resolve para um arquivo diferente do que se lê. O Windows remove ponto e espaço finais, então `x.properties.` abre `x.properties` e uma checagem de extensão aprova o arquivo errado; um segmento que nomeia dispositivo reservado não é arquivo; e um caminho que não é NFC é um segundo nome que um revisor não distingue do primeiro. Os três são recusados como questões semânticas, uma vez, para que toda rota que aceita caminho dê a mesma resposta.

`rejectLinkedComponents` deixava um `ENOENT` cru escapar: a leitura de um arquivo ausente aparecia como erro de sistema de arquivos em vez de recusa. Passou a recusar como caminho inseguro.

## Upload e download

São as rotas de criação e leitura: texto UTF-8 limitado com hash declarado, em JSON. Não há transferência binária, não há expansão de arquivo compactado e não há rota que execute qualquer coisa — nada que chegue aqui pode ser salvo e executado. A extensão gravável é política da raiz, então criar `.sh`, `.bat` ou `.jar` é recusado mesmo por quem pode gravar.

## Diff que não revela segredo

O diff casa linhas pelo texto **cru** e redige na saída. A ordem é o ponto inteiro: redigir antes colapsaria `rcon.password=antigo` e `=novo` na mesma string mascarada, o diff chamaria a linha de inalterada, e uma troca de credencial ficaria invisível justamente na tela feita para revisá-la. Casar cru e mascarar tarde dá a resposta honesta — *esta linha mudou, e você pode não ver como*. `containsRedactedChange` é parte do contrato por isso: um revisor precisa distinguir "inalterada" de "mudou de um jeito que não te mostro".

O alinhamento remove prefixo e sufixo comuns antes de montar a tabela LCS e recusa acima de um orçamento fixo, porque um diff sem limite entre dois arquivos grandes é esgotamento de memória disparável de uma caixa de texto.

Texto vazio é zero linhas, não uma linha vazia — senão um arquivo que não existe apareceria com uma linha em branco adicionada, e a revisão de uma exclusão mostraria uma linha fantasma que ninguém escreveu.

## Restauração

Restaurar só preenche caminho ausente. Restaurar por cima de um arquivo vivo seria o único jeito de este pacote destruir dados sem ter sido pedido; quem quer substituir usa `replace`, que exige declarar o hash que acredita estar substituindo.

Os bytes preservados **não saem do serviço** nesse caminho: uma revisão pode ser restaurada por quem não tem permissão para ler o que ela contém.

O manifesto é revalidado na leitura, não confiado: ele vive em disco, e um manifesto adulterado não pode redirecionar uma restauração para outro arquivo nem para outra raiz.

## Permissão por ação

`files.view`, `files.upload`, `files.edit` e `files.delete` são distintas. Poder alterar um arquivo não é poder fazê-lo deixar de existir. A exclusão ainda exige `acknowledgesDataLoss` explícito, sem valor padrão, pelo mesmo motivo do force kill.

Um caminho inseguro responde 404, igual a um ausente. Dizer a quem não pode alcançar um caminho que ele **existe** já é divulgação, então os dois casos são deliberadamente indistinguíveis de fora.

Recusas são auditadas junto com sucessos: um operador sendo negado repetidamente em um caminho é exatamente o padrão que o log existe para tornar visível.

## Limites mantidos

1. Nenhuma rota aceita caminho absoluto, unidade, URL ou arquivo compactado.
2. Nenhuma resposta ou erro revela caminho do host.
3. Nada é sobrescrito e nada destrutivo acontece sem revisão prévia.
4. Nenhuma raiz real foi ligada.

## Riscos abertos após a Fase 10.2

- as raízes autorizadas ainda não são configuradas por nenhum ambiente: o serviço é opcional e a API responde 503 sem ele;
- não há coleta de lixo das revisões preservadas; elas crescem sem poda;
- o painel ainda não consome as rotas — a interface de arquivos permanece a da Fase 9.3;
- o diff é por linha; um arquivo de linha única grande é comparado como uma linha só.
