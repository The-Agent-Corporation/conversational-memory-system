# ADR 0021: Budget Stub Fallback

## Status

Accepted

## Context

Injection budget packing skips memories that exceed the host-provided memory budget. That protects active context, but it can also suppress a highly relevant summary when every full memory is too large.

## Decision

Allow a summary-only stub fallback when budget packing selects no full memories.

The first fallback policy:

- prefer full memories that fit the budget
- only use a stub when no full memory fits
- only stub summaries, not anchors
- require at least three memory tokens for a stub
- preserve the original summary id and source references
- count the stub against the full memory budget

## Consequences

- A useful oversized summary can still surface as a compact pointer.
- Exact anchors are not truncated.
- Retrieval strengthening still applies to the source summary when its stub is injected.
- Future detail-level compression can replace the deterministic word-truncation stub.
