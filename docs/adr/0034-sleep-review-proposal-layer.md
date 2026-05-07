# ADR 0034: Sleep Review Proposal Layer

## Status

Accepted.

## Context

Sleep review can decay summaries, refresh boxes, and propose basic boxes. The accordion memory design needs a safer background organization layer for richer boxes, parent/child structure, and non-contiguous traces without automatically rewriting approved memory.

## Decision

Add `MemoryProposal` and `MemoryTrace` domain records.

Sleep review stores proposed boxes, parent/child relationships, and trace links as proposals. Approved boxes remain unchanged until a future explicit review command approves a proposal. Deterministic planners are the default and the test oracle. OpenRouter-backed planning can implement the same planner interfaces in a future phase.

## Consequences

- Sleep review can explain what it found without silently changing approved organization.
- Hermes receives compact proposal ids from `hermes:sleep`.
- Proposal review commands can be added without changing planner output.
- SQLite remains local-first with additive JSON payload tables.
