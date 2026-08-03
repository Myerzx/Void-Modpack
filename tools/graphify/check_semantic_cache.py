"""Persist Graphify semantic cache hits and the files still needing extraction."""

from __future__ import annotations

import json
from pathlib import Path

from graphify.cache import check_semantic_cache


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "graphify-out"
SPEC = Path.home() / ".agents" / "skills" / "graphify" / "references" / "extraction-spec.md"


def main() -> None:
    detection = json.loads((OUT / ".graphify_detect.json").read_text(encoding="utf-8"))
    files = [
        file_name
        for category in ("document", "paper", "image")
        for file_name in detection["files"].get(category, [])
    ]
    nodes, edges, hyperedges, uncached = check_semantic_cache(
        files,
        root=ROOT,
        prompt_file=SPEC,
    )
    cache_path = OUT / ".graphify_cached.json"
    if nodes or edges or hyperedges:
        cache_path.write_text(
            json.dumps(
                {"nodes": nodes, "edges": edges, "hyperedges": hyperedges},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    else:
        cache_path.unlink(missing_ok=True)
    (OUT / ".graphify_uncached.txt").write_text("\n".join(uncached), encoding="utf-8")
    print(f"Cache: {len(files) - len(uncached)} files hit, {len(uncached)} files need extraction")


if __name__ == "__main__":
    main()
