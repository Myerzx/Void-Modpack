# Platform implementation agent guide

## Current phase

Phase 2 is complete. Phase 3 has validated launch plans and isolated Windows/Linux process adapters in `packages/minecraft-process`. The next bounded slice may add a serialized start/stop/restart controller and failure tests inside that package. Do not connect process control to the API/agent, edit the private runtime, add generic console execution, or implement force-kill/restore until a later task explicitly clears the applicable roadmap gates.

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

## Required handoff

Update `docs/plataforma/HANDOFF.md` with decisions, files, validation, unresolved risks, and the next bounded task.
