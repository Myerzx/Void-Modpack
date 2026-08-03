# Canonical pack source

This directory is the only input accepted by the CurseForge package builder.

- `manifest.json` is generated from sanitized enabled-addon metadata.
- `overrides/` contains only reviewed, portable instance files.
- Mods, resource packs, and shader packs hosted by CurseForge stay out of Git and are resolved from project/file IDs.

Do not copy the raw profile into this directory.

