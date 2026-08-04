"""Generate the compact VoidFall modpack knowledge base.

The generator performs read-only forensics against the ignored launcher/server
profiles and writes only sanitized, deterministic documentation under
``docs/modpack``. It never loads or executes a JAR: ZIP entries are limited to
loader metadata, manifests and feature-presence checks.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import shutil
import tempfile
import tomllib
import zipfile
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from typing import Any, Iterable


BUILTIN_DEPENDENCIES = {
    "minecraft",
    "forge",
    "neoforge",
    "java",
    "fml",
    "fabricloader",
    "fabric-api",
}

CONTEXT_LABELS = {
    "launcher_current": "launcher atual",
    "launcher_disabled": "launcher desativado",
    "server_active": "servidor ativo",
    "server_disabled": "servidor desativado",
    "server_other": "servidor backup/outro",
    "embedded_client": "cliente privado de referência",
}

CATEGORY_TERMS = {
    "bibliotecas": (
        "api", "lib", "library", "core", "framework", "architectury", "cloth",
        "citadel", "curios", "geckolib", "konkrete", "moonlight", "resourceful",
        "placebo", "puzzleslib", "balm", "bookshelf", "collective",
    ),
    "tecnologia": (
        "thermal", "mekanism", "energy", "machine", "tech", "computer", "industrial",
    ),
    "magia": (
        "magic", "spell", "ars", "mana", "occult", "hex", "sorcery", "wizard",
        "enchant", "apotheosis", "irons_spell", "irons spell",
    ),
    "mundo": (
        "biome", "world", "terrain", "tectonic", "aether", "dimension", "dungeon",
        "structure", "cave", "village", "ocean", "alexsmobs", "mobs", "generation",
    ),
    "cliente": (
        "fancymenu", "tooltip", "jei", "rei", "emi", "jade", "mouse", "screen",
        "hud", "sound", "audio", "shader", "oculus", "embeddium", "render",
        "visual", "map", "xaero", "inventory hud", "loading",
    ),
    "servidor": (
        "server", "admin", "permission", "whitelist", "backup", "spark", "chunky",
        "voicechat", "voice chat", "ftb chunks", "ftb teams", "claim",
    ),
    "otimizacao": (
        "optim", "performance", "memory", "ferrite", "modernfix", "fast", "smooth",
        "starlight", "canary", "radium", "immediatelyfast", "accelerated",
    ),
    "combate": (
        "fight", "combat", "weapon", "armor", "armour", "battle", "sword", "bow",
        "epicfight", "epic fight", "dodge", "parry", "boss",
    ),
    "progressao": (
        "quest", "level", "skill", "mmorpg", "exile", "bounty", "talent", "class",
        "profession", "economy", "currency", "progression",
    ),
    "armazenamento": (
        "storage", "inventory", "chest", "backpack", "drawer", "container",
    ),
    "automacao": (
        "automation", "automate", "create", "pipe", "transport", "crafting", "hopper",
    ),
    "rede": (
        "network", "sync", "voicechat", "voice chat", "packet", "multiplayer",
    ),
    "scripts": (
        "kubejs", "crafttweaker", "openloader", "datapack", "script", "rhino",
    ),
}

WORLD_RISK_TERMS = (
    "world", "biome", "terrain", "dimension", "structure", "dungeon", "ore", "mob",
    "aether", "block", "item", "storage", "create", "magic", "spell", "quest",
)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def stable_json(value: Any) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False, sort_keys=False) + "\n"


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(stable_json(value), encoding="utf-8")


def write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value.rstrip() + "\n", encoding="utf-8")


def slug(value: str, fallback: str = "unknown") -> str:
    result = re.sub(r"[^a-z0-9]+", "_", value.casefold()).strip("_")
    return result or fallback


def artifact_component_id(filename: str, digest: str) -> str:
    stem = re.sub(r"(?i)\.(jar(?:\.disabled)?|zip)$", "", filename).strip()
    match = re.match(r"^(.+?)(?:[-_ ]+v?\d+(?:[.+_-].*)?)$", stem, re.IGNORECASE)
    candidate = match.group(1) if match and len(match.group(1)) >= 3 else stem
    return slug(candidate, f"artifact_{digest[-16:]}")


def compact_text(value: Any, limit: int = 220) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_manifest(raw: bytes) -> dict[str, str]:
    lines = raw.decode("utf-8", errors="replace").replace("\r\n", "\n").split("\n")
    unfolded: list[str] = []
    for line in lines:
        if line.startswith(" ") and unfolded:
            unfolded[-1] += line[1:]
        else:
            unfolded.append(line)
    result: dict[str, str] = {}
    for line in unfolded:
        if ": " in line:
            key, value = line.split(": ", 1)
            result[key] = value
    return result


def resolve_version(value: Any, manifest: dict[str, str]) -> str | None:
    if value is None:
        return None
    rendered = str(value).strip()
    replacements = {
        "${file.jarVersion}": manifest.get("Implementation-Version"),
        "${global.mcVersion}": "1.20.1",
        "${mc_version}": "1.20.1",
    }
    for token, replacement in replacements.items():
        if replacement:
            rendered = rendered.replace(token, replacement)
    return rendered or None


def bool_value(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.casefold() == "true"
    if value is None:
        return default
    return bool(value)


def parse_forge_metadata(
    raw: bytes, manifest: dict[str, str], metadata_path: str
) -> tuple[list[dict[str, Any]], list[str]]:
    errors: list[str] = []
    try:
        parsed = tomllib.loads(raw.decode("utf-8-sig", errors="replace"))
    except (tomllib.TOMLDecodeError, UnicodeError) as exc:
        return [], [f"{metadata_path}: {compact_text(exc, 160)}"]

    dependencies = parsed.get("dependencies", {})
    if not isinstance(dependencies, dict):
        dependencies = {}
    mods = parsed.get("mods", [])
    if isinstance(mods, dict):
        mods = [mods]
    result: list[dict[str, Any]] = []
    for entry in mods if isinstance(mods, list) else []:
        if not isinstance(entry, dict):
            continue
        mod_id = str(entry.get("modId") or "").strip()
        if not mod_id:
            continue
        declared: list[dict[str, Any]] = []
        raw_dependencies = dependencies.get(mod_id, [])
        if isinstance(raw_dependencies, dict):
            raw_dependencies = [raw_dependencies]
        for dependency in raw_dependencies if isinstance(raw_dependencies, list) else []:
            if not isinstance(dependency, dict) or not dependency.get("modId"):
                continue
            declared.append(
                {
                    "target": str(dependency["modId"]).strip(),
                    "mandatory": bool_value(dependency.get("mandatory"), True),
                    "versionRange": str(dependency.get("versionRange") or "").strip() or None,
                    "ordering": str(dependency.get("ordering") or "NONE").upper(),
                    "side": str(dependency.get("side") or "BOTH").upper(),
                    "source": metadata_path,
                }
            )
        result.append(
            {
                "id": mod_id,
                "name": str(entry.get("displayName") or mod_id).strip(),
                "version": resolve_version(entry.get("version"), manifest),
                "description": compact_text(entry.get("description"), 240),
                "displayTest": str(entry.get("displayTest") or parsed.get("displayTest") or "").strip() or None,
                "dependencies": declared,
                "metadataPath": metadata_path,
            }
        )
    if not result:
        errors.append(f"{metadata_path}: nenhum bloco [[mods]] reconhecido")
    return result, errors


def parse_fabric_metadata(raw: bytes, metadata_path: str) -> tuple[list[dict[str, Any]], list[str]]:
    try:
        parsed = json.loads(raw.decode("utf-8-sig"))
    except (json.JSONDecodeError, UnicodeError) as exc:
        return [], [f"{metadata_path}: {compact_text(exc, 160)}"]
    mod_id = str(parsed.get("id") or "").strip()
    if not mod_id:
        return [], [f"{metadata_path}: id ausente"]
    declared: list[dict[str, Any]] = []
    for field, mandatory in (("depends", True), ("recommends", False), ("suggests", False)):
        values = parsed.get(field, {})
        if isinstance(values, dict):
            for target, version_range in values.items():
                declared.append(
                    {
                        "target": target,
                        "mandatory": mandatory,
                        "versionRange": str(version_range),
                        "ordering": "NONE",
                        "side": "BOTH",
                        "source": metadata_path,
                    }
                )
    return [
        {
            "id": mod_id,
            "name": str(parsed.get("name") or mod_id).strip(),
            "version": str(parsed.get("version") or "").strip() or None,
            "description": compact_text(parsed.get("description"), 240),
            "displayTest": None,
            "dependencies": declared,
            "metadataPath": metadata_path,
        }
    ], []


def parse_archive_metadata(
    archive: zipfile.ZipFile, source_prefix: str = ""
) -> tuple[list[dict[str, Any]], list[str], list[str], list[str]]:
    names = archive.namelist()
    name_lookup = {name.casefold(): name for name in names}
    manifest: dict[str, str] = {}
    evidence: list[str] = []
    errors: list[str] = []
    loaders: list[str] = []
    manifest_name = name_lookup.get("meta-inf/manifest.mf")
    if manifest_name:
        manifest = parse_manifest(archive.read(manifest_name))
        evidence.append(f"{source_prefix}META-INF/MANIFEST.MF")

    forge_candidates = [
        candidate
        for candidate in ("META-INF/mods.toml", "META-INF/neoforge.mods.toml")
        if candidate.casefold() in name_lookup
    ]
    mods: list[dict[str, Any]] = []
    if forge_candidates:
        for candidate in forge_candidates:
            actual = name_lookup[candidate.casefold()]
            source = f"{source_prefix}{candidate}"
            evidence.append(source)
            parsed_mods, parsed_errors = parse_forge_metadata(archive.read(actual), manifest, source)
            mods.extend(parsed_mods)
            errors.extend(parsed_errors)
            loaders.append("neoforge" if "neoforge" in candidate.casefold() else "forge")
        if "fabric.mod.json".casefold() in name_lookup:
            evidence.append(f"{source_prefix}fabric.mod.json (ignorado no baseline Forge)")
    elif "fabric.mod.json".casefold() in name_lookup:
        actual = name_lookup["fabric.mod.json".casefold()]
        source = f"{source_prefix}fabric.mod.json"
        evidence.append(source)
        parsed_mods, parsed_errors = parse_fabric_metadata(archive.read(actual), source)
        mods.extend(parsed_mods)
        errors.extend(parsed_errors)
        loaders.append("fabric")
    elif "mcmod.info".casefold() in name_lookup:
        evidence.append(f"{source_prefix}mcmod.info")
        errors.append(f"{source_prefix}mcmod.info legado detectado; parser não implementado")
        loaders.append("legacy")
    return mods, errors, evidence, loaders


def inspect_jar(path: Path, context: str, state: str, known_hash: str | None = None) -> dict[str, Any]:
    digest = known_hash if known_hash and len(known_hash) == 64 else sha256_file(path)
    artifact: dict[str, Any] = {
        "artifactId": f"sha256:{digest}",
        "fileName": path.name,
        "bytes": path.stat().st_size,
        "sha256": digest,
        "format": "jar",
        "contexts": [context],
        "state": state,
        "loaders": [],
        "mods": [],
        "features": {
            "mixins": [],
            "accessTransformers": [],
            "containsData": False,
            "containsAssets": False,
        },
        "metadataErrors": [],
        "evidence": [],
    }
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            mods, errors, evidence, loaders = parse_archive_metadata(archive)
            artifact["mods"].extend(mods)
            artifact["metadataErrors"].extend(errors)
            artifact["evidence"].extend(evidence)
            artifact["loaders"].extend(loaders)

            for nested_name in sorted(
                name for name in names
                if name.casefold().startswith("meta-inf/jarjar/") and name.casefold().endswith(".jar")
            ):
                try:
                    with zipfile.ZipFile(io.BytesIO(archive.read(nested_name))) as nested:
                        prefix = f"{nested_name}!"
                        nested_mods, nested_errors, nested_evidence, nested_loaders = parse_archive_metadata(nested, prefix)
                        artifact["mods"].extend(nested_mods)
                        artifact["metadataErrors"].extend(nested_errors)
                        artifact["evidence"].extend(nested_evidence)
                        artifact["loaders"].extend(nested_loaders)
                except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
                    artifact["metadataErrors"].append(
                        f"{nested_name}: metadado JarJar ilegível: {compact_text(exc, 140)}"
                    )

            mixins = sorted(
                name for name in names
                if name.casefold().endswith((".mixins.json", ".mixin.json"))
            )
            access_transformers = sorted(
                name for name in names
                if "accesstransformer" in name.casefold() or name.casefold().endswith(".cfg")
                and name.casefold().startswith("meta-inf/")
            )
            artifact["features"] = {
                "mixins": mixins[:30],
                "accessTransformers": access_transformers[:30],
                "containsData": any(name.startswith("data/") for name in names),
                "containsAssets": any(name.startswith("assets/") for name in names),
            }
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        artifact["metadataErrors"].append(f"jar ilegível: {compact_text(exc, 160)}")
    return artifact


def merge_artifact(target: dict[str, Any], incoming: dict[str, Any]) -> None:
    target["contexts"] = sorted(set(target["contexts"] + incoming["contexts"]))
    target.setdefault("fileNames", [target["fileName"]])
    target["fileNames"] = sorted(set(target["fileNames"] + [incoming["fileName"]]))
    target["metadataErrors"] = sorted(set(target["metadataErrors"] + incoming["metadataErrors"]))
    target["loaders"] = sorted(set(target.get("loaders", []) + incoming.get("loaders", [])))
    if incoming["state"] == "active":
        target["state"] = "active"


def context_state(filename: str, active_context: str, disabled_context: str) -> tuple[str, str]:
    if filename.casefold().endswith(".jar.disabled"):
        return disabled_context, "disabled"
    return active_context, "active"


def load_artifacts(root: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    launcher_addons = read_json(root / "Launcher/catalog/addons.json")
    server_rows = read_csv(root / "Servidor/catalog/mods.csv")
    compatibility_rows = read_csv(root / "Servidor/catalog/compatibilidade-cliente.csv")
    server_by_name = {row["FileName"].casefold(): row for row in server_rows}

    jar_roots = (
        (
            root / "Launcher/workspace/profile-original/mods",
            "launcher_current",
            "launcher_disabled",
        ),
        (
            root / "Servidor/workspace/server-original/mods",
            "server_active",
            "server_disabled",
        ),
        (
            root / "Servidor/workspace/server-original/local/drive_exports/VOID_MMORPG_CLIENT_ESSENTIAL_20260414_113822/mods",
            "embedded_client",
            "embedded_client",
        ),
    )

    artifacts_by_hash: dict[str, dict[str, Any]] = {}
    artifacts_by_filename: dict[str, list[dict[str, Any]]] = defaultdict(list)
    inspected = 0
    for directory, active_context, disabled_context in jar_roots:
        if not directory.exists():
            continue
        for path in sorted(directory.iterdir(), key=lambda item: item.name.casefold()):
            if not path.is_file() or not re.search(r"\.jar(?:\.disabled)?$", path.name, re.IGNORECASE):
                continue
            context, state = context_state(path.name, active_context, disabled_context)
            server_row = server_by_name.get(path.name.casefold())
            known_hash = server_row.get("Sha256") if server_row else None
            artifact = inspect_jar(path, context, state, known_hash)
            inspected += 1
            key = artifact["sha256"]
            if key in artifacts_by_hash:
                merge_artifact(artifacts_by_hash[key], artifact)
            else:
                artifacts_by_hash[key] = artifact

    artifacts = list(artifacts_by_hash.values())
    for artifact in artifacts:
        for filename in artifact.get("fileNames", [artifact["fileName"]]):
            artifacts_by_filename[filename.casefold()].append(artifact)

    provider_only = 0
    for addon in launcher_addons:
        provider = {
            "provider": "curseforge",
            "projectId": int(addon["projectId"]),
            "fileId": int(addon["fileId"]),
            "projectUrl": addon.get("projectUrl"),
            "distributionAllowed": bool(addon.get("distributionAllowed")),
            "required": bool(addon.get("required")),
            "enabled": bool(addon.get("enabled")),
            "category": addon.get("category"),
            "name": addon.get("name"),
        }
        matches = artifacts_by_filename.get(str(addon.get("fileName", "")).casefold(), [])
        if matches:
            for artifact in matches:
                artifact["provider"] = provider
            continue
        provider_only += 1
        fake_hash = hashlib.sha256(
            f"curseforge:{provider['projectId']}:{provider['fileId']}".encode("ascii")
        ).hexdigest()
        context = "launcher_current" if provider["enabled"] else "launcher_disabled"
        artifacts.append(
            {
                "artifactId": f"provider:curseforge:{provider['projectId']}:{provider['fileId']}",
                "fileName": addon.get("fileName") or f"curseforge-{provider['projectId']}-{provider['fileId']}",
                "bytes": None,
                "sha256": None,
                "format": addon.get("category") or "provider-file",
                "contexts": [context],
                "state": "active" if provider["enabled"] else "disabled",
                "loaders": [],
                "mods": [],
                "features": {"mixins": [], "accessTransformers": [], "containsData": False, "containsAssets": False},
                "metadataErrors": ["arquivo não é JAR do perfil ou não foi localizado para leitura de metadados"],
                "evidence": ["Launcher/catalog/addons.json"],
                "provider": provider,
                "syntheticSha256": fake_hash,
            }
        )

    for artifact in artifacts:
        row = server_by_name.get(artifact["fileName"].casefold())
        if row:
            artifact["serverCatalog"] = {
                "kind": row["Kind"],
                "distributionReview": row["DistributionReview"],
            }

    return sorted(artifacts, key=lambda item: (item["fileName"].casefold(), item["artifactId"])), {
        "jarOccurrencesInspected": inspected,
        "uniqueArtifacts": len(artifacts),
        "providerOnlyArtifacts": provider_only,
        "launcherAddons": len(launcher_addons),
        "serverCatalogEntries": len(server_rows),
        "compatibilityEntries": len(compatibility_rows),
    }


def public_override_inventory(root: Path) -> list[dict[str, Any]]:
    base = root / "Launcher/pack/overrides"
    result: list[dict[str, Any]] = []
    if not base.exists():
        return result
    for path in sorted((item for item in base.rglob("*") if item.is_file()), key=lambda item: item.as_posix().casefold()):
        relative = path.relative_to(root).as_posix()
        suffix = path.suffix.casefold()
        if relative.startswith("Launcher/pack/overrides/config/"):
            kind = "config"
        elif "/openloader/" in f"/{relative.casefold()}/":
            kind = "openloader"
        elif suffix in {".zip", ".png", ".ogg", ".mp3", ".fma", ".icns"}:
            kind = "resource"
        else:
            kind = "override"
        result.append(
            {
                "path": relative,
                "kind": kind,
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
            }
        )
    return result


def component_side(contexts: set[str]) -> tuple[str, str, list[str]]:
    server = "server_active" in contexts
    client = bool(contexts & {"launcher_current", "embedded_client"})
    if server and client:
        return "ambos", "alta", ["artefato/mod_id observado no servidor e em cliente de referência"]
    if server:
        return "servidor", "media", ["observado no servidor ativo e ausente dos conjuntos de cliente por mod_id"]
    if client:
        return "cliente", "media", ["observado em conjunto de cliente e ausente do servidor por mod_id"]
    return "desconhecido", "baixa", ["apenas cópia desativada ou artefato sem contexto executável"]


def category_for(component: dict[str, Any]) -> str:
    haystack = " ".join(
        [component["id"], component.get("name", ""), component.get("description", "")]
    ).casefold()
    if component["side"] == "cliente":
        return "cliente"
    scores = {
        category: sum(term in haystack for term in terms)
        for category, terms in CATEGORY_TERMS.items()
    }
    category, score = max(scores.items(), key=lambda item: (item[1], item[0]))
    return category if score else "outros"


def infer_config_paths(component_id: str, overrides: list[dict[str, Any]]) -> list[str]:
    token = slug(component_id)
    variants = {token, token.replace("_", "-"), token.replace("_", "")}
    if len(token) < 4:
        return []
    paths = []
    for item in overrides:
        normalized = slug(item["path"])
        if any(variant and variant in normalized for variant in variants):
            paths.append(item["path"])
    return paths[:80]


def build_components(artifacts: list[dict[str, Any]], overrides: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    components: dict[str, dict[str, Any]] = {}
    for artifact in artifacts:
        mod_entries = artifact["mods"]
        if not mod_entries:
            provider = artifact.get("provider", {})
            generated_id = (
                f"curseforge_project_{provider['projectId']}"
                if provider.get("projectId")
                else artifact_component_id(
                    artifact["fileName"],
                    artifact.get("sha256") or artifact["artifactId"],
                )
            )
            mod_entries = [
                {
                    "id": generated_id,
                    "name": provider.get("name") or artifact["fileName"],
                    "version": None,
                    "description": "Metadados internos não verificados para este artefato.",
                    "displayTest": None,
                    "dependencies": [],
                    "metadataPath": None,
                }
            ]
        for mod in mod_entries:
            component_id = slug(mod["id"])
            component = components.setdefault(
                component_id,
                {
                    "id": component_id,
                    "declaredIds": set(),
                    "names": set(),
                    "versions": set(),
                    "descriptions": set(),
                    "artifacts": [],
                    "contexts": set(),
                    "dependencies": {},
                    "metadataPaths": set(),
                    "metadataErrors": set(),
                    "features": {"mixins": set(), "accessTransformers": set(), "containsData": False, "containsAssets": False},
                    "providers": [],
                    "loaders": set(),
                },
            )
            component["declaredIds"].add(str(mod["id"]))
            component["names"].add(str(mod.get("name") or component_id))
            if mod.get("version"):
                component["versions"].add(str(mod["version"]))
            if mod.get("description"):
                component["descriptions"].add(str(mod["description"]))
            component["artifacts"].append(
                {
                    "artifactId": artifact["artifactId"],
                    "fileName": artifact["fileName"],
                    "sha256": artifact.get("sha256"),
                    "bytes": artifact.get("bytes"),
                    "state": artifact["state"],
                    "contexts": artifact["contexts"],
                    "modVersion": str(mod["version"]) if mod.get("version") else None,
                }
            )
            component["contexts"].update(artifact["contexts"])
            if mod.get("metadataPath"):
                component["metadataPaths"].add(mod["metadataPath"])
            component["metadataErrors"].update(artifact["metadataErrors"])
            component["loaders"].update(artifact.get("loaders", []))
            for feature in ("mixins", "accessTransformers"):
                component["features"][feature].update(artifact["features"][feature])
            for feature in ("containsData", "containsAssets"):
                component["features"][feature] = component["features"][feature] or artifact["features"][feature]
            if artifact.get("provider") and artifact["provider"] not in component["providers"]:
                component["providers"].append(artifact["provider"])
            for dependency in mod.get("dependencies", []):
                key = (
                    slug(dependency["target"]),
                    dependency["mandatory"],
                    dependency.get("versionRange"),
                    dependency.get("side"),
                )
                component["dependencies"][key] = dependency

    for component in components.values():
        component["name"] = sorted(component["names"], key=lambda item: (len(item), item.casefold()))[0]
        component["description"] = sorted(component["descriptions"], key=lambda item: (-len(item), item.casefold()))[0] if component["descriptions"] else "Descrição não verificada."
        side, confidence, evidence = component_side(component["contexts"])
        component["side"] = side
        component["sideConfidence"] = confidence
        component["sideEvidence"] = evidence
        component["category"] = category_for(component)
        component["configPaths"] = infer_config_paths(component["id"], overrides)
    return components


def version_tuple(value: str) -> tuple[int, ...] | None:
    match = re.match(r"^\s*(\d+(?:\.\d+)*)", value)
    return tuple(int(part) for part in match.group(1).split(".")) if match else None


def pad_version(value: tuple[int, ...], length: int) -> tuple[int, ...]:
    return value + (0,) * (length - len(value))


def compare_versions(left: str, right: str) -> int | None:
    a, b = version_tuple(left), version_tuple(right)
    if a is None or b is None:
        return None
    length = max(len(a), len(b))
    pa, pb = pad_version(a, length), pad_version(b, length)
    return (pa > pb) - (pa < pb)


def version_in_range(version: str, declared: str | None) -> bool | None:
    if not declared or declared in {"*", ""}:
        return None
    value = declared.strip()
    if value.startswith(("[", "(")) and value.endswith(("]", ")")) and "," in value:
        if value[1:-1].count(",") != 1:
            return None
        lower, upper = (part.strip() for part in value[1:-1].split(",", 1))
        if lower:
            compared = compare_versions(version, lower)
            if compared is None or compared < 0 or (compared == 0 and value[0] == "("):
                return False if compared is not None else None
        if upper:
            compared = compare_versions(version, upper)
            if compared is None or compared > 0 or (compared == 0 and value[-1] == ")"):
                return False if compared is not None else None
        return True
    if re.fullmatch(r"\d+(?:\.\d+)*", value):
        compared = compare_versions(version, value)
        return compared == 0 if compared is not None else None
    return None


def dependency_connections(components: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    connections: list[dict[str, Any]] = []
    known = set(components)
    compact_aliases: dict[str, list[str]] = defaultdict(list)
    for component_id in known:
        compact_aliases[component_id.replace("_", "")].append(component_id)
    for origin_id, component in sorted(components.items()):
        for dependency in sorted(component["dependencies"].values(), key=lambda item: (slug(item["target"]), not item["mandatory"])):
            declared_target = slug(dependency["target"])
            target = declared_target
            aliases = compact_aliases.get(declared_target.replace("_", ""), [])
            if target not in known and len(aliases) == 1:
                target = aliases[0]
            builtin = declared_target in BUILTIN_DEPENDENCIES
            present = builtin or target in known
            connection_type = "dependencia" if dependency["mandatory"] else "compatibilidade"
            evidence = [
                f"{artifact['fileName']}!{dependency['source']}"
                for artifact in component["artifacts"][:4]
            ]
            connections.append(
                {
                    "origem": origin_id,
                    "destino": target,
                    "destino_declarado": declared_target,
                    "tipo": connection_type,
                    "obrigatoria": bool(dependency["mandatory"]),
                    "direcao": "origem_depende_do_destino",
                    "motivo": f"dependência declarada; faixa={dependency.get('versionRange') or 'não declarada'}; lado={dependency.get('side') or 'BOTH'}",
                    "evidencias": sorted(set(evidence)),
                    "risco_de_quebra": "alto" if dependency["mandatory"] and not present else ("alto" if dependency["mandatory"] else "medio"),
                    "presente": present,
                    "builtin": builtin,
                    "confianca": {"nivel": "alta", "origem": "metadado interno do loader", "evidencias": [dependency["source"]]},
                }
            )
    return connections


def detect_cycles(nodes: Iterable[str], edges: dict[str, set[str]]) -> list[list[str]]:
    visiting: list[str] = []
    active: set[str] = set()
    visited: set[str] = set()
    found: set[tuple[str, ...]] = set()

    def visit(node: str) -> None:
        if node in visited:
            return
        active.add(node)
        visiting.append(node)
        for target in edges.get(node, set()):
            if target in active:
                index = visiting.index(target)
                cycle = visiting[index:] + [target]
                body = cycle[:-1]
                rotations = [tuple(body[index:] + body[:index]) for index in range(len(body))]
                found.add(min(rotations))
            elif target not in visited:
                visit(target)
        visiting.pop()
        active.remove(node)
        visited.add(node)

    for node in sorted(nodes):
        visit(node)
    return [list(cycle) + [cycle[0]] for cycle in sorted(found)]


def analyze_components(
    components: dict[str, dict[str, Any]], connections: list[dict[str, Any]]
) -> dict[str, Any]:
    required_dependents: dict[str, set[str]] = defaultdict(set)
    optional_dependents: dict[str, set[str]] = defaultdict(set)
    graph: dict[str, set[str]] = defaultdict(set)
    for connection in connections:
        if connection["builtin"]:
            continue
        if connection["obrigatoria"]:
            required_dependents[connection["destino"]].add(connection["origem"])
            if connection["presente"]:
                graph[connection["origem"]].add(connection["destino"])
        else:
            optional_dependents[connection["destino"]].add(connection["origem"])

    compatibility: list[dict[str, Any]] = []
    risks: list[dict[str, Any]] = []
    removals: list[dict[str, Any]] = []
    performance: list[dict[str, Any]] = []
    active_contexts = {"launcher_current", "server_active", "embedded_client"}
    missing_all = [connection for connection in connections if connection["obrigatoria"] and not connection["presente"]]
    missing = [
        connection for connection in missing_all
        if components[connection["origem"]]["contexts"] & active_contexts
    ]

    for component_id, component in sorted(components.items()):
        dependents = sorted(required_dependents.get(component_id, set()))
        optional = sorted(optional_dependents.get(component_id, set()))
        component["dependents"] = dependents
        component["optionalDependents"] = optional
        component_missing = [item for item in missing if item["origem"] == component_id]

        environment_checks: list[dict[str, Any]] = []
        incompatible = False
        for dependency in component["dependencies"].values():
            target = slug(dependency["target"])
            if target not in BUILTIN_DEPENDENCIES:
                continue
            environment_version = {
                "minecraft": "1.20.1",
                "forge": "47.4.0",
                "neoforge": "47.4.4",
                "java": "17",
                "fml": "47.4.0",
            }.get(target)
            result = version_in_range(environment_version or "", dependency.get("versionRange"))
            if result is False:
                incompatible = True
            environment_checks.append(
                {
                    "dependency": target,
                    "environmentVersion": environment_version,
                    "declaredRange": dependency.get("versionRange"),
                    "matches": result,
                }
            )

        active_versions_by_context: dict[str, set[str]] = defaultdict(set)
        for artifact in component["artifacts"]:
            if not artifact.get("modVersion"):
                continue
            for context in artifact["contexts"]:
                if context in active_contexts:
                    active_versions_by_context[context].add(artifact["modVersion"])
        active_versions = sorted({version for values in active_versions_by_context.values() for version in values})
        server_versions = active_versions_by_context.get("server_active", set())
        launcher_versions = active_versions_by_context.get("launcher_current", set())
        embedded_versions = active_versions_by_context.get("embedded_client", set())
        version_mismatch = bool(
            server_versions
            and (
                (launcher_versions and server_versions.isdisjoint(launcher_versions))
                or (embedded_versions and server_versions.isdisjoint(embedded_versions))
            )
        )
        verified_metadata = bool(component["metadataPaths"]) and not component["metadataErrors"]
        fabric_only = component["loaders"] == {"fabric"}
        if component_missing:
            state = "dependencia ausente"
            action = "bloquear release e resolver dependência"
        elif incompatible or fabric_only or version_mismatch:
            state = "incompativel"
            action = "selecionar artefato compatível e repetir smoke test"
        elif verified_metadata and component["providers"]:
            state = "correto"
            action = "manter arquivo fixado; verificar atualizações separadamente"
        elif verified_metadata:
            state = "possivelmente compativel"
            action = "validar origem e smoke test"
        else:
            state = "nao verificado"
            action = "obter metadados/proveniência antes da release"

        versions = sorted(component["versions"])
        installed = active_versions[0] if len(active_versions) == 1 else (" | ".join(active_versions) if active_versions else None)
        expected = installed if state == "correto" else "faixas declaradas + smoke test; versão mais recente não verificada"
        compatibility.append(
            {
                "modId": component_id,
                "installedVersion": installed,
                "expectedVersion": expected,
                "minecraft": "1.20.1",
                "loader": "Forge 47.4.x (baseline divergente: cliente 47.4.0; servidor 47.4.4)",
                "state": state,
                "action": action,
                "environmentChecks": environment_checks,
                "observedVersionsByContext": {
                    context: sorted(values) for context, values in sorted(active_versions_by_context.items())
                },
                "evidence": sorted(component["metadataPaths"]),
                "confidence": "alta" if state == "correto" else ("media" if verified_metadata else "baixa"),
            }
        )

        haystack = f"{component_id} {component['name']} {component['description']}".casefold()
        world_data = component["features"]["containsData"] or any(term in haystack for term in WORLD_RISK_TERMS)
        library_critical = bool(dependents)
        disabled_only = not bool(component["contexts"] & {"launcher_current", "server_active", "embedded_client"})
        if len(dependents) >= 2 or (component["category"] == "bibliotecas" and dependents):
            importance = 0
        elif library_critical:
            importance = 1
        elif component["side"] == "cliente":
            importance = 4
        elif component["category"] in {"mundo", "magia", "tecnologia", "combate", "progressao", "automacao"}:
            importance = 1
        elif component["dependencies"]:
            importance = 2
        else:
            importance = 3
        if disabled_only:
            importance = 5

        if library_critical or component_missing:
            removal_impact = "critico"
        elif world_data and component["side"] in {"ambos", "servidor"}:
            removal_impact = "alto"
        elif component["side"] == "cliente":
            removal_impact = "baixo"
        else:
            removal_impact = "medio"

        risk_reasons: list[str] = []
        if component_missing:
            risk_reasons.append("dependência obrigatória ausente no inventário")
        if dependents:
            risk_reasons.append(f"{len(dependents)} dependente(s) obrigatório(s)")
        if world_data:
            risk_reasons.append("pode registrar conteúdo persistente ou orientado a dados")
        if component["metadataErrors"]:
            risk_reasons.append("metadados incompletos ou não verificados")
        if len(active_versions) > 1:
            risk_reasons.append("mais de uma versão ativa observada entre os conjuntos")
        elif len(versions) > 1:
            risk_reasons.append("versões históricas/desativadas adicionais foram observadas")
        if not component["providers"]:
            risk_reasons.append("origem/licença ainda não ligada a um provedor")
        if not risk_reasons:
            risk_reasons.append("nenhum risco estrutural adicional confirmado; smoke test continua obrigatório")

        risk_score = (
            5 * len(component_missing)
            + min(len(dependents), 8)
            + (3 if world_data else 0)
            + (2 if component["metadataErrors"] else 0)
            + (2 if len(active_versions) > 1 else 0)
            + (1 if not component["providers"] else 0)
        )
        risk_level = "critico" if risk_score >= 10 else "alto" if risk_score >= 6 else "medio" if risk_score >= 3 else "baixo"
        risks.append(
            {
                "modId": component_id,
                "level": risk_level,
                "score": risk_score,
                "reasons": risk_reasons,
                "removalImpact": removal_impact,
                "confidence": "media" if verified_metadata else "baixa",
            }
        )

        backup = removal_impact in {"alto", "critico"} or world_data
        removals.append(
            {
                "modId": component_id,
                "atualizar_com_seguranca": "somente com backup, changelog do provedor e smoke test" if backup else "com smoke test do cliente",
                "remover_com_seguranca": disabled_only or (component["side"] == "cliente" and not dependents),
                "exige_backup": backup,
                "exige_novo_mundo": bool(world_data and component["category"] == "mundo"),
                "pode_corromper_chunks": "possivel" if world_data and component["side"] in {"ambos", "servidor"} else "não evidenciado",
                "pode_remover_itens": bool(world_data and component["side"] in {"ambos", "servidor"}),
                "pode_quebrar_receitas": component["features"]["containsData"],
                "pode_quebrar_scripts": bool(component["configPaths"]),
                "pode_quebrar_progressao": component["category"] in {"mundo", "magia", "tecnologia", "combate", "progressao", "automacao"},
                "procedimento_recomendado": "clonar ambiente, fazer backup verificável, alterar um componente por vez, iniciar mundo descartável, conectar cliente e testar restauração",
                "impacto_remocao": removal_impact,
                "importanceLevel": importance,
                "confidence": "media" if verified_metadata else "baixa",
            }
        )

        performance_area = {
            "mundo": "geração de mundo e tick",
            "tecnologia": "tick de blocos, redes e automação",
            "magia": "entidades, efeitos e sincronização",
            "cliente": "renderização, memória gráfica e interface",
            "otimizacao": "altera caminhos críticos; ganho/regressão exige benchmark",
            "servidor": "tick, rede ou observabilidade",
            "bibliotecas": "indireto por dependentes",
            "combate": "entidades, animações, IA e sincronização de combate",
            "progressao": "dados persistentes, missões e regras de progressão",
            "armazenamento": "tick de inventários, serialização e redes de itens",
            "automacao": "tick de máquinas, receitas e transporte",
            "rede": "pacotes, latência e sincronização cliente-servidor",
            "scripts": "reload de dados, receitas e eventos dirigidos por script",
        }.get(component["category"], "não caracterizado")
        performance.append(
            {
                "modId": component_id,
                "area": performance_area,
                "estimatedImpact": "alto" if component["category"] in {"mundo", "tecnologia", "otimizacao"} else "medio" if component["side"] != "cliente" else "cliente",
                "evidence": ["classificação funcional heurística; benchmark não executado"],
                "confidence": "baixa",
            }
        )

        component["importanceLevel"] = importance
        component["removalImpact"] = removal_impact
        component["riskLevel"] = risk_level

    cycles = detect_cycles(components, graph)
    roots = sorted(component_id for component_id in components if not graph.get(component_id))
    shared = [
        {"modId": component_id, "requiredDependents": sorted(dependents)}
        for component_id, dependents in sorted(required_dependents.items(), key=lambda item: (-len(item[1]), item[0]))
        if len(dependents) >= 2
    ]
    return {
        "compatibility": compatibility,
        "risks": risks,
        "removals": removals,
        "performance": performance,
        "missing": missing,
        "missingInactive": [item for item in missing_all if item not in missing],
        "cycles": cycles,
        "roots": roots,
        "shared": shared,
    }


def yaml_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return str(value)
    return json.dumps(str(value), ensure_ascii=False)


def yaml_dump(value: Any, indent: int = 0) -> str:
    prefix = " " * indent
    if isinstance(value, dict):
        lines: list[str] = []
        for key, child in value.items():
            safe_key = key if re.fullmatch(r"[A-Za-z0-9_]+", str(key)) else json.dumps(str(key), ensure_ascii=False)
            if isinstance(child, (dict, list)):
                if not child:
                    lines.append(f"{prefix}{safe_key}: {'{}' if isinstance(child, dict) else '[]'}")
                else:
                    lines.append(f"{prefix}{safe_key}:")
                    lines.append(yaml_dump(child, indent + 2))
            else:
                lines.append(f"{prefix}{safe_key}: {yaml_scalar(child)}")
        return "\n".join(lines)
    if isinstance(value, list):
        lines = []
        for child in value:
            if isinstance(child, dict):
                if not child:
                    lines.append(f"{prefix}- {{}}")
                    continue
                first_key, first_value = next(iter(child.items()))
                safe_key = first_key if re.fullmatch(r"[A-Za-z0-9_]+", str(first_key)) else json.dumps(str(first_key), ensure_ascii=False)
                if isinstance(first_value, (dict, list)):
                    lines.append(f"{prefix}- {safe_key}:")
                    lines.append(yaml_dump(first_value, indent + 4))
                else:
                    lines.append(f"{prefix}- {safe_key}: {yaml_scalar(first_value)}")
                for key, item in list(child.items())[1:]:
                    safe_key = key if re.fullmatch(r"[A-Za-z0-9_]+", str(key)) else json.dumps(str(key), ensure_ascii=False)
                    if isinstance(item, (dict, list)):
                        if not item:
                            lines.append(f"{prefix}  {safe_key}: {'{}' if isinstance(item, dict) else '[]'}")
                        else:
                            lines.append(f"{prefix}  {safe_key}:")
                            lines.append(yaml_dump(item, indent + 4))
                    else:
                        lines.append(f"{prefix}  {safe_key}: {yaml_scalar(item)}")
            elif isinstance(child, list):
                lines.append(f"{prefix}-")
                lines.append(yaml_dump(child, indent + 2))
            else:
                lines.append(f"{prefix}- {yaml_scalar(child)}")
        return "\n".join(lines)
    return f"{prefix}{yaml_scalar(value)}"


def mod_document(component: dict[str, Any], connection_index: dict[str, list[dict[str, Any]]], analysis: dict[str, Any]) -> dict[str, Any]:
    compatibility = next(item for item in analysis["compatibility"] if item["modId"] == component["id"])
    removal = next(item for item in analysis["removals"] if item["modId"] == component["id"])
    required = sorted({item["destino"] for item in connection_index[component["id"]] if item["obrigatoria"]})
    optional = sorted({item["destino"] for item in connection_index[component["id"]] if not item["obrigatoria"]})
    versions = sorted(component["versions"])
    active_versions = sorted({
        artifact["modVersion"]
        for artifact in component["artifacts"]
        if artifact.get("modVersion")
        and set(artifact["contexts"]) & {"launcher_current", "server_active", "embedded_client"}
    })
    filenames = sorted({artifact["fileName"] for artifact in component["artifacts"]})
    return {
        "mod": {
            "id": component["id"],
            "ids_declarados": sorted(component["declaredIds"]),
            "nome": component["name"],
            "arquivo": filenames[0] if len(filenames) == 1 else None,
            "artefatos": component["artifacts"],
            "versao_instalada": active_versions[0] if len(active_versions) == 1 else active_versions,
            "versoes_observadas_incluindo_desativadas": versions,
            "minecraft": "1.20.1",
            "loader": sorted(component["loaders"]) or ["não verificado"],
            "lado": component["side"],
            "categoria": component["category"],
            "descricao_curta": compact_text(component["description"], 180),
            "funcao_principal": compact_text(component["description"], 180),
            "essencial": component["importanceLevel"] <= 1,
            "nivel_importancia": component["importanceLevel"],
            "pode_ser_removido": removal["remover_com_seguranca"],
            "impacto_remocao": component["removalImpact"],
            "dependencias_obrigatorias": required,
            "dependencias_opcionais": optional,
            "dependentes": component["dependents"],
            "integracoes": [item["destino"] for item in connection_index[component["id"]] if item["tipo"] != "dependencia"],
            "configs_principais": component["configPaths"],
            "riscos": next(item["reasons"] for item in analysis["risks"] if item["modId"] == component["id"]),
            "impacto_desempenho": next(item["area"] for item in analysis["performance"] if item["modId"] == component["id"]),
            "observacoes": [
                f"contextos: {', '.join(CONTEXT_LABELS.get(item, item) for item in sorted(component['contexts']))}",
                f"compatibilidade: {compatibility['state']}",
                *sorted(component["metadataErrors"]),
            ],
            "confianca": {
                "nivel": "alta" if component["metadataPaths"] and not component["metadataErrors"] else "media" if component["metadataPaths"] else "baixa",
                "origem": "metadatos do loader, hashes e inventários sanitizados",
                "evidencias": sorted(component["metadataPaths"]) + sorted(component["sideEvidence"]),
            },
        },
        "manutencao": {key: value for key, value in removal.items() if key not in {"modId", "importanceLevel", "confidence"}},
    }


def mermaid_id(value: str) -> str:
    return "n_" + slug(value)


def mermaid_graph(connections: list[dict[str, Any]], title: str, limit: int = 180) -> str:
    ordered = sorted(
        connections,
        key=lambda item: (not item["obrigatoria"], not item["presente"], item["origem"], item["destino"]),
    )[:limit]
    lines = [f"%% {title}", "graph TD"]
    for item in ordered:
        origin, target = mermaid_id(item["origem"]), mermaid_id(item["destino"])
        origin_label = item["origem"].replace('"', "'")
        target_label = item["destino"].replace('"', "'")
        lines.append(f'    {origin}["{origin_label}"]')
        lines.append(f'    {target}["{target_label}"]')
        if not item["presente"] and item["obrigatoria"]:
            arrow, label = "--x", "ausente"
        elif item["obrigatoria"]:
            arrow, label = "-->", "depende"
        elif not item["presente"]:
            arrow, label = "-.->", "opcional ausente"
        else:
            arrow, label = "-.->", "opcional"
        lines.append(f"    {origin} {arrow}|{label}| {target}")
    if not ordered:
        lines.append('    none["Nenhuma conexão confirmada neste recorte"]')
    return "\n".join(lines) + "\n"


def dependency_tree(shared: list[dict[str, Any]], components: dict[str, dict[str, Any]]) -> str:
    lines = ["ÁRVORE DE DEPENDÊNCIAS — PONTOS COMPARTILHADOS", ""]
    for item in shared[:80]:
        component = components.get(item["modId"])
        critical = "[CRÍTICO]" if len(item["requiredDependents"]) >= 5 else "[OBRIGATÓRIO]"
        side = f"[{component['side'].upper()}]" if component else ""
        lines.append(f"{item['modId']} {critical} {side}".rstrip())
        for index, dependent in enumerate(item["requiredDependents"]):
            branch = "└──" if index == len(item["requiredDependents"]) - 1 else "├──"
            lines.append(f"{branch} {dependent}")
        lines.append("")
    if len(lines) == 2:
        lines.append("Nenhuma biblioteca compartilhada confirmada.")
    return "\n".join(lines)


def conflict_graph(missing: list[dict[str, Any]], incompatible: list[dict[str, Any]]) -> str:
    lines = [
        "%% Conflitos globais e dependências obrigatórias ausentes",
        "graph TD",
        '    launcher["launcher VoidFall atual"] --x|somente 11/181 JARs comuns| server["servidor auditado"]',
        '    forge_client["Forge cliente 47.4.0"] --x|baseline divergente| forge_server["Forge servidor 47.4.4"]',
    ]
    for item in missing:
        lines.append(
            f'    {mermaid_id(item["origem"])}["{item["origem"]}"] --x|dependência ausente| '
            f'{mermaid_id(item["destino"])}["{item["destino"]}"]'
        )
    for item in incompatible:
        lines.append(
            f'    {mermaid_id(item["modId"])}["{item["modId"]}"] --x|versão ou loader incompatível| '
            f'{mermaid_id(item["modId"] + "_baseline")}["baseline VoidFall"]'
        )
    return "\n".join(lines) + "\n"


def category_markdown(category: str, items: list[dict[str, Any]]) -> str:
    lines = [f"# Categoria: {category}", "", f"Total: **{len(items)}** componentes.", "", "| Mod ID | Lado | Nível | Risco | Ficha |", "| --- | --- | ---: | --- | --- |"]
    for item in sorted(items, key=lambda value: value["id"]):
        lines.append(
            f"| `{item['id']}` | {item['side']} | {item['importanceLevel']} | {item['riskLevel']} | [YAML](../mods/{item['id']}.yaml) |"
        )
    return "\n".join(lines)


def build_docs(root: Path, output: Path, analysis_date: str) -> dict[str, Any]:
    artifacts, extraction = load_artifacts(root)
    overrides = public_override_inventory(root)
    server_summary = read_json(root / "Servidor/catalog/resumo-servidor.json")
    components = build_components(artifacts, overrides)
    for pack in server_summary.get("openLoaderPacks", []):
        pack_token = slug(pack["name"])
        for component in components.values():
            component_token = component["id"].replace("_", "")
            if len(component_token) >= 4 and component_token in pack_token.replace("_", ""):
                component["configPaths"].append(
                    f"Servidor:config/openloader/data/{pack['name']} (agregado sanitizado)"
                )
    connections = dependency_connections(components)
    analysis = analyze_components(components, connections)
    connection_index: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for connection in connections:
        connection_index[connection["origem"]].append(connection)

    launcher_summary = read_json(root / "docs/launcher/inventario/resumo-perfil.json")
    verified_sources = read_json(root / "tools/modpack/verified_sources.json")
    compatibility_rows = read_csv(root / "Servidor/catalog/compatibilidade-cliente.csv")
    active_components = [
        component for component in components.values()
        if component["contexts"] & {"launcher_current", "server_active", "embedded_client"}
    ]
    category_counts = Counter(component["category"] for component in active_components)
    side_counts = Counter(component["side"] for component in active_components)
    critical = sorted(
        (component["id"] for component in active_components if component["importanceLevel"] == 0),
        key=lambda component_id: (-len(components[component_id]["dependents"]), component_id),
    )
    conflicts = [
        {
            "id": "client-server-baseline-mismatch",
            "type": "conflito",
            "summary": "O launcher canônico atual não representa o conjunto ativo do servidor.",
            "evidence": {
                "serverActiveJars": server_summary["compatibility"]["serverActiveJars"],
                "currentLauncherExactCommon": server_summary["compatibility"]["currentLauncherExactCommon"],
                "currentLauncherServerOnly": server_summary["compatibility"]["currentLauncherServerOnly"],
            },
            "confidence": "alta",
        },
        {
            "id": "forge-baseline-divergence",
            "type": "conflito",
            "summary": "Cliente canônico usa Forge 47.4.0 e servidor auditado usa Forge 47.4.4.",
            "evidence": ["Launcher/pack/manifest.json", "Servidor/catalog/resumo-servidor.json"],
            "confidence": "alta",
        },
    ]
    disabled_candidates = sorted(
        component["id"] for component in components.values()
        if not component["contexts"] & {"launcher_current", "server_active", "embedded_client"}
    )
    duplicate_candidates = sorted(
        component["id"] for component in components.values()
        if len(component["versions"]) > 1 or len({artifact["sha256"] for artifact in component["artifacts"] if artifact["sha256"]}) > 1
    )
    removal_candidates = sorted(set(disabled_candidates + duplicate_candidates))
    incompatible_components = [
        item for item in analysis["compatibility"] if item["state"] == "incompativel"
    ]

    inventory = {
        "schemaVersion": 1,
        "analysisDate": analysis_date,
        "environment": {
            "product": "VoidFall",
            "minecraft": "1.20.1",
            "clientLoader": "Forge 47.4.0",
            "serverLoader": "Forge 47.4.4",
            "java": 17,
        },
        "scope": {
            "launcherProviderCatalog": "Launcher/catalog/addons.json",
            "launcherCanonicalOverrides": "Launcher/pack/overrides",
            "serverSanitizedCatalog": "Servidor/catalog/mods.csv",
            "serverCompatibilityCatalog": "Servidor/catalog/compatibilidade-cliente.csv",
            "runtimeForensics": "read-only loader metadata from ignored mods directories",
            "excluded": ["worlds", "logs", "player identities", "addresses", "secrets", "configuration values"],
        },
        "extraction": extraction,
        "artifacts": artifacts,
        "publicOverrides": overrides,
        "sanitizedServerDirectorySummary": read_csv(root / "Servidor/catalog/diretorios.csv"),
        "serverOpenLoaderPacks": server_summary.get("openLoaderPacks", []),
        "exactFilenameCompatibility": compatibility_rows,
    }
    dependencies = {
        "schemaVersion": 1,
        "required": [item for item in connections if item["obrigatoria"]],
        "optional": [item for item in connections if not item["obrigatoria"]],
        "missing": analysis["missing"],
        "missingInactive": analysis["missingInactive"],
        "roots": analysis["roots"],
        "sharedLibraries": analysis["shared"],
        "cycles": analysis["cycles"],
        "singlePointsOfFailure": analysis["shared"][:20],
    }
    compatibility = {
        "schemaVersion": 1,
        "baseline": inventory["environment"],
        "matrix": analysis["compatibility"],
        "globalConflicts": conflicts,
        "officialEnvironmentReference": verified_sources,
        "onlineLatestVersionCheck": {
            "status": "not_verified",
            "reason": "A versão instalada é registrável; 'mais recente' não implica compatibilidade. Atualizações exigem revisão oficial por projeto e smoke test.",
        },
    }
    risk_document = {
        "schemaVersion": 1,
        "top10": sorted(analysis["risks"], key=lambda item: (-item["score"], item["modId"]))[:10],
        "all": sorted(analysis["risks"], key=lambda item: item["modId"]),
        "global": [
            "launcher atual incompatível por inventário com o servidor ativo",
            "proveniência/licença incompleta bloqueia redistribuição",
            "17 artefatos ativos locais/alterados no servidor exigem autoria e licença",
            "3 stubs ativos podem mascarar dependências reais",
            "OpenLoader contém milhares de arquivos e integrações orientadas a dados",
            "world/data do cliente canônico falhou em criação de mundo histórica",
            "Forge diverge entre cliente e servidor",
            "compatibilidade por nome/hash não substitui conexão real",
            "remoções de worldgen/conteúdo podem destruir dados persistentes",
            "configurações privadas não foram publicadas nem comparadas por valor",
        ],
    }
    removals = {
        "schemaVersion": 1,
        "policy": "Nunca remover automaticamente; backup e teste de restauração são obrigatórios para impacto alto/crítico.",
        "candidates": removal_candidates,
        "items": sorted(analysis["removals"], key=lambda item: item["modId"]),
    }
    performance = {
        "schemaVersion": 1,
        "status": "heuristic_only",
        "warning": "Nenhum benchmark foi executado. Impacto é triagem, não medição.",
        "items": sorted(analysis["performance"], key=lambda item: item["modId"]),
    }
    configuration_surface = {
        "schemaVersion": 1,
        "analysisDate": analysis_date,
        "launcherCanonical": {
            "source": "Launcher/pack/overrides",
            "files": overrides,
            "countsByKind": dict(sorted(Counter(item["kind"] for item in overrides).items())),
            "countsByExtension": dict(sorted(Counter(Path(item["path"]).suffix.casefold() or "(none)" for item in overrides).items())),
        },
        "serverSanitized": {
            "directorySummary": read_csv(root / "Servidor/catalog/diretorios.csv"),
            "openLoaderPacks": server_summary.get("openLoaderPacks", []),
            "publicTemplates": [
                path.relative_to(root).as_posix()
                for path in sorted((root / "Servidor/templates").glob("*"))
                if path.is_file()
            ],
            "valuesExported": False,
            "reason": "valores, segredos, identidades e estado vivo permanecem no workspace privado",
        },
        "modMappings": {
            component["id"]: sorted(set(component["configPaths"]))
            for component in sorted(components.values(), key=lambda item: item["id"])
            if component["configPaths"]
        },
        "phase7SchemaCandidates": [
            {"id": "forge_toml_v1", "patterns": ["config/*.toml"], "status": "candidate_not_selected"},
            {"id": "java_properties_v1", "patterns": ["config/**/*.properties"], "status": "candidate_not_selected"},
            {"id": "openloader_json_v1", "patterns": ["openloader/*.json", "config/openloader/**/*.json"], "status": "candidate_not_selected"},
            {"id": "fancymenu_text_v1", "patterns": ["config/fancymenu/**/*.txt"], "status": "candidate_not_selected"},
            {"id": "minecraft_options_v1", "patterns": ["options.txt"], "status": "candidate_not_selected"},
        ],
        "selectionRule": "nenhum schema é suportado até revisão humana de campos, limites, reinício, migração e rollback",
    }
    summary = {
        "minecraft": "1.20.1",
        "loader": "Forge",
        "loaderVersion": {"client": "47.4.0", "server": "47.4.4"},
        "java": "17",
        "totalMods": len(active_components),
        "totalComponentsDocumented": len(components),
        "criticalMods": critical,
        "clientOnly": sorted(component["id"] for component in active_components if component["side"] == "cliente"),
        "serverOnly": sorted(component["id"] for component in active_components if component["side"] == "servidor"),
        "bothSides": sorted(component["id"] for component in active_components if component["side"] == "ambos"),
        "unknownSide": sorted(component["id"] for component in active_components if component["side"] == "desconhecido"),
        "missingDependencies": sorted({item["destino"] for item in analysis["missing"]}),
        "conflicts": [item["id"] for item in conflicts] + [f"mod:{item['modId']}:incompatible" for item in incompatible_components],
        "removalCandidates": removal_candidates,
        "graphs": [
            "graficos/mapa-geral.mmd",
            "graficos/dependencias.mmd",
            "graficos/cliente-servidor.mmd",
            "graficos/progressao.mmd",
            "graficos/conflitos.mmd",
            "graficos/arvore-dependencias.txt",
        ],
        "categoryCounts": dict(sorted(category_counts.items())),
        "sideCounts": dict(sorted(side_counts.items())),
        "notVerifiedItems": sum(item["state"] == "nao verificado" for item in analysis["compatibility"]),
        "lastAnalysis": analysis_date,
    }

    if output.exists():
        shutil.rmtree(output)
    (output / "mods").mkdir(parents=True)
    (output / "categorias").mkdir(parents=True)
    (output / "graficos").mkdir(parents=True)

    write_json(output / "resumo.json", summary)
    write_json(output / "inventario.json", inventory)
    write_json(output / "dependencias.json", dependencies)
    write_json(output / "conexoes.json", {"schemaVersion": 1, "connections": connections})
    write_json(output / "compatibilidade.json", compatibility)
    write_json(output / "riscos.json", risk_document)
    write_json(output / "remocoes.json", removals)
    write_json(output / "performance.json", performance)
    write_json(output / "configuracoes.json", configuration_surface)

    for component in sorted(components.values(), key=lambda item: item["id"]):
        document = mod_document(component, connection_index, analysis)
        write_text(output / "mods" / f"{component['id']}.yaml", yaml_dump(document))

    category_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for component in components.values():
        category_groups[component["category"]].append(component)
    for category in (*CATEGORY_TERMS.keys(), "outros"):
        write_text(output / "categorias" / f"{category}.md", category_markdown(category, category_groups.get(category, [])))

    non_builtin_connections = [item for item in connections if not item["builtin"]]
    write_text(output / "graficos/mapa-geral.mmd", mermaid_graph(non_builtin_connections, "Mapa geral de dependências confirmadas", 160))
    write_text(output / "graficos/dependencias.mmd", mermaid_graph([item for item in connections if item["obrigatoria"]], "Dependências obrigatórias", 220))
    client_server_ids = {component["id"] for component in components.values() if component["side"] in {"cliente", "servidor"}}
    write_text(output / "graficos/cliente-servidor.mmd", mermaid_graph([item for item in non_builtin_connections if item["origem"] in client_server_ids or item["destino"] in client_server_ids], "Fronteira cliente-servidor", 160))
    progression_ids = {
        component["id"] for component in components.values()
        if component["category"] in {"tecnologia", "magia", "mundo", "combate", "progressao", "automacao"}
    }
    write_text(output / "graficos/progressao.mmd", mermaid_graph([item for item in non_builtin_connections if item["origem"] in progression_ids or item["destino"] in progression_ids], "Tecnologia, magia, mundo e progressão", 160))
    write_text(output / "graficos/conflitos.mmd", conflict_graph(analysis["missing"], incompatible_components))
    write_text(output / "graficos/arvore-dependencias.txt", dependency_tree(analysis["shared"], components))

    index_lines = [
        "# VoidFall — mapa técnico do modpack",
        "",
        "## Resumo",
        "",
        "Base auditada: Minecraft 1.20.1, Java 17 e Forge 47.4.x. O cliente canônico e o servidor ainda não formam uma release compatível: somente "
        f"{server_summary['compatibility']['currentLauncherExactCommon']} dos {server_summary['compatibility']['serverActiveJars']} JARs ativos do servidor coincidem por nome exato com o launcher publicado.",
        "",
        "## Versões principais",
        "",
        "| Componente | Versão |",
        "| --- | --- |",
        "| Minecraft | 1.20.1 |",
        "| Java | 17 |",
        "| Forge do launcher | 47.4.0 |",
        "| Forge do servidor | 47.4.4 |",
        "",
        "## Quantidades",
        "",
        f"- Componentes ativos mapeados por `mod_id`: **{len(active_components)}**.",
        f"- Componentes documentados, incluindo desativados/candidatos: **{len(components)}**.",
        f"- Artefatos únicos inventariados: **{len(artifacts)}**.",
        f"- Dependências declaradas: **{len(connections)}**.",
        f"- Dependências obrigatórias ausentes: **{len(analysis['missing'])}**.",
        "",
        "## Quantidade por categoria",
        "",
        "| Categoria | Componentes ativos |",
        "| --- | ---: |",
        *[f"| {category} | {count} |" for category, count in sorted(category_counts.items())],
        "",
        "## Mods críticos",
        "",
        ", ".join(f"`{item}`" for item in critical[:30]) or "Nenhum ponto estrutural confirmado.",
        "",
        "## Problemas encontrados",
        "",
        "- O launcher atual não é compatível com o servidor por inventário.",
        "- Forge diverge entre cliente (47.4.0) e servidor (47.4.4).",
        f"- A fonte oficial lista Forge {verified_sources['forge']['recommended']} como recomendado e {verified_sources['forge']['latest']} como mais recente para 1.20.1; isso não autoriza atualização automática.",
        "- Proveniência, licença e redistribuição ainda não estão resolvidas para a maioria dos artefatos do servidor.",
        "- Compatibilidade da versão mais recente de cada projeto não foi presumida; exige revisão oficial e smoke test.",
        "- Configurações privadas foram preservadas; apenas caminhos públicos e agregados sanitizados entram nesta base.",
        "",
        "## Dependências ausentes",
        "",
        ", ".join(f"`{item}`" for item in summary["missingDependencies"]) or "Nenhuma ausente confirmada no conjunto agregado.",
        "",
        "## Incompatibilidades",
        "",
        "- `client-server-baseline-mismatch`",
        "- `forge-baseline-divergence`",
        *[f"- `{item['modId']}`: {item['action']}" for item in incompatible_components],
        "",
        "## Candidatos à remoção",
        "",
        f"{len(removal_candidates)} componentes foram marcados apenas para revisão; nada foi removido. Consulte [remocoes.json](remocoes.json).",
        "",
        "## Navegação",
        "",
        "- [Resumo para agentes](resumo.json)",
        "- [Inventário](inventario.json)",
        "- [Dependências](dependencias.json)",
        "- [Conexões](conexoes.json)",
        "- [Compatibilidade](compatibilidade.json)",
        "- [Riscos](riscos.json)",
        "- [Remoções](remocoes.json)",
        "- [Performance](performance.json)",
        "- [Configurações, scripts e datapacks](configuracoes.json)",
        "- [Categorias](categorias/)",
        "- [Fichas individuais](mods/)",
        "- [Gráficos](graficos/)",
        "- [Metodologia e limites](metodologia.md)",
        "- [Relatório final](relatorio-final.md)",
    ]
    write_text(output / "index.md", "\n".join(index_lines))

    methodology = f"""# Metodologia e limites

