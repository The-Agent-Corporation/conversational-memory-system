# ADR 0042: Resumable Historical Bootstrap

## Status

Accepted

## Context

Approved native histories arrive as person-scoped canonical events from many applications and sessions. The memory layer must immediately contract that history into topics, summaries, anchors, boxes, and traces without treating native session boundaries as conversational boundaries. It must also resume cheaply as importers append events and recover deterministically when an importer replay changes the historical prefix.

Dense synthetic turn sequence numbers are useful to reuse the existing topic and summarization pipeline, but they are not stable provenance: inserting an earlier event can shift every later sequence.

## Decision

Process canonical events in their deterministic person-level order through one synthetic compatibility thread named `person:<personId>`.

The bootstrap processor:

- creates compatibility turns that retain person, canonical event, source, application, native session, and native event identity in metadata,
- stores canonical event IDs directly on historical summaries and anchors,
- checkpoints the processed event count, last event ID, rolling prefix hash, and active topic after each event,
- restores the active topic when later events are appended,
- snapshots the active topic as a compacted summary without closing it,
- derives stable summary identity from the person, first canonical event, and normalized topic label,
- replays from the beginning when the parser version or previously processed prefix changes,
- supersedes historical summaries that are not reproduced by a reset,
- scopes box and trace planning to the same person,
- leaves all generated box and trace changes in proposed state for human review.

The processor is local and deterministic by default. Model-backed summarization remains optional through the existing summarizer adapter.

## Consequences

- Separate Codex, Claude Code, OpenClaw, Hermes, and future sessions can behave as one continuous conversation while their native boundaries remain auditable.
- Appends process only new canonical events and extend the current topic in place.
- Earlier-event insertion or importer replay is detected instead of silently corrupting dense sequence ranges.
- Canonical event IDs remain the durable provenance layer when compatibility sequences shift.
- Derived objects are isolated by person, but finer workspace/client retrieval policy remains follow-on work.
- Source deletion propagation still requires a dedicated dependency and tombstone workflow.
