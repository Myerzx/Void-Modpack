"""Validate the committed modpack knowledge base without private runtimes."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


REQUIRED_JSON = (
    "resumo.json",
    "inventario.json",
    "dependencias.json",
    "conexoes.json",
    "compatibilidade.json",
    "riscos.json",
    "remocoes.json",
    "performance.json",
    "configuracoes.json",
    "relatorio-final.json",
)

REQUIRED_GRAPHS = (
    "mapa-geral.mmd",
    "dependencias.mmd",
    "cliente-servidor.mmd",
    "progressao.mmd",
    "conflitos.mmd",
    "arvore-dependencias.txt",
)


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    root = args.root.resolve()
    docs = root / "docs/modpack"
    artifact_fixture = root / "tools/modpack/fixtures/sanitized-artifact-inventory-v1.json"
    regression_fixture = root / "tools/modpack/fixtures/contextual-compatibility-regressions.json"
    errors: list[str] = []

    for name in REQUIRED_JSON:
        path = docs / name
        if not path.is_file():
            errors.append(f"missing JSON: {name}")
            continue
        try:
            load(path)
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            errors.append(f"invalid JSON {name}: {exc}")

    for name in REQUIRED_GRAPHS:
        path = docs / "graficos" / name
        if not path.is_file() or path.stat().st_size == 0:
            errors.append(f"missing/empty graph: {name}")

    if errors:
        print("\n".join(errors))
        return 1

    summary = load(docs / "resumo.json")
    inventory = load(docs / "inventario.json")
    dependencies = load(docs / "dependencias.json")
    connections = load(docs / "conexoes.json")["connections"]
    compatibility_document = load(docs / "compatibilidade.json")
    compatibility = compatibility_document["matrix"]
    configuration_document = load(docs / "configuracoes.json")
    removals = load(docs / "remocoes.json")["items"]
    performance = load(docs / "performance.json")["items"]
    mod_files = sorted((docs / "mods").glob("*.yaml"))

    expected = summary["totalComponentsDocumented"]
    counts = {
        "mod yaml": len(mod_files),
        "compatibility": len(compatibility),
        "removals": len(removals),
        "performance": len(performance),
    }
    for label, count in counts.items():
        if count != expected:
            errors.append(f"{label} count {count} != documented components {expected}")

    all_ids = {path.stem for path in mod_files}
    for item in compatibility:
        if item["modId"] not in all_ids:
            errors.append(f"compatibility references missing mod: {item['modId']}")
    for connection in connections:
        if connection["origem"] not in all_ids:
            errors.append(f"connection origin missing: {connection['origem']}")
        if not connection["builtin"] and connection["presente"] and connection["destino"] not in all_ids:
            errors.append(f"connection target marked present but missing: {connection['destino']}")

    if len(dependencies["required"]) + len(dependencies["optional"]) != len(connections):
        errors.append("dependency partitions do not match connection count")
    if inventory["environment"]["minecraft"] != summary["minecraft"]:
        errors.append("environment Minecraft mismatch")
    if compatibility_document.get("schemaVersion") != 2:
        errors.append("compatibility schemaVersion must be 2")
    if inventory.get("scope", {}).get("runtimeForensics") != "not accessed; fixture-only deterministic regeneration":
        errors.append("inventory must declare fixture-only runtime behavior")

    allowed_statuses = {"compatible", "incompatible", "unknown"}
    matrix_by_id = {item["modId"]: item for item in compatibility}
    for item in compatibility:
        if item.get("status") not in allowed_statuses:
            errors.append(f"invalid compatibility status: {item['modId']}")
        if item.get("status") == "compatible" and any(
            finding.get("severity") == "blocker" for finding in item.get("findings", [])
        ):
            errors.append(f"compatible component has blocker: {item['modId']}")
    expected_regressions = {
        "armourers_workshop": ("incompatible", "canonical-conflict"),
        "epicfight": ("incompatible", "canonical-conflict"),
        "killcam": ("unknown", "reference-divergence"),
        "openloader": ("incompatible", "canonical-conflict"),
        "preloading_tricks": ("unknown", "reference-only"),
        "wom": ("incompatible", "canonical-conflict"),
    }
    for component_id, (status, classification) in expected_regressions.items():
        item = matrix_by_id.get(component_id)
        if item is None or (item.get("status"), item.get("classification")) != (status, classification):
            errors.append(f"regression mismatch: {component_id}")
    for component_id in ("cumulus_menus", "nitrogen_internals"):
        if matrix_by_id.get(component_id, {}).get("componentKind") != "embedded-library":
            errors.append(f"JarJar component not separated: {component_id}")
    for item in compatibility:
        for check in item.get("environmentChecks", []):
            if check.get("dependency") == "neoforge" and check.get("environmentVersion") in {"47.4.0", "47.4.4"}:
                errors.append(f"Forge baseline reused for NeoForge: {item['modId']}")

    selected_schemas = [
        item
        for item in configuration_document.get("phase7SchemaCandidates", [])
        if item.get("status") == "selected"
    ]
    if len(selected_schemas) != 1:
        errors.append("Phase 7.1 must select exactly one configuration schema")
    else:
        selected = selected_schemas[0]
        expected_openloader = {
            "id": "openloader_advanced_options_v1",
            "patterns": ["config/openloader/advanced_options.json"],
            "schemaVersion": "1.0.0",
            "schemaSha256": "25c2d9d41af6fb0ead2ecc25dd5b9eda130ab60353b37b1b707b6da7b9291ce0",
            "owner": "voidfall-product-owner",
            "fields": ["dataPacks.enabled", "resourcePacks.enabled"],
            "maximumBytes": 4096,
            "secretFields": [],
            "restartRequired": True,
            "userSuppliedPaths": False,
            "adr": "docs/plataforma/DECISIONS/ADR-008-openloader-como-primeiro-schema.md",
        }
        for key, expected_value in expected_openloader.items():
            if selected.get(key) != expected_value:
                errors.append(f"selected OpenLoader schema mismatch: {key}")
        if any("*" in pattern for pattern in selected.get("patterns", [])):
            errors.append("selected OpenLoader schema must not contain wildcard paths")
    if any(
        item.get("status") == "selected" and item.get("id") != "openloader_advanced_options_v1"
        for item in configuration_document.get("phase7SchemaCandidates", [])
    ):
        errors.append("an unapproved Phase 7 schema is selected")

    openloader_fixtures = (
        root / "Plataforma/packages/configuration-schemas/fixtures/openloader-advanced-options-v1/default.json",
        root / "Plataforma/packages/configuration-schemas/fixtures/openloader-advanced-options-v1/data-packs-disabled.json",
        root / "Plataforma/packages/configuration-schemas/fixtures/openloader-advanced-options-v1/rejected-user-path.json",
    )
    for fixture in (artifact_fixture, regression_fixture, *openloader_fixtures):
        if not fixture.is_file():
            errors.append(f"missing sanitized fixture: {fixture.relative_to(root).as_posix()}")
            continue
        try:
            load(fixture)
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            errors.append(f"invalid sanitized fixture {fixture.name}: {exc}")

    forbidden_patterns = (
        re.compile(r"[A-Za-z]:\\Users\\", re.IGNORECASE),
        re.compile(r"server-ip\s*[=:]\s*\d"),
        re.compile(r"rcon\.password\s*[=:]\s*\S+", re.IGNORECASE),
        re.compile(r"level-seed\s*[=:]\s*\S+", re.IGNORECASE),
    )
    inspected_paths = [path for path in docs.rglob("*") if path.is_file()]
    inspected_paths.extend(
        path for path in (artifact_fixture, regression_fixture, *openloader_fixtures) if path.is_file()
    )
    for path in inspected_paths:
        if not path.is_file() or path.suffix.casefold() not in {".md", ".json", ".yaml", ".mmd", ".txt"}:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for pattern in forbidden_patterns:
            if pattern.search(text):
                errors.append(f"potential private value in {path.relative_to(root).as_posix()}: {pattern.pattern}")

    if errors:
        print("\n".join(errors[:100]))
        return 1
    print(
        f"Modpack documentation valid: {expected} components, {len(inventory['artifacts'])} artifacts, "
        f"{len(connections)} connections, {len(dependencies['missing'])} missing dependencies."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