## Fontes

- Manifesto e catálogo do launcher: `Launcher/pack/manifest.json` e `Launcher/catalog/addons.json`.
- Overrides públicos: `Launcher/pack/overrides/**`.
- Catálogos sanitizados do servidor: `Servidor/catalog/**`.
- Forense explícita e somente-leitura: metadados de loader nos diretórios ignorados `mods/` do launcher, servidor e cliente privado de referência.

## O que foi lido nos JARs

Somente estrutura ZIP, `META-INF/mods.toml`, `META-INF/neoforge.mods.toml`, `fabric.mod.json`, `mcmod.info`, `META-INF/MANIFEST.MF`, nomes de mixins e presença de access transformers, `data/` e `assets/`. Nenhuma classe foi carregada, executada ou descompilada.

## Confiança

- **Alta:** hash, manifesto do provedor, `mod_id`, versão e dependência declarados em metadado interno.
- **Média:** lado inferido pela presença nos conjuntos cliente/servidor e categorização apoiada por metadados.
- **Baixa:** impacto de performance, função sem descrição interna, risco comportamental ou versão online mais recente.

## Limites deliberados

- Mundos, logs, relatórios de crash, identidades, endereços, segredos e valores de configuração não foram exportados.
- `compatibilidade por nome/hash` não certifica protocolo, registries, datapacks ou gameplay.
- `versão mais recente` não foi tratada como `versão correta`; a matriz usa faixas declaradas e mantém atualização como revisão manual.
- A classificação de lado por presença é uma inferência. Mods de handshake opcional podem aparecer somente em um conjunto.
- A análise de performance é triagem sem benchmark.

