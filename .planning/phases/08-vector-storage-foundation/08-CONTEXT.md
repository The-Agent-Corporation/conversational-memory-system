# Phase 8: Vector Storage Foundation - Context

**Gathered:** 2026-07-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Add a scope-aware, deletion-tombstonable store for per-summary vector embeddings, with exact nearest-neighbor result parity between `SqliteStore` and `InMemoryStore`. This phase builds the storage substrate and query surface only (REQ-041) — it does **not** compute embeddings (Phase 9), backfill (Phase 10), run in the daemon (Phase 11), discover traces (Phase 12), power recall (Phase 13), or wire deletion (Phase 14). The tombstoning capability is built and tested here but not yet invoked.

</domain>

<decisions>
## Implementation Decisions

### Vector store mechanism
- **D-01:** Store vectors in a **dedicated `summary_vectors` table**, not in the existing nullable `Summary.embedding` payload field. Rationale: neighbor search scans a narrow table instead of deserializing 135k full-summary JSON payloads; enables clean multi-version rows and per-vector tombstoning.
- **D-02:** **Pure-JS cosine** search — both `SqliteStore` and `InMemoryStore` compute similarity in JavaScript using the existing `cosineSimilarity` util. No native extension. This makes the exact-parity success criterion (SC3) trivial: identical math in both stores. `sqlite-vec` was explicitly rejected for this phase — it needs `DatabaseSync({allowExtension:true})` at construction (changes how the DB is opened everywhere), ships a native binary, and its C float32 distances could rank ties differently from a JS InMemoryStore, jeopardizing exact parity. True ANN / sqlite-vec remain deferred (see REQUIREMENTS.md v1.1 Out of Scope) until measured latency pain at ~500k–1M.
- **D-03:** Vector payload encoded as a **packed Float32 BLOB** (little-endian), with `dimensions` stored per row and validated against the decoded length on read.

### Multi-version vectors
- **D-04:** A summary may hold **multiple vector rows, one per `(provider, model)`** — primary key `(summary_id, provider, model)`. Lets Phase 9 add ONNX vectors alongside hash vectors non-destructively, and lets Phase 14 see model-skew directly (rows under a stale provider/model). Searches target a specified/active `(provider, model)`.
- **D-05:** `listSummaryIdsMissingVector(provider, model)` returns, in stable order, summary IDs that lack a vector **for that specific `(provider, model)`** — this is the idempotency/resume key for Phase 10 backfill.

### Scope enforcement (locked by success criteria)
- **D-06:** **Filter before scoring.** `findNearestSummaries` denormalizes `person_id` and `scope_ids` onto each vector row and restricts candidates by the caller's authorized person/scope **before** computing cosine — never score-then-filter (per PITFALLS.md; a flat global index that filters post-query leaks across boundaries). The denormalized scope columns are written from the summary's `personId`/`scopeIds` at `saveSummaryVector` time.

### Determinism & tie-breaking (locked by success criteria)
- **D-07:** Similarity metric is **cosine**; top-K results are ordered by score descending, ties broken by **`summary_id` ascending**, so `SqliteStore` and `InMemoryStore` return byte-identical rankings, scores, and tie-order for identical input (SC3). No RNG, no insertion-order sensitivity.

### Migration (locked by success criteria)
- **D-08:** Schema change is **additive** — `create table if not exists summary_vectors` plus supporting indexes, following the existing inline-DDL / `schema-migrations` pattern. It must not touch or rewrite the `summaries` table or any existing payloads, must be safe against the live ~3.5GB DB, and must leave daemon startup and all existing tests unaffected (SC5). The existing nullable `Summary.embedding` field is left as-is for backward-compatible scoring; it is **not** populated in this phase (avoids rewriting 135k payloads).

### New MemoryStore surface
- **D-09:** Add four methods to the `MemoryStore` interface, implemented in **both** `SqliteStore` and `InMemoryStore`: `saveSummaryVector`, `getSummaryVector`, `listSummaryIdsMissingVector`, and `findNearestSummaries`. Plus a tombstone/delete-by-summary capability (built + tested, unused until Phase 14). Contract/parity tests must assert identical behavior across both stores.

