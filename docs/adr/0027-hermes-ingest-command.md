# ADR 0027: Hermes Ingest Command

## Status

Accepted

## Context

Roscoe-Hermes can now emit unified timeline rows through an optional command bridge. The memory system needs a stable command target that accepts that row shape and persists it into the standalone memory store.

## Decision

Add `hermes:ingest`.

The command:

- reads one `HermesTimelineRow` JSON object from stdin
- validates it with the shared Hermes row schema
- opens a configured SQLite memory database
- passes the row through `HermesMemoryAdapter.processTimelineRow`
- prints a small JSON result with the ingested turn id and any completed topic summary id

The database path can be passed with `--db <path>` or `HERMES_CONVERSATIONAL_MEMORY_DB`.

## Consequences

- Roscoe can configure `HERMES_CONVERSATIONAL_MEMORY_COMMAND` to call the standalone memory system without linking Python to TypeScript internals.
- Per-row command execution durably captures turns, but it does not preserve the adapter's in-process topic monitor across invocations.
- Live compaction from Roscoe will need either a long-running worker or persisted topic monitor state.
