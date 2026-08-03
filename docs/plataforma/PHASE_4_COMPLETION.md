# Conclusão da Fase 4 — catálogo, artefatos, arquivos e schemas

Status: itens 2 a 6 implementados em isolamento e gate local aprovado em 2026-08-03; matriz Windows/Linux pendente.

## Objetivo

Concluir os itens 2 a 6 da Fase 4 como uma única entrega técnica verificável, sem transformar os pacotes em operações de produção. A entrega acrescenta classificação humana revisável, análise determinística do catálogo, ingestão em quarentena, acesso versionado a arquivos autorizados e schemas genéricos de configuração. Nenhuma dessas capacidades é conectada à Control API, ao agente, ao worker, ao painel, ao launcher ou ao servidor privado nesta fase.

## Arquitetura do recorte

| Item | Pacote proprietário | Entrada confiável | Saída | Efeito permitido |
| --- | --- | --- | --- | --- |
| 2. classificação manual | `@voidfall/mod-catalog` | entrada válida, hash esperado e decisão humana | nova entrada + revisão canônica | memória apenas |
| 3. upload em quarantine | `@voidfall/artifact-quarantine` | raiz construída pelo operador e stream limitado | payload opaco + manifesto imutável | filesystem temporário de teste |
| 4. file manager | `@voidfall/authorized-files` | registro fechado de raízes e path relativo | leitura/listagem ou substituição com revisão | filesystem temporário de teste |
| 5. schemas genéricos | `@voidfall/configuration-schemas` | definição declarativa e revisão esperada | schema validado, histórico e validação de valores | memória apenas |
| 6. dependências e conflitos | `@voidfall/mod-catalog` | catálogo validado + restrições explícitas | relatório determinístico | nenhum |

Os contratos públicos são estreitos e tipados. Paths absolutos, comandos, funções executáveis, conteúdo arbitrário extensível e decisões implícitas não atravessam as fronteiras públicas.

## 1. Classificação manual revisável

A classificação altera somente os campos cuja decisão pertence à revisão humana:

- `side`;
- `requirement`;
- `distribution`;
- `reviewState`.

O plano exige `revisionId`, `actorId`, `reasonCode`, instante canônico e o SHA-256 canônico da entrada atual. O hash esperado implementa concorrência otimista: uma decisão baseada numa versão antiga falha sem produzir resultado. A revisão registra hashes anterior e novo, os nomes dos campos alterados e a identidade do ator, mas não persiste nem envia dados.

Invariantes:

1. a entrada original e a resultante devem satisfazer `ModCatalogEntry`;
2. `distribution.allowed` continua exigindo licença, evidência, revisor e horário;
3. `reviewState.reviewed` exige lado conhecido e distribuição decidida;
4. uma classificação sem mudança é rejeitada;
5. nenhum dado de inventário promove automaticamente uma decisão;
6. o retorno é imutável e determinístico para a mesma entrada e plano.

## 2. Dependências, duplicatas e conflitos

O analisador recebe entradas já validadas e restrições incompatíveis declaradas por um revisor. Ele detecta:

- IDs lógicos duplicados;
- hashes atribuídos a mais de um ID lógico;
- filenames normalizados compartilhados por bytes diferentes;
- dependências obrigatórias ou opcionais ausentes;
- dependência de si próprio;
- ciclos de dependências obrigatórias;
- ranges declarados cuja compatibilidade não pode ser provada;
- runtime incompatível entre dependente e dependência;
- pares explicitamente incompatíveis presentes ao mesmo tempo.

O analisador não interpreta SemVer parcial, metadata interna de JAR ou regras de loader. Um range não resolvido aparece como bloqueio verificável, nunca como compatibilidade presumida. Restrições incompatíveis são dados revisados, não inferências.

## 3. Quarentena de artefatos

O serviço de quarentena recebe bytes como stream e nunca executa, carrega ou descompacta o conteúdo. A raiz é absoluta e confiável na construção; o chamador fornece apenas IDs fechados e um filename simples.

Controles obrigatórios:

1. extensões permitidas por registro confiável;
2. limite de bytes aplicado durante o streaming, não somente por metadata;
3. comparação de tamanho declarado e SHA-256 esperado;
4. assinatura mínima de container ZIP para `.jar` e `.zip`;
5. staging exclusivo, `fsync`, rename e diretório final novo;
6. manifesto canônico separado com hash do payload;
7. rejeição de symlink, junction, hardlink e entrada especial;
8. ID existente é conflito e jamais é sobrescrito;
9. falha remove somente o staging conhecido;
10. payload permanece em quarantine; não existe operação de promover ou publicar.

A checagem de assinatura comprova apenas que o início do arquivo é compatível com um container ZIP. Ela não certifica estrutura interna, malware, licença, mod ID ou compatibilidade. Inspeção profunda terá um recorte futuro com parser limitado e isolamento próprio.

## 4. Arquivos em raízes autorizadas

O gerenciador conhece uma lista imutável de raízes registradas pelo operador. Cada raiz declara ID, path absoluto, extensões legíveis, extensões graváveis, limite de bytes e modo somente leitura ou versionado.

