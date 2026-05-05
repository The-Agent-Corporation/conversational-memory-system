# ADR 0001: Initial Storage Backend

## Status

Proposed

## Context

The memory system must be standalone and adapter-driven. Roscoe-Hermes is the first integration target, but later adapters may include Pi, OpenClaw, Codex, Cursor, and other agents.

The system needs:

- append-only transcript storage
- source-linked summaries
- nested boxes
- anchors
- injection audit trail
- vector search over summaries, boxes, and anchors
- re-embedding support
- local development simplicity
- eventual cross-agent portability

## Options

### Option A: Postgres + pgvector

Pros:

- strong relational model
- good auditability
- mature vector indexing
- better for server deployment and future multi-user use
- easier concurrent access across adapters

Cons:

- requires database setup
- less local-first
- Supabase/PostgREST vector queries need RPC or direct SQL

### Option B: SQLite + sqlite-vec or external vector index

Pros:

- local-first
- matches Roscoe-Hermes per-profile SQLite state
- easy backup and inspection
- low infrastructure burden

Cons:

- vector search ecosystem is less mature
- concurrent multi-process writes need care
- server sync would be later work

### Option C: Hybrid SQLite Capture + Postgres Consolidation

Pros:

- fast local capture
- durable server-side consolidation
- good long-term path for cross-agent memory

Cons:

- sync complexity
- two storage layers from day one
- harder to debug initial implementation

## Decision

Start with Option B only if the first implementation is strictly local to Roscoe-Hermes. Start with Option A if the first implementation must support multiple hosts or remote access from the beginning.

For the first implementation plan, defer persistence behind `MemoryStore` and use `InMemoryStore` for tests. Choose A or B before implementing persistent storage.

## Consequences

- Core domain code must not import database-specific libraries.
- All persistence operations go through `MemoryStore`.
- Embedding metadata must include provider, model, dimension, and created time.
- Raw turns remain immutable regardless of backend.

## First Adapter Target: Roscoe-Hermes

Roscoe-Hermes already has a unified per-profile timeline with SQLite and FTS5. The first adapter should ingest from that timeline or from the same write path used by the gateway. The memory system should not replace Hermes memory on day one; it should run alongside it, producing injection packets and search/resume tools.

The first adapter must preserve:

- `profile_id`
- host session id
- monotonic sequence
- platform/channel metadata
- inbound and outbound role
- raw content
- created timestamp
