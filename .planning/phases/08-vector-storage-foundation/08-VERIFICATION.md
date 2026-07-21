---
phase: 08-vector-storage-foundation
verified: 2026-07-21T21:30:00Z
status: gaps_found
score: 4/5 must-haves verified
overrides_applied: 0
gaps:
  - truth: "A nearest-neighbor query returns identical top-K results (same ranking, same scores, same tie-break) from SqliteStore and InMemoryStore given identical input vectors — not 'closely enough,' an exact match (SC3)"
    status: failed
    reason: >
      Verified by direct reproduction (not just code review) that SqliteStore and InMemoryStore
      diverge on findNearestSummaries for identical stored input + identical query when a stored
      vector contains a NaN component and minimumScore is supplied. SqliteStore's minimumScore
      predicate is a reject-condition (`score < minimumScore` → skip), under which `NaN < x` is
      false so the NaN-scored row is KEPT. InMemoryStore's predicate is a keep-condition
      (`score >= minimumScore` → keep), under which `NaN >= x` is false so the row is DROPPED.
      Reproduction: seeded both stores with the identical malformed vector record, queried both
      with the identical FindNearestSummariesQuery (minimumScore: 0.1) — InMemoryStore returned
      `[]`, SqliteStore returned `[{"summaryId":"s1","score":NaN}]`. This is a genuine,
      code-verified violation of the SC3 "exact match, not closely enough" contract that is the
      explicit design driver of this phase. The parity suite (tests/storage/summary-vectors.test.ts)
      never exercises minimumScore or any NaN/malformed-vector input, so this divergence is
      unguarded by the required test gate even though the gate itself passes.
    artifacts:
      - path: "src/storage/sqlite-store.ts"
        issue: "Line ~1317: `if (query.minimumScore !== undefined && score < query.minimumScore) continue;` keeps NaN scores"
      - path: "src/storage/in-memory-store.ts"
        issue: "Line ~940-941: `scored.filter((match) => match.score >= query.minimumScore!)` drops NaN scores — logically non-equivalent predicate to SqliteStore's"
    missing:
      - "Use an identical keep-condition (or identical reject-condition) for minimumScore filtering in both stores"
      - "Reject non-finite (NaN/Infinity) vector values in saveSummaryVector in both stores so NaN can never enter scoring in the first place"
      - "Add a parity/unit test exercising minimumScore (including a NaN-score case) so this class of divergence is caught going forward"
  - truth: "SqliteStore write-path integrity: saveSummaryVector does not persist rows where dimensions disagrees with vector.length, which would poison reads and diverge from InMemoryStore's tolerant behavior"
    status: failed
    reason: >
      Verified by direct reproduction that neither store validates record.dimensions ===
      record.vector.length on write. A caller bug (dimensions=8, vector.length=4) is accepted
      silently by both saveSummaryVector implementations. On subsequent read: InMemoryStore's
      getSummaryVector returns the malformed record unchanged (no error). SqliteStore's
      getSummaryVector throws `unpackFloat32Vector: byte length mismatch — got 16 bytes, expected
      32 bytes for 8 dimensions`. This is a second concrete, reproduced exact-parity divergence
      (one store errors, the other silently serves malformed data) and, per the code review
      (CR-01), a single such row poisons every findNearestSummaries call over that
      (provider, model, personId) partition in SqliteStore going forward (every candidate row in
      that partition is unpacked inside the query loop — one bad row throws for the whole partition).
    artifacts:
      - path: "src/storage/sqlite-store.ts"
        issue: "saveSummaryVector (~line 1254) has no dimensions/vector.length invariant check before persisting"
      - path: "src/storage/in-memory-store.ts"
        issue: "saveSummaryVector (~line 889) has no dimensions/vector.length invariant check before persisting"
    missing:
      - "Validate record.dimensions === record.vector.length at the top of saveSummaryVector in both stores, throwing a descriptive error on mismatch"
      - "Consider skip-and-log (rather than hard-throw) inside findNearestSummaries' per-row unpack so one already-malformed row cannot take down an entire partition's queries"
deferred: []
human_verification: []
---

# Phase 8: Vector Storage Foundation Verification Report

