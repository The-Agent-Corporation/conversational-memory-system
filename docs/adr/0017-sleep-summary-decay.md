# ADR 0017: Sleep Summary Decay

## Status

Accepted

## Context

Retrieval strengthening now increases selected summary strength, but memory strength needs to move both directions. Without decay, old untouched summaries remain artificially strong and sleep review cannot identify stale memory.

## Decision

Add `SleepReviewer.decaySummaries`.

The first decay policy:

- uses `lastAccessedAt`, then `retrievedAt`, then `createdAt` as the decay reference
- applies exponential half-life decay using each summary's `halfLifeHours`
- rounds strength to two decimals
- marks eligible summaries as `stale` when decayed strength falls below `staleStrengthThreshold`
- skips summaries when the review time is not after the decay reference

Eligible states are `compacted`, `active`, `revived`, and `stale`.

## Consequences

- Sleep review can now weaken inactive memory.
- Recently retrieved summaries decay from their last access time rather than their creation time.
- Stale detection becomes data-driven instead of a separate ad hoc flag.
- Outcome-aware decay tuning remains future work.
