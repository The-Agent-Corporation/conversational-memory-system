# ADR 0016: Retrieval Strengthening

## Status

Accepted

## Context

The memory schema tracks access and strengthening fields on summaries, but retrieval only produced audit packets. Selected summaries were not updated after recall, so sleep review and future decay logic could not distinguish repeatedly useful memories from old untouched memories.

## Decision

Update selected summaries whenever `MemoryRetriever` prepares an injection packet.

For each selected summary:

- set `lastAccessedAt` to the packet creation time
- set `retrievedAt` to the packet creation time
- increment `retrievalCount`
- increase `strength` by `0.05`, capped at `1`

Unselected summaries are left unchanged. Anchor strengthening remains deferred until anchor-specific usefulness signals exist.

## Consequences

- Retrieval has a durable feedback trail beyond the injection audit packet.
- Sleep review and decay logic can use summary strength and retrieval counts.
- Repeatedly recalled summaries become easier to preserve in future memory policy.
- The first strengthening rule is intentionally simple and can later be replaced with outcome-aware scoring.
