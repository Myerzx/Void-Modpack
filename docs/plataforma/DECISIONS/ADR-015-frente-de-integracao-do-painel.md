# ADR-015 — Frente de integração do painel, em paralelo ao roadmap

Status: aceito em 2026-08-07.

## Contexto

O motor do VoidFall existe. As fases 12 a 16 entregaram inventário de workspace, inferência e staging de configuração, sandbox descartável, o primeiro adaptador específico e o construtor de release — tudo provado contra o servidor real, com 834 testes no gate.

E nada disso podia ser visto. O resultado só aparecia por CLI, teste e relatório.

Isso não é só desconforto. Levantamento feito antes desta decisão encontrou **sete bloqueios** entre o operador e o painel, dos quais três eram código ausente e não configuração:

1. não existia tela de login — a API tinha o endpoint desde a Fase 1 e o painel tinha o cliente, e nenhuma página chamava;
2. `/api/v1/auth/session` não devolvia o `csrfToken`, que só existia na resposta do login porque era guardado hasheado; qualquer tela que recarregasse ficava com cookie válido e sem poder escrever;
3. não existia rota para criar uma instância de servidor — `ServerRepository.create` existia desde a Fase 1 e nada fora de teste a chamava;
4. nenhum app dependia de `workspace-inventory`, `configuration-inference`, `configuration-staging`, `sandbox-runner`, `mod-adapters` ou `release-planner`;
5. a página inicial era fixture declarada;
6. o painel é exportado estático e chama caminhos relativos, exigindo um proxy reverso que não existe;
7. não há `docker-compose`, `Dockerfile` nem `.env` de exemplo para subir o PostgreSQL.

Acumular integração para o final produz exatamente isso: capacidades corretas que ninguém consegue exercer, e cujos problemas de uso só aparecem quando já é caro mudar o contrato.

## Decisão

**Abrir uma segunda linha de trabalho, permanente e paralela ao roadmap.**

- **Motor/roadmap** continua nas fases, com os mesmos critérios, testes e arquitetura. Nenhuma fase é encurtada, adiada ou substituída por causa desta frente.
- **Painel/integração** expõe progressivamente as capacidades já maduras, na ordem do caminho principal do produto: importar → inventário → mods → mod → configurações detectadas → editar e validar → staging → sandbox → resultado e logs → diff → release.

Quatro regras governam a frente:

**Nada é reimplementado no frontend.** A tela renderiza o que o motor decidiu. Nenhum nível de edição é inferido, nenhum total é recalculado, nenhuma regra de configuração é redecidida no navegador. Uma segunda resposta seria uma segunda coisa para manter verdadeira.

**A interface é funcional, não final.** O design evolui junto com as fases. O que não pode evoluir é a honestidade do que a tela mostra: "nunca inventariado" não vira zero, "recusado por limite" não vira "não declara nada", e o que foi deliberadamente não lido aparece na página.

**Uma capacidade se conecta quando existe interface útil para ela**, não quando a fase termina. A frente nunca bloqueia pesquisa ou fundação das fases seguintes.

**A frente é também validação do produto.** Se uma capacidade tecnicamente correta ficar ruim, confusa ou impraticável pelo painel, isso é registrado e o contrato ou a experiência muda antes de a decisão endurecer. Uma capacidade que só é usável por CLI ainda não está pronta.

## Consequências

### O que a primeira fatia mudou

O token CSRF passa a ser guardado como emitido, e não hasheado, e `/session` o devolve. Os dois não são o mesmo tipo de segredo: o token de sessão **é** a credencial e continua hasheado; o CSRF só significa alguma coisa apresentado junto com aquele cookie e é inútil para quem não consegue ler uma resposta de mesma origem. Guardá-lo hasheado era simetria sem função, e custava toda escrita depois de um reload.

Existe rota para criar instância de servidor, sob `security.manage`, porque a instância é a que todas as permissões posteriores acabam escopando.

Existe um registro de workspaces. **O caminho é digitado uma vez, no registro, e nenhuma tela envia caminho depois disso** — a mesma regra que o núcleo de arquivos autorizados já segue. Nada devolvido a um navegador carrega caminho do host, nem em documento nem em mensagem de erro, e há teste para isso.

Cada varredura é uma linha nova, nunca uma substituição. Um inventário é evidência com hora; sobrescrever tornaria "como isso estava antes de eu mexer?" impossível de responder, que é a pergunta em torno da qual o caminho de release inteiro foi construído.

### Primeiro achado da frente como validação

A regra "se uma capacidade ficar impraticável pelo painel, ajuste o contrato" cobrou na primeira execução.

A política de raiz exigia que o operador digitasse um caminho já canônico e recusava qualquer outra coisa — inclusive `H:/pasta/servidor`, que é um caminho válido no Windows, e qualquer barra final. E dizia apenas "use forma canônica", sem explicar o que isso queria dizer.

