# ADR-012 — Credenciais, tickets de login e rotação de chaves

- Status: **aceita**
- Data: 2026-08-06
- Proprietário: `voidfall-product-owner`
- Resolve: pendência registrada no [ADR-009](ADR-009-autenticacao-minecraft-e-topologia.md) e no [ADR-011](ADR-011-dados-de-jogador-e-retencao.md)
- Bloqueia: qualquer login real até estar completo

## Contexto

O [ADR-009](ADR-009-autenticacao-minecraft-e-topologia.md) tornou obrigatória uma camada de autenticação offline e deixou aberto **onde a credencial mora**. O [ADR-011](ADR-011-dados-de-jogador-e-retencao.md) registrou que verificador de senha não é identidade, vínculo nem moderação, e portanto não está coberto pelo núcleo mínimo.

Existe um fato que muda o desenho e que a análise anterior não usou: **o VoidFall tem launcher próprio.** Isso remove a premissa de que a senha precisa atravessar o protocolo do Minecraft. Os mods de autenticação levantados no ADR-009 — `/register`, `/login`, senha digitada no chat — existem porque servidores cracked não controlam o cliente. Aqui controlamos.

Digitar senha no chat do Minecraft significa: a senha passa pelo protocolo do jogo, aparece em buffers de chat, pode ser capturada por qualquer mod cliente instalado e é registrada por qualquer coisa que logue pacotes. Nada disso é aceitável quando existe alternativa.

## Decisão

### 1. A credencial fica no VoidFall, em armazenamento próprio

Armazenamento de autenticação **separado** de identidade, vínculo Minecraft e moderação. Não é uma coluna de perfil.

A separação é estrutural, não cosmética: um vazamento da tabela de perfis não pode conter verificador, e uma consulta de moderação não passa perto de credencial. Ter a credencial ao lado do perfil é como uma leitura rotineira acaba tocando o material mais sensível que existe no sistema.

### 2. O verificador é Argon2id

| Propriedade | Regra |
| --- | --- |
| Função | Argon2id |
| Sal | único por credencial, nunca derivado da identidade |
| Parâmetros de custo | **versionados**, gravados junto do verificador |
| Rehash | quando a política de custo muda, no próximo login bem-sucedido |
| Rotação | suportada explicitamente |
| Revogação | explícita, imediata, invalida tickets em aberto |
| Purga | explícita, e independente da purga de perfil |

Parâmetros versionados junto do verificador é o que torna a política mudável sem invalidar todo mundo: um verificador antigo continua verificável com os parâmetros que o produziram, e o rehash acontece quando a pessoa comprova a senha de novo.

### 3. A senha nunca chega ao servidor Minecraft

O fluxo:

1. o **launcher** autentica no VoidFall com a credencial;
2. o VoidFall emite um **ticket de login** — curto, assinado, de uso único, vinculado a servidor, identidade e reivindicação Minecraft;
3. o launcher entrega o ticket ao entrar;
4. o **Forge Bridge valida o ticket localmente**, contra chave pública, sem consultar o VoidFall no caminho crítico do login;
5. a sessão passa a ter identidade autenticada.

O servidor **não armazena senha nem verificador**. Ele guarda apenas chaves públicas, proteção contra replay e a identidade autenticada da sessão.

Validar localmente é deliberado: um login que dependesse de uma chamada ao plano de controle falharia toda vez que a rede oscilasse, e a resposta a "não consegui perguntar" seria negar entrada a jogadores legítimos ou — pior — deixar entrar por otimismo.

### 4. O ticket

| Campo | Razão |
| --- | --- |
| identidade VoidFall | a quem o ticket pertence |
| servidor | um ticket para uma instância não vale em outra |
| reivindicação Minecraft esperada | liga o ticket ao UUID que a sessão vai apresentar |
| emissão e expiração | janela curta, medida em minutos |
| nonce | uso único |
| id da chave de assinatura | permite rotação sem invalidar o que está em voo |
| assinatura | Ed25519, como todo envelope do agente |

Vinculação tripla — servidor, identidade e reivindicação — porque um ticket que valesse em qualquer servidor seria uma chave mestra, e um que não nomeasse a reivindicação deixaria trocar de UUID entre a emissão e o uso.

### 5. Replay e rotação

- **Replay**: o Bridge mantém os nonces consumidos até a expiração do ticket. A janela é curta por desenho, então a memória é limitada. O `NonceStore` que o comando de build já usa é a mesma forma.
- **Rotação de chave**: o Bridge aceita um conjunto de chaves públicas, cada uma com id. Rotacionar publica a nova e mantém a anterior até os tickets em voo expirarem. Nenhum ticket válido é invalidado por rotação.
- **Revogação de credencial** invalida tickets em aberto daquela identidade. Como o Bridge valida localmente, a revogação só é imediata para tickets ainda não emitidos; os já emitidos expiram na janela curta. **Essa janela é o custo aceito da validação local**, e é por isso que ela é medida em minutos.

### 6. Nada disso permite login até estar completo

Enquanto o armazenamento de credencial e o protocolo de tickets não existirem, **não há login**. A capability fica indisponível com motivo nomeado, como toda a readiness da Fase 11.0. Um login pela metade é pior do que login nenhum: parece proteger e não protege.

## Consequências

- ADR-011 recebe emenda mínima reconhecendo credencial como categoria separada, sem ampliar o núcleo mínimo;
- a persistência de credencial é fatia própria, separada da persistência de jogadores;
- Argon2id não está na biblioteca padrão do Node nem na do Java 17; a dependência precisa ser escolhida e revisada, e essa escolha é pré-requisito da fatia;
- o Bridge ganha validação de ticket além do que faz hoje, reutilizando `NonceStore` e o mesmo Ed25519 do `BuildRequestSigner`;
- o launcher ganha um passo de autenticação antes de conectar — trabalho de Fase 12;
- a revogação tem latência igual à janela do ticket, registrada aqui como custo aceito;
- nenhum mod de autenticação de terceiro é necessário, e os candidatos levantados no ADR-009 ficam descartados: eles resolvem o problema de quem não controla o cliente.

## Não autorização

Este ADR não autoriza criar tabela, emitir ticket, alterar o launcher, instalar dependência, nem permitir qualquer login. Ele descreve o recorte que a fatia de implementação seguirá.