O recorte implementa somente:

- listagem limitada e ordenada de uma pasta relativa;
- leitura limitada de arquivo regular UTF-8;
- substituição de arquivo regular existente com SHA-256 esperado;
- revisão imutável dos bytes anteriores antes da troca;
- recibo sem conteúdo.

Não implementa criação, remoção, move, copy, download público, extração, alteração de permissões ou navegação por path absoluto. Para cada operação, a resolução canônica precisa permanecer na raiz registrada. Links, junctions, hardlinks, arquivos especiais, NUL, traversal, extensões não autorizadas e conteúdo binário são rejeitados. A escrita usa arquivo temporário exclusivo, verificação anterior e posterior e substituição com recuperação.

## 5. Schemas genéricos de configuração

Um schema genérico descreve um recurso e seus campos sem fornecer código executável. Formatos são metadata fechada: `java-properties`, `json`, `toml`, `yaml` ou `cfg`. O pacote não lê nem serializa nenhum desses formatos nesta fase.

Tipos de campo iniciais:

- `boolean`;
- `integer` com mínimo e máximo;
- `number` finito com mínimo e máximo;
- `string` com tamanho máximo e pattern limitado;
- `enum` com valores únicos.

Todo campo declara obrigatoriedade, valor padrão opcional, necessidade de restart e descrição curta opcional. O registro mantém revisões imutáveis em memória, exige hash esperado para atualizar um schema e rejeita IDs/revisões duplicados. A validação de valores rejeita chaves desconhecidas, valores ausentes, não finitos ou fora dos limites e informa de forma ordenada quais campos exigem restart.

O pacote não substitui `@voidfall/server-configuration`: aquele pacote continua sendo o único adaptador operacional do subconjunto Java Properties da Fase 3. Uma integração entre definição genérica e arquivo real exigirá adapter específico, persistência, autorização e testes próprios.

## Limites de confiança comuns

Esta conclusão não autoriza:

- ler `Launcher/workspace/` ou `Servidor/workspace/`;
- executar ou extrair JAR/ZIP;
- chamar CurseForge, Modrinth, GitHub ou outra rede;
- aprovar origem, licença, lado ou publicação automaticamente;
- expor endpoint, tela ou comando;
- gravar catálogo/schema no banco;
- conectar filesystem real do servidor;
- publicar build, manifesto ou canal;
- remover ou sobrescrever arquivos sem revisão recuperável.

Todos os testes de filesystem usam diretórios temporários controlados pelo próprio teste.

## Gate de conclusão

A Fase 4 somente pode ser marcada como concluída quando:

1. documentação e contratos acima estiverem versionados;
2. os quatro pacotes proprietários compilarem com TypeScript estrito;
3. classificação provar concorrência otimista e invariantes de revisão;
4. análise produzir resultado determinístico para dependências, duplicatas e conflitos;
5. quarentena provar limites de stream, hash/tamanho, assinatura e não sobrescrita;
6. file manager provar containment, rejeição de links/hardlinks e recuperação versionada;
7. schemas provarem histórico, conflito de revisão e validação estrita de valores;
8. o gate completo do monorepo passar em ambiente local;
9. a matriz Windows/Linux passar no GitHub Actions;
10. Graphify, roadmap, handoff e guia de agentes refletirem o estado final.

Concluir esse gate significa que os núcleos existem e são testáveis em isolamento. Não significa que os dados reais do modpack foram classificados, que um upload público está disponível ou que o servidor pode ser editado pelo painel.

## Resultado implementado

- `@voidfall/mod-catalog`: classificação por revisão humana com concorrência otimista e análise determinística de dependências, duplicatas e conflitos;
- `@voidfall/artifact-quarantine`: ingestão opaca de `.jar`/`.zip`, limite durante o stream, SHA-256, tamanho declarado, assinatura inicial, staging e identidade não sobrescrevível;
- `@voidfall/authorized-files`: registro fechado de raízes/extensões, listagem limitada, leitura UTF-8, substituição com hash esperado, revisão anterior e recuperação;
- `@voidfall/configuration-schemas`: schemas declarativos para cinco formatos, campos tipados, defaults, padrões fechados, histórico imutável em memória e validação de valores;
- raiz do monorepo: os três novos pacotes entram no build ordenado e nos gates de workspace.

## Validação local

| Pacote | Casos | Resultado no Windows local |
| --- | ---: | --- |
| `@voidfall/mod-catalog` | 19 | 19 aprovados |
| `@voidfall/artifact-quarantine` | 7 | 7 aprovados |
| `@voidfall/authorized-files` | 8 | 8 aprovados |
| `@voidfall/configuration-schemas` | 8 | 8 aprovados |
| monorepo completo | 125 | 123 aprovados e 2 sockets Unix ignorados |

`npm run check` passou com build, typecheck, testes e build dos aplicativos. `npm audit --omit=dev` encontrou zero vulnerabilidades de runtime. Os testes de filesystem usaram apenas raízes criadas em `os.tmpdir()` e não acessaram `Launcher/` nem `Servidor/workspace/`.
