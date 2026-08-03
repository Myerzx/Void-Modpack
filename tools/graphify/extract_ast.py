"""Run Graphify's deterministic AST extraction from the saved detection file."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from graphify.extract import collect_files, extract


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    args = parser.parse_args()

    root = args.root.resolve()
    detect_path = root / "graphify-out" / ".graphify_detect.json"
    output_path = root / "graphify-out" / ".graphify_ast.json"
    detection = json.loads(detect_path.read_text(encoding="utf-8"))

    code_files: list[Path] = []
    for item in detection.get("files", {}).get("code", []):
        path = Path(item)
        code_files.extend(collect_files(path) if path.is_dir() else [path])

    result = (
        extract(code_files, cache_root=root)
        if code_files
        else {"nodes": [], "edges": [], "input_tokens": 0, "output_tokens": 0}
    )
    output_path.write_text(
        json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"AST: {len(result['nodes'])} nodes, {len(result['edges'])} edges")


if __name__ == "__main__":
    main()
