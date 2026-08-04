---
type: "query"
date: "2026-08-04T17:56:16.975653+00:00"
question: "How does Phase 7.0 contextual compatibility work?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["PHASE_7_CONTEXTUAL_COMPATIBILITY.md", "analyzeContextualCompatibility", "evaluateMavenVersionRange", "build_docs"]
---

# Q: How does Phase 7.0 contextual compatibility work?

## Answer

The v1 plan separates launcher, server, reference, and historical contexts; occurrences retain side, metadata loader, and root/JarJar containment; dependencies are evaluated only in their applicable context and loader branch; Maven ranges yield match, mismatch, or unknown; reports distinguish canonical conflicts from reference and historical divergence.

## Outcome

- Signal: useful

## Source Nodes

- PHASE_7_CONTEXTUAL_COMPATIBILITY.md
- analyzeContextualCompatibility
- evaluateMavenVersionRange
- build_docs