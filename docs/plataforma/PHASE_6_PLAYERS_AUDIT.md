# Fase 6 — jogadores, privacidade e auditoria

Status: conclusão técnica em isolamento em 2026-08-03; gate local e matriz Windows/Linux aprovados, integrações operacionais bloqueadas.

## Objetivo e recorte

A Fase 6 cria os domínios de identidade de jogador, aliases observados, grupos do Minecraft, moderação, decisão de tratamento de dados e auditoria encadeada. O recorte é deliberadamente independente do runtime privado: nenhum componente lê `usercache.json`, `usernamecache.json`, `whitelist.json`, logs, chat, coordenadas, mundos ou arquivos de mods.

A identidade estável é o UUID do Minecraft. Nome é somente um alias observado e nunca autentica, autoriza, vincula conta do painel ou concede grupo. RBAC do painel e grupos do Minecraft continuam domínios distintos.

## Seis entregas técnicas

1. **Perfis por UUID:** snapshot versionado, estado de ciclo de vida e concorrência otimista.
2. **Aliases observados:** histórico limitado, origem explícita e união case-insensitive sem transformar nome em identidade.
3. **Permissões Minecraft:** estado desejado por instância e porta de provider deny-by-default; nenhum provider Forge é escolhido nesta fase.
4. **Moderação:** casos tipados e máquina de estados para aviso, mute, kick e ban, sem aceitar texto de comando.
5. **Dados de jogador:** decisão de coleta, visualização e exportação para atividade, chat e coordenadas; sem payload sensível ou persistência de observações neste recorte.
6. **Auditoria:** cadeia SHA-256 por partição, verificação determinística e exportação NDJSON com manifesto de integridade.

## Componentes

| Componente | Responsabilidade | Efeito permitido |
| --- | --- | --- |
| `@voidfall/contracts` | schemas v1 que atravessarão API, agente, bridge e storage | validação estrutural e semântica |
| `@voidfall/player-governance` | registros puros de perfil, binding, moderação e política | somente memória; nenhuma rede ou filesystem |
| `@voidfall/audit-chain` | encadear, verificar e exportar eventos sanitizados | somente memória e bytes retornados ao chamador |
| `@voidfall/database` | persistência encadeada da auditoria administrativa existente | PostgreSQL/PGlite; sem tabelas de chat ou coordenadas |

Control API, Server Agent, Forge Bridge e painel não serão conectados aos novos domínios nesta fase. Uma integração posterior precisará de endpoints estreitos, autenticação, autorização, idempotência, rate limit e auditoria de leitura sensível.

## Contratos e invariantes

### Perfil e alias

- UUID canônico em minúsculas é a chave; aliases não são únicos globalmente.
- Alias segue o formato de nome Minecraft, registra primeira/última observação, contagem, instância e origem autorizada.
- Observações são idempotentes por `operationId`, limitadas por perfil e aplicadas com `expectedRevision`.
- O registro não escolhe “dono” de um nome e não consulta serviços Mojang/Microsoft.

### Binding de grupos

- todo estado desejado não revogado inclui o grupo basal `player`;
- grupos são IDs canônicos, únicos e ordenados;
- criar perfil não cria binding e vincular usuário do painel não concede grupo;
- o provider entra somente por dependência confiável e recebe operação tipada;
- provider ausente, resposta divergente ou permissão desconhecida produz negação/falha, nunca concessão implícita;
- sincronização registra provider, revisão, horário e recibo opaco limitado, sem comando de console.

### Moderação

- toda ação possui UUID do alvo, instância, ator, motivo humano e `reasonCode`;
- `mute` e `temporary-ban` exigem expiração futura; ações permanentes ou instantâneas a proíbem;
- transições usam revisão esperada e uma allowlist; falha de executor não vira sucesso;
- o executor futuro recebe uma ação estruturada, nunca string, seletor ou comando Minecraft;
- warning/kick concluídos são fatos históricos e não podem ser “desfeitos”.

### Política de dados

