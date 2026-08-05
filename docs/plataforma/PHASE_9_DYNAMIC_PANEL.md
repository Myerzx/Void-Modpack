# Fase 9.3: painel dinâmico

Status: concluída tecnicamente em isolamento em 2026-08-05.

## Resultado

As áreas implementadas deixam de depender de fixture: sessão real contra a Control API, seletor de instância montado a partir dos servidores registrados, dashboard, lista de operações e página de auditoria paginada.

O view model é puro e testável sem navegador, como nas telas anteriores.

## Três regras no shell, não repetidas por página

### Estado de tela explícito

Uma tela declara em qual de `loading`, `empty`, `unavailable`, `denied` ou `error` está, e só renderiza conteúdo quando está pronta.

Uma **recusa nunca aparece como erro**. Ser negado é um fato diferente de algo ter quebrado; juntar os dois ensina o operador a ignorar ambos. `401`/`403` viram `denied`, `404` vira `empty`, `503` vira `unavailable`, o resto vira `error`.

### Ação sem permissão não é renderizada

Não fica desabilitada — some. Um controle acinzentado ainda conta ao usuário que a capacidade existe e que ele foi recusado, e isso é informação que ele não precisa ter.

### Permissão e disponibilidade são coisas separadas

Uma mutação perigosa continua **desabilitada mesmo com permissão**, porque a capacidade por trás dela ainda não existe. Iniciar, parar e reiniciar servidor, comando de console, backup e instalação de artefato aparecem visíveis e desabilitados, cada um nomeando a fase que os implementa.

Um `owner` tem `server.control.start`; ainda assim o botão não funciona, porque nada no plano de controle executa isso hoje. Marcar o contrário seria mentir para quem opera.

## Procedência em cada valor

Todo tile do dashboard carrega origem, qualidade e horário de observação:

| Origem | Qualidade |
| --- | --- |
| `control-api` | `live` |
| `agent-observation` | `live`, `stale` ou `unknown` |
| `demo-fixture` | `demo` |

Um processo que **ninguém observou** é reportado como desconhecido, não como desligado — são afirmações diferentes. Uma observação que ninguém acompanha mais é marcada como desatualizada em vez de repetida como atual. As áreas que continuam fixture são nomeadas dentro da própria view, de modo que nenhuma tela as apresente como leitura viva.

## Sessão

O painel não guarda credencial: o cookie de sessão é opaco e HTTP-only, definido pela API. O cliente carrega apenas o token CSRF e o conjunto de permissões que a API reportou.

Senha errada, bloqueio por rate limit e falha da API são três resultados distintos, porque significam coisas diferentes para quem está entrando. Um payload de sessão malformado é tratado como erro em vez de confiado.

## Limites mantidos

1. Nenhuma tela desta fatia executa mutação perigosa.
2. Nenhuma tela inventa dado: o que não tem origem ligada aparece como indisponível.
3. Fixture aparece rotulada como fixture.
4. O runtime Minecraft privado não foi conectado.

## Riscos abertos após a Fase 9.3

- métricas de host e atividade recente continuam fixture, e o dashboard as nomeia como tal;
- as páginas de mods e configurações seguem com as próprias telas das Fases 7.3 e 8.4; a 9.3 não as unificou sob o shell novo;
- a seleção de instância vive no estado do componente, sem persistência entre navegações;
- a auditoria pagina por `offset`; um cursor por sequência continua o próximo passo;
- não existe teste de navegador: o comportamento é provado pelo view model puro, não pela renderização.
