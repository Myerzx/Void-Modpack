# Agent operating guide

## Repository mission

Maintain a reproducible Minecraft 1.20.1 Forge modpack without coupling it to a single launcher. Keep client and server work isolated and make every release reconstructible from manifests plus reviewed overrides.

## Scope map

- `Launcher/pack/**`: canonical client pack source. Only release-ready files belong here.
- `Launcher/catalog/**`: generated, sanitized dependency inventory. Never add account IDs or local paths.
- `Launcher/tools/**`: launcher inventory, sync, validation, and packaging automation.
- `Launcher/workspace/**`: immutable local evidence profile. It is ignored and must never be edited, staged, copied into releases, or used as a build output.
- `Servidor/**`: frozen until the user explicitly starts the server phase.
- `docs/launcher/**`: client decisions, known defects, compatibility, assets, and release runbooks.
- `docs/agentes/**`: ownership and handoff conventions for agents.
- `tools/graphify/**` and `graphify-out/**`: knowledge-graph automation and portable outputs.

## Working rules

1. Run `git status --short` before meaningful edits and preserve unrelated changes.
2. Read the nearest documentation and existing tooling before changing pack files.
3. Do not commit JARs, worlds, logs, crash reports, user caches, launcher metadata, or unreviewed third-party assets.
4. Never infer that an asset is redistributable. Record its project/file ID or quarantine it until license evidence exists.
5. Use relative Minecraft-instance paths only; never persist a Windows drive path, username, UUID, token, server address, or account metadata.
6. Run `Launcher/tools/Test-LauncherPack.ps1` after launcher changes.
7. Keep launcher and server changes in separate commits. Use technical English Conventional Commit messages.
8. A successful ZIP build is not a gameplay certification. Record import, launch, resource-pack, new-world, and multiplayer smoke tests separately.

## Release gates

- Manifest Minecraft/Forge versions match the tested runtime.
- Every external file has a stable provider ID, expected filename, and distribution decision.
- FancyMenu local references resolve inside `overrides/`.
- `options.txt` references only resource packs delivered by the same release.
- No file exceeds the normal GitHub 100 MB limit.
- No unresolved P0 issue remains in `docs/launcher/auditoria.md`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
