# Contratos compartilhados

Status: implementação v1 iniciada na Fase 2 e ampliada nas Fases 4, 5, 6 e 7.0.

## Objetivo

`@voidfall/contracts` concentra os formatos que atravessam limites de confiança da plataforma VoidFall. O pacote produz simultaneamente tipos TypeScript, schemas JSON portáteis e validadores semânticos. Isso evita que painel, API, agente, worker, ponte Forge ou adaptadores de launcher criem formatos incompatíveis em paralelo.

Código: `Plataforma/packages/contracts/`.

## Limite de confiança

Um payload não se torna confiável apenas porque passou no schema. Cada consumidor deve executar, nesta ordem:

1. impor limite de bytes, content type e parsing JSON seguro no transporte;
2. validar `schemaVersion`, estrutura, formatos e campos adicionais;
3. executar o validador semântico específico do contrato;
4. verificar identidade, autenticação, autorização, nonce, prazo, hash e assinatura aplicáveis;
5. validar `payload` ou `parameters` com o schema específico da operação;
6. só então encaminhar a operação a um adaptador tipado e allowlisted.

Os contratos iniciais não acessam rede, banco, filesystem operacional nem processos. A presença de um tipo como `server.stop` em `Job` descreve um dado futuro; não autoriza implementar ou executar essa ação.

## Matriz de contratos

| Contrato | Produtor planejado | Consumidor planejado | Proteções iniciais |
| --- | --- | --- | --- |
| `Job` | Control API e scheduler | Server Agent ou Build Worker | idempotência, correlação, lease, tentativas e payload versionado |
| `AgentEnvelope` | Server Agent | Control API | identidade de agente/instância, nonce, validade, hash e metadados de assinatura |
| `DatapackLoadOrderObservationRequest/Acceptance/Command/Result` | cliente autorizado / Control API / job persistido / Server Agent | produtor e capability `datapack-load-order.observe` | análise/inventário pinados, idempotência pública, somente IDs/hashes/contagem, campos exatos, sem root, path, filename ou bytes |
| `ModCatalogEntry` | inventário revisado e catálogo | Build Worker e painel | path relativo, hash, lado, proveniência, licença, revisão e dependências |
| `InventorySnapshot` | exportador autorizado de cliente/servidor | reconciliador de catálogo | fonte/escopo explícitos, runtime, paths canônicos, estado, tamanho e hash sem dados privados |
| `CatalogReconciliationReport` | reconciliador determinístico | revisão futura, worker e painel | identidade de conteúdo, ocorrências, sugestão de lado, conflitos e bloqueios ordenados |
| `ModCompatibilityAnalysisPlan` | tooling sanitizado de modpack | analisador contextual | contextos, lado, runtime, ocorrência, loader, contêiner JarJar e dependência por ocorrência |
| `ModCompatibilityReport` | analisador contextual determinístico | revisão futura e Fase 7.1 | status compatível/incompatível/desconhecido, findings tipados e totais verificáveis |
| `ReleaseManifest` | Build Worker após gates | Launcher API e adaptadores | identidade VoidFall, artifacts por hash, paths canônicos, remoção explícita e assinatura |
| `AuditEvent` | todos os componentes autorizados | armazenamento append-only e painel | ator, recurso, correlação, resultado, integridade opcional e bloqueio de chaves secretas |
| `PlayerProfile` | fonte autorizada de observações | domínio de jogadores e futura API | UUID, revisão, aliases limitados, origem e ordem canônica |
| `MinecraftPermissionBinding` | operação administrativa autorizada | adapter futuro do provider Forge | grupos separados do painel, baseline `player`, revisão e recibo correlacionado |
| `ModerationCase` | moderação autorizada | executor futuro do Forge Bridge | ação tipada, motivo, expiração e evidência de transição |
| `PlayerDataPolicy` | proprietário da política | consumidores futuros de dados sensíveis | finalidade, aprovação, três categorias, retenção e export separado |
| `AuditChainExportManifest` | armazenamento de auditoria | verificador/storage imutável | partição, intervalo contíguo, hashes da cadeia e conteúdo NDJSON |

## Invariantes implementadas

### `Job`

- rejeita propriedades de topo não declaradas;
- `attempt` não pode exceder `maxAttempts`;
- estado `running` exige lease;
- expiração do lease deve ser posterior à aquisição;
- término não pode preceder o início.

O objeto `parameters` é extensível para permitir contratos especializados. Nenhum consumidor pode interpretá-lo antes de validar o schema da operação correspondente.

### `AgentEnvelope`

- associa mensagem, correlação, agente e instância por UUID;
- exige nonce, hash SHA-256 do payload e metadados Ed25519;
- expiração deve ser posterior à emissão.

O validador atual não confirma assinatura, conteúdo do hash, replay, relógio observado ou certificado mTLS. Essas verificações pertencem à futura camada de identidade do agente.

### `ModCatalogEntry`

- path relativo e basename coerente com `filename`;
- decisão `allowed` exige licença, evidência, revisor e timestamp;
- `unknown`, `server`, distribuição não aprovada ou item não revisado impede stable;
- tamanho, hash, runtime e dependências são explícitos.

Esse contrato registra uma decisão de distribuição; ele não descobre nem concede licença automaticamente.

### `InventorySnapshot`

- fonte diferencia exportação do launcher, servidor, release anterior ou importação revisada;
- `launcher-export` e `release-manifest` exigem escopo cliente; `server-export` exige servidor;
- entrada contém somente path relativo, filename, tipo, estado, bytes e SHA-256;
- basename precisa coincidir e os paths devem ser únicos e estritamente ordenados após normalização cross-platform;
- snapshot vazio é válido como observação, sem provar ausência global;
- não inclui path absoluto, arquivo, segredo, jogador, licença ou decisão final de lado.

