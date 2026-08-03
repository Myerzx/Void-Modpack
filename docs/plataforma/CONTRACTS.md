# Contratos compartilhados

Status: implementação inicial v1 na Fase 2.

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
| `ModCatalogEntry` | inventário revisado e catálogo | Build Worker e painel | path relativo, hash, lado, proveniência, licença, revisão e dependências |
| `ReleaseManifest` | Build Worker após gates | Launcher API e adaptadores | identidade VoidFall, artifacts por hash, paths canônicos, remoção explícita e assinatura |
| `AuditEvent` | todos os componentes autorizados | armazenamento append-only e painel | ator, recurso, correlação, resultado, integridade opcional e bloqueio de chaves secretas |

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

## Schemas portáteis

`npm run build` gera em `Plataforma/packages/contracts/dist/schemas/`:

- `job.schema.json`;
- `agent-envelope.schema.json`;
- `mod-catalog-entry.schema.json`;
- `release-manifest.schema.json`;
- `audit-event.schema.json`.

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

O check executa typecheck, testes e geração dos cinco schemas. A revisão seguinte deve começar por esses comandos e pelo [handoff](HANDOFF.md).
