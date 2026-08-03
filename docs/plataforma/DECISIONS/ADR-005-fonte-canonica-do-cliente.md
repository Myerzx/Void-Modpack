# ADR-005 — Fonte canônica do cliente

- Status: Aceito para planejamento
- Data: 2026-08-03

## Contexto

O servidor possui 181 JARs ativos, enquanto o launcher atual possui 23 e apenas 11 nomes coincidem. Copiar o servidor também carregaria mundo, dados privados, mods server-only e arquivos sem licença resolvida.

## Opções

1. Copiar e filtrar o runtime em cada build.
2. Usar um catálogo revisado como fonte e comparar o runtime apenas para drift.
3. Manter listas manuais independentes por launcher.

## Decisão

Escolher a opção 2. O catálogo canônico define arquivo, hash, lado, origem, licença, dependências e política de sanitização. Drift do servidor gera alerta/revisão.

## Motivo

Transforma uma heurística perigosa em decisão auditável e reproduzível, preservando independência de launcher.

## Consequências

- trabalho inicial de reconciliação do catálogo;
- `unknown` bloqueia stable;
- mudanças no runtime não entram automaticamente no cliente;
- adaptadores de exportação consomem o mesmo catálogo;
- a UI precisa permitir revisão manual com auditoria.

## Revisão futura

Detecção automática pode aumentar confiança, mas nunca substitui evidência de distribuição e teste de compatibilidade.
