# Modpack knowledge-base tooling

These scripts implement the deterministic, context-aware compatibility audit for
Platform Phase 7.0.

```powershell
$python = Get-Content graphify-out/.graphify_python
& $python tools/modpack/generate_modpack_docs.py --root .
& $python -m unittest discover -s tools/modpack/tests -p "test_*.py"
& $python tools/modpack/validate_modpack_docs.py --root .
```

The generator reads `tools/modpack/fixtures/sanitized-artifact-inventory-v1.json`
and public catalogs only. It does not open `Launcher/workspace` or
`Servidor/workspace`. Context, side, metadata loader, JarJar containment and
Maven version-range results remain explicit; unsupported ranges resolve to
`unknown`, never to compatible. The validator and regression tests are CI-safe.
