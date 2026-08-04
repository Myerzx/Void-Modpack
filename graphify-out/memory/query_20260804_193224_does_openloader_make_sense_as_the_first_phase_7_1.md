---
type: "query"
date: "2026-08-04T19:32:24.362863+00:00"
question: "Does OpenLoader make sense as the first Phase 7.1 configuration schema?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["OPENLOADER_ADVANCED_OPTIONS_V1", "OPENLOADER_ADVANCED_OPTIONS_POLICY_V1", "parseOpenLoaderAdvancedOptions", "serializeOpenLoaderAdvancedOptions"]
---

# Q: Does OpenLoader make sense as the first Phase 7.1 configuration schema?

## Answer

Expanded from graph vocabulary: OpenLoader, advanced, options, schema, codec, restart, configuration. OpenLoader is suitable only as the narrow openloader_advanced_options_v1 schema: the trusted file path is fixed, the editable surface contains only dataPacks.enabled and resourcePacks.enabled, both require restart, additionalFolders stays empty, and the strict parser and canonical serializer reject user paths, extra or duplicate keys, and oversized documents. Packs remain outside configuration editing; persistence and operational application belong to Phase 7.2.

## Outcome

- Signal: useful

## Source Nodes

- OPENLOADER_ADVANCED_OPTIONS_V1
- OPENLOADER_ADVANCED_OPTIONS_POLICY_V1
- parseOpenLoaderAdvancedOptions
- serializeOpenLoaderAdvancedOptions