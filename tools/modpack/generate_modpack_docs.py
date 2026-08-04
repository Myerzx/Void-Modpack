"""Generate the VoidFall modpack knowledge base from sanitized evidence.

The committed generator is CI-safe and never reads the ignored launcher/server
workspaces. Its only artifact-level input is a reviewed, sanitized fixture.
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

CONTEXTS = {
    "launcher_current": {"kind": "canonical", "side": "client", "loader": "forge", "loaderVersion": "47.4.0", "javaVersion": "17"},
    "server_active": {"kind": "canonical", "side": "server", "loader": "forge", "loaderVersion": "47.4.4", "javaVersion": "17"},
    "embedded_client": {"kind": "reference", "side": "client", "loader": "forge", "loaderVersion": None, "javaVersion": "17"},
    "launcher_disabled": {"kind": "historical", "side": "client", "loader": "forge", "loaderVersion": "47.4.0", "javaVersion": "17"},
    "server_disabled": {"kind": "historical", "side": "server", "loader": "forge", "loaderVersion": "47.4.4", "javaVersion": "17"},
    "server_other": {"kind": "historical", "side": "server", "loader": "forge", "loaderVersion": "47.4.4", "javaVersion": "17"},
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


def _disabled_private_runtime_forensics(root: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    raise RuntimeError("private runtime forensics are disabled in the committed generator")
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


def load_artifacts(fixture_path: Path) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    fixture = read_json(fixture_path)
    if fixture.get("schemaVersion") != 1 or not isinstance(fixture.get("artifacts"), list):
        raise ValueError(f"invalid sanitized artifact fixture: {fixture_path}")
    analysis_date = fixture.get("analysisDate")
    if not isinstance(analysis_date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", analysis_date):
        raise ValueError(f"fixture analysisDate must be ISO date: {fixture_path}")
    extraction = dict(fixture.get("extraction") or {})
    extraction["source"] = f"tools/modpack/fixtures/{fixture_path.name}"
    extraction["mode"] = "committed-sanitized-fixture"
    artifacts = fixture["artifacts"]
    return (
        sorted(artifacts, key=lambda item: (item["fileName"].casefold(), item["artifactId"])),
        extraction,
        analysis_date,
    )


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


def loader_from_metadata(mod: dict[str, Any], artifact: dict[str, Any]) -> str | None:
    metadata_path = str(mod.get("metadataPath") or "").casefold()
    if metadata_path.endswith("meta-inf/neoforge.mods.toml"):
        return "neoforge"
    if metadata_path.endswith("fabric.mod.json"):
        return "fabric"
    if metadata_path.endswith("meta-inf/mods.toml"):
        return "forge"
    declared = [item for item in artifact.get("loaders", []) if item in {"forge", "neoforge", "fabric", "quilt"}]
    return declared[0] if len(set(declared)) == 1 else None


def container_from_metadata(mod: dict[str, Any], artifact: dict[str, Any]) -> dict[str, Any]:
    metadata_path = str(mod.get("metadataPath") or "")
    if metadata_path.casefold().startswith("meta-inf/jarjar/"):
        return {"kind": "jarjar", "parentArtifactId": artifact["artifactId"]}
    return {"kind": "root"}


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
                    "occurrences": [],
                    "contexts": set(),
                    "dependencies": {},
                    "dependencyDeclarations": {},
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
            loader = loader_from_metadata(mod, artifact)
            container = container_from_metadata(mod, artifact)
            component["artifacts"].append(
                {
                    "artifactId": artifact["artifactId"],
                    "fileName": artifact["fileName"],
                    "sha256": artifact.get("sha256"),
                    "bytes": artifact.get("bytes"),
                    "state": artifact["state"],
                    "contexts": artifact["contexts"],
                    "modVersion": str(mod["version"]) if mod.get("version") else None,
                    "loader": loader,
                    "container": container,
                    "metadataPath": mod.get("metadataPath"),
                }
            )
            for context in artifact["contexts"]:
                component["occurrences"].append(
                    {
                        "context": context,
                        "artifactId": artifact["artifactId"],
                        "fileName": artifact["fileName"],
                        "version": str(mod["version"]) if mod.get("version") else None,
                        "loader": loader,
                        "container": container,
                        "metadataPath": mod.get("metadataPath"),
                    }
                )
            component["contexts"].update(artifact["contexts"])
            if mod.get("metadataPath"):
                component["metadataPaths"].add(mod["metadataPath"])
            component["metadataErrors"].update(artifact["metadataErrors"])
            if loader:
                component["loaders"].add(loader)
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
                    dependency.get("source"),
                )
                component["dependencies"][key] = dependency
                for context in artifact["contexts"]:
                    declaration_key = (
                        context,
                        loader,
                        artifact["artifactId"],
                        slug(dependency["target"]),
                        dependency["mandatory"],
                        dependency.get("versionRange"),
                        dependency.get("side"),
                        dependency.get("source"),
                    )
                    component["dependencyDeclarations"][declaration_key] = {
                        **dependency,
                        "context": context,
                        "loader": loader,
                        "artifactId": artifact["artifactId"],
                        "fileName": artifact["fileName"],
                    }

    for component in components.values():
        component["name"] = sorted(component["names"], key=lambda item: (len(item), item.casefold()))[0]
        component["description"] = sorted(component["descriptions"], key=lambda item: (-len(item), item.casefold()))[0] if component["descriptions"] else "Descrição não verificada."
        side, confidence, evidence = component_side(component["contexts"])
        component["side"] = side
        component["sideConfidence"] = confidence
        component["sideEvidence"] = evidence
        component["category"] = category_for(component)
        component["componentKind"] = (
            "embedded-library"
            if component["occurrences"]
            and all(item["container"]["kind"] == "jarjar" for item in component["occurrences"])
            else "root-mod"
        )
        component["configPaths"] = infer_config_paths(component["id"], overrides)
    return components


QUALIFIER_ORDER = {
    "alpha": 0,
    "beta": 1,
    "milestone": 2,
    "rc": 3,
    "snapshot": 4,
    "": 5,
    "sp": 6,
}


def normalize_qualifier(value: str) -> str:
    lowered = value.casefold()
    return {
        "a": "alpha",
        "b": "beta",
        "m": "milestone",
        "cr": "rc",
        "final": "",
        "ga": "",
        "release": "",
    }.get(lowered, lowered)


def tokenize_maven_version(value: str) -> list[tuple[str, str, bool]] | None:
    normalized = value.strip()
    if not normalized or len(normalized) > 128 or not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._+\-]*", normalized):
        return None
    tokens: list[tuple[str, str, bool]] = []
    current = ""
    separator = ""
    numeric: bool | None = None

    def push() -> None:
        nonlocal current, numeric
        rendered = current or "0"
        tokens.append((separator, rendered.casefold(), rendered.isdigit()))
        current = ""
        numeric = None

    for character in normalized:
        if character in ".-_":
            push()
            separator = "." if character == "." else "-"
            continue
        next_numeric = character.isdigit()
        if current and numeric != next_numeric:
            push()
            separator = "-"
        current += character
        numeric = next_numeric
    push()
    while len(tokens) > 1:
        _, token, is_numeric = tokens[-1]
        if (is_numeric and int(token) == 0) or (not is_numeric and normalize_qualifier(token) == ""):
            tokens.pop()
        else:
            break
    return tokens


def compare_maven_versions(left: str, right: str) -> int | None:
    left_tokens = tokenize_maven_version(left)
    right_tokens = tokenize_maven_version(right)
    if left_tokens is None or right_tokens is None:
        return None

    def padded(other: tuple[str, str, bool]) -> tuple[str, str, bool]:
        separator, _, numeric = other
        return (separator, "0", True) if separator == "." and numeric else (separator, "", False)

    def token_class(token: tuple[str, str, bool]) -> int:
        separator, _, numeric = token
        if not numeric:
            return 0
        return 2 if separator in {"", "."} else 1

    for index in range(max(len(left_tokens), len(right_tokens))):
        left_token = left_tokens[index] if index < len(left_tokens) else padded(right_tokens[index])
        right_token = right_tokens[index] if index < len(right_tokens) else padded(left_tokens[index])
        left_class, right_class = token_class(left_token), token_class(right_token)
        if left_class != right_class:
            return -1 if left_class < right_class else 1
        if left_token[2] and right_token[2]:
            left_number, right_number = int(left_token[1]), int(right_token[1])
            if left_number != right_number:
                return -1 if left_number < right_number else 1
        elif not left_token[2] and not right_token[2]:
            left_qualifier, right_qualifier = normalize_qualifier(left_token[1]), normalize_qualifier(right_token[1])
            left_rank = QUALIFIER_ORDER.get(left_qualifier, 7)
            right_rank = QUALIFIER_ORDER.get(right_qualifier, 7)
            if left_rank != right_rank:
                return -1 if left_rank < right_rank else 1
            if left_qualifier != right_qualifier:
                return -1 if left_qualifier < right_qualifier else 1
    return 0


def parse_maven_range(value: str) -> list[tuple[str | None, bool, str | None, bool]] | None:
    spec = value.strip()
    if not spec or len(spec) > 128 or spec == "*":
        return None
    restrictions: list[tuple[str | None, bool, str | None, bool]] = []
    index = 0
    while index < len(spec):
        opening = spec[index]
        if opening not in "[(":
            return None
        closing_index = index + 1
        while closing_index < len(spec) and spec[closing_index] not in "])":
            closing_index += 1
        if closing_index >= len(spec):
            return None
        closing = spec[closing_index]
        body = spec[index + 1 : closing_index].strip()
        if body.count(",") == 0:
            if opening != "[" or closing != "]" or tokenize_maven_version(body) is None:
                return None
            restrictions.append((body, True, body, True))
        elif body.count(",") == 1:
            raw_lower, raw_upper = body.split(",", 1)
            lower, upper = raw_lower.strip() or None, raw_upper.strip() or None
            if (lower is None and upper is None) or (lower and tokenize_maven_version(lower) is None) or (upper and tokenize_maven_version(upper) is None):
                return None
            restrictions.append((lower, opening == "[", upper, closing == "]"))
        else:
            return None
        index = closing_index + 1
        if index == len(spec):
            break
        if spec[index] != ",":
            return None
        index += 1
        while index < len(spec) and spec[index].isspace():
            index += 1
    return restrictions or None


def evaluate_maven_version_range(version: str | None, declared: str | None) -> str:
    if version is None:
        return "unknown"
    if declared is None or not declared.strip():
        return "match"
    recommended_version = declared.strip()
    if not recommended_version.startswith(("[", "(")):
        compared = compare_maven_versions(version, recommended_version)
        return "match" if compared == 0 else "unknown"
    restrictions = parse_maven_range(declared)
    if restrictions is None:
        return "unknown"
    for lower, lower_inclusive, upper, upper_inclusive in restrictions:
        if lower:
            compared = compare_maven_versions(version, lower)
            if compared is None:
                return "unknown"
            if compared < 0 or (compared == 0 and not lower_inclusive):
                continue
        if upper:
            compared = compare_maven_versions(version, upper)
            if compared is None:
                return "unknown"
            if compared > 0 or (compared == 0 and not upper_inclusive):
                continue
        return "match"
    return "mismatch"


def _legacy_dependency_connections(components: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
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


def dependency_side_applies(declared_side: str | None, context: dict[str, Any]) -> bool:
    side = (declared_side or "BOTH").upper()
    return side in {"BOTH", context["side"].upper()}


def builtin_version(target: str, context: dict[str, Any]) -> str | None:
    if target == "minecraft":
        return "1.20.1"
    if target == "java":
        return context.get("javaVersion")
    if target in {"forge", "fml"} and context["loader"] == "forge":
        return context.get("loaderVersion")
    if target == "neoforge" and context["loader"] == "neoforge":
        return context.get("loaderVersion")
    if target in {"fabricloader", "fabric-api"} and context["loader"] == "fabric":
        return context.get("loaderVersion")
    return None


def dependency_connections(components: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    connections: list[dict[str, Any]] = []
    known = set(components)
    compact_aliases: dict[str, list[str]] = defaultdict(list)
    for component_id in known:
        compact_aliases[component_id.replace("_", "")].append(component_id)

    for origin_id, component in sorted(components.items()):
        declarations = sorted(
            component["dependencyDeclarations"].values(),
            key=lambda item: (
                item["context"],
                str(item.get("loader") or ""),
                slug(item["target"]),
                not item["mandatory"],
                str(item.get("versionRange") or ""),
            ),
        )
        for dependency in declarations:
            context_id = dependency["context"]
            context = CONTEXTS.get(context_id)
            if context is None:
                continue
            declared_target = slug(dependency["target"])
            target = declared_target
            aliases = compact_aliases.get(declared_target.replace("_", ""), [])
            if target not in known and len(aliases) == 1:
                target = aliases[0]
            builtin = declared_target in BUILTIN_DEPENDENCIES
            loader_applicable = dependency.get("loader") in {None, context["loader"]}
            side_applicable = dependency_side_applies(dependency.get("side"), context)
            applicable = loader_applicable and side_applicable
            target_versions: list[str] = []
            if builtin:
                version = builtin_version(declared_target, context)
                present = (
                    declared_target in {"minecraft", "java"}
                    or (declared_target in {"forge", "fml"} and context["loader"] == "forge")
                    or (declared_target == "neoforge" and context["loader"] == "neoforge")
                    or (declared_target in {"fabricloader", "fabric-api"} and context["loader"] == "fabric")
                )
                if version:
                    target_versions = [version]
            else:
                target_component = components.get(target)
                occurrences = [] if target_component is None else [
                    item for item in target_component["occurrences"]
                    if item["context"] == context_id and item.get("loader") in {None, context["loader"]}
                ]
                present = bool(occurrences)
                target_versions = sorted({item["version"] for item in occurrences if item.get("version")})

            declared_range = dependency.get("versionRange")
            if not applicable:
                range_result = "not-applicable"
            elif not present:
                range_result = "not-evaluated"
            elif not declared_range:
                range_result = "match"
            elif not target_versions:
                range_result = "unknown"
            else:
                results = [evaluate_maven_version_range(version, declared_range) for version in target_versions]
                range_result = "match" if "match" in results else "mismatch" if all(item == "mismatch" for item in results) else "unknown"

            evidence = [f"{dependency['fileName']}!{dependency['source']}"]
            connections.append(
                {
                    "origem": origin_id,
                    "destino": target,
                    "destino_declarado": declared_target,
                    "tipo": "dependencia" if dependency["mandatory"] else "compatibilidade",
                    "obrigatoria": bool(dependency["mandatory"]),
                    "direcao": "origem_depende_do_destino",
                    "contexto": context_id,
                    "lado_contexto": context["side"],
                    "loader_metadado": dependency.get("loader"),
                    "loader_contexto": context["loader"],
                    "aplicavel": applicable,
                    "faixa_declarada": declared_range,
                    "versoes_destino": target_versions,
                    "resultado_faixa": range_result,
                    "motivo": f"dependencia declarada; faixa={declared_range or 'nao declarada'}; lado={dependency.get('side') or 'BOTH'}; contexto={context_id}",
                    "evidencias": evidence,
                    "risco_de_quebra": "alto" if applicable and dependency["mandatory"] and (not present or range_result == "mismatch") else "medio" if applicable else "baixo",
                    "presente": present,
                    "builtin": builtin,
                    "confianca": {"nivel": "alta", "origem": "fixture sanitizada de metadado do loader", "evidencias": [dependency["source"]]},
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


def evaluate_component_compatibility(
    component_id: str,
    component: dict[str, Any],
    component_connections: list[dict[str, Any]],
) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    context_evaluations: list[dict[str, Any]] = []
    versions_by_context: dict[str, list[str]] = {}

    def add_finding(code: str, severity: str, contexts: list[str], reference: str | None = None) -> None:
        finding = {
            "code": code,
            "severity": severity,
            "contexts": sorted(contexts),
            "evidence": sorted(component["metadataPaths"]),
        }
        if reference:
            finding["reference"] = reference
        if finding not in findings:
            findings.append(finding)

    for context_id, context in CONTEXTS.items():
        observed = [item for item in component["occurrences"] if item["context"] == context_id]
        observed_versions = sorted({item["version"] for item in observed if item.get("version")})
        if not observed:
            context_evaluations.append({"context": context_id, "status": "not-present", "versions": [], "loaders": []})
            continue
        matching = [item for item in observed if item.get("loader") in {None, context["loader"]}]
        known_loaders = sorted({item["loader"] for item in observed if item.get("loader")})
        if not matching:
            severity = "blocker" if context["kind"] == "canonical" else "warning" if context["kind"] == "reference" else "information"
            add_finding("loader-mismatch", severity, [context_id], f"expected={context['loader']};observed={','.join(known_loaders)}")
            context_evaluations.append({
                "context": context_id,
                "status": "incompatible" if context["kind"] == "canonical" else "unknown",
                "versions": observed_versions,
                "loaders": known_loaders,
            })
            versions_by_context[context_id] = observed_versions
            continue

        selected_versions = sorted({item["version"] for item in matching if item.get("version")})
        versions_by_context[context_id] = selected_versions
        status = "compatible" if all(item.get("loader") for item in matching) else "unknown"
        for connection in [item for item in component_connections if item["contexto"] == context_id and item["aplicavel"]]:
            severity = "blocker" if context["kind"] == "canonical" else "warning" if context["kind"] == "reference" else "information"
            if connection["obrigatoria"] and not connection["presente"]:
                add_finding("missing-required-dependency", severity, [context_id], connection["destino"])
                status = "incompatible" if context["kind"] == "canonical" else "unknown"
            elif connection["resultado_faixa"] == "mismatch":
                add_finding("dependency-version-mismatch", severity, [context_id], f"{connection['destino']}:{connection['faixa_declarada']}")
                status = "incompatible" if context["kind"] == "canonical" else "unknown"
            elif connection["resultado_faixa"] == "unknown":
                unknown_severity = "information" if context["kind"] == "historical" else "warning"
                add_finding("dependency-version-unknown", unknown_severity, [context_id], f"{connection['destino']}:{connection['faixa_declarada']}")
                if status != "incompatible":
                    status = "unknown"
        context_evaluations.append({
            "context": context_id,
            "status": status,
            "versions": selected_versions,
            "loaders": sorted({item["loader"] for item in matching if item.get("loader")}),
        })

    launcher_versions = set(versions_by_context.get("launcher_current", []))
    server_versions = set(versions_by_context.get("server_active", []))
    if launcher_versions and server_versions and launcher_versions.isdisjoint(server_versions):
        add_finding(
            "canonical-version-conflict",
            "blocker",
            ["launcher_current", "server_active"],
            f"launcher={','.join(sorted(launcher_versions))};server={','.join(sorted(server_versions))}",
        )

    reference_observed = [item for item in component["occurrences"] if item["context"] == "embedded_client"]
    reference_versions = {item["version"] for item in reference_observed if item.get("version")}
    canonical_versions = server_versions or launcher_versions
    if reference_observed and not canonical_versions:
        add_finding("reference-only-component", "information", ["embedded_client"])
    elif reference_versions and canonical_versions and reference_versions.isdisjoint(canonical_versions):
        add_finding(
            "reference-version-divergence",
            "warning",
            ["embedded_client", "server_active" if server_versions else "launcher_current"],
            f"reference={','.join(sorted(reference_versions))};canonical={','.join(sorted(canonical_versions))}",
        )

    active_versions = launcher_versions | server_versions
    for context_id, context in CONTEXTS.items():
        if context["kind"] != "historical":
            continue
        historical_versions = set(versions_by_context.get(context_id, []))
        if historical_versions and active_versions and historical_versions.isdisjoint(active_versions):
            add_finding(
                "historical-version-divergence",
                "information",
                [context_id],
                f"historical={','.join(sorted(historical_versions))};active={','.join(sorted(active_versions))}",
            )

    findings.sort(key=lambda item: (item["code"], item["contexts"], item.get("reference", "")))
    canonical_compatible = any(
        item["status"] == "compatible" and CONTEXTS[item["context"]]["kind"] == "canonical"
        for item in context_evaluations
    )
    if any(item["severity"] == "blocker" for item in findings):
        status = "incompatible"
    elif findings or not canonical_compatible:
        status = "unknown"
    else:
        status = "compatible"
    codes = {item["code"] for item in findings}
    classification = (
        "canonical-conflict" if "canonical-version-conflict" in codes
        else "dependency-conflict" if codes & {"missing-required-dependency", "dependency-version-mismatch"}
        else "reference-divergence" if "reference-version-divergence" in codes
        else "reference-only" if "reference-only-component" in codes
        else "loader-mismatch" if "loader-mismatch" in codes
        else "unknown" if status == "unknown"
        else "compatible"
    )
    all_active_versions = sorted(launcher_versions | server_versions | reference_versions)
    installed = all_active_versions[0] if len(all_active_versions) == 1 else " | ".join(all_active_versions) or None
    return {
        "modId": component_id,
        "componentKind": component["componentKind"],
        "status": status,
        "classification": classification,
        "state": {"compatible": "correto", "incompatible": "incompativel", "unknown": "nao verificado"}[status],
        "installedVersion": installed,
        "expectedVersion": installed if status == "compatible" else "faixas Maven declaradas + smoke test",
        "minecraft": "1.20.1",
        "loader": "avaliado por contexto e metadado; Forge nunca e reutilizado como baseline NeoForge",
        "action": "manter arquivo fixado; verificar atualizacoes separadamente" if status == "compatible" else "resolver findings e repetir smoke test" if status == "incompatible" else "obter evidencia suficiente antes de classificar",
        "contexts": context_evaluations,
        "findings": findings,
        "environmentChecks": [
            {
                "context": item["contexto"],
                "dependency": item["destino_declarado"],
                "environmentVersion": item["versoes_destino"][0] if len(item["versoes_destino"]) == 1 else None,
                "declaredRange": item["faixa_declarada"],
                "result": item["resultado_faixa"],
            }
            for item in component_connections if item["builtin"] and item["aplicavel"]
        ],
        "observedVersionsByContext": {key: value for key, value in versions_by_context.items()},
        "evidence": sorted(component["metadataPaths"]),
        "confidence": "alta" if status == "compatible" else "media" if component["metadataPaths"] else "baixa",
    }


def analyze_components(
    components: dict[str, dict[str, Any]], connections: list[dict[str, Any]]
) -> dict[str, Any]:
    required_dependents: dict[str, set[str]] = defaultdict(set)
    optional_dependents: dict[str, set[str]] = defaultdict(set)
    graph: dict[str, set[str]] = defaultdict(set)
    for connection in connections:
        if connection["builtin"] or not connection["aplicavel"]:
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
    missing_all = [
        connection for connection in connections
        if connection["aplicavel"] and connection["obrigatoria"] and not connection["presente"]
    ]
    missing = [
        connection for connection in missing_all
        if connection["contexto"] in active_contexts
    ]

    for component_id, component in sorted(components.items()):
        dependents = sorted(required_dependents.get(component_id, set()))
        optional = sorted(optional_dependents.get(component_id, set()))
        component["dependents"] = dependents
        component["optionalDependents"] = optional
        component_missing = [item for item in missing if item["origem"] == component_id]

        active_versions_by_context: dict[str, set[str]] = defaultdict(set)
        for artifact in component["artifacts"]:
            if not artifact.get("modVersion"):
                continue
            for context in artifact["contexts"]:
                if context in active_contexts:
                    active_versions_by_context[context].add(artifact["modVersion"])
        active_versions = sorted({version for values in active_versions_by_context.values() for version in values})
        verified_metadata = bool(component["metadataPaths"]) and not component["metadataErrors"]
        versions = sorted(component["versions"])
        compatibility.append(
            evaluate_component_compatibility(
                component_id,
                component,
                [item for item in connections if item["origem"] == component_id],
            )
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
            "tipo_componente": component["componentKind"],
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
                f"status contextual: {compatibility['status']} ({compatibility['classification']})",
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


def build_docs(
    root: Path,
    output: Path,
    analysis_date: str | None = None,
    artifact_fixture: Path | None = None,
) -> dict[str, Any]:
    fixture_path = artifact_fixture or root / "tools/modpack/fixtures/sanitized-artifact-inventory-v1.json"
    artifacts, extraction, fixture_date = load_artifacts(fixture_path)
    analysis_date = analysis_date or fixture_date
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
        item for item in analysis["compatibility"] if item["status"] == "incompatible"
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
            "artifactsFixture": "tools/modpack/fixtures/sanitized-artifact-inventory-v1.json",
            "runtimeForensics": "not accessed; fixture-only deterministic regeneration",
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
        "schemaVersion": 2,
        "baseline": inventory["environment"],
        "contexts": CONTEXTS,
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
        "notVerifiedItems": sum(item["status"] == "unknown" for item in analysis["compatibility"]),
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
- Fixture versionada: `tools/modpack/fixtures/sanitized-artifact-inventory-v1.json`.
- Corpus de regressão: `tools/modpack/fixtures/contextual-compatibility-regressions.json`.

## Limite de execução

Esta regeneração não abre JARs nem acessa `Launcher/workspace` ou `Servidor/workspace`. A fixture preserva somente evidência sanitizada de uma extração anterior revisada: hashes, nomes de arquivo, `mod_id`, metadados de loader, dependências declaradas, contexto e presença de recursos.

## Confiança

- **Alta:** hash, manifesto do provedor, `mod_id`, versão e dependência declarados em metadado interno.
- **Média:** lado inferido pela presença nos conjuntos cliente/servidor e categorização apoiada por metadados.
- **Baixa:** impacto de performance, função sem descrição interna, risco comportamental ou versão online mais recente.

## Limites deliberados

- Mundos, logs, relatórios de crash, identidades, endereços, segredos e valores de configuração não foram exportados.
- `compatibilidade por nome/hash` não certifica protocolo, registries, datapacks ou gameplay.
- `versão mais recente` não foi tratada como `versão correta`; a matriz usa faixas declaradas e mantém atualização como revisão manual.
- Faixas seguem a sintaxe Maven usada pelo Forge. Sintaxe ambígua, operadores de outro ecossistema e versões ausentes resultam em `unknown`, nunca em compatibilidade presumida.
- Dependências são avaliadas somente no contexto, lado e branch de loader que as declarou. Um baseline Forge não é usado para satisfazer uma dependência NeoForge.
- Mods internos em `META-INF/jarjar/` são componentes próprios e preservam o artefato contêiner como evidência.
- A classificação de lado por presença é uma inferência. Mods de handshake opcional podem aparecer somente em um conjunto.
- A análise de performance é triagem sem benchmark.

## Referências oficiais verificadas

- [Forge 1.20.1 — downloads]({verified_sources['forge']['source']}) — recomendado {verified_sources['forge']['recommended']}, mais recente {verified_sources['forge']['latest']} em {verified_sources['verifiedAt']}.
- [Metadados `mods.toml`]({verified_sources['forgeMetadataDocumentation']}).
- [Versionamento Forge e ranges Maven](https://docs.minecraftforge.net/en/1.20.1/gettingstarted/versioning/).
- [Requisitos de versão Maven](https://maven.apache.org/pom.html#dependency-version-requirement-specification).
- [Versionamento NeoForge](https://docs.neoforged.net/docs/gettingstarted/versioning/).
- [Formato de exportação CurseForge]({verified_sources['curseForgeExportDocumentation']}).

## Regeração

```powershell
$python = Get-Content graphify-out/.graphify_python
& $python tools/modpack/generate_modpack_docs.py --root .
& $python -m unittest discover -s tools/modpack/tests -p "test_*.py"
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
        "incompatibilities": sum(item["status"] == "incompatible" for item in analysis["compatibility"]),
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
            "usar `compatibilidade.json` como entrada sanitizada da Fase 7.1",
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
    parser.add_argument("--analysis-date")
    parser.add_argument("--artifact-fixture", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    output = args.output.resolve() if args.output else root / "docs/modpack"
    fixture = args.artifact_fixture.resolve() if args.artifact_fixture else None
    report = build_docs(root, output, args.analysis_date, fixture)
    print(stable_json(report).rstrip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
