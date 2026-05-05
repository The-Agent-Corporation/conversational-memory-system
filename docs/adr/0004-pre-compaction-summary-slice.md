# ADR 0004: Pre-Compaction Summary Slice

## Status

Accepted

## Context

The topic monitor now emits completed topic spans when conversation movement is clear. The next conservative step is to persist a source-linked summary record for that completed span, while leaving LLM summarization, embeddings, box assignment, and retrieval ranking for later slices.

## Decision

Add a deterministic `PreCompactor` that consumes a completed topic span and writes a `Summary` through `MemoryStore`.

The first pre-compaction implementation:

- links summaries to exact source turn ranges
- uses stable summary ids based on host session and sequence range
- stores summaries with `state: "compacted"` and `detailLevel: "brief"`
- leaves embeddings null
- leaves box assignment empty
- uses deterministic summary text from the rolling topic summary and available source turn preview

## Consequences

- Topic changes can now produce durable summary rows without deleting or mutating raw turns.
- The implementation stays auditable and testable without an LLM.
- Later summarizer work can replace the deterministic text while preserving ids, source ranges, and store behavior.
