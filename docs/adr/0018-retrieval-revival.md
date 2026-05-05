# ADR 0018: Retrieval Revival

## Status

Accepted

## Context

Sleep review can mark inactive summaries as `stale`, and retrieval strengthens selected summaries. But a stale summary selected as relevant memory still stayed `stale`, leaving no durable signal that it had re-entered useful context.

## Decision

When `MemoryRetriever` selects a stale summary for an injection packet, update the summary state to `revived` while applying the normal retrieval metadata updates.

The update includes:

- `lastAccessedAt`
- `retrievedAt`
- incremented `retrievalCount`
- strengthened `strength`
- `state: "revived"` when the prior state was `stale`

Non-stale selected summaries keep their existing state.

## Consequences

- Stale memory can return to active relevance without manual state repair.
- Sleep review can distinguish never-reused stale memory from memory that became useful again.
- Future box assignment and surfacing policy can treat revived memory as assignable and higher priority.