Fazer o chamador satisfazer uma normalização que o chamado consegue fazer sozinho é o tipo de contrato tecnicamente correto e miserável de usar. A política passou a **devolver** o caminho canônico em vez de aprovar o que recebeu, e o registro guarda o que ela devolveu. `..` continua recusado, e não resolvido: uma raiz que significa outra coisa do que foi digitada é uma raiz que ninguém revisou.

### Execução real

O caminho inteiro rodado contra `Servidor/workspace/server-original` pela própria API:

```
login 200 · sessão devolve o csrf · registrar 201 · varrer 201 (5,4 s)
7.928 arquivos · 176 mods declarados de 181 arquivos · 6 sem declaração
exclusões: 40 private-state, 1 runtime-infrastructure
níveis: 74 STRUCTURED, 94 RUNTIME_ONLY, 8 RAW_EDITABLE
cataclysm 3.16 (122 MiB) · STRUCTURED · 9 configurações detectadas
caminho do host em alguma resposta: não
```

O mod de 122 MiB aparecer aqui identificado é a inspeção em camadas chegando à tela: antes desta semana ele seria "sem declaração".

### O ambiente local é do projeto, não do operador

Decidido em 2026-08-08, fechando o único ponto que sobrava: `npm run panel`, e nada mais.

**A API serve o painel.** As alternativas eram um proxy reverso que o operador configura, ou CORS com duas origens. A primeira é uma ferramenta para instalar e um arquivo para manter; a segunda enfraquece exatamente as regras de cookie das quais a sessão depende. Servir o export do processo que já responde `/api` faz da mesma-origem uma propriedade da arquitetura em vez de uma instrução de implantação — e o `SameSite=strict` continua valendo porque não há requisição cross-site para fazer.

Sem dependência nova para isso. Um servidor de arquivos estáticos é resolução de caminho, content type e stream, e a resolução de caminho é a parte que vale possuir: cada requisição é resolvida contra a raiz do export e recusada se cair fora, com teste para `..`, `%2e%2e`, `%2e%2e%2f` e `..%5c`. O painel também nunca responde por `/api`, `/agent` ou `/health` — uma tela que recebesse o 404 do painel dentro de um `fetch` renderizaria um formulário de login como se fosse dado.

**O banco é provisionado.** PGlite já estava no repositório rodando a suíte de testes, é PostgreSQL de verdade e persiste em diretório. Então a resposta local é a que o projeto consegue provisionar sozinho: `.voidfall/database`, sem daemon, sem porta, sem credencial. Produção continua em `PostgresDatabase` sobre servidor real — PGlite é single-connection, o que é certo para um operador numa máquina e errado para qualquer outra coisa, e as duas fábricas são separadas para ninguém pegar a errada sem querer.

**O primeiro dono é gerado.** Senha aleatória, impressa uma vez e gravada em `.voidfall/first-owner.txt`. Uma senha que ninguém escolheu ainda é uma senha que ninguém precisa inventar, e inventar é o passo que as pessoas fazem mal.

Três razões independentes impedem isso de virar implantação: escuta só loopback, recusa `NODE_ENV=production`, e o dono só nasce com a tabela de usuários vazia.

### Segundo achado da frente como validação

`POST` sem corpo era recusado quando o cliente mandava `content-type: application/json` — que é o que `curl` e praticamente qualquer cliente fazem. Disparar uma ação sem nada a dizer é ordinário, e a resposta era um erro de validação com `details` vazio: correto, e impossível de agir sobre.

Só apareceu ao exercitar por HTTP; em processo, `app.inject` sem payload não manda content-type. O parser passou a tratar corpo vazio como ausência de corpo. Rotas que exigem corpo não mudaram — o schema delas continua recusando, agora com uma mensagem que nomeia o campo.

### Sandbox: um boot que leva minutos não cabe numa requisição

O `POST` cria a execução, entrega ao lançador e responde **202** com o id. Tudo depois disso chega por callback e é lido de volta. Bloquear uma requisição num JVM seria o outro desenho, e o operador ficaria com um navegador pendurado por dois minutos sem saber onde a coisa está.

Isso obrigou o staging a virar durável. Antes ele era um arquivo em disco e nada mais, então o painel mostrava um diff e depois esquecia **quais campos** o produziram — suficiente para revisar, insuficiente para fazer qualquer coisa: bootar contra uma mudança precisa da mudança, não de um arquivo reescrito que alguém teria de reler e adivinhar.

As duas metades têm naturezas diferentes de propósito. Uma mudança preparada é uma intenção que ainda está sendo editada, então é substituída no lugar e apagada ao descartar. Uma execução é evidência com hora, então é criada uma vez e concluída uma vez.

Quatro distinções que a tela carrega do motor em vez de achatar: **executando não é falha** (não há `outcome` enquanto roda); **`timed-out` não é `exited-early`** (a janela fechou com o servidor ainda carregando — isso é um desconhecido, não um fracasso); **recusado não é "não subiu"** (uma EULA ausente ou nenhum Java encontrável nomeiam o que faltou); e **uma falha de descarte fica ao lado do resultado, nunca por cima** — na primeira execução real a limpeza destruiu a evidência que estava limpando.

