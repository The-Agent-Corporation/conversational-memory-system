# ADR 0044: Source Revocation and Attributable Deletion

## Status

Accepted

## Context

Durable source approval is required before a background process can safely ingest native agent histories. Approval must also be withdrawable, and a user must be able to remove memory derived from one source without modifying the native history or unrelated personal memory.

## Decision

Persist person-owned source grants and append-only lifecycle audit events in the memory database.

- Approval binds a person, discovered candidate ID, application, format, canonical source locator, profile, and retrieval scope.
- Revocation is a separate operation that stops future authorized reads without deleting memory or touching the source.
- Source deletion requires the grant to be revoked and requires an exact candidate ID confirmation.
- Deletion physically removes canonical events, compatibility turns, anchors, source registrations, stale injections, and the bootstrap checkpoint attributable to that candidate.
- Summaries containing any deleted event are superseded. Boxes, proposals, and traces depending on an affected summary are also superseded so derived text cannot remain retrievable.
- Import checkpoints and the revoked grant remain as anti-reimport and audit state.
- Lifecycle audit events record approval, revocation, deletion request, deletion completion, actor, timestamp, and aggregate counts. They do not copy deleted message content.
- Native source paths are never modified, moved, or deleted.

## Consequences

- Revocation and deletion are explicit, inspectable, and isolated by person and candidate.
- Derived memory is fail-closed: mixed-source derived objects are superseded if deleted content may have influenced them.
- Re-approval is an explicit future user action; deletion does not silently resume import.
- The remaining lifecycle work is parser quarantine/replay and retrieval-scope enforcement.
