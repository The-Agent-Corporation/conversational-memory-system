# ADR 0028: Stateless Hermes Control Compaction

## Status

Accepted

## Context

Roscoe-Hermes invokes the external memory bridge command once per unified timeline row. That means the normal in-process `TopicMonitor` state is not available when a later `/new`, `/clear`, `/reset`, or `/compress` row arrives. Without special handling, the command would ingest raw turns but miss the compaction boundary.

## Decision

Teach `hermes:ingest` to reconstruct topic state for control-signal rows.

When a bridged row maps to a control signal, the command:

- loads stored turns for the row's Hermes session id
- replays those turns through `TopicMonitor`
- observes the control signal as the closing event
- compacts the completed span with `PreCompactor`

Non-control rows still use `HermesMemoryAdapter.processTimelineRow` directly.

## Consequences

- Roscoe's per-row bridge can compact on `/new`, `/clear`, `/reset`, and `/compress` without a long-running memory worker.
- The behavior remains deterministic and storage-backed.
- This reconstructs topic state from stored turns, so future richer topic state may still benefit from a persistent worker.
