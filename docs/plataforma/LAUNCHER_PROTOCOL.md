# Protocolo do launcher

## Objetivo

Permitir atualização incremental, íntegra e recuperável em qualquer launcher que implemente o protocolo, sem assumir diretórios privados de CurseForge, Prism, Modrinth App ou outro produto.

Status: contratos, assinatura/verificação, estado gerenciado, planner portátil e Launcher API somente leitura estão implementados e testados em isolamento. Nenhuma release real foi publicada.

## Endpoints públicos planejados

- `GET /launcher/v1/channels/{channel}`: ponteiro assinado para a release atual.
- `GET /launcher/v1/releases/{version}/{buildId}/manifest`: manifesto imutável.
- `GET /launcher/v1/artifacts/{artifactId}`: download ou redirecionamento temporário.

O canal pode ser `stable`, `beta` ou outro nome configurado. A resposta pública não contém credencial administrativa nem endereço interno do servidor.

## Documento de canal

```json
{
  "schemaVersion": 1,
  "channel": "stable",
  "revision": 42,
  "releaseVersion": "1.1.0",
  "buildId": "build-20260803-012900",
  "manifestUrl": "https://updates.example.invalid/launcher/v1/releases/1.1.0/build-20260803-012900/manifest",
  "publishedAt": "2026-08-03T04:29:00Z",
  "signature": {
    "algorithm": "Ed25519",
    "keyId": "release-2026-01",
    "value": "base64url-signature"
  }
}
```

Valores são ilustrativos e o domínio `.invalid` não é um endereço real.

## Manifesto inicial

```json
{
  "schemaVersion": 1,
  "product": {
    "id": "voidfall",
    "displayName": "VoidFall"
  },
  "release": {
    "version": "1.1.0",
    "buildId": "build-20260803-012900",
    "previousVersion": "1.0.1",
    "publishedAt": "2026-08-03T04:29:00Z",
    "message": "Atualização de conteúdo"
  },
  "runtime": {
    "minecraft": "1.20.1",
    "loader": "forge",
    "loaderVersion": "1.20.1-47.4.4",
    "javaMajor": 17
  },
  "serverProfile": {
    "id": "voidfall-primary",
    "displayName": "VoidFall"
  },
  "files": [
    {
      "path": "mods/example.jar",
      "artifactId": "sha256:0123456789abcdef",
      "size": 123456,
      "sha256": "64-lowercase-hex-characters",
      "kind": "mod",
      "side": "both",
      "required": true
    }
  ],
  "removedPaths": ["mods/old-example.jar"],
  "signature": {
    "algorithm": "Ed25519",
    "keyId": "release-2026-01",
    "value": "base64url-signature"
  }
}
```

Os contratos estão implementados e versionados em `Plataforma/packages/contracts`. O build exporta `release-manifest.schema.json`, `launcher-channel.schema.json` e `launcher-managed-state.schema.json` para consumidores que não usam TypeScript. O payload assinado usa JSON canônico UTF-8 excluindo o próprio campo `signature`; assinatura e verificação Ed25519 estão em `@voidfall/modpack-release`, e o pin de chaves está em `@voidfall/launcher-protocol`.

## Algoritmo de atualização

1. Buscar o canal por HTTPS.
2. Validar schema, chave conhecida, assinatura, prazo e monotonicidade da revisão.
3. Buscar o manifesto imutável indicado.
4. Validar assinatura e coerência entre canal e manifesto.
5. Ler o estado local gerenciado pelo protocolo.
6. Calcular plano: manter, baixar, substituir e remover.
7. Não tocar em arquivo que não esteja no estado gerenciado anterior nem no novo manifesto.
8. Baixar para staging com limite de tamanho e retomada segura.
9. Validar tamanho e SHA-256 antes de promover cada arquivo.
10. Criar ponto de rollback dos arquivos gerenciados alterados.
11. Aplicar mudanças por rename atômico quando o sistema permitir.
12. Validar novamente a instalação resultante.
13. Gravar o novo estado local somente no final.
14. Em falha, restaurar o estado anterior e conservar diagnóstico sanitizado.

## Propriedade de arquivos

O launcher mantém um arquivo interno de estado com versão, build, paths e hashes que ele próprio gerencia. `removedPaths` é apenas uma declaração adicional; uma remoção só ocorre quando o path também era gerenciado pela versão local anterior.

Assim, screenshots, saves locais, opções pessoais e mods adicionados manualmente não são apagados silenciosamente. Uma política separada pode bloquear mods extras em modo competitivo, mas deve avisar antes de alterar qualquer coisa.

## Segurança

- HTTPS obrigatório em produção;
- pin de chaves públicas de assinatura por `keyId`;
- rotação com período de sobreposição;
- manifesto e artefatos imutáveis;
- hash verificado antes e depois da aplicação;
- path relativo normalizado, sem `..`, path absoluto, dispositivo Windows ou symlink externo;
- limite de arquivo, pacote total, tempo e taxa;
- URLs de artefato restritas a origens aprovadas;
- nenhuma execução de JAR durante a inspeção ou download.

## Compatibilidade entre launchers

O protocolo não depende de metadados privados de um launcher. Adaptadores de exportação poderão gerar CurseForge, Modrinth ou pacote genérico a partir do mesmo catálogo, mas cada formato passa por testes próprios de importação. Uma exportação válida não certifica launch nem multiplayer.

O adaptador oficial desta fase é `portable-v1`: ele recebe canal, manifesto e estado gerenciado anterior, verifica assinatura/revisão/coerência e devolve operações ordenadas `keep`, `download`, `replace` e `remove`. A remoção só é emitida quando o path existia no estado gerenciado e aparece em `removedPaths`; uma omissão ambígua bloqueia o plano.

## Serviço executável

`@voidfall/launcher-api` expõe somente:

- `GET /health/live`;
- `GET /launcher/v1/channels/{channel}`;
- `GET /launcher/v1/releases/{version}/{buildId}/manifest`;
- `GET /launcher/v1/artifacts/{artifactId}`.

O serviço exige `VOIDFALL_RELEASE_REPOSITORY_ROOT` absoluto e `VOIDFALL_RELEASE_PUBLIC_KEYS_JSON` com chaves públicas Ed25519. A chave privada não pertence à API. Canal usa cache curto; manifestos e artifacts usam cache imutável e ETag derivado de SHA-256. Não existem rotas de upload, promoção, rollback ou execução nesse serviço.