**Phase Goal:** Every summary can have a locally computed vector embedding persisted in a dedicated, scope-aware, deletion-tombstonable store, with exact result parity between SqliteStore and InMemoryStore.
**Verified:** 2026-07-21T21:30:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| SC1 | A vector can be saved for a summary, tagged with provider/model/dimensionality, retrieved by summary ID | ✓ VERIFIED | `saveSummaryVector`/`getSummaryVector` implemented in both `src/storage/sqlite-store.ts` and `src/storage/in-memory-store.ts`; round-trip test passes on both backends (`tests/storage/summary-vectors.test.ts`, "round-trips a saved vector with byte-identical fidelity (SC1)") |
| SC2 | listSummaryIdsMissingVector(provider, model) returns exactly the correct set in stable order | ✓ VERIFIED | SqliteStore uses explicit `order by id asc`; InMemoryStore uses `.sort()`; both parity-tested with a mixed present/absent fixture and a repeat-call stability assertion — green on both backends |
| SC3 | Nearest-neighbor query returns identical top-K (ranking, scores, tie-break) from SqliteStore and InMemoryStore given identical input — exact match, not "closely enough" | ✗ FAILED | Required parity test (`cross-store exact parity (SC3, D-07)`) passes for well-formed float32-exact vectors with no `minimumScore`. However, direct reproduction against the actual store code shows the guarantee does NOT hold generally: (1) `minimumScore` filtering diverges on NaN-scored rows (reject- vs keep-condition are not logical inverses — verified by running both stores against identical input, see gap 1); (2) a caller-supplied `dimensions !== vector.length` record diverges even harder — InMemoryStore serves it silently, SqliteStore throws on every subsequent read of that row and (per code review CR-01) poisons `findNearestSummaries` for the whole partition (verified by reproduction, see gap 2). Neither case is covered by the required test suite. |
| SC4 | Storage schema/query surface support scope-partitioned lookups and per-vector tombstoning, verified by tests, even though nothing invokes deletion yet | ✓ VERIFIED | `findNearestSummaries` filters by `personId` + scope `.every()` before scoring in both stores (grep confirms filter precedes `cosineSimilarity`/scoring loop); scope-isolation and tombstone tests pass on both backends in `tests/storage/summary-vectors.test.ts` |
| SC5 | Schema migration is additive and safe against the live ~3.5GB database — existing summaries, tests, daemon startup unaffected | ✓ VERIFIED | `schema-migrations.ts` version 2 entry adds `summary_vectors` (create table if not exists) + one index only; no DDL added to `SqliteStore.migrate()`'s frozen base block; `npm test` reports 91 test files / 735 tests passing (no regression in `tests/storage/sqlite-store.test.ts`, daemon, or sync suites) and `npm run typecheck` is clean |

**Score:** 4/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/embeddings/vector-codec.ts` | packFloat32Vector + unpackFloat32Vector with dimension validation | ✓ VERIFIED | Both functions exist, exported, dimension-mismatch throws on decode; 6 unit tests pass |
| `src/storage/memory-store.ts` | 5 vector method signatures + shared types on MemoryStore interface | ✓ VERIFIED | `SummaryVectorRecord`, `FindNearestSummariesQuery`, `SummaryVectorMatch` exported; all 5 methods declared (lines 194-205) |
| `src/storage/sqlite-store.ts` | SqliteStore implementations of all 5 vector methods | ✓ VERIFIED (with correctness gaps) | All 5 methods implemented against typed `summary_vectors` columns using `cosineSimilarity` + the exact tie-break comparator; filter-before-score confirmed by reading WHERE clause ordering. Correctness gaps noted above (no write-time validation, NaN predicate divergence) |
| `src/storage/in-memory-store.ts` | InMemoryStore implementations of all 5 vector methods | ✓ VERIFIED (with correctness gaps) | All 5 methods implemented, `summaryVectors: SummaryVectorRecord[]` field present, identical filter-before-score and tie-break sequence. Same correctness gaps as above |
| `src/storage/schema-migrations.ts` | summary_vectors as version-2 additive migration | ✓ VERIFIED | `version: 2` entry present, `create table if not exists summary_vectors (...)` + index, description names REQ-041 |
| `tests/storage/summary-vectors.test.ts` | Backend-parameterized parity suite incl. cross-store exact-parity gate | ✓ VERIFIED | Both per-backend suites and the cross-store parity describe block exist; 18/18 tests pass; no `it.todo` remains |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `src/storage/sqlite-store.ts` | `src/embeddings/embedder.ts` | `cosineSimilarity` import | ✓ WIRED | Imported and used inside `findNearestSummaries` |
| `src/storage/sqlite-store.ts` | `src/embeddings/vector-codec.ts` | `packFloat32Vector`/`unpackFloat32Vector` import | ✓ WIRED | Used in `saveSummaryVector`/`getSummaryVector`/`findNearestSummaries` |
| `src/storage/in-memory-store.ts` | `src/embeddings/embedder.ts` | `cosineSimilarity` import | ✓ WIRED | Imported and used inside `findNearestSummaries` |
| `tests/storage/summary-vectors.test.ts` | both stores | identical query fed to both, `toEqual` | ✓ WIRED | Cross-store parity test present and passing for the happy-path corpus it constructs |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Required test suite green | `npx vitest run tests/storage/summary-vectors.test.ts tests/embeddings/vector-codec.test.ts` | 2 files, 18 tests, all pass | ✓ PASS |
| SC3 parity holds for malformed/edge-case input (minimumScore + NaN score) | Direct reproduction script instantiating both stores, saving identical malformed record, querying both with identical `FindNearestSummariesQuery{minimumScore:0.1}` | InMemoryStore → `[]`; SqliteStore → `[{"summaryId":"s1","score":null}]` (NaN) | ✗ FAIL — confirms gap 1 |
| Write-path integrity: dimensions/vector.length invariant | Direct reproduction script saving `{dimensions:8, vector:[1,0,0,0]}` (length 4) to both stores, then reading it back | InMemoryStore → returns malformed record silently; SqliteStore → throws `unpackFloat32Vector: byte length mismatch` | ✗ FAIL — confirms gap 2 |
| Full project suite regression | `npm test` (from 08-VALIDATION.md record) | 91 files / 735 tests passing | ✓ PASS |
| Typecheck | `npm run typecheck` (from 08-VALIDATION.md record) | 0 errors | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| REQ-041 | 08-01, 08-02, 08-03, 08-04 (all four plans declare it) | Each summary shall have a locally computed vector embedding persisted in a dedicated vector store, tagged with provider/model/dimensionality | ⚠️ PARTIALLY SATISFIED | Persistence, tagging, and retrieval mechanics exist and are tested on the happy path (SC1/SC2/SC4/SC5 hold). The requirement's implicit correctness bar — a dedicated store that behaves identically regardless of backend — is not fully met; see SC3 gap above. `.planning/REQUIREMENTS.md` traceability table (line 103) still shows REQ-041 as "Pending," which is a documentation staleness item, not a code gap. |

No orphaned requirements found — REQ-041 is the only ID mapped to Phase 8 in REQUIREMENTS.md and it is declared in all four plans.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/storage/sqlite-store.ts` | ~1254-1277 (`saveSummaryVector`) | Missing write-time invariant validation (`dimensions !== vector.length` accepted silently) | 🛑 Blocker | Reproduced: poisons SqliteStore reads for the affected row and (per partition-wide unpack loop in `findNearestSummaries`) can take down an entire partition's nearest-neighbor queries; diverges from InMemoryStore's tolerant behavior — breaks SC3 |
| `src/storage/sqlite-store.ts` vs `src/storage/in-memory-store.ts` | ~1317 / ~940-941 | `minimumScore` predicate is a reject-condition in one store and a keep-condition in the other — not logical inverses under NaN | 🛑 Blocker | Reproduced divergence in returned result sets for identical input — direct SC3 violation |
| `src/storage/sqlite-store.ts` | ~1321 | `localeCompare` tie-break is locale/ICU-dependent (D-07 promises deterministic order) | ⚠️ Warning | Does not affect single-process test runs but is a portability risk for the "deterministic order" contract across machines/Node versions; not independently reproduced here beyond code reading, carried from code review WR-03 |
| `src/storage/sqlite-store.ts` | ~1330-1333 (`deleteSummaryVectors`) | Not wrapped in a transaction (unlike other multi-row mutations in the same file) | ⚠️ Warning | Partial-tombstone risk on mid-loop failure; unwired until Phase 14 so not yet reachable by production code paths, but noted for backfill/Phase 14 wiring — carried from code review WR-05 |

