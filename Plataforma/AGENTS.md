# Platform implementation agent guide

## Current phase

Phase 2, all six Phase 3 items, all six Phase 4 items and all seven Phase 5 technical items are complete in isolation. The Phase 5 local gate and final Windows/Linux matrix are green under `docs/plataforma/PHASE_5_EXECUTION.md`. Content identity is SHA-256; logical identity remains the reviewed catalog ID. The worker accepts only an opaque `planId`; build roots, catalogs and private keys stay in trusted construction. Launcher API is read-only, the portable planner removes only explicitly managed paths, and channel mutation uses signed revisions with CAS. The Java Bridge core exists but is not installed into Forge. Do not scan private runtimes, inspect/execute JARs, call providers, import the current client, publish `stable`, install the Bridge or enable `/atualizar-modpack`. The next bounded task is Phase 6 item 1 as a pure UUID profile domain, without importing player files, chat, coordinates or live server state. Existing operational restrictions remain in force.

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

## Required handoff

Update `docs/plataforma/HANDOFF.md` with decisions, files, validation, unresolved risks, and the next bounded task.
