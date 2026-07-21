---
phase: 8
slug: vector-storage-foundation
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-07-21
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts (existing) |
| **Quick run command** | `npx vitest run tests/storage` |
| **Full suite command** | `npm test` (vitest run) + `npm run typecheck` |
| **Estimated runtime** | ~15s full suite |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/storage`
- **After every plan wave:** Run `npm test` + `npm run typecheck`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 08-01 Task 1: Float32 BLOB codec | 08-01 | 1 | REQ-041 | T-08-02 | `unpackFloat32Vector` throws when `byteLength !== dimensions*4` before constructing the Float32Array view (D-03, Pitfall 3) | unit | `npx vitest run tests/embeddings/vector-codec.test.ts` | ✅ | ✅ green |
| 08-01 Task 2: Extend MemoryStore interface with the vector surface (D-09) | 08-01 | 1 | REQ-041 | — | Contract declares personId + allowedScopeIds required on `findNearestSummaries` (D-06) | typecheck | `npm run typecheck` | ✅ | ✅ green |
| 08-01 Task 3: Author the backend-parameterized parity suite (Wave 0 RED gate) | 08-01 | 1 | REQ-041 | T-08-01 | Scope-isolation fixture authored (RED, pre-implementation) proving filter-before-score contract once implemented | unit | `npx vitest run tests/storage/summary-vectors.test.ts` | ✅ | ✅ green |
| 08-02 Task 1: Add summary_vectors as schema-migrations version 2 (D-01/D-04/D-08) | 08-02 | 2 | REQ-041 | T-08-03 | Additive `create table if not exists` + one index only, inside `runSchemaMigrations`' single transaction; no rewrite of `summaries` (SC5) | unit | `npx vitest run tests/storage/schema-migrations-concurrency.test.ts tests/storage/sqlite-store.test.ts` | ✅ | ✅ green |
| 08-02 Task 2: Implement the five vector methods in SqliteStore (D-02/D-03/D-05/D-06/D-07/D-09) | 08-02 | 2 | REQ-041 | T-08-01, T-08-02 | `person_id = ?` in WHERE + scope `.every` filter run before cosine scoring; topK applied to filtered set only | unit | `npx vitest run tests/storage/summary-vectors.test.ts` | ✅ | ✅ green |
| 08-03 Task 1: Implement the five vector methods in InMemoryStore (D-02/D-05/D-06/D-07/D-09) | 08-03 | 2 | REQ-041 | T-08-01, T-08-04 | person/scope `.filter()` runs before `cosineSimilarity`; reuses identical comparator/tie-break as SqliteStore | unit | `npx vitest run tests/storage/summary-vectors.test.ts` | ✅ | ✅ green |
| 08-04 Task 1: Author the SC3 cross-store exact-parity test | 08-04 | 3 | REQ-041 | T-08-04 | `toEqual` (not `toBeCloseTo`) proves byte-identical `(summaryId, score)` sequences including an engineered exact-score tie resolved by summary_id-ascending order (D-07) | unit | `npx vitest run tests/storage/summary-vectors.test.ts` | ✅ | ✅ green |
| 08-04 Task 2: Full-suite regression gate + finalize validation record (SC5) | 08-04 | 3 | REQ-041 | T-08-01 | Full-suite gate re-runs the cross-scope fixture on both backends; storage/daemon/sync suites and daemon startup unaffected by the additive migration | unit+typecheck | `npm run typecheck && npm test` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**Full-suite run (2026-07-21):** `npm run typecheck` exit 0 (no errors); `npm test` — 91 test files, 735 tests, all green, ~12.3s runtime. No regression in `tests/storage/sqlite-store.test.ts`, `tests/daemon/*`, or `tests/sync/*`.

---

## Validation Architecture (from RESEARCH.md)

Success criteria → how each is proven (see `08-RESEARCH.md` §"Validation Architecture" for detail):

- **SC1 — save/get by summary ID, tagged (provider,model,dims):** unit round-trip test per store; assert `getSummaryVector` returns byte-identical vector + tags after `saveSummaryVector`.
- **SC2 — `listSummaryIdsMissingVector(provider,model)` exact + stable order:** fixture with mixed present/absent vectors across two (provider,model) pairs; assert exact set + deterministic ordering.
- **SC3 — EXACT cross-store nearest-neighbor parity:** the load-bearing test. Feed identical query vector + identical corpus to `SqliteStore` and `InMemoryStore`; assert identical `(summary_id, score)` sequence (ranking, scores, tie-break). Both stores reuse `cosineSimilarity` (`src/embeddings/embedder.ts:48`) and the `rankMemories` comparator `right.score - left.score || left.id.localeCompare(right.id)` (`src/retrieval/memory-retriever.ts:354`). Run via the existing `backends`-array parity harness idiom (`tests/storage/sync-store.test.ts`, `tests/daemon/daemon-store.test.ts`).
- **SC4 — scope-partitioned lookups + tombstone capability:** cross-scope fixture asserting `findNearestSummaries` never returns out-of-scope vectors (filter-before-score, D-06); tombstone/delete test asserting a removed vector is unreachable — capability exercised even though nothing wires deletion until Phase 14.
- **SC5 — additive, safe migration:** idempotent-migration test (run twice, no error, no data change); assert `summaries`/existing tables untouched and store open/startup unaffected. Follows `src/storage/schema-migrations.ts` versioned mechanism, not the frozen base DDL.

---

## Wave 0 Requirements

- [x] `tests/storage/summary-vectors.test.ts` — parity + round-trip + missing-list + scope + tombstone tests for REQ-041 (extends the existing `backends`-array harness idiom); cross-store exact-parity suite added in 08-04 replaces the original `it.todo` placeholder

*Existing vitest infrastructure otherwise covers all phase requirements — no framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| _(none)_ | REQ-041 | — | All Phase 8 behaviors have automated verification. |

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved — full suite (`npm run typecheck && npm test`) green: 91 test files, 735 tests passing, 2026-07-21. SC1-SC5 all proven per the Per-Task Verification Map above.
