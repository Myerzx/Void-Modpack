---
type: "query"
date: "2026-08-03T23:30:41.971177+00:00"
question: "Como a Fase 6 completa separa identidade UUID, permissoes Minecraft, moderacao, privacidade e auditoria encadeada?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["PlayerProfileRegistry", "MinecraftPermissionRegistry", "ModerationCaseRegistry", "PlayerDataPolicyEngine", "chainAuditEvent", "AuditRepository"]
---

# Q: Como a Fase 6 completa separa identidade UUID, permissoes Minecraft, moderacao, privacidade e auditoria encadeada?

## Answer

Expanded from graph vocabulary: [profile, uuid, permission, audit, moderation, privacy]. Phase 6 is represented by PlayerProfileRegistry, MinecraftPermissionRegistry, ModerationCaseRegistry and PlayerDataPolicyEngine in player-governance, plus storage-owned chainAuditEvent and transactional AuditRepository integration. The graph confirms separate provider/executor ports and shared AuditEvent validation without runtime player imports.

## Outcome

- Signal: useful

## Source Nodes

- PlayerProfileRegistry
- MinecraftPermissionRegistry
- ModerationCaseRegistry
- PlayerDataPolicyEngine
- chainAuditEvent
- AuditRepository