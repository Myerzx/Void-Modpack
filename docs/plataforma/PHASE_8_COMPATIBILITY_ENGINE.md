# Fase 8.2: motor de compatibilidade

Status: concluída tecnicamente em isolamento em 2026-08-05; gate local aprovado e [matriz Windows/Linux 30974767140](https://github.com/Myerzx/Void-Modpack/actions/runs/30974767140) aprovada nos dois sistemas.

## Resultado

A Fase 8.1 responde **o que este arquivo declara?**. `@voidfall/artifact-compatibility` responde a pergunta seguinte — **esta declaração pode entrar naquele runtime?** — e nada além disso.

O pacote é puro: sem filesystem, rede, banco, fila, relógio ou efeito operacional. Ele não instala, não corrige, não renomeia e não propõe conserto automático. Toda ação recomendada é uma decisão humana.

## Dois eixos independentes

| Eixo | Papel |
| --- | --- |
| `code` | nomeia o **assunto** da issue e é estável para sempre |
| `determinacy` | diz **com que força** aquilo foi estabelecido |

- `proven` — o motor demonstrou o problema a partir de uma declaração;
- `unproven` — o motor não conseguiu demonstrar a **ausência** do problema.

O contrato recusa qualquer issue `unproven` que não seja `blocker`. Desconhecido bloqueia; ele nunca passa em silêncio e nunca é reportado como defeito provado.

## Contextos

Todo contexto de um plano é um **alvo**. Diferente da análise documental da Fase 7.0, aqui não existe contexto de referência ou histórico cuja severidade pudesse ser suavizada. Um contexto declara Minecraft, loader, versão do loader, lado e Java, e um contexto sem loader é recusado no plano — um runtime que não carrega mod não é alvo de compatibilidade.

## Códigos

| Código | Severidade | Determinação |
| --- | --- | --- |
| `minecraft-version-mismatch` | blocker | provado, ou não provado sem declaração/range suportado |
| `loader-mismatch` | blocker | provado |
| `loader-version-mismatch` | blocker | provado, ou não provado sem versão/range suportado |
| `side-mismatch` | blocker no lado revisado; information na dependência de outro lado | provado |
| `missing-required-dependency` | blocker | provado, ou não provado com biblioteca embutida |
| `dependency-version-mismatch` | blocker | provado, ou não provado sem versão/range suportado |
| `duplicate-mod-id` | blocker | provado |
| `duplicate-content` | warning | provado |
| `filename-collision` | blocker | provado |
| `explicit-conflict` | blocker | provado |
| `dependency-cycle` | warning | provado |
| `metadata-unverified` | blocker, exceto warning para biblioteca aninhada e versão não resolvida | não provado, exceto os dois warnings |
| `distribution-unreviewed` | blocker | provado |

A mensagem humana vive fora do código, em uma tabela fechada indexada por `code:reason`. Uma frase pode ser reescrita ou traduzida sem quebrar quem ramifica pelo código.

## Julgamentos que o motor recusa fazer

- **Lado** vem de revisão humana. Presença, filename ou metadata declarada nunca substituem essa decisão; sem revisão o resultado é `metadata-unverified:side-not-reviewed`, não `both`.
- **Conflito explícito** também vem de revisão: a Fase 8.1 não lê nenhuma declaração de `breaks`, então um conflito só entra pelo plano.
- **Biblioteca JarJar** é declarada e nunca aberta. Por isso uma dependência obrigatória ausente vira `possibly-embedded` e **não provada** quando o artefato declara bibliotecas embutidas — o JAR aninhado poderia carregá-la.
- **Range fora do subconjunto suportado** permanece desconhecido. O avaliador Maven da Fase 7.0 é reutilizado em vez de reimplementado, então a semântica de qualifier e build continua uma só no repositório.
- **Dependência opcional ausente** não é issue. Presente e fora do range, é blocker: um range declarado vale quando o alvo existe.
- **Alvo de loader que o contexto não roda** é ignorado na dependência, porque `loader-mismatch` já afirma o mesmo fato com evidência melhor. O mesmo problema não é contado duas vezes.
- **Ciclo** é fato estrutural, não prova de falha: mods que se exigem mutuamente viram `warning`, porque nenhum deles pode ser admitido sozinho, e não porque o carregamento quebre. Os componentes fortemente conexos são calculados por Tarjan iterativo, com nós e arestas ordenados, de modo que o mesmo grafo sempre produz a mesma saída e um grafo profundo não estoura a pilha.
- **Par já aprovado** não é julgado: uma issue precisa citar ao menos um artefato sob análise.

## Evidência fechada

A evidência de uma issue é a mesma união fechada dos seis descritores revisados da Fase 8.1, então um nome de entrada arbitrário não pode ser reportado. Todo `artifactId`, `contextId` e `modId` citado por uma issue precisa estar declarado pelo próprio relatório; um artefato instalado citado aparece em `relatedInstalled` justamente para manter esse fechamento.

Um alvo de dependência que nenhum artefato declara **não** pode ser citado como `modId` — ele fica no `detail`, porque não é um mod que o relatório conheça.

O contrato limita quantos artefatos uma issue cita. Quando um grupo excede o limite, os artefatos **sob análise** ficam à frente dos já aprovados antes do corte, de modo que um grupo grande nunca empurre para fora o único candidato da própria issue; o total real permanece no `detail`.

## `detail` sanitizado

O `detail` carrega o observado, como `required=[48,);running=47.4.4`. Ele é filtrado pelo motor antes de entrar no relatório, contra um charset que não expressa separador de caminho, prefixo de unidade, aspas ou caractere de controle. Dois pontos ficaram **fora** do charset de propósito: nenhum formato de detail precisa deles, e sem eles um `C:` não sobrevive.

A sanitização é do motor, não do contrato: um range hostil vindo de um arquivo não confiável não pode nem vazar caminho nem fazer o relatório falhar na própria validação.

## Veredito

Por artefato e por contexto:

- `incompatible` — existe blocker provado;
- `unknown` — existe blocker, todos não provados;
- `compatible` — não existe blocker.

O veredito do artefato é o pior entre seus contextos alvo. Warning e information nunca mudam veredito.

## Limites mantidos

1. Nenhum JAR é aberto, lido ou executado aqui; o motor recebe declarações da Fase 8.1.
2. Nenhuma instalação, cópia, renomeação ou correção automática existe neste recorte.
3. O pacote é puro e determinístico: a mesma entrada produz o mesmo relatório, profundamente congelado.
4. Nenhum runtime privado foi conectado; nenhuma decisão de licença é tomada.

## Riscos abertos após a Fase 8.2

- o motor julga **declaração**, não comportamento: nada aqui prova que o mod carrega, funciona em jogo ou não conflita em runtime;
- um contexto Quilt recebe `loader-mismatch` para artefato Fabric, porque o motor não assume compatibilidade herdada entre loaders que ninguém revisou;
- bibliotecas JarJar continuam sem análise própria, então `possibly-embedded` permanece a resposta honesta e não uma resolução;
- a lista de conflitos explícitos é revisada manualmente e não tem persistência, ator nem trilha de auditoria neste recorte — isso é da Fase 8.3;
- o plano é montado por quem chama: não há repositório, endpoint, job durável nem painel ligados ao motor;
- `side-mismatch` de dependência é informativo e não distingue dependência de cliente legítima em pacote de servidor;
- um artefato instalado não declara dependências no plano, então um ciclo que só se fecha através dele não é observável e não é adivinhado;
- o corpus de regressão usa fixtures construídas em código; nenhum inventário real foi reconciliado contra o motor.
