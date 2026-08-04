# `@voidfall/contracts`

Contratos versionados entre painel, APIs, agentes, worker, ponte Forge e adaptadores de launcher do VoidFall.

## Conteúdo inicial

- `Job`: unidade durável de trabalho, sem autorizar execução arbitrária;
- `AgentEnvelope`: envelope assinado e correlacionado para mensagens de agente;
- `ModCatalogEntry`: proveniência, lado, dependências e decisão de distribuição;
- `ModCompatibilityAnalysisPlan` e `ModCompatibilityReport`: contextos canônicos,
  referência/histórico, ocorrências por loader, JarJar e findings conservadores;
- `ReleaseManifest`: release imutável e independente de launcher;
- `AuditEvent`: evento sanitizado e append-only de auditoria.

Cada contrato exporta um tipo TypeScript, um schema JSON e uma função de validação. O build também grava os schemas portáteis em `dist/schemas/`.

Validação de contrato não equivale a confiança: assinatura, hash do payload, nonce, identidade mTLS, prazo observado e autorização ainda precisam ser verificados pelos serviços responsáveis antes de qualquer efeito externo.

## Comandos

```powershell
npm install
npm run check
```

Execute os comandos a partir de `Plataforma/`. Os validadores apenas verificam dados em memória; eles não acessam rede, filesystem operacional, banco ou processos.

## Evolução

Mudanças aditivas compatíveis permanecem em `schemaVersion: 1`. Remoções, mudanças de significado ou alterações incompatíveis exigem nova versão de schema e fixtures de compatibilidade. Payloads extensíveis precisam de um schema específico antes de serem consumidos por uma operação. Compatibilidade desconhecida permanece `unknown`; validação estrutural nunca a promove a compatível.
