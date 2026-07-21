---
phase: 08-vector-storage-foundation
reviewed: 2026-07-21T20:50:00Z
depth: standard
files_reviewed: 7
files_reviewed_list:
  - src/embeddings/vector-codec.ts
  - src/storage/in-memory-store.ts
  - src/storage/memory-store.ts
  - src/storage/schema-migrations.ts
  - src/storage/sqlite-store.ts
  - tests/embeddings/vector-codec.test.ts
  - tests/storage/summary-vectors.test.ts
findings:
  critical: 1
  warning: 5
  info: 4
  total: 10
status: issues_found
---

# Phase 08: Code Review Report

**Reviewed:** 2026-07-21T20:50:00Z
**Depth:** standard
**Files Reviewed:** 7
**Status:** issues_found

## Summary

Reviewed the Phase 08 vector-surface additions: the Float32 BLOB codec, the 5-method `MemoryStore` vector interface, the schema-migrations v2 `summary_vectors` table, the SqliteStore and InMemoryStore implementations, and the parity test suites. Verified the test suites pass (18/18) and that migration v2 is wired into `SqliteStore.migrate()` via `runSchemaMigrations`.

The design is sound (filter-before-score boundary enforcement, transactional migrations, upsert keying on `(summary_id, provider, model)`), but the write path has no invariant validation, and I found several exact-parity holes between the two backends that the SC3 gate does not exercise — including one NaN-handling divergence where the two stores use logically non-equivalent predicates. The codec's decode path is also asymmetric with its encode path (explicit little-endian write, platform-endian aligned read).

## Critical Issues

### CR-01: `saveSummaryVector` persists rows where `dimensions !== vector.length`, poisoning every subsequent read/query of that partition in SqliteStore

**File:** `src/storage/sqlite-store.ts:1254-1277` (also `src/storage/in-memory-store.ts:889-902`, `src/embeddings/vector-codec.ts:9-15`)
**Issue:** Neither store validates that `record.dimensions === record.vector.length` on write. In SqliteStore, `packFloat32Vector(record.vector)` stores a blob of `vector.length * 4` bytes while the `dimensions` column stores the caller-supplied `record.dimensions`. On read, `unpackFloat32Vector(row.vector, row.dimensions)` throws "byte length mismatch". Consequences of a single malformed write:
1. `getSummaryVector` for that row throws forever.
2. `findNearestSummaries` unpacks every candidate row inside its loop (`sqlite-store.ts:1315`), so **one** bad row makes **every** nearest-neighbor query over that `(provider, model, personId)` partition throw — a denial of semantic recall on the live ~3.5GB DB until manual SQL repair.
3. InMemoryStore accepts and serves the same malformed record without error, so SqliteStore and InMemoryStore diverge — a direct violation of the SC3 exact-parity contract this phase exists to guarantee.

Phase 10's backfill will push high row volumes through this API; write-time validation is the only cheap place to stop corrupt rows from entering a persisted store.
**Fix:**
```typescript
// In both stores, at the top of saveSummaryVector:
if (record.dimensions !== record.vector.length) {
  throw new Error(
    `saveSummaryVector: dimensions (${record.dimensions}) !== vector.length (${record.vector.length}) for summary ${record.summaryId}`
  );
}
```
Optionally also skip-and-log (rather than throw) on unpack failure inside `findNearestSummaries` so one bad row cannot take down the whole partition.

## Warnings

### WR-01: `unpackFloat32Vector` is not the inverse of `packFloat32Vector` — platform-endian read vs explicit little-endian write, plus a 4-byte alignment crash

**File:** `src/embeddings/vector-codec.ts:25`
**Issue:** `packFloat32Vector` writes explicitly little-endian (`writeFloatLE`), but `unpackFloat32Vector` reads via `new Float32Array(bytes.buffer, bytes.byteOffset, dimensions)`, which uses **platform** endianness. On any big-endian platform decode silently returns garbage numbers (no error — silent data corruption). Separately, the `Float32Array` constructor throws `RangeError: start offset ... should be a multiple of 4` when `bytes.byteOffset` is not 4-byte aligned, bypassing the codec's own descriptive error contract. The existing test at `tests/embeddings/vector-codec.test.ts:36-43` only covers an aligned offset (8), so the alignment hazard is untested.
**Fix:**
```typescript
const view = new DataView(bytes.buffer, bytes.byteOffset, expectedByteLength);
const result = new Array<number>(dimensions);
for (let i = 0; i < dimensions; i += 1) {
  result[i] = view.getFloat32(i * 4, true); // explicit little-endian, alignment-safe
}
return result;
```

### WR-02: `minimumScore` predicates are not logically equivalent between backends — NaN scores are kept by SqliteStore and dropped by InMemoryStore

**File:** `src/storage/sqlite-store.ts:1317` and `src/storage/in-memory-store.ts:940-941`
**Issue:** SqliteStore uses a reject-condition: `if (minimumScore !== undefined && score < minimumScore) continue;` — for a NaN score, `NaN < x` is false, so the row is **kept**. InMemoryStore uses a keep-condition: `scored.filter((match) => match.score >= query.minimumScore!)` — `NaN >= x` is false, so the row is **dropped**. `cosineSimilarity` returns NaN whenever a stored vector contains NaN (NaN round-trips cleanly through the Float32 codec, and the `leftMagnitude === 0` guard does not catch NaN magnitudes). So the same corpus + query can return different result sets from the two backends — an exact-parity (SC3/D-07) break that the parity test never exercises.
**Fix:** Use the identical keep-condition in both stores (e.g. `score >= minimumScore` in both), and reject non-finite vector values in `saveSummaryVector` / `findNearestSummaries` input so NaN can never enter scoring.

