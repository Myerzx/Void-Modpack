---
type: "query"
date: "2026-08-04T21:16:51.850042+00:00"
question: "entendi, sobre isso algumas versao podem ser diferente, mas dentro do jogo funciona, entao nao fique muito preso nestá parte, vamos continuar"
contributor: "graphify"
outcome: "useful"
source_nodes: ["PersistentConfigurationService", "ConfigurationRepository", "OperationalLockRepository", "appendAuditRecord()", "createReviewedConfigurationResource()"]
---

# Q: entendi, sobre isso algumas versao podem ser diferente, mas dentro do jogo funciona, entao nao fique muito preso nestá parte, vamos continuar

## Answer

Expanded from the original request via graph vocabulary: [persistent, configuration, service, prepare, applied, reviewed, codec, mutation, audit, lock]. Phase 7.2 is complete in isolation: the closed reviewed OpenLoader codec registry feeds safe filesystem mutations; ConfigurationRepository persists reviewed schemas, resources, prepared/applied/failed revisions and optimistic application state; OperationalLockRepository supplies the shared leased minecraft-exclusive lock; PersistentConfigurationService coordinates prepare, apply or rollback, failure, atomic chained audit and release without persisting configuration values. Tests use PGlite and temporary directories only. Phase 7.3 is next; runtime version differences remain evidence for smoke testing rather than blocking isolated platform development.

## Outcome

- Signal: useful

## Source Nodes

- PersistentConfigurationService
- ConfigurationRepository
- OperationalLockRepository
- appendAuditRecord()
- createReviewedConfigurationResource()