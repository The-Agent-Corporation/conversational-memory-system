# ADR 0012: Embedding-Backed Retrieval

## Status

Accepted

## Context

Retrieval initially used deterministic keyword overlap. That made the first injection path transparent and testable, but it cannot reliably surface semantically related memories when the current topic uses different words than the stored summary.

The memory design calls for embeddings on summaries as the primary retrieval unit. Raw turns remain available for expansion, but summaries are the right first vector target because they represent coherent topic chunks.

## Decision

Add an `Embedder` interface and make `MemoryRetriever` use vector similarity when:

- an embedder is configured for the retriever
- the current topic can be embedded
- a stored summary or anchor has embedding metadata that matches provider, model, and dimensions

If those conditions are not met, retrieval falls back to keyword overlap.

The first embedder is `DeterministicEmbedder`, a local keyword-hash implementation for tests and offline behavior. It is not a semantic embedding model; it exists to exercise the storage and retrieval contracts without making network calls.

## Consequences

- Retrieval can now rank by vector similarity without changing the injection packet contract.
- Embeddings from different providers or models are not mixed.
- Keyword retrieval remains available for older memories and offline operation.
- A provider-backed embedding implementation can be added later behind the same `Embedder` interface.
