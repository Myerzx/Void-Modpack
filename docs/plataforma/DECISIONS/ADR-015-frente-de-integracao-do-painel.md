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

### O que fica em aberto

Subir o ambiente continua sendo trabalho de operação: PostgreSQL, `bootstrap-owner` e um proxy servindo o painel na mesma origem da API. Não há manifesto de serviço, e esta decisão não cria um.

A política de raiz aceita qualquer diretório canônico e existente. Num painel pessoal o operador é o dono do host, e uma allow-list ali seria teatro sobre um diretório que ele já possui. Ela passa a ser necessária no dia em que isto rodar onde o operador não é o dono.

### Ordem seguinte da frente

1. configurações detectadas de um mod, com formulário inferido e validação — `configuration-inference` já produz o formulário e os limites declarados;
2. staging e diff — `configuration-staging` já reescreve uma linha preservando tudo o que não entende;
3. execução de sandbox com resultado e logs — `sandbox-runner` já tem a evidência de boot;
4. release, diff entre versões e pacotes — `release-planner` já recusa distribuição por licença e já empacota.

Cada uma entra quando houver tela útil, e cada uma tem de sobreviver ao teste de uso antes de a próxima começar.
