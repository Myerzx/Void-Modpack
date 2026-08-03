---
type: "query"
date: "2026-08-03T19:18:08.287309+00:00"
question: "Como o backup e o restore isolado da Fase 3 se conectam no grafo?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["FilesystemBackupService", "CreateBackupPlan", "RestoreBackupPlan", "OfflineExclusiveBackupGuard", "BackupManifest", "server-backup.test.ts"]
---

# Q: Como o backup e o restore isolado da Fase 3 se conectam no grafo?

## Answer

O grafo conecta FilesystemBackupService aos planos CreateBackupPlan e RestoreBackupPlan, à guarda OfflineExclusiveBackupGuard, ao BackupManifest e à suíte server-backup.test.ts; a documentação da Fase 3 também contém as seções de implementação, preflight, manifesto, fluxos e gate.

## Outcome

- Signal: useful

## Source Nodes

- FilesystemBackupService
- CreateBackupPlan
- RestoreBackupPlan
- OfflineExclusiveBackupGuard
- BackupManifest
- server-backup.test.ts