---
phase: 08-vector-storage-foundation
reviewed: 2026-07-21T21:15:00Z
depth: standard
files_reviewed: 5
files_reviewed_list:
  - src/embeddings/vector-codec.ts
  - src/storage/in-memory-store.ts
  - src/storage/sqlite-store.ts
  - tests/embeddings/vector-codec.test.ts
  - tests/storage/summary-vectors.test.ts
findings:
  critical: 0
  warning: 1
  info: 6
  total: 7
resolved:
  - CR-01
  - WR-01
  - WR-02
  - WR-03
  - WR-04
  - WR-05
status: issues_found
---

# Phase 08: Code Review Report (Re-review after gap-closure plan 08-05)

**Reviewed:** 2026-07-21T21:15:00Z
**Depth:** standard
**Files Reviewed:** 5
**Status:** issues_found

## Summary

Re-review of the 08-05 gap-closure diff (`1050d07..HEAD`, commits 8371b02 / b052c64 / 05fba31) against the prior findings. All six claimed fixes were verified in code and by running the suites (25/25 tests pass): CR-01 and WR-01 through WR-05 are **resolved** — write-time dimension and finite-value validation exists in both stores, the codec decodes via alignment-safe explicit-little-endian `DataView`, both stores now use logically equivalent `minimumScore` keep-predicates and identical code-unit tie-breaks, dimension-drifted rows are skipped identically, and `deleteSummaryVectors` is transactional using the store's established `begin immediate` pattern.

One new Warning: the finite-value guard validates the float64 input, but SqliteStore then quantizes to Float32 — finite values above Float32 max pack to `Infinity`, evading the guard and reintroducing the WR-02 class of backend score divergence. Three new/updated Info items: the query vector is never validated in `findNearestSummaries`, the new `minimumScore` parity test carries a garbled self-contradicting comment and skips the boundary-equal case, and the prior Info findings (IN-01, IN-03, IN-04, and the untested-upsert portion of IN-02) remain open — 08-05 did not claim them, so they are carried forward, not regressions.

## Resolved Findings

### CR-01 — RESOLVED (b052c64, tests 05fba31)
Both `SqliteStore.saveSummaryVector` (sqlite-store.ts:1255-1259) and `InMemoryStore.saveSummaryVector` (in-memory-store.ts:890-894) now throw when `record.dimensions !== record.vector.length`, and the parameterized test at summary-vectors.test.ts:230-233 covers both backends. Malformed rows can no longer enter either store, so the read/query poisoning path is closed for new writes. (Note: rows written to a persisted DB *before* this fix would still throw inside `unpackFloat32Vector` during `findNearestSummaries` when `row.dimensions` happens to equal the query dimension but the blob length disagrees — acceptable residual risk since the `summary_vectors` table shipped in this same phase and no pre-fix production writes exist.)

### WR-01 — RESOLVED (8371b02, test 05fba31)
`unpackFloat32Vector` (vector-codec.ts:25-30) now reads via `DataView.getFloat32(offset, true)` — explicit little-endian, matching `writeFloatLE`, and alignment-safe. The new test at vector-codec.test.ts:45-53 exercises a non-4-byte-aligned `byteOffset` and asserts exact round-trip.

### WR-02 — RESOLVED (b052c64, test 05fba31)
SqliteStore's reject-condition changed to `!(score >= query.minimumScore)` (sqlite-store.ts:1330), which is logically equivalent to InMemoryStore's keep-filter `score >= query.minimumScore` (in-memory-store.ts:952) including for NaN (both drop it). Additionally, non-finite vector values are rejected at write time in both stores (tested at summary-vectors.test.ts:235-238), and a `minimumScore` parity test was added (summary-vectors.test.ts:318-346). See WR-06 for a residual quantization gap in the finite guard and IN-06 for a defect in the new test's comment/coverage.

### WR-03 — RESOLVED (b052c64)
Both stores replaced `localeCompare` with a plain code-unit comparison tie-break (`left.summaryId < right.summaryId ? -1 : ...`) — sqlite-store.ts:1334-1338, in-memory-store.ts:946-950. Deterministic across locales/ICU versions and consistent with `listSummaryIdsMissingVector`'s code-unit/BINARY ordering.

### WR-04 — RESOLVED (b052c64, test 05fba31)
Both stores skip candidates where stored `dimensions !== query.vector.length` before scoring — sqlite-store.ts:1327 (before unpack, so mismatched rows also cannot trigger a codec throw), in-memory-store.ts:939. The cross-store parity test at summary-vectors.test.ts:348-376 confirms a dimension-drifted row is excluded identically in both backends.

### WR-05 — RESOLVED (b052c64)
`SqliteStore.deleteSummaryVectors` (sqlite-store.ts:1342-1353) now wraps the per-id deletes in `begin immediate` / `commit` with `rollback` on error, plus an empty-input early return. Pattern matches the store's other multi-row mutations (same `exec("begin immediate")` convention used throughout the file). All-or-nothing REQ-050 tombstoning is now guaranteed.

## Critical Issues

None open.

## Warnings

### WR-06: Finite-value guard runs before Float32 quantization — float64 values above Float32 max pack to `Infinity`, evading the guard and reintroducing the WR-02 backend-divergence class

