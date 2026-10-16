# ADR 0058: Single-Event Deletion and Append-Only Source Tombstones

## Status

Accepted.

## Context

Cordis forgets a journal row, but the journal is append-only. A later scan would import the same native id again unless the canonical event stays deleted.

## Decision

Schema version 7 adds `canonical_event_tombstones` and `event_deletion_audit`. `commitEventDeletion` on both stores, in one transaction:

- tombstones the canonical event
- deletes the event, its turns, and its anchors
- supersedes summaries that cite it and deletes their vectors and citing injection packets
- marks the contraction job dirty
- writes an audit row that is not a source-lifecycle action

`MemoryService.ingestEvent` returns without saving when the canonical id is tombstoned. MCP exposes `event_delete_preview` and `event_delete_execute`. The CLI command is `memory event:delete`. Recall cannot return the deleted text after commit. This is not a sync operation kind.

## Consequences

A rescan of an append-only journal skips the forgotten event. The contraction job re-derives the span without it.