No unresolved `TBD`/`FIXME`/`XXX` debt markers found in any phase-touched file.

### Human Verification Required

None — all findings above were verified programmatically via direct code reading and reproduction scripts, not requiring subjective/visual/UX judgment.

### Gaps Summary

The phase delivered real, substantive, wired implementations on both backends — the interface, codec, migration, and all five methods exist and are not stubs. The required backend-parameterized test suite (18 tests) is genuine and passes. However, the phase's own goal statement is explicit and absolute: "exact result parity between SqliteStore and InMemoryStore" / SC3: "not 'closely enough,' an exact match." Two concrete, reproduced divergences violate that contract:

1. **`minimumScore` + NaN-scored rows**: SqliteStore keeps what InMemoryStore drops (and vice versa is not the case — it's asymmetric), for the identical stored data and identical query.
2. **Malformed writes (`dimensions !== vector.length`)**: silently tolerated by InMemoryStore, causes SqliteStore to throw on read and (per the code review's CR-01 analysis, which traces the partition-wide unpack loop) can deny nearest-neighbor queries across an entire `(provider, model, personId)` partition once one bad row lands.

Both are pre-existing conditions reachable via the public `MemoryStore` interface as currently implemented (no additional wiring needed to trigger them), and neither is caught by the phase's required test gate. Because SC3 is the explicit "design driver of the whole phase" (08-04-SUMMARY.md's own words) and REQ-041/Phase 9-14 downstream work (embedding backfill, semantic recall, deletion propagation) depends on this parity holding under real-world data (including malformed rows from bugs, upgrades, or partial writes), these are classified as blocking gaps rather than advisory warnings.

The code review (08-REVIEW.md) independently found and prescribed fixes for both (CR-01, WR-02), plus three additional warnings (WR-01 endian/alignment asymmetry, WR-03 locale-dependent tie-break, WR-05 non-transactional delete) not elevated to blocking status here because they were not independently reproduced as behavior-level divergences in this verification pass (WR-01 requires a big-endian platform or misaligned buffer to manifest; WR-03/WR-05 are portability/atomicity risks rather than confirmed parity breaks under current single-process test conditions).

**Suggested fix scope for gap closure:** add an invariant check (`dimensions === vector.length`) at the top of `saveSummaryVector` in both stores, and unify the `minimumScore` predicate to an identical keep/reject condition in both stores (plus reject non-finite vector values on write so NaN cannot enter scoring). Both fixes are small, localized, and match the code review's prescribed patches.

---

_Verified: 2026-07-21T21:30:00Z_
_Verifier: Claude (gsd-verifier)_
