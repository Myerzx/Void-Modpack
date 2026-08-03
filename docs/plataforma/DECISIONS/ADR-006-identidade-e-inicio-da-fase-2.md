# ADR-006 — Identidade VoidFall e início limitado da Fase 2

- Status: Aceito
- Data: 2026-08-03

## Contexto

A arquitetura precisava de uma identidade única para nomes públicos, IDs estáveis, pacotes e manifestos. O proprietário também autorizou o início de uma nova fase, enquanto outros P0 de compatibilidade, distribuição e segurança operacional ainda permanecem abertos.

## Decisão

1. O nome oficial do produto e do modpack é **VoidFall**.
2. O identificador de máquina é `voidfall` e o namespace dos pacotes internos é `@voidfall/*`.
3. O versionamento das releases do modpack segue SemVer; a versão dos schemas é independente e explícita em cada documento.
4. A Fase 2 começa por uma fatia sem efeitos externos: toolchain TypeScript e contratos compartilhados com testes.
5. Os P0 restantes não são considerados resolvidos por esta autorização. Eles continuam bloqueando publicação stable, autenticação real, RCON, controle de processos e integração com o runtime.

## Motivo

Uma identidade estável elimina divergência entre launcher, servidor, pacote e futura plataforma. O recorte inicial transforma as decisões da Fase 1 em interfaces verificáveis sem ampliar a superfície privilegiada nem depender de decisões operacionais pendentes.

## Consequências

- documentação, pacotes e manifestos usam VoidFall de forma consistente;
- renomear o produto no futuro exigirá novo ADR e estratégia de compatibilidade para IDs persistidos;
- contratos podem evoluir antes dos serviços, mas mudanças incompatíveis exigem nova versão de schema;
- nenhuma capacidade operacional é implicitamente autorizada pela existência dos contratos.

## Revisão futura

Revisar somente se houver mudança formal de marca, namespace ou estratégia de versionamento. A liberação de novos recortes da Fase 2 deve ser registrada no roadmap e no handoff, sem alterar esta decisão retroativamente.
