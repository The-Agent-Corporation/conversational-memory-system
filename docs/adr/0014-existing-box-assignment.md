# ADR 0014: Existing Box Assignment

## Status

Accepted

## Context

Compaction now creates summaries and can store embeddings, but summaries still default to `boxIds: []`. That weakens provenance in injection packets and forces sleep review to rediscover structure even when an approved box already exists.

The system should remain conservative: sleep review proposes new boxes, and human approval controls structural changes. Compaction should not auto-create new boxes yet.

## Decision

Add `BoxAssigner` and run it during pre-compaction.

The first assignment policy:

- only attaches summaries to existing boxes
- only considers boxes with state `approved`, `active`, or `revived`
- matches when every significant title token is present in the summary text
- updates the matched box aggregate with summary id, source ranges, appended summary text, and activity timestamps
- leaves `proposed` boxes untouched

## Consequences

- Newly compacted summaries carry useful box provenance when a box already exists.
- Injection packets can include box ids without changing their contract.
- Proposed box approval remains the gate before compaction starts attaching future summaries to that box.
- More advanced semantic or nested assignment can replace the deterministic matcher later.
