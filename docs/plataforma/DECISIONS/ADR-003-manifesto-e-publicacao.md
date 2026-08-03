# ADR-003 — Manifesto e publicação

- Status: Aceito para planejamento
- Data: 2026-08-03

## Contexto

Launchers diferentes precisam obter a mesma release, verificar bytes e recuperar falhas sem apagar arquivos pessoais.

## Opções

1. ZIP mutável em uma URL fixa.
2. Manifesto versionado com artifacts imutáveis, hashes e assinatura.
3. Copiar o servidor diretamente a cada atualização.

## Decisão

Escolher a opção 2. Releases são imutáveis, arquivos usam SHA-256, o manifesto usa schema versionado e assinatura Ed25519, e canais são ponteiros atômicos revisionados.

## Motivo

Permite update incremental, cache, integridade, rollback e adaptadores de launcher sem acoplar o catálogo ao formato de uma plataforma.

## Consequências

- gerenciamento e rotação de chaves;
- JSON canônico para assinatura;
- estado local de propriedade de arquivos;
- artifacts nunca reescritos;
- rollback muda ponteiro;
- testes de cada adaptador continuam obrigatórios.

## Revisão futura

Algoritmo de assinatura e canonicalização exigem revisão independente antes da implementação final.
