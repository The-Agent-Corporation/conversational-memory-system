# ADR 0040: Person-Scoped Canonical Timeline

## Status

Accepted

## Context

The first implementation used a host session as the durable turn boundary because Roscoe-Hermes was the initial integration target. The product now needs to serve multiple agent hosts as one lifelong personal conversation while preserving native source and session provenance.

A flag-day replacement of `Turn`, turn ranges, summaries, resume, and the Hermes pipeline would put the proven accordion-memory behavior at unnecessary risk.

## Decision

Introduce an additive person-scoped canonical timeline alongside the existing turn representation.

Each ingested conversation event now creates:

- a person record,
- a source record scoped to that person and native profile,
- a canonical event with deterministic source-and-session-namespaced identity, native session and sequence, normalized timestamp, provenance, parser version, and content hash,
- the existing `Turn` used by current compaction, retrieval, and resume behavior.

Canonical events are listed across native sessions in timestamp, native-sequence, and deterministic-ID order. Store adapters reject attempts to reassign an existing source or canonical event identity to a different person.

SQLite adds new tables and indexes without altering existing tables. The in-memory and SQLite stores implement the same contracts.

## Consequences

- Multiple host sessions and applications can contribute to one personal timeline immediately.
- Existing Hermes behavior and historical data remain compatible while later phases migrate compaction and retrieval to canonical ranges.
- Re-ingesting a native event is idempotent at the canonical-event identity layer.
- Person isolation is enforced at storage identity boundaries and query boundaries.
- Consent manifests, import checkpoints, aliases, deletion provenance, sensitive-context policy, MCP, and encrypted synchronization remain later phases.
- Until downstream memory objects migrate to canonical ranges, the system writes both canonical events and compatibility turns.