### Claude's Discretion
- Exact method signatures, index column order, BLOB pack/unpack helper placement, and whether the tombstone capability is a distinct `deleteSummaryVectors(summaryId)` method or a flag — planner's call, as long as D-01…D-09 hold and the parity tests pass.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & requirements
- `.planning/ROADMAP.md` §"Phase 8: Vector Storage Foundation" — goal + 5 success criteria (esp. SC3 exact parity, SC4 scope/tombstone, SC5 safe additive migration).
- `.planning/REQUIREMENTS.md` — REQ-041 (summary embeddings) is the sole in-phase requirement; REQ-050 storage half (tombstone capability) is built here, fulfilled in Phase 14. See also v1.1 "Out of Scope" (true ANN / sqlite-vec deferred).

### Research (this milestone)
- `.planning/research/ARCHITECTURE.md` — dedicated `summary_vectors` table design, the four MemoryStore methods, InMemoryStore exact-parity approach, sync recompute-per-device rationale.
- `.planning/research/STACK.md` — sqlite-vec vs. pure-JS analysis, `node:sqlite`/`DatabaseSync({allowExtension:true})` constraint (why sqlite-vec was deferred).
- `.planning/research/PITFALLS.md` — "filter at selection not post-query" boundary leak; determinism traps; InMemoryStore/SqliteStore divergence risk.
- `.planning/research/SUMMARY.md` — synthesized build order and open-decision framing.

### Cross-cutting decisions
- `docs/adr/0047-zero-knowledge-sync-threat-model-and-protocol.md` — embeddings are a per-device recomputed cache, never synced; `SyncOperationKind` has no summary/embedding kind. Informs why vectors are local-only (relevant to Phase 11 but constrains storage assumptions here).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `cosineSimilarity` util (in the retrieval/embeddings module alongside `MemoryRetriever` and `Embedder`) — the exact scoring function both stores must use for `findNearestSummaries`.
- `EmbeddingSchema` (`src/domain/types.ts:81`) — `{provider, model, dimensions, vector[], createdAt}`, already validates `vector.length === dimensions`. Reuse for row validation.
- `Summary` (`src/domain/types.ts:104`) — carries `personId?` and `scopeIds?: string[]` (the boundary keys to denormalize) and the nullable `embedding` field (left unpopulated).

### Established Patterns
- Storage is the generic `(id text primary key, payload text not null)` table idiom (`summaries`, `boxes`, `anchors` at `src/storage/sqlite-store.ts:1868`) with `upsertPayload`/`listPayloads` helpers. The new `summary_vectors` table breaks that mold intentionally (typed columns for scan-narrow search + scope filtering) — follow the inline `create table if not exists` DDL block + `schema-migrations` convention.
- Every `MemoryStore` method is implemented in both `SqliteStore` and `InMemoryStore`; recent additions like `getSyncOutboxOperation` show the interface-plus-both-stores pattern to mirror.
- Existing checkpoint tables (`import_checkpoints`, `bootstrap_checkpoints`) model the resumability pattern Phase 10 will reuse — no work here, but the `listSummaryIdsMissingVector` set-difference key (D-05) is designed to feed it.

### Integration Points
- `src/storage/memory-store.ts` (interface), `src/storage/sqlite-store.ts` + `src/storage/in-memory-store.ts` (implementations) — the entire surface area of this phase.
- Contract/parity test harness for stores — extend it with vector round-trip, missing-vector listing, scope-filtered nearest-neighbor, exact cross-store parity, and tombstone tests.

</code_context>

<specifics>
## Specific Ideas

- SC3 is the design driver: "identical top-K from both stores — not closely enough, an exact match." Both stores share one JS cosine path; parity is verified by a test feeding identical input vectors to each store and asserting identical `(summary_id, score)` sequences.
- Scope columns are denormalized onto the vector row so boundary filtering happens in the candidate scan, never after ranking.

</specifics>

<deferred>
## Deferred Ideas

- **Native `sqlite-vec` / true ANN (HNSW/usearch):** deferred to a future performance milestone (~500k–1M summaries with measured latency pain) — would be the codebase's only determinism regression.
- **Populating the legacy `Summary.embedding` field / anchor embeddings:** out of scope; the dedicated table is the search source of truth. Anchor vectors are a near-term follow-up, not v1.1.
- **Actually invoking tombstoning on source deletion:** Phase 14 (REQ-050) — this phase only builds and tests the capability.

None of the above are in Phase 8 scope; captured so they aren't lost.

</deferred>

---

*Phase: 8-Vector Storage Foundation*
*Context gathered: 2026-07-21*
