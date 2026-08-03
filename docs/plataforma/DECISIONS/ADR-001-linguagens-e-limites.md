# ADR-001 — Linguagens e limites

- Status: Aceito para planejamento
- Data: 2026-08-03

## Contexto

Painel, APIs, agentes, worker e contratos compartilham muitos modelos. O comando dentro do Minecraft precisa integrar com Forge 1.20.1/Java 17.

## Opções

1. TypeScript para toda a plataforma e tentar controlar o comando externamente.
2. Java para todos os componentes.
3. TypeScript no plano de controle e Java somente na ponte Forge.

## Decisão

Escolher a opção 3. TypeScript estrito cobre web e serviços; Java 17 cobre somente código carregado pelo Forge. SQL representa migrações e constraints.

## Motivo

Maximiza contratos compartilhados sem forçar uma linguagem inadequada dentro do runtime Minecraft. Também reduz a superfície Java privilegiada.

## Consequências

- monorepo TypeScript com packages compartilhados;
- build Gradle independente para a ponte;
- contrato explícito entre Java e agente;
- CI precisa validar dois toolchains;
- nenhuma lógica de publicação ou filesystem amplo na ponte.

## Revisão futura

Revisar se o loader mudar, se uma API Forge necessária não existir ou se o agente exigir garantias que o runtime Node não oferece.
