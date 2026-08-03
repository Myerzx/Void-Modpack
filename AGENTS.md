# Agent operating guide

## Repository mission

Maintain a reproducible Minecraft 1.20.1 Forge modpack and its future management platform without coupling releases to a single launcher. Keep client, server, and control-plane work isolated and make every release reconstructible from reviewed catalogs, manifests, and overrides.

## Scope map

- `Launcher/pack/**`: canonical client pack source. Only release-ready files belong here.
- `Launcher/catalog/**`: generated, sanitized dependency inventory. Never add account IDs or local paths.
- `Launcher/tools/**`: launcher inventory, sync, validation, and packaging automation.
- `Launcher/workspace/**`: immutable local evidence profile. It is ignored and must never be edited, staged, copied into releases, or used as a build output.
- `Servidor/catalog/**`: generated, sanitized server dependency and compatibility inventories.
- `Servidor/templates/**`: public security-first examples without live state or secrets.
- `Servidor/tools/**`: server inventory and public-documentation validation.
- `Servidor/pack/**` and `Servidor/source/**`: future canonical server artifacts, blocked until release gates pass.
- `Servidor/workspace/**`: immutable private server evidence. It is ignored and must never be edited, staged, or packaged.
- `docs/servidor/**`: server architecture, audit, security, compatibility, operations, and release runbooks.
- `docs/launcher/**`: client decisions, known defects, compatibility, assets, and release runbooks.
- `Plataforma/**`: future control-plane implementation root. Phase 1 is documentation-only; do not scaffold or install dependencies until Phase 2 is explicitly authorized.
- `docs/plataforma/**`: platform context, architecture, contracts, data, security, roadmap, ADRs, and handoff.
- `docs/agentes/**`: ownership and handoff conventions for agents.
- `tools/graphify/**` and `graphify-out/**`: knowledge-graph automation and portable outputs.

## Working rules

1. Run `git status --short` before meaningful edits and preserve unrelated changes.
2. Read the nearest documentation and existing tooling before changing pack files.
3. Do not commit JARs, worlds, logs, crash reports, user caches, launcher metadata, or unreviewed third-party assets.
4. Never infer that an asset is redistributable. Record its project/file ID or quarantine it until license evidence exists.
5. Use relative Minecraft-instance paths only; never persist a Windows drive path, username, UUID, token, server address, or account metadata.
6. Run `Launcher/tools/Test-LauncherPack.ps1` after launcher changes.
7. Run `Servidor/tools/Test-ServerDocumentation.ps1` after server documentation or catalog changes.
8. Keep launcher and server changes in separate commits. Use technical English Conventional Commit messages.
9. A successful ZIP build or historical server boot is not a gameplay certification. Record import, launch, resource-pack, new-world, multiplayer, restart, backup, and restore smoke tests separately.
10. During platform Phase 1, do not create application code, package-manager files, database migrations, containers, UI, APIs, or the Forge bridge.
11. Never silently replace an accepted ADR. Propose a new ADR with consequences and migration path.
12. The live server runtime is evidence, not the canonical source for a client release.

## Platform planning gates

- Product identity and the canonical client baseline are explicitly chosen.
- Current P0 security and distribution blockers have owners and decisions.
- TypeScript control-plane and Java Forge-bridge boundaries remain explicit.
- Agent operations are typed, authenticated, allowlisted, idempotent, and audited.
- Manifest ownership, signatures, atomic promotion, and rollback are defined.
- Panel RBAC and Minecraft permissions remain separate.
- Phase 2 starts only after the open P0 questions in `docs/plataforma/ROADMAP.md` are resolved or deliberately accepted.

## Release gates

- Manifest Minecraft/Forge versions match the tested runtime.
- Every external file has a stable provider ID, expected filename, and distribution decision.
- FancyMenu local references resolve inside `overrides/`.
- `options.txt` references only resource packs delivered by the same release.
- No file exceeds the normal GitHub 100 MB limit.
- No unresolved P0 issue remains in `docs/launcher/auditoria.md`.

## Server release gates

- Authentication, whitelist, RCON, firewall, and secret rotation have been reviewed.
- The exact client release is identified and passes a real connection smoke test.
- Every server dependency has origin, hash, side, license, and distribution approval.
- Local patches, stubs, KubeJS scripts, datapacks, and media have reviewed authorship and license.
- A clean install boots both a new world and an isolated test copy of the production world.
- Restart, backup, and restore procedures have passed without exposing private state.
- No unresolved P0 issue remains in `docs/servidor/auditoria.md`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
