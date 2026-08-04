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
    compatibility = load(docs / "compatibilidade.json")["matrix"]
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

    forbidden_patterns = (
        re.compile(r"[A-Za-z]:\\Users\\", re.IGNORECASE),
        re.compile(r"server-ip\s*[=:]\s*\d"),
        re.compile(r"rcon\.password\s*[=:]\s*\S+", re.IGNORECASE),
        re.compile(r"level-seed\s*[=:]\s*\S+", re.IGNORECASE),
    )
    for path in docs.rglob("*"):
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
