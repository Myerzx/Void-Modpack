# Fases 8.3 e 8.4: persistência, API, revisão e painel

Status: concluídas tecnicamente em isolamento em 2026-08-05.

## Resultado

A Fase 8.1 lê a declaração, a 8.2 a julga. A 8.3 dá a esse ciclo memória, autorização e uma decisão humana; a 8.4 mostra tudo isso em tela.

**Aprovar altera um estado de revisão e nada mais.** Nenhuma coluna, rota, job ou botão desta fatia instala, copia ou promove um artefato, e nada aqui alcança o runtime Minecraft.

## Máquina de estados

```
uploaded ──> quarantined ──> analyzing ──> reviewable ──> approved
    │             │              │              └──────> rejected
    └─────────────┴──────────────┴──────────> blocked ──> rejected
```

- `blocked` é terminal para a análise, não para a revisão: a única saída é uma **rejeição explícita registrada por uma pessoa**. Não existe transição `blocked → approved`.
- A transição é validada em três lugares independentes: no contrato, no repositório antes de qualquer escrita e nas CHECKs da migration. Um escritor que ignorasse o contrato ainda não conseguiria gravar um estado impossível.

## Uma decisão nomeia os bytes que julgou

Toda decisão registra **ator, motivo e hash analisado**. O pedido carrega o `analyzedSha256` e o `expectedVersion` que o revisor leu:

- hash diferente do artefato → recusa `analysis-mismatch`;
- versão diferente da armazenada → recusa `stale-submission`.

Sem isso, uma decisão tomada sobre uma análise antiga poderia ser aplicada a bytes que ninguém viu. As decisões vivem também em `artifact_review_decisions`, append-only, além da coluna corrente da submissão.

## Persistência

A migration `0006_artifact_review.sql` cria submissões, relatórios de inspeção e de compatibilidade, issues como linhas e o log de decisões. As issues são linhas **além** de estarem no relatório, para que o painel filtre por severidade sem interpretar um documento; a CHECK `determinacy = 'proven' OR severity = 'blocker'` mantém a regra da Fase 8.2 também no banco.

Os mesmos bytes enviados duas vezes para o mesmo servidor resolvem para a submissão existente — um índice único por `(server_instance_id, sha256)` impede que um reenvio abra uma segunda revisão.

## Upload

O corpo é **streaming**. O chamador declara o tamanho e o digest antes; o limite é recusado a partir do `content-length` **antes de qualquer byte ser lido**, e a quarentena confere as duas coisas enquanto consome o fluxo. Bytes que não correspondem ao que foi anunciado nunca viram submissão.

A rota não resolve raiz, não escreve arquivo e não guarda um artefato inteiro em memória: a quarentena é um colaborador injetado, e sem ele o upload é recusado (`503`) em vez de aceito num lugar que ninguém configurou.

O nome de arquivo é validado **por ponto de código**, não por literal de regex — a mesma regra da Fase 8.1, adotada aqui depois que um acidente de codificação inseriu bytes de controle crus neste próprio arquivo-fonte.

## Jobs duráveis

`artifact.inspect` e `artifact.analyze` reutilizam a fila `SKIP LOCKED`. O payload carrega apenas uma referência opaca e a versão esperada: nenhuma raiz, caminho ou byte atravessa a fila. Um payload malformado falha **antes** de os pacotes de artefato serem tocados.

A inspeção e a análise são jobs separados de propósito, então uma queda entre as duas retoma pela fila em vez de perder a inspeção. O relatório só é gravado depois de satisfazer o contrato público — um relatório impublicável nunca vira o registro de um artefato.

## Permissões

Nenhuma permissão nova foi criada: `mods.view`, `mods.manage` e `mods.classify` já existiam com concessão de menor privilégio. `manage` e `classify` pertencem somente a `owner` e `administrator`; `read-only`, `support` e `moderator` recebem apenas `mods.view`.

## Painel

O view model é puro e testável sem navegador:

- lista compacta com busca por arquivo, mod id ou prefixo de hash, além de lado, versão e estado;
- upload com progresso — a porcentagem descreve **somente bytes enviados**, porque quarentena e análise são passos duráveis à parte e não uma fração de um envio que já terminou;
- drawer de incompatibilidade com severidade, determinação, motivo, evidência e ação manual;
- filtro por blocker/warning/information;
- grafo de dependências sob demanda, derivado do que o artefato declara — sem resolver dependência contra repositório e sem abrir JAR aninhado;
- **nenhum botão de instalação**: `buildInstallActionView()` devolve `present: false` por construção, então nenhuma tela consegue renderizar um botão habilitado por acidente.

Um lado que ninguém revisou aparece como **Não revisado**. Presença, filename ou loader nunca substituem essa decisão. Um bloqueio apenas não comprovado é apresentado como *não comprovado*, nunca como defeito provado.

## Correção trazida da Fase 8.1

O serviço de inspeção emite um discriminador `format` que o contrato da própria Fase 8.1 recusava — a saída do serviço nunca satisfez o contrato publicado, porque os testes de 8.1 validavam objetos construídos à mão em vez da saída real. O campo foi acrescentado ao contrato e o worker passou a validar antes de gravar, de modo que a lacuna não pode voltar em silêncio.

## Critério de conclusão da Fase 8

Provado de ponta a ponta em `artifact-e2e.test.ts`:

1. um JAR de teste entra em quarentena, é inspecionado sem execução e gera relatório persistido;
2. a incompatibilidade declarada chega ao painel com severidade, evidência e ação, e o caminho fica auditado;
3. nenhum artefato analisado alcança o runtime Minecraft — os únicos jobs criados são `artifact.inspect` e `artifact.analyze`, e a ação de instalação não existe.

## Limites mantidos

1. Nenhum JAR privado foi aberto; o arquivo de teste é construído em código.
2. Nenhuma classe é carregada e nenhum artefato é executado.
3. Aprovação não instala: ela altera estado de revisão.
4. Nenhuma rota, coluna ou resposta carrega caminho, raiz, localização de quarentena ou bytes.

## Riscos abertos após as Fases 8.3 e 8.4

- a quarentena e o leitor de bytes são colaboradores injetados; o wiring de produção com `@voidfall/artifact-quarantine` sobre raiz confiável ainda não existe;
- o plano de compatibilidade é montado por quem chama o worker: não há origem persistida dos contextos alvo nem reconciliação com o inventário real;
- o upload confia no `content-length` declarado para recusar cedo; um cliente que mentir é recusado depois, ao conferir digest e tamanho reais, mas os bytes já terão trafegado;
- a análise não é reexecutada automaticamente quando o contexto do servidor muda, então uma revisão aprovada continua descrevendo o runtime da época;
- a conciliação de um job `analyzing` interrompido por crash depende de reenfileiramento manual; não há varredura de submissões paradas;
- o painel lê a sessão de `sessionStorage` como as demais telas e ainda não tem paginação, ordenação ou busca no servidor;
- `reviewedSide` só é gravado quando um revisor o informa junto da decisão; não existe tela dedicada de classificação de lado.
