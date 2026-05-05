# ADR 0013: Summary Embedding at Compaction

## Status

Accepted

## Context

Retrieval can now rank embedded summaries by vector similarity, but compaction still stores summaries with `embedding: null`. That leaves vector retrieval dependent on some external backfill step and makes the normal Hermes pipeline keyword-only by default.

## Decision

Allow `PreCompactor` to accept an optional `Embedder`.

When an embedder is configured:

- the compactor embeds the generated summary text before persistence
- the resulting embedding is stored on the summary row
- `HermesMemoryAdapter` passes the same embedder to compaction and retrieval

When no embedder is configured, summaries continue to store `embedding: null`.

## Consequences

- Newly compacted summaries can participate in vector retrieval immediately.
- Offline and test defaults remain unchanged.
- Provider/model/dimension compatibility checks still happen during retrieval.
- A later provider-backed embedder can be injected without changing compaction or adapter contracts.
