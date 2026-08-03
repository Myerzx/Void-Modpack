"""Finalize portable Graphify outputs, manifest, benchmark, and local state."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from graphify.analyze import suggest_questions
from graphify.benchmark import print_benchmark, run_benchmark
from graphify.build import build_from_json
from graphify.cli import _stamped_manifest_files
from graphify.detect import save_manifest
from graphify.diagnostics import diagnose_extraction, format_diagnostic_report
from graphify.export import to_json
from graphify.exporters.html import to_html
from graphify.report import generate


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "graphify-out"


def read_json(name: str) -> dict:
    return json.loads((OUT / name).read_text(encoding="utf-8"))


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def main() -> None:
    extraction = read_json(".graphify_extract.json")
    detection = read_json(".graphify_detect.json")
    analysis = read_json(".graphify_analysis.json")
    labels = {int(key): value for key, value in read_json(".graphify_labels.json").items()}
    communities = {int(key): value for key, value in analysis["communities"].items()}
    cohesion = {int(key): value for key, value in analysis["cohesion"].items()}
    missing_labels = sorted(set(communities) - set(labels))
    if missing_labels:
        raise ValueError(f"Missing labels for communities: {missing_labels}")

    graph = build_from_json(extraction, root=ROOT, directed=False)
    if graph.number_of_nodes() == 0:
        raise RuntimeError("Graph extraction produced no nodes")

    health = diagnose_extraction(extraction, directed=False, root=ROOT)
    print(format_diagnostic_report(health))

    questions = suggest_questions(graph, communities, labels)
    tokens = {
        "input": extraction.get("input_tokens", 0),
        "output": extraction.get("output_tokens", 0),
    }
    report = generate(
        graph,
        communities,
        cohesion,
        labels,
        analysis["gods"],
        analysis["surprises"],
        detection,
        tokens,
        ".",
        suggested_questions=questions,
    )
    (OUT / "GRAPH_REPORT.md").write_text(report, encoding="utf-8")
    if not to_json(
        graph,
        communities,
        str(OUT / "graph.json"),
        force=True,
        community_labels=labels,
    ):
        raise RuntimeError("Failed to update graph.json")
    to_html(graph, communities, str(OUT / "graph.html"), community_labels=labels)

    benchmark = run_benchmark(
        graph_path=str(OUT / "graph.json"),
        corpus_words=int(detection.get("total_words", 0)),
        questions=[
            "how does the canonical CurseForge pack support portable distribution",
            "what release audit blockers prevent publishing the launcher",
            "how are launcher and server responsibilities separated",
            "how does pack validation protect reviewed portable overrides",
            "how does the Graphify knowledge graph support agent responsibilities",
        ],
    )
    print_benchmark(benchmark)
    write_json(OUT / "BENCHMARK.json", benchmark)

    corpus = detection.get("all_files") or detection["files"]
    manifest_files = _stamped_manifest_files(corpus, extraction, ROOT)
    semantic_types = ("document", "paper", "image")
    dispatched = {
        file_name
        for type_name, files in detection["files"].items()
        if type_name in semantic_types
        for file_name in files
    }
    stamped = {file_name for files in manifest_files.values() for file_name in files}
    cleared = dispatched - stamped
    scan_corpus = {file_name for files in corpus.values() for file_name in files}
    save_manifest(
        manifest_files,
        root=ROOT,
        scan_corpus=scan_corpus,
        clear_semantic=cleared or None,
    )

    cost_path = OUT / "cost.json"
    cost = (
        json.loads(cost_path.read_text(encoding="utf-8"))
        if cost_path.exists()
        else {"runs": [], "total_input_tokens": 0, "total_output_tokens": 0}
    )
    input_tokens = int(extraction.get("input_tokens", 0))
    output_tokens = int(extraction.get("output_tokens", 0))
    cost["runs"].append(
        {
            "date": datetime.now(timezone.utc).isoformat(),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "files": int(detection.get("total_files", 0)),
        }
    )
    cost["total_input_tokens"] += input_tokens
    cost["total_output_tokens"] += output_tokens
    write_json(cost_path, cost)

    for name in (
        ".graphify_detect.json",
        ".graphify_extract.json",
        ".graphify_ast.json",
        ".graphify_semantic.json",
        ".graphify_semantic_new.json",
        ".graphify_cached.json",
        ".graphify_uncached.txt",
        ".graphify_analysis.json",
        ".needs_update",
    ):
        (OUT / name).unlink(missing_ok=True)
    for path in OUT.glob(".graphify_chunk_*.json"):
        path.unlink()

    print(
        f"Final graph: {graph.number_of_nodes()} nodes, {graph.number_of_edges()} edges, "
        f"{len(communities)} labeled communities; tokens recorded: {input_tokens}/{output_tokens}"
    )


if __name__ == "__main__":
    main()
