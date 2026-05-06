# ADR 0032: Retrieval Source Deduplication

## Status

Accepted.

## Context

The Hermes smoke harness showed that injection could include both anchor text and a summary covering the same underlying source turn. That made selected memory noisy:

- the same deadline appeared as an anchor
- the same deadline appeared again as another anchor
- the summary covering the source span appeared afterward

For host injection, this wastes memory budget and makes the recalled context look less trustworthy.

## Decision

Deduplicate ranked retrieval candidates before budget packing.

The first rule is conservative:

- keep summaries
- drop duplicate anchors with the same normalized text
- drop an anchor when its normalized text is already covered by a summary for the same thread/box context

When either side is unboxed, matching thread context is sufficient. This handles early-stage summaries before box assignment matures.

## Consequences

- Injection packets are quieter and spend budget on distinct memory.
- Summary provenance is preferred over duplicate anchor-only snippets when both describe the same source.
- Independent anchors still surface when their content is not already covered by a selected summary.
