"""Persist Graphify corpus detection without shell-dependent quoting."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from graphify.detect import detect


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    args = parser.parse_args()

    root = args.root.resolve()
    output = root / "graphify-out" / ".graphify_detect.json"
    result = detect(root)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")

    print(f"Corpus: {result.get('total_files', 0)} files")
    for category, files in result.get("files", {}).items():
        if files:
            print(f"  {category}: {len(files)}")


if __name__ == "__main__":
    main()
