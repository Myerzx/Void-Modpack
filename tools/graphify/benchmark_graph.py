"""Run the project-specific Graphify token-reduction benchmark."""

from __future__ import annotations

import json
from pathlib import Path

from graphify.benchmark import print_benchmark, run_benchmark
from graphify.detect import detect


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "graphify-out"
QUESTIONS = [
    "how does the canonical CurseForge pack support portable distribution",
    "what release audit blockers prevent publishing the launcher",
    "how are launcher and server responsibilities separated",
    "how does pack validation protect reviewed portable overrides",
    "how does the Graphify knowledge graph support agent responsibilities",
]


def main() -> None:
    detection = detect(ROOT)
    result = run_benchmark(
        graph_path=str(OUT / "graph.json"),
        corpus_words=int(detection.get("total_words", 0)),
        questions=QUESTIONS,
    )
    if "error" in result:
        raise RuntimeError(result["error"])
    print_benchmark(result)
    (OUT / "BENCHMARK.json").write_text(
        json.dumps(result, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