### `CatalogReconciliationReport`

- `artifactId` deriva exclusivamente do SHA-256;
- entradas lógicas, filenames, observações, bloqueios e artefatos são únicos e canonicamente ordenados;
- estados `cataloged`, `untracked` e `ambiguous` não são convertidos silenciosamente;
- `suggestedSide` é evidência e não substitui o lado revisado;
- resumo precisa corresponder exatamente aos artefatos;
- o relatório não concede autorização de publicação.

### `ModCompatibilityAnalysisPlan` e `ModCompatibilityReport`

- exigem exatamente um contexto `launcher_current` cliente e um `server_active` servidor;
- preservam referência e histórico sem tratá-los como conflitos canônicos;
- cada ocorrência conserva loader e contêiner `root` ou `jarjar`; bibliotecas JarJar não herdam silenciosamente a identidade do JAR externo;
- dependências pertencem à ocorrência que declarou o metadado e conservam lado e range;
- relatório diferencia conflito canônico, divergência de referência/histórico, loader incompatível, ausência e range incompatível/desconhecido;
- componentes ou ranges sem evidência suficiente permanecem `unknown` e não podem ser promovidos por inferência.

O contrato não abre JARs nem workspaces. A análise recebe somente objetos sanitizados em memória.

### `ReleaseManifest`

- identidade literal `voidfall`/`VoidFall`;
- SemVer e build ID previsível;
- apenas arquivos de cliente ou ambos;
- paths relativos, únicos após normalização cross-platform e ordenados;
- `artifactId` deve ser derivado do SHA-256;
- um path não pode ser entregue e removido na mesma release;
- endereço do servidor e credenciais não fazem parte do manifesto.

O manifesto é independente do launcher. Adaptadores resolvem `artifactId` pela Launcher API e aplicam apenas arquivos gerenciados pelo protocolo.

### `AuditEvent`

- ator, origem, ação, recurso, resultado e correlação são obrigatórios;
- dados before/after/metadata são objetos JSON sanitizados;
- nomes de campos associados a senha, secret, token, authorization e cookie são rejeitados em qualquer profundidade;
- hash de integridade encadeada é opcional até a persistência ser implementada.

Redação por nome de campo é uma defesa adicional, não substitui sanitização no produtor nem testes de vazamento.

### `PlayerProfile`

- UUID é a chave e alias é somente observação;
- `normalizedName` precisa derivar do alias e ser único case-insensitive;
- aliases são estritamente ordenados e limitados a 64;
- primeira/última observação e revisão não podem regredir.

### `MinecraftPermissionBinding`

- binding não revogado exige grupo basal `player`;
- grupos são únicos, ordenados e pertencem ao domínio Minecraft;
- estado sincronizado/falho exige recibo de provider coerente;
- binding pendente/revogado não aceita recibo fabricado.

### `ModerationCase`

- aceita somente warning, mute, kick, ban temporário ou permanente;
- mute/ban temporário exigem expiração; ações instantâneas/permanentes a proíbem;
- transição precisa corresponder ao estado e falha exige `errorCode` seguro;
- não existe campo de comando, seletor ou payload extensível.

### `PlayerDataPolicy`

- contém exatamente atividade, chat e coordenadas em ordem canônica;
- coleta permitida exige retenção máxima entre 60 segundos e um ano;
- categoria desabilitada não possui retenção nem export;
- política aprovada exige ator, aprovação e vigência coerentes.

O contrato não contém mensagem, comando, coordenada ou payload de observação.

### `AuditChainExportManifest`

- intervalo de sequência é contíguo e corresponde à quantidade;
- algoritmo é `sha256-chain-v1` e conteúdo é NDJSON UTF-8;
- registra âncora anterior, hash final e SHA-256 do conteúdo;
- o manifesto comprova integridade interna, não autorização de leitura ou imutabilidade externa.

## Schemas portáteis

`npm run build` gera em `Plataforma/packages/contracts/dist/schemas/`:

- `job.schema.json`;
- `agent-envelope.schema.json`;
- `mod-catalog-entry.schema.json`;
- `mod-compatibility-analysis-plan.schema.json`;
- `mod-compatibility-report.schema.json`;
- `inventory-snapshot.schema.json`;
- `catalog-reconciliation-report.schema.json`;
- `release-manifest.schema.json`;
- `audit-event.schema.json`;
- `audit-chain-export-manifest.schema.json`;
- `minecraft-permission-binding.schema.json`;
- `moderation-case.schema.json`;
- `player-data-policy.schema.json`;
- `player-profile.schema.json`.

`dist/` é derivado e não entra no Git. Os `$id` usam o domínio reservado `.invalid` como identificadores estáveis, não como endpoints de rede.

## Compatibilidade

- `schemaVersion` pertence ao documento e começa em `1`;
- o pacote começa em `0.1.0` e permanece privado enquanto as integrações não forem implementadas;
- mudanças aditivas compatíveis podem permanecer no schema v1 com testes;
- remoção, mudança semântica ou tipo incompatível exige schema v2 e período de compatibilidade entre produtores e consumidores;
- schemas antigos publicados com uma release permanecem imutáveis;
- TypeScript, JSON Schema e fixtures devem mudar no mesmo commit.

## Validação local

```powershell
cd Plataforma
npm ci
npm run check
npm pack --workspace @voidfall/contracts --dry-run
```

O check executa typecheck, testes e geração dos 17 schemas. A revisão seguinte deve começar por esses comandos e pelo [handoff](HANDOFF.md).
