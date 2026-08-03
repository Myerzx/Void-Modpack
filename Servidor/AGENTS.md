# Server agent guide

## Scope

- `Servidor/workspace/**` is immutable local evidence. Never edit, stage, package, or scan it broadly unless the user requests runtime forensics.
- `Servidor/catalog/**` contains generated and sanitized inventories. Regenerate it with `Servidor/tools/Export-ServerInventory.ps1`.
- `Servidor/templates/**` contains public examples only. Never copy secrets or live world identifiers into templates.
- `Servidor/pack/**` is the future canonical dedicated-server package. It remains blocked until dependencies, licenses, security, and client compatibility pass review.
- `Servidor/source/**` is reserved for project-owned source after authorship and license review.
- `docs/servidor/**` is the canonical public knowledge base for this phase.

## Rules

1. Keep launcher and server changes in separate commits.
2. Never commit worlds, player data, UUIDs, operator lists, caches, logs, crash reports, IP addresses, seeds, RCON credentials, JARs, archives, binaries, or generated libraries.
3. Do not copy client mods to the dedicated server in bulk. Classify each dependency as client-only, server-only, or both.
4. Do not change gameplay, balance, world state, or access control while performing documentation work.
5. Treat local patches, stubs, datapacks, and media as non-redistributable until authorship and license are documented.
6. Run `Servidor/tools/Test-ServerDocumentation.ps1` after server documentation or catalog changes.
7. A successful historical boot is evidence, not a release certification. Fresh-world boot, client connection, restart, backup, and restore tests are separate gates.
