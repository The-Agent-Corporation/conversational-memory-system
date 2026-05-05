# ADR 0002: Initial Persistent Store

## Status

Accepted

## Context

ADR 0001 kept storage open between Postgres, SQLite, and a hybrid capture/consolidation model. The first adapter target is Roscoe-Hermes, which already uses local per-profile SQLite state and FTS5. The next implementation slice needs durable storage behind `MemoryStore` without committing the memory system to Hermes internals or a remote server.

## Decision

Use SQLite as the first persistent backend behind the existing `MemoryStore` interface.

The first SQLite implementation stores validated domain objects as JSON payloads with the minimum relational columns needed for stable listing:

- turns: `id`, `thread_id`, `sequence`, `payload`
- injections: `id`, `host_session_id`, `payload`
- summaries, boxes, anchors: `id`, `payload`

Vector search, FTS, normalized relationship tables, and sync are deferred until retrieval and topic-monitor behavior are implemented.

## Consequences

- The core service remains storage-neutral.
- Roscoe-Hermes can use a local-first backend without replacing its existing memory on day one.
- The store can preserve exact domain payloads while the data model is still maturing.
- Future migrations will need to split high-query fields out of JSON payloads once retrieval, decay, and sleep-review queries become concrete.
