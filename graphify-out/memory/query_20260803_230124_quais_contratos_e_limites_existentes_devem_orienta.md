---
type: "query"
date: "2026-08-03T23:01:24.038423+00:00"
question: "Quais contratos e limites existentes devem orientar a Fase 6 completa de perfis UUID, permissoes, moderacao, privacidade e auditoria?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["UuidSchema", "ActorRefSchema", "AuditEventSchema", "PANEL_PERMISSIONS", "permissions", "roles"]
---

# Q: Quais contratos e limites existentes devem orientar a Fase 6 completa de perfis UUID, permissoes, moderacao, privacidade e auditoria?

## Answer

Expanded from original query via vocab: [profile, uuid, minecraft, permission, permissions, audit, authentication, identity, actor, event, role, roles]. The graph shows reusable boundaries in UuidSchema and ActorRefSchema (contracts/common.ts), AuditEventSchema with forbidden-key sanitation (contracts/audit-event.ts), and panel-specific RBAC in permissions/src/index.ts plus roles/permissions tables in 0001_foundation.sql. Phase 6 should reuse UUID/actor/audit contracts while keeping Minecraft permission bindings separate from panel roles and without coupling to launcher artifacts or release identity.

## Outcome

- Signal: useful

## Source Nodes

- UuidSchema
- ActorRefSchema
- AuditEventSchema
- PANEL_PERMISSIONS
- permissions
- roles