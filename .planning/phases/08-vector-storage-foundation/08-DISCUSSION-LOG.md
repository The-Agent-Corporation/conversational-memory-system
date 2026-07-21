# Phase 8: Vector Storage Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-21
**Phase:** 8-Vector Storage Foundation
**Areas discussed:** Vector store mechanism, Multi-version vectors

---

## Vector store mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Pure-JS + dedicated `summary_vectors` BLOB table | Both stores compute cosine in JS via existing `cosineSimilarity`; exact parity trivial; no native binary; no change to DB open; O(n) scan over narrow table (fine at 135k). | ✓ |
| Native `sqlite-vec` extension | C-speed vec0 virtual table, but needs `DatabaseSync({allowExtension:true})` at construction, ships a native binary, and InMemoryStore must reproduce C float math exactly (determinism risk vs. the exact-parity criterion). Speed not needed at 135k. | |

**User's choice:** Pure-JS + BLOB table.
**Notes:** Driven by Phase 8 SC3 (exact top-K parity between SqliteStore and InMemoryStore). Identical JS math in both stores makes parity trivial and sidesteps C-vs-JS float ranking differences. sqlite-vec / true ANN remain deferred to a future perf milestone.

---

## Multi-version vectors

| Option | Description | Selected |
|--------|-------------|----------|
| Multiple vectors per summary, keyed by `(provider, model)` | A summary can hold several vector rows; searches target the active embedder; Phase 9 hash→ONNX switch is non-destructive; Phase 14 sees model-skew directly as rows under a stale model. | ✓ |
| One vector per summary | Simpler schema, half the rows, but switching embedders is a destructive rewrite and skew must be inferred from a single tag. | |

**User's choice:** Multiple, keyed by `(provider, model)`.
**Notes:** Chosen for clean interaction with downstream phases — non-destructive embedder switch (Phase 9) and direct model-skew visibility (Phase 14). PK `(summary_id, provider, model)`; `listSummaryIdsMissingVector(provider, model)` becomes the backfill idempotency key.

## Claude's Discretion

Locked without asking (dictated by success criteria / research constraints): cosine metric + `summary_id`-ascending tie-break (SC3); filter-before-scoring with denormalized `person_id`/`scope_ids` on the vector row (PITFALLS boundary-leak prevention); packed little-endian Float32 BLOB encoding; additive `create table if not exists` migration safe against the live DB; the exact method signatures, index column order, and BLOB helper placement.

## Deferred Ideas

- Native sqlite-vec / true ANN — future performance milestone (~500k–1M).
- Populating the legacy `Summary.embedding` field; anchor embeddings — out of v1.1 scope.
- Invoking tombstoning on source deletion — Phase 14 (REQ-050); capability built+tested here only.
