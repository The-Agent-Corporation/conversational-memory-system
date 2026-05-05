# ADR 0020: Injection Budget Packing

## Status

Accepted

## Context

Retrieval previously selected the top three memories regardless of size. The memory design treats the active memory budget as a ceiling, not a target, because injected memory should not crowd out the live conversation.

## Decision

Add optional `maxMemoryTokens` to `InjectionRequest`.

When no budget is provided, retrieval keeps the existing top-three behavior.

When a budget is provided:

- ranked memories are considered in rank order
- memories that would exceed the budget are skipped
- at most three memories are selected
- if no memory fits, no injection packet is produced
- disclosure text records the selected token usage

Summary memory uses stored `tokenCount`. Anchor memory uses a deterministic text estimate.

## Consequences

- Hosts can cap memory injection without changing retrieval ranking.
- Oversized memories no longer force themselves into context.
- Existing integrations keep the same default behavior until they provide a budget.
- Future detail-level compression can use this budget signal to produce smaller memories instead of skipping them.