- sem política aprovada e vigente, coleta, leitura e exportação são negadas;
- política é versionada, possui finalidade explícita e uma regra por categoria;
- regra habilitada define retenção máxima e permissão do painel para leitura;
- exportação começa desabilitada separadamente da coleta;
- a decisão calcula expiração e retorna metadados, mas não recebe nem armazena mensagem, comando ou coordenada;
- coordenadas significam localização virtual no jogo, não localização física;
- acesso permitido a dado sensível ainda exigirá evento de auditoria no consumidor futuro.

### Cadeia e exportação de auditoria

- somente `AuditEvent` v1 sem `integrity` fornecida pelo produtor pode ser anexado;
- a camada de storage é dona de `previousHash` e `eventHash`;
- o hash cobre algoritmo, partição, sequência, hash anterior e JSON canônico do evento sanitizado;
- sequência é contígua e monotônica por partição; partições não compartilham cabeça;
- verificação rejeita lacuna, duplicata, evento alterado e quebra do hash anterior;
- exportação usa NDJSON canônico e manifesto com intervalo, hashes inicial/final, quantidade e SHA-256 do conteúdo;
- hash encadeado detecta alteração, mas não substitui controle de acesso, backup imutável, assinatura externa ou carimbo de tempo confiável.

## Classificação e minimização

| Dado | Classe | Persistência neste recorte |
| --- | --- | --- |
| UUID | identificador de jogador | snapshot puro; futuro banco autorizado |
| alias | identificador observado | histórico puro, limitado |
| grupo Minecraft | autorização de gameplay | estado desejado puro |
| motivo/caso de moderação | dado administrativo restrito | estado puro |
| atividade | dado pessoal de jogo | **nenhum payload** |
| chat | conteúdo sensível | **nenhum payload** |
| coordenadas | localização virtual sensível | **nenhum payload** |
| auditoria administrativa sanitizada | segurança/compliance | cadeia no repositório existente |

Segredos, IP, token, cookie, senha, texto de chat, coordenadas, path privado e conteúdo de arquivo permanecem proibidos nos novos snapshots e exports.

## Gates externos preservados

Continuam bloqueados:

- importação de qualquer arquivo ou estado do servidor privado;
- autenticação ou vínculo de conta Minecraft antes da decisão online-mode/proxy;
- escolha e instalação de provider de permissões Forge antes de ADR e teste real 1.20.1;
- aplicação real de grupo, kick, mute ou ban;
- coleta de atividade, chat ou coordenadas antes de política jurídica/operacional com prazos;
- endpoint ou tela de leitura sensível;
- exportação para storage externo antes de autorização, criptografia, retenção e imutabilidade;
- uso de nome como prova de identidade e promoção automática entre papel do painel e grupo Minecraft.

## Gate técnico de conclusão

A fase pode ser marcada como tecnicamente concluída em isolamento quando:

1. schemas portáteis e validadores semânticos cobrem os cinco novos documentos;
2. registros puros aplicam limites, idempotência, revisão e deny-by-default;
3. adapters de provider/moderação são apenas portas tipadas testadas com fakes;
4. política ausente ou expirada nega todas as operações de dados;
5. cadeia detecta adulteração e exporta conteúdo reproduzível;
6. `AuditRepository` encadeia eventos novos por transação sem aceitar hash do produtor;
7. build, typecheck, testes, pack e auditoria passam em Windows e Linux;
8. documentação, handoff, roadmap e Graphify refletem os limites reais.

Conclusão técnica não autoriza conexão ao Forge, ingestão de jogadores reais ou exposição no painel.

## Validação executada

- `@voidfall/contracts`: 31 testes, 15 JSON Schemas, typecheck, build e pack seco;
- `@voidfall/player-governance`: 12 testes, typecheck, build e pack seco;
- `@voidfall/audit-chain`: 7 testes, typecheck, build e pack seco;
- `@voidfall/database`: 3 testes PGlite, incluindo appends concorrentes, verificação e export;
- gate integral: 178 casos descobertos, 176 aprovados no Windows e dois sockets Unix ignorados;
- builds de pacotes, apps, Forge Bridge Java 17 e painel estático aprovados;
- `npm audit --omit=dev`: zero vulnerabilidades de runtime.
- matriz final aprovada em Ubuntu e Windows: [execução 30862534188](https://github.com/Myerzx/Void-Modpack/actions/runs/30862534188).
