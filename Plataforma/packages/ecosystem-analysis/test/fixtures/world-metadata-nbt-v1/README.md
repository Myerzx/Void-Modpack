# Synthetic Minecraft world-metadata NBT corpus v1

This corpus is generated in memory by `corpus.ts`. It contains no copied
`level.dat`, player state, local path, account identifier, server address or
third-party pack content.

The canonical fixture models only the reviewed Minecraft 1.20.1 path
`Data.DataPacks.Enabled` / `Disabled`. Synthetic unrelated tags exercise all
standard NBT payload types. Separate malformed variants cover unknown tag
types, excessive depth and list length, duplicate pack IDs, wrong target
types, gzip/output budgets and unmapped active OpenLoader IDs.

Binary fixtures are intentionally not committed. Each test creates its gzip
bytes deterministically from these authored primitives and hashes the exact
compressed evidence it passes to the reader.
