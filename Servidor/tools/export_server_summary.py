"""Build a sanitized JSON summary from the private server workspace.

The script intentionally exports counts and security booleans only. Secrets,
player identities, addresses, world coordinates, and local paths never leave
the ignored workspace.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
from pathlib import Path


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_properties(path: Path) -> dict[str, str]:
    properties: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        properties[key] = value
    return properties


def json_entry_count(path: Path) -> int:
    if not path.exists():
        return 0
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return -1
    return len(value) if isinstance(value, (list, dict)) else -1


def bool_cell(value: str) -> bool:
    return value.strip().lower() == "true"


def directory_size(path: Path) -> tuple[int, int]:
    files = 0
    size = 0
    for root, _, names in os.walk(path):
        for name in names:
            try:
                size += (Path(root) / name).stat().st_size
                files += 1
            except OSError:
                continue
    return files, size


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--server-root", type=Path, required=True)
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    repo_root = args.repo_root.resolve()
    server_root = args.server_root.resolve()
    catalog = server_root / "catalog"

    directory_rows = read_csv(repo_root / "docs" / "servidor" / "inventario" / "diretorios.csv")
    mod_rows = read_csv(catalog / "mods.csv")
    compatibility_rows = read_csv(catalog / "compatibilidade-cliente.csv")
    properties = read_properties(workspace / "server.properties")

    manifest_path = (
        workspace
        / "local"
        / "drive_exports"
        / "VOID_MMORPG_CLIENT_ESSENTIAL_20260414_113822"
        / "manifest.json"
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig")) if manifest_path.exists() else {}

    forge_root = workspace / "libraries" / "net" / "minecraftforge" / "forge"
    forge_versions = sorted(path.name for path in forge_root.iterdir() if path.is_dir()) if forge_root.exists() else []

    latest_boot_seconds: float | None = None
    latest_log = workspace / "logs" / "latest.log"
    if latest_log.exists():
        done_pattern = re.compile(r"Done \(([0-9.]+)s\)!")
        for line in latest_log.read_text(encoding="utf-8", errors="replace").splitlines():
            match = done_pattern.search(line)
            if match:
                latest_boot_seconds = float(match.group(1))

    openloader_packs: list[dict[str, int | str]] = []
    openloader_root = workspace / "config" / "openloader" / "data"
    if openloader_root.exists():
        for pack in sorted(path for path in openloader_root.iterdir() if path.is_dir()):
            files, size = directory_size(pack)
            openloader_packs.append({"name": pack.name, "files": files, "bytes": size})

    max_heap: str | None = None
    jvm_args_path = workspace / "user_jvm_args.txt"
    if jvm_args_path.exists():
        for line in jvm_args_path.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("-Xmx"):
                max_heap = line.strip()

    active_mods = [row for row in mod_rows if row["State"] == "active"]
    server_active = sum(bool_cell(row["Server"]) for row in compatibility_rows)
    embedded_active = sum(bool_cell(row["EmbeddedClient"]) for row in compatibility_rows)
    launcher_active = sum(bool_cell(row["CurrentLauncher"]) for row in compatibility_rows)
    embedded_common = sum(
        bool_cell(row["Server"]) and bool_cell(row["EmbeddedClient"])
        for row in compatibility_rows
    )
    launcher_common = sum(
        bool_cell(row["Server"]) and bool_cell(row["CurrentLauncher"])
        for row in compatibility_rows
    )

    crash_reports = workspace / "crash-reports"
    crash_report_count = sum(path.is_file() for path in crash_reports.iterdir()) if crash_reports.exists() else 0
    profile = manifest.get("minecraft", {})

    summary = {
        "auditDate": "2026-08-03",
        "profile": {
            "name": str(manifest.get("name", "The Casket of Reveries")).strip(),
            "version": manifest.get("version", "2.0.26"),
            "minecraft": profile.get("version", "1.20.1"),
            "forge": forge_versions[0] if forge_versions else None,
            "java": 17,
            "providerManifestFiles": len(manifest.get("files", [])),
        },
        "inventory": {
            "files": sum(int(row["Files"]) for row in directory_rows),
            "bytes": sum(int(row["Bytes"]) for row in directory_rows),
            "modsTotal": len(mod_rows),
            "modsActive": len(active_mods),
            "modsDisabled": sum(row["State"] == "disabled" for row in mod_rows),
            "modBackupsOrOther": sum(row["State"] == "backup-or-other" for row in mod_rows),
            "activeStubs": sum(row["Kind"] == "compatibility-stub" for row in active_mods),
            "activeLocalOrPatched": sum(row["Kind"] == "local-or-patched" for row in active_mods),
            "crashReports": crash_report_count,
        },
        "security": {
            "onlineMode": properties.get("online-mode") == "true",
            "whitelistEnabled": properties.get("white-list") == "true",
            "enforceWhitelist": properties.get("enforce-whitelist") == "true",
            "rconEnabled": properties.get("enable-rcon") == "true",
            "rconPasswordConfigured": bool(properties.get("rcon.password")),
            "serverIpConfigured": bool(properties.get("server-ip")),
            "levelSeedConfigured": bool(properties.get("level-seed")),
            "operators": json_entry_count(workspace / "ops.json"),
            "cachedUsers": json_entry_count(workspace / "usercache.json"),
        },
        "compatibility": {
            "serverActiveJars": server_active,
            "embeddedClientActiveJars": embedded_active,
            "embeddedClientExactCommon": embedded_common,
            "embeddedClientServerOnly": server_active - embedded_common,
            "embeddedClientOnly": embedded_active - embedded_common,
            "currentLauncherActiveJars": launcher_active,
            "currentLauncherExactCommon": launcher_common,
            "currentLauncherServerOnly": server_active - launcher_common,
            "currentLauncherOnly": launcher_active - launcher_common,
        },
        "runtimeEvidence": {
            "latestBootCompleted": latest_boot_seconds is not None,
            "latestBootSeconds": latest_boot_seconds,
            "maxHeap": max_heap,
        },
        "openLoaderPacks": openloader_packs,
        "accessFileCounts": {
            "whitelist": json_entry_count(workspace / "whitelist.json"),
            "bannedIps": json_entry_count(workspace / "banned-ips.json"),
            "bannedPlayers": json_entry_count(workspace / "banned-players.json"),
        },
    }

    output = catalog / "resumo-servidor.json"
    output.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Sanitized server summary written to {output.name}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
