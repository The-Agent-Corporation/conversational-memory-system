# ADR 0019: Sleep Box State Refresh

## Status

Accepted

## Context

Summaries can now become `stale` during sleep review and `revived` during retrieval. Boxes aggregate summaries, but their state does not yet reflect linked summary state. That can leave a box looking approved or active when all of its contents are stale, or stale after one of its summaries becomes relevant again.

## Decision

Add `SleepReviewer.refreshBoxStates`.

The first refresh policy:

- considers boxes in `approved`, `active`, `revived`, or `stale` states
- marks a non-stale box `stale` when every linked summary is stale
- marks a stale box `revived` when any linked summary is revived
- updates `updatedAt` for every changed box
- updates `lastActivityAt` when a box revives
- ignores proposed and rejected boxes

## Consequences

- Box state now follows the summary state machine.
- Proposed/rejected box review boundaries remain intact.
- Retrieval revival can bubble up to the topic/container level during sleep review.
- More nuanced box scoring can be added later using summary strength, retrieval count, and outcome score.
