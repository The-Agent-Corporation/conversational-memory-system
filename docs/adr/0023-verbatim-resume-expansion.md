# ADR 0023: Verbatim Resume Expansion

## Status

Accepted

## Context

Summaries, boxes, and injection packets preserve source turn ranges, but the system did not yet expose a way to expand a compacted memory back into verbatim conversation turns. The accordion model needs this: compact summaries should stay lightweight until the user or host asks to resume the original discussion.

## Decision

Add `ConversationResumer`.

The first resume service:

- expands a summary id into its source turns
- expands an injection packet into all referenced source turns
- deduplicates overlapping source ranges
- returns turns in thread/sequence order
- preserves source summary ids and turn ranges in the result

## Consequences

- Compacted memory can now expand back into verbatim conversation context.
- Retrieval packets can support a follow-up "show/resume this" path.
- No storage schema change is required because summaries and packets already carry source ranges.
- Future host adapters can expose this as a tool or context-expansion action.
