# ADR 0015: Proposed Box Review

## Status

Accepted

## Context

Sleep review creates boxes in the `proposed` state. Existing-box assignment intentionally ignores proposed boxes so structural changes remain approval-gated. Without a review path, proposed boxes cannot become assignable memory structure.

## Decision

Add `BoxReviewer` with explicit approve and reject operations.

Approval:

- requires the box to exist
- requires the box state to be `proposed`
- changes the box state to `approved`
- attaches listed summaries to the approved box by adding the box id to each summary's `boxIds`

Rejection:

- requires the box to exist
- requires the box state to be `proposed`
- changes the box state to `rejected`
- leaves summaries unchanged

## Consequences

- Sleep-review proposals can now graduate into assignable box structure.
- Summary provenance is updated when a proposal is approved.
- Rejected proposals remain auditable without polluting summary box ids.
- Future UI, CLI, or agent approval flows can call this service without changing storage contracts.