## Referências oficiais verificadas

- [Forge 1.20.1 — downloads]({verified_sources['forge']['source']}) — recomendado {verified_sources['forge']['recommended']}, mais recente {verified_sources['forge']['latest']} em {verified_sources['verifiedAt']}.
- [Metadados `mods.toml`]({verified_sources['forgeMetadataDocumentation']}).
- [Formato de exportação CurseForge]({verified_sources['curseForgeExportDocumentation']}).

## Regeração

```powershell
$python = Get-Content graphify-out/.graphify_python
& $python tools/modpack/generate_modpack_docs.py --root .
& $python tools/modpack/validate_modpack_docs.py --root .
```

Análise gerada em: {analysis_date}.
"""
    write_text(output / "metodologia.md", methodology)

    report = {
        "modsFound": len(active_components),
        "modsAnalyzed": len(components),
        "libraries": category_counts.get("bibliotecas", 0),
        "criticalMods": len(critical),
        "clientMods": side_counts.get("cliente", 0),
        "serverMods": side_counts.get("servidor", 0),
        "bothSides": side_counts.get("ambos", 0),
        "missingDependencies": len(analysis["missing"]),
        "incompatibilities": sum(item["state"] == "incompativel" for item in analysis["compatibility"]),
        "probableConflicts": len(conflicts) + len(analysis["missing"]),
        "removalCandidates": len(removal_candidates),
        "unverifiedItems": summary["notVerifiedItems"],
        "documentationFiles": len(list(output.rglob("*"))),
        "topRisks": risk_document["top10"],
        "singlePointsOfFailure": dependencies["singlePointsOfFailure"],
        "manualValidation": [
            "alinhar Forge do cliente e servidor",
            "selecionar o catálogo cliente compatível com o servidor",
            "resolver origem/licença de cada artefato",
            "validar valores de configuração sem publicá-los",
            "importar em launcher limpo, iniciar, criar mundo e conectar ao servidor",
            "executar backup e restauração antes de remoções/atualizações",
        ],
        "nextSteps": [
            "revisar `compatibilidade.json` e selecionar schemas explícitos para a Fase 7",
            "resolver divergências de baseline e revisar integrações opcionais",
            "promover somente configurações necessárias e sanitizadas",
            "executar matriz de smoke tests cliente-servidor",
        ],
    }
    report_lines = [
        "# ANÁLISE DO MODPACK CONCLUÍDA",
        "",
        f"- Mods/componentes ativos encontrados: **{report['modsFound']}**",
        f"- Componentes analisados: **{report['modsAnalyzed']}**",
        f"- Bibliotecas: **{report['libraries']}**",
        f"- Mods críticos: **{report['criticalMods']}**",
        f"- Mods de cliente: **{report['clientMods']}**",
        f"- Mods de servidor: **{report['serverMods']}**",
        f"- Mods de ambos os lados: **{report['bothSides']}**",
        f"- Dependências obrigatórias ausentes: **{report['missingDependencies']}**",
        f"- Incompatibilidades: **{report['incompatibilities']}**",
        f"- Conflitos globais prováveis: **{report['probableConflicts']}**",
        f"- Candidatos à remoção/revisão: **{report['removalCandidates']}**",
        f"- Itens não verificados: **{report['unverifiedItems']}**",
        "",
        "## Dez maiores riscos",
        "",
        "| Mod ID | Nível | Score | Evidência resumida |",
        "| --- | --- | ---: | --- |",
        *[
            f"| `{item['modId']}` | {item['level']} | {item['score']} | {'; '.join(item['reasons'])} |"
            for item in report["topRisks"]
        ],
        "",
        "## Principais pontos únicos de falha",
        "",
        *[
            f"- `{item['modId']}`: {len(item['requiredDependents'])} dependentes obrigatórios."
            for item in report["singlePointsOfFailure"][:15]
        ],
        "",
        "## Validação manual pendente",
        "",
        *[f"- {item}" for item in report["manualValidation"]],
        "",
        "## Próximas etapas",
        "",
        *[f"- {item}" for item in report["nextSteps"]],
    ]
    write_text(output / "relatorio-final.md", "\n".join(report_lines))
    write_json(output / "relatorio-final.json", report)
    report["documentationFiles"] = len([item for item in output.rglob("*") if item.is_file()])
    write_json(output / "relatorio-final.json", report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path)
    parser.add_argument("--analysis-date", default=date.today().isoformat())
    args = parser.parse_args()
    root = args.root.resolve()
    output = args.output.resolve() if args.output else root / "docs/modpack"
    report = build_docs(root, output, args.analysis_date)
    print(stable_json(report).rstrip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
