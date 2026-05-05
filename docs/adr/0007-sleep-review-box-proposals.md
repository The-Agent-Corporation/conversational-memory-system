# ADR 0007: Sleep Review Box Proposals

## Status

Accepted

## Context

The memory design calls for sleep review to propose structural changes such as child boxes, merges, and splits. Early versions should require confirmation for these structural changes. The system now has summary rows and box storage, so it can begin proposing topic boxes without automatic approval.

## Decision

Add a deterministic `SleepReviewer` that groups repeated summary patterns and writes proposed `Box` records through `MemoryStore`.

The first sleep review implementation:

- groups summaries by conservative title extraction
- requires at least two summaries before proposing a box
- skips proposals when a matching box title already exists
- writes proposed boxes with `state: "proposed"`
- preserves summary ids and source turn ranges

## Consequences

- The system can surface durable topic structure without silently reorganizing memory.
- Proposed boxes are stored in the same contract future approval workflows will use.
- More advanced split, merge, and child-box proposals remain deferred.