**File:** `src/storage/sqlite-store.ts:1260-1262` (guard) and `src/storage/sqlite-store.ts:1280` (quantizing pack); contrast `src/storage/in-memory-store.ts:895-897`
**Issue:** New code from b052c64. `Number.isFinite(value)` is checked on the float64 input, but `packFloat32Vector` then calls `writeFloatLE`, which quantizes to Float32 without range-checking. A finite value with magnitude above Float32 max (~3.4028e38, e.g. `1e39`) passes the guard, is stored as `Infinity` in the BLOB, and decodes as `Infinity`. InMemoryStore keeps the original finite float64 verbatim. Result: the same record produces a finite cosine score in InMemoryStore but `Infinity`/`NaN` (e.g. `Infinity/Infinity`) in SqliteStore — the exact SC3/D-07 parity divergence WR-02 was meant to eliminate, now entering through the quantization step the guard does not model. A NaN score in SqliteStore also makes the sort comparator inconsistent (`right.score - left.score` is NaN, falsy, falling through to the id tie-break), so ordering of the poisoned partition is comparator-inconsistent rather than score-deterministic. Unlikely with real embedding values (typically in [-1, 1]), but Phase 10's backfill pushes provider output through this API unchecked, and this is precisely the class of hole the gap closure was scoped to close.
**Fix:** Validate against the *stored* representation in both stores so the invariant matches what SqliteStore persists:
```typescript
if (!record.vector.every((value) => Number.isFinite(Math.fround(value)))) {
  throw new Error(
    `saveSummaryVector: vector contains a value not finitely representable in float32 for summary ${record.summaryId}`
  );
}
```
(`Math.fround` maps Float32-overflowing values to `Infinity`, so this single check subsumes the current NaN/Infinity guard.)

## Info

### IN-01: Security-relevant magic string `"personal"` (empty-scope default) duplicated across both stores — STILL OPEN (not claimed by 08-05)

**File:** `src/storage/sqlite-store.ts:1325` and `src/storage/in-memory-store.ts:940`
**Issue:** The D-06 rule "empty `scopeIds` means scope `personal`" remains an inline literal in two files; silent parity drift risk if one copy changes.
**Fix:** Extract a shared `effectiveScopeIds(record)` helper in `memory-store.ts`.

### IN-02: Upsert-overwrite and `createdAt` round-trip still untested — PARTIALLY ADDRESSED

**File:** `tests/storage/summary-vectors.test.ts`
**Issue:** 05fba31 added `minimumScore` coverage (closing that slice of this finding), but the other two gaps remain: no test saves the same `(summaryId, provider, model)` twice and asserts the second write wins in both backends (the SQLite `on conflict ... do update` path at sqlite-store.ts:1268-1273 has zero coverage), and SC1 still never asserts `createdAt`.
**Fix:** Add a parameterized upsert-overwrite test and assert `createdAt` in the SC1 round-trip test.

### IN-03: `listSummaryIdsMissingVector` ordering can diverge between backends for non-ASCII ids — STILL OPEN (not claimed by 08-05)

**File:** `src/storage/in-memory-store.ts:929` vs `src/storage/sqlite-store.ts:1306`
**Issue:** UTF-16 code-unit sort vs SQLite BINARY (UTF-8 byte) collation; differs for ids mixing U+E000–U+FFFF with supplementary-plane characters. Harmless for current ASCII ids; matters if the Phase 10 backfill resume key ever sees non-ASCII ids.
**Fix:** Document the ASCII-id assumption or normalize both to code-unit comparison.

### IN-04: `getSummaryVector` performs no personId/scope boundary check — STILL OPEN (not claimed by 08-05)

**File:** `src/storage/sqlite-store.ts:1287-1296`, `src/storage/in-memory-store.ts:912-918`
**Issue:** Direct-by-id read returns any person's vector; asymmetry with `findNearestSummaries` (D-06) is undocumented on the interface.
**Fix:** Add a doc comment on `MemoryStore.getSummaryVector` stating boundary enforcement is the caller's responsibility.

### IN-05: `findNearestSummaries` never validates the query vector — NaN/non-finite query values produce silent garbage rankings

**File:** `src/storage/sqlite-store.ts:1312-1332` and `src/storage/in-memory-store.ts:932-953`
**Issue:** New validation from b052c64 covers only the write path. A query vector containing NaN (or Float32-overflowing values, per WR-06) sails through: every candidate scores NaN, the sort comparator degrades to pure id order, and with no `minimumScore` the method returns up to `topK` "matches" indistinguishable from real results — the same silent-garbage failure mode as the original WR-04, on the query side. (With `minimumScore` set, the unified predicate happens to drop NaN rows, masking the bug intermittently.)
**Fix:** At the top of `findNearestSummaries` in both stores:
```typescript
if (!query.vector.every((value) => Number.isFinite(Math.fround(value)))) {
  throw new Error("findNearestSummaries: query vector contains a non-finite value");
}
```

### IN-06: The new `minimumScore` parity test carries a garbled, self-contradicting comment, and the boundary-equal case it describes was never written

**File:** `tests/storage/summary-vectors.test.ts:326-330`
**Issue:** New in 05fba31. The comment first claims summary_beta "sits at the minimumScore boundary — both stores must keep it identically, and both must drop summary_gamma (also exactly 0.5)" — keeping and dropping two rows with the same score 0.5 is contradictory — then mid-sentence pivots: "... instead pick a threshold that excludes at least one row unambiguously: 0.9". This is an abandoned draft left in place. Substantively, the boundary-equal case (score exactly equal to `minimumScore`, e.g. `minimumScore: 0.5` keeping beta/gamma via `>=`) is precisely where the original WR-02 divergence lived, and it remains untested — the test only exercises a threshold strictly between the two score clusters, which the old broken predicate pair would also have passed for non-NaN scores.
**Fix:** Rewrite the comment to describe the actual assertion, and add a second query with `minimumScore: 0.5` asserting both stores keep summary_beta and summary_gamma (score exactly 0.5) identically.

---

_Reviewed: 2026-07-21T21:15:00Z (re-review after gap-closure plan 08-05; original review 2026-07-21T20:50:00Z)_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
_Fixing commits verified: 8371b02, b052c64, 05fba31_
