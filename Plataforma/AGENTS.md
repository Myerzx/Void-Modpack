# Platform implementation agent guide

## Current phase

Phase 2, all six Phase 3 items, all six Phase 4 items, all seven Phase 5 items, all six Phase 6 technical items and Phase 7.0 are complete in isolation. The contextual compatibility audit is published in `docs/modpack/`: 299 components, 298 artifacts and 1,363 context-specific dependency declarations, with four canonical incompatibilities and unknown evidence kept distinct. Regeneration uses committed sanitized fixtures and does not access private runtimes. Five schema candidates remain unselected. No player data was imported and no Minecraft provider or executor is connected. The remaining work is ordered in `docs/plataforma/FINAL_IMPLEMENTATION_PLAN.md`. The next safe recut is Phase 7.1: record an ADR selecting the first configuration schema; do not infer that choice or begin API/panel work. Platform work must not inspect/execute private JARs, call real providers, import the current client or player files, collect chat/coordinates, publish `stable`, install the Bridge or enable `/atualizar-modpack`. Existing operational restrictions remain in force.

## Ownership

- `Plataforma/**`: implementation root for packages and applications.
- `docs/plataforma/**`: canonical architecture, contracts, decisions, roadmap, and handoff.
- `Launcher/**` and `docs/launcher/**`: client pack scope; do not modify from a platform task without a coordinator handoff.
- `Servidor/workspace/**`: immutable private runtime evidence; never edit, stage, package, or expose it.
- `Servidor/**` and `docs/servidor/**`: dedicated-server scope; changes require a server handoff.

## Decision rules

1. TypeScript is the control-plane language; Java 17 is limited to the Forge bridge.
2. A recorded ADR may only be superseded by a new ADR that explains the migration.
3. Shared API and event contracts must be versioned and validated at every trust boundary.
4. No web service may execute arbitrary shell text. Process adapters use fixed executables, argument arrays, allowlists, timeouts, and audit events.
5. The live server directory is evidence, not the canonical client build source.
6. Unknown mod side, origin, license, or dependency blocks stable publication.
7. Panel roles and Minecraft permission groups remain separate domains.
8. Large packages, logs, worlds, and backups stay outside PostgreSQL.
9. Product identity is `VoidFall`; use `voidfall` for stable machine identifiers and `@voidfall/*` for internal package names.
10. A contract that accepts extensible JSON does not authorize executing, interpolating, or persisting that data without a narrower operation-specific schema.
11. `packages/minecraft-process` launch plans accept trusted configuration only; tests may execute the committed Java fixture in an OS temp directory, never the private Minecraft runtime.
12. The Panel Web is a static Phase 2 fixture. Never present its sample values as server telemetry.
13. Process controller idempotency and exclusion are currently in-memory only. Do not represent them as durable or safe across agent restarts until persistence, locking, PID reconciliation, and crash tests exist.
14. Console callers provide only `list-players` or `save-all`; never add a string command parameter. Console snapshots require redaction, authorization, audit, and retention policy before external exposure.
15. Configuration callers may select only a registered `resourceId` and typed known fields. Paths, schemas, formats, restart policy and limits come from trusted construction; revision and error metadata never expose configuration values.
16. Minecraft UUID is player identity; aliases are observations only and never authenticate, authorize or link a panel account.
17. Player activity, chat and coordinates are denied without an approved effective policy. The Phase 6 engine handles decisions and retention metadata only; it must not be extended with a generic sensitive payload.
18. Audit producers never supply integrity fields. Storage owns partition sequence, previous hash and event hash; exports remain bounded and require separate access/storage policy.

## Required handoff

Update `docs/plataforma/HANDOFF.md` with decisions, files, validation, unresolved risks, and the next bounded task.