### WR-03: `localeCompare` tie-break makes D-07's "deterministic order" locale/ICU-dependent

**File:** `src/storage/sqlite-store.ts:1321` and `src/storage/in-memory-store.ts:938`
**Issue:** The score-tie fallback uses `left.summaryId.localeCompare(right.summaryId)`. `localeCompare` ordering depends on the process locale and the ICU version bundled with Node — e.g. `"Summary_A".localeCompare("summary_a")` differs from code-unit order, and collation tables change between ICU releases. Both stores agree with each other in one process, but D-07 promises a deterministic tie-break, and this ordering can differ across machines/Node versions. It also diverges from `listSummaryIdsMissingVector`, which uses plain code-unit sort (in-memory) / SQLite BINARY collation.
**Fix:**
```typescript
matches.sort((l, r) =>
  r.score - l.score || (l.summaryId < r.summaryId ? -1 : l.summaryId > r.summaryId ? 1 : 0)
);
```

### WR-04: `findNearestSummaries` silently returns score-0 garbage on query/row dimension mismatch

**File:** `src/storage/sqlite-store.ts:1316` and `src/storage/in-memory-store.ts:934-937`
**Issue:** `cosineSimilarity` returns `0` when `left.length !== right.length` (`src/embeddings/embedder.ts:49-51`). If a caller queries with a vector whose dimensionality doesn't match the stored rows (e.g. model dimension drift before provider/model keying catches it, or a caller bug), every candidate scores exactly 0. With no `minimumScore`, the method then returns up to `topK` "matches" ordered purely by summaryId — garbage results indistinguishable from legitimate low-similarity matches. Nothing at any layer surfaces the mismatch.
**Fix:** In both stores, skip (or better, throw on) candidates where `row.dimensions !== query.vector.length` before scoring, e.g. `if (record.dimensions !== query.vector.length) continue;` — and consider throwing, since a mismatch inside a single (provider, model) partition always indicates a bug.

### WR-05: `deleteSummaryVectors` in SqliteStore is not transactional — partial tombstoning on failure

**File:** `src/storage/sqlite-store.ts:1330-1333`
**Issue:** The method runs one `delete` statement per summaryId with no enclosing transaction, unlike the store's other multi-row mutations (which use `begin immediate` / `commit`). If a later `run` throws (I/O error, busy timeout), earlier deletes are already committed, leaving REQ-050 deletion propagation half-applied with no way for the Phase 14 caller to know which ids succeeded. Each autocommit delete also pays a separate fsync.
**Fix:**
```typescript
async deleteSummaryVectors(summaryIds: string[]): Promise<void> {
  if (summaryIds.length === 0) return;
  this.database.exec("begin immediate");
  try {
    const statement = this.database.prepare("delete from summary_vectors where summary_id = ?");
    for (const summaryId of summaryIds) statement.run(summaryId);
    this.database.exec("commit");
  } catch (error) {
    this.database.exec("rollback");
    throw error;
  }
}
```

## Info

### IN-01: Security-relevant magic string `"personal"` (empty-scope default) duplicated across both stores

**File:** `src/storage/sqlite-store.ts:1313` and `src/storage/in-memory-store.ts:931`
**Issue:** The rule "a record with empty `scopeIds` is treated as scope `personal`" is a boundary-enforcement (D-06) rule duplicated as an inline literal in two files. If one copy drifts, the parity break is silent and security-relevant.
**Fix:** Extract to a shared constant or helper (e.g. `effectiveScopeIds(record)` exported from `memory-store.ts`) used by both stores.

### IN-02: Documented behaviors with zero test coverage: upsert-overwrite, `minimumScore`, `createdAt` round-trip

**File:** `tests/storage/summary-vectors.test.ts`
**Issue:** The interface doc promises `saveSummaryVector` "Upserts", but no test saves the same `(summaryId, provider, model)` twice and asserts the second write wins in both backends. `minimumScore` is never exercised at all (which is exactly where WR-02's parity divergence hides). SC1 asserts every field except `createdAt`.
**Fix:** Add a parameterized upsert-overwrite test, a `minimumScore` filtering test (including a boundary-equal score), and assert `createdAt` in SC1.

### IN-03: `listSummaryIdsMissingVector` ordering can diverge between backends for non-ASCII ids

**File:** `src/storage/in-memory-store.ts:919` vs `src/storage/sqlite-store.ts:1287`
**Issue:** In-memory sorts by UTF-16 code units (default `.sort()`); SQLite `order by id asc` uses BINARY collation over UTF-8 bytes. These orderings differ for ids mixing code points in U+E000–U+FFFF with supplementary-plane characters. Harmless for the current ASCII `summary_*` ids, but this list is the Phase 10 backfill resume key, so any future non-ASCII id scheme would break resume determinism.
**Fix:** Document the ASCII-id assumption, or normalize both to code-unit comparison.

### IN-04: `getSummaryVector` performs no personId/scope boundary check

**File:** `src/storage/sqlite-store.ts:1278-1289`, `src/storage/in-memory-store.ts:904-910`
**Issue:** Unlike `findNearestSummaries` (D-06 filter-before-score), the direct-by-id read returns any person's vector to any caller. This matches the store's other getters (single-user local store trust model), but the asymmetry is undocumented on the interface.
**Fix:** Add a doc comment on `MemoryStore.getSummaryVector` stating that boundary enforcement is the caller's responsibility for direct-by-id reads.

---

_Reviewed: 2026-07-21T20:50:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