Um boot por workspace de cada vez. Dois sandboxes montados do mesmo servidor disputam os mesmos arquivos e a mesma porta, e o segundo falha de um jeito que se parece com a mudança sob teste.

### Execução real, do painel ao JVM

```
preparar  config/alexsmobs.toml · general.lavaVisionOpacity 0.65 -> 0.5
iniciar   202 · testedChanges: true
          EULA acceptance found in the imported server.
          Java 17.0.12 via PATH.
          5530 files to copy (1017 MiB).
          1 file(s) staged; the sandbox will boot the change.
          Sandbox composed. Starting the server.
          Sandbox disposed.
resultado booted em 102.274 ms · 3 arquivos gerados · descartado: sim
mudança   valuesHeld: true · observedSha256 == stagedSha256
          workspaceUnchanged: true
```

O servidor subiu com a mudança, o valor sobreviveu ao boot, a cópia foi apagada e o workspace original não foi tocado.

### Release: construir e distribuir são perguntas diferentes

A tela mantém a separação que o motor já fazia. Construir para a própria máquina é sempre permitido — restaurar o seu servidor no seu host é backup. Entregar a alguém exige licença revisada de cada arquivo, e `intent` é entrada, nunca inferência: ninguém produz um artefato redistribuível por esquecer de perguntar.

Uma build de distribuição é recusada **antes de escrever qualquer coisa**, com as contagens do próprio gate. Uma recusa de licença não é um export menor; é uma violação com barra de progresso.

Uma versão não pode ser reusada. Reconstruir a mesma versão sobre outra evidência é como um número de versão deixa de significar alguma coisa.

O download é endereçado por id de release e lado. O caminho fica no host; o navegador recebe nome de arquivo e bytes.

Executado contra o pacote real pela API:

```
prévia        182 arquivos sem revisão · distribuível: não
distribuição  recusada em 3 s, nada escrito
uso próprio   202 imediato · pronto em 15 s
              voidfall-server-1.0.0.zip  1.070 MiB · 7.928 entradas
              voidfall-client-1.0.0.zip    182 MiB · 7.708 entradas · 220 excluídos
download      1.121.968.005 bytes · assinatura PK · .NET lê as 7.928 entradas e os 181 jars
```

Sem perfil de cliente registrado, os 181 mods saem como `server-only` — **por observação**, porque o servidor é o único lugar onde qualquer um deles foi visto. A tela diz isso na própria opção, em vez de fingir que o corte foi feito.

### O que fica em aberto

A política de raiz aceita qualquer diretório canônico e existente. Num painel pessoal o operador é o dono do host, e uma allow-list ali seria teatro sobre um diretório que ele já possui. Ela passa a ser necessária no dia em que isto rodar onde o operador não é o dono.

### Ordem seguinte da frente

1. ~~configurações detectadas de um mod, com formulário inferido e validação~~ — **ligada em 2026-08-08**;
2. ~~staging e diff~~ — **ligada em 2026-08-08**, junto com a anterior, porque editar sem ver o que sairia não é uma tela útil;
3. ~~execução de sandbox com resultado e logs~~ — **ligada em 2026-08-08**;
4. ~~release, diff entre versões e pacotes~~ — **ligada em 2026-08-08**. A frente do ADR-015 está encerrada; o painel continua no [ADR-016](ADR-016-painel-como-gerenciador-completo.md).

Cada uma entra quando houver tela útil, e cada uma tem de sobreviver ao teste de uso antes de a próxima começar.

### Editar, validar, preparar e ver a diferença

Três coisas que a tela se recusa a suavizar, todas herdadas do motor em vez de decididas nela:

**Limite declarado e ausência de limite leem diferente.** O validador informa se chegou a conferir contra algo que o mod declarou; onde não havia nada para conferir a tela diz "tipo correto, o mod não declarou limite", e não um tique verde tranquilizador.

**Um formulário que não representa o arquivo inteiro não pode ser salvo.** Gravar uma visão parcial descartaria justamente o que o leitor não entendeu. `cataclysm.toml`, no pacote real, tem 127 campos e 97 linhas não representadas — a tela mostra os campos e bloqueia o preparo, dizendo por quê.

**Nada é aplicado.** O caminho que a panel pode nomear é restrito ao que a varredura encontrou, então travessia nunca vira questão de tratamento de string. Um `POST` de staging escreve em `.voidfall/staging/<workspaceId>/` e o arquivo do servidor continua byte a byte o que era. `apply` continua sem dono em lugar nenhum deste repositório, e a tela afirma isso em vez de deixar um botão sugerir o contrário.

Exercitado contra o pacote real pela API:

```
config/alexsmobs.toml · 250 campos · completo
general.lavaVisionOpacity = 0.65 · range 0.01..1 (declared)

validar 0.5   -> aceito, checkedAgainstDeclaredBounds: true
validar 7     -> recusado, out-of-declared-range
preparar 0.5  -> - lavaVisionOpacity = 0.65
                 + lavaVisionOpacity = 0.5
arquivo do servidor: intacto (mesmo digest antes e depois)
```
