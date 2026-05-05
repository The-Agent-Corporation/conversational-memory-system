# ADR 0006: Deterministic Retrieval And Injection

## Status

Accepted

## Context

The system can now store raw turns, compact topic spans into summaries, and detect anchors. The next Phase 1 requirement is quiet memory injection: when the current topic resembles prior summaries or anchors, the memory service should prepare an auditable packet for the host agent.

Embeddings and vector ranking are still deferred, so the first retrieval path needs to be deterministic and transparent.

## Decision

Add a `MemoryRetriever` that ranks summaries and anchors by keyword overlap with the current topic summary. `MemoryService.prepareInjection` delegates to this retriever and stores every produced injection packet through `MemoryStore`.

The first retrieval implementation:

- searches summaries and anchors
- ranks by keyword overlap and confidence/anchor weighting
- emits at most three memory items
- preserves source summary ids, source turn ranges, box ids, relevance reason, confidence, and disclosure text
- returns `null` when no memory overlaps the current topic

## Consequences

- Hosts can receive quiet, auditable memory packets before embeddings exist.
- Retrieval behavior is explainable and stable in tests.
- Vector retrieval can later replace the ranking function without changing the injection packet contract.
