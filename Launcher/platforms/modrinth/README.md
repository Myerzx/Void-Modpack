# Modrinth export status

Blocked for the audit release.

A valid `.mrpack` requires an index with permitted HTTPS download URLs, SHA-1 and SHA-512 hashes, file sizes, environments, and loader dependencies. The current source metadata is CurseForge-centric and cannot be converted safely by replacing IDs with guessed CDN URLs.

Before enabling this exporter:

1. map every required addon to a Modrinth project/version or an explicitly permitted host;
2. decide client/server environment for every file;
3. resolve licenses for local overrides;
4. generate and validate hashes;
5. import the `.mrpack` in Modrinth App and Prism Launcher.

