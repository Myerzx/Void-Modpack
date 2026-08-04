# Modpack knowledge-base tooling

These scripts implement the read-only audit that precedes Platform Phase 7.

```powershell
$python = Get-Content graphify-out/.graphify_python
& $python tools/modpack/generate_modpack_docs.py --root .
& $python tools/modpack/validate_modpack_docs.py --root .
```

The generator reads loader metadata from ignored local JARs but never imports,
loads, executes, copies or modifies them. Only sanitized hashes, filenames,
`mod_id` values, declared dependencies and aggregate evidence are written to
`docs/modpack/`. The validator is CI-safe and needs only committed files.
