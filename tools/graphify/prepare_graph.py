"""Consolidate Graphify semantic chunks with the deterministic AST extraction."""

from __future__ import annotations

import json
from pathlib import Path

from graphify.analyze import god_nodes, suggest_questions, surprising_connections
from graphify.build import build_from_json
from graphify.cache import save_semantic_cache
from graphify.cluster import cluster, score_all
from graphify.diagnostics import diagnose_extraction, format_diagnostic_report
from graphify.export import to_json
from graphify.report import generate


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "graphify-out"
SPEC = Path.home() / ".agents" / "skills" / "graphify" / "references" / "extraction-spec.md"


def read_json(path: Path, default: dict | None = None) -> dict:
    if not path.exists() and default is not None:
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def validate_chunk(path: Path, allowed_sources: set[str]) -> dict:
    chunk = read_json(path)
    for key in ("nodes", "edges", "hyperedges"):
        if not isinstance(chunk.get(key, []), list):
            raise ValueError(f"{path.name}: {key} must be a list")
    for node in chunk.get("nodes", []):
        if not node.get("id") or not node.get("label") or not node.get("source_file"):
            raise ValueError(f"{path.name}: node is missing id, label, or source_file")
        if str(Path(node["source_file"]).resolve()).casefold() not in allowed_sources:
            raise ValueError(f"{path.name}: node source is outside the dispatched corpus: {node['source_file']}")
    for edge in chunk.get("edges", []):
        if not edge.get("source") or not edge.get("target") or not edge.get("relation"):
            raise ValueError(f"{path.name}: edge is missing source, target, or relation")
    return chunk


def main() -> None:
    uncached_path = OUT / ".graphify_uncached.txt"
    uncached = [line for line in uncached_path.read_text(encoding="utf-8").splitlines() if line]
    allowed_sources = {str(Path(item).resolve()).casefold() for item in uncached}

    chunks = [validate_chunk(path, allowed_sources) for path in sorted(OUT.glob(".graphify_chunk_*.json"))]
    if not chunks:
        raise RuntimeError("No semantic chunks were found")

    semantic_new = {
        "nodes": [node for chunk in chunks for node in chunk.get("nodes", [])],
        "edges": [edge for chunk in chunks for edge in chunk.get("edges", [])],
        "hyperedges": [item for chunk in chunks for item in chunk.get("hyperedges", [])],
        "input_tokens": sum(int(chunk.get("input_tokens", 0)) for chunk in chunks),
        "output_tokens": sum(int(chunk.get("output_tokens", 0)) for chunk in chunks),
    }
    write_json(OUT / ".graphify_semantic_new.json", semantic_new)

    saved = save_semantic_cache(
        semantic_new["nodes"],
        semantic_new["edges"],
        semantic_new["hyperedges"],
        root=ROOT,
        allowed_source_files=uncached,
        prompt_file=SPEC,
    )

    cached = read_json(
        OUT / ".graphify_cached.json",
        {"nodes": [], "edges": [], "hyperedges": []},
    )
    all_nodes = cached.get("nodes", []) + semantic_new["nodes"]
    seen: set[str] = set()
    semantic_nodes = []
    for node in all_nodes:
        if node["id"] not in seen:
            semantic_nodes.append(node)
            seen.add(node["id"])
    semantic = {
        "nodes": semantic_nodes,
        "edges": cached.get("edges", []) + semantic_new["edges"],
        "hyperedges": cached.get("hyperedges", []) + semantic_new["hyperedges"],
        "input_tokens": semantic_new["input_tokens"],
        "output_tokens": semantic_new["output_tokens"],
    }
    write_json(OUT / ".graphify_semantic.json", semantic)

    ast = read_json(OUT / ".graphify_ast.json")
    merged_nodes = list(ast.get("nodes", []))
    seen = {node["id"] for node in merged_nodes}
    for node in semantic_nodes:
        if node["id"] not in seen:
            merged_nodes.append(node)
            seen.add(node["id"])
    extraction = {
        "nodes": merged_nodes,
        "edges": ast.get("edges", []) + semantic["edges"],
        "hyperedges": semantic["hyperedges"],
        "input_tokens": semantic["input_tokens"],
        "output_tokens": semantic["output_tokens"],
    }
    write_json(OUT / ".graphify_extract.json", extraction)

    detection = read_json(OUT / ".graphify_detect.json")
    graph = build_from_json(extraction, root=ROOT, directed=False)
    if graph.number_of_nodes() == 0:
        raise RuntimeError("Graph extraction produced no nodes")

    communities = cluster(graph)
    cohesion = score_all(graph, communities)
    gods = god_nodes(graph)
    surprises = surprising_connections(graph, communities)
    labels = {community_id: f"Community {community_id}" for community_id in communities}
    questions = suggest_questions(graph, communities, labels)
    tokens = {"input": extraction["input_tokens"], "output": extraction["output_tokens"]}

    wrote = to_json(graph, communities, str(OUT / "graph.json"))
    if not wrote:
        raise RuntimeError("Graphify refused to shrink an existing graph.json")
    report = generate(
        graph,
        communities,
        cohesion,
        labels,
        gods,
        surprises,
        detection,
        tokens,
        ".",
        suggested_questions=questions,
    )
    (OUT / "GRAPH_REPORT.md").write_text(report, encoding="utf-8")
    analysis = {
        "communities": {str(key): value for key, value in communities.items()},
        "cohesion": {str(key): value for key, value in cohesion.items()},
        "gods": gods,
        "surprises": surprises,
        "questions": questions,
    }
    write_json(OUT / ".graphify_analysis.json", analysis)

    health = diagnose_extraction(extraction, directed=False, root=ROOT)
    print(format_diagnostic_report(health))
    print(
        f"Semantic cache: {saved} files; graph: {graph.number_of_nodes()} nodes, "
        f"{graph.number_of_edges()} edges, {len(communities)} communities"
    )
    for community_id, node_ids in communities.items():
        node_labels = [graph.nodes[node_id].get("label", node_id) for node_id in node_ids[:12]]
        print(f"COMMUNITY {community_id}: " + " | ".join(node_labels))


if __name__ == "__main__":
    main()
