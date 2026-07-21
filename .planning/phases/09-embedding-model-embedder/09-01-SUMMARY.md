---
phase: 09-embedding-model-embedder
plan: 01
subsystem: embeddings
tags: [embeddings, onnx, transformers-js, bge, vitest, tdd-scaffolding]

# Dependency graph
requires:
  - phase: 08-vector-storage-foundation
    provides: "summary_vectors write-time invariants (dimensions === vector.length, float32-finite components) that TransformerEmbedder output must satisfy"
provides:
  - "AsymmetricEmbedder interface + isAsymmetricEmbedder type guard (D-03) appended to src/embeddings/embedder.ts without touching the base Embedder or DeterministicEmbedder"
  - "Throwing skeleton modules for transformer-embedder, embeddings-config, model-vendor, embedder-resolver so downstream plans have a stable, typechecked contract to implement against"
  - "Committed D-08 golden-set fixture (15 real summary-like texts, both embed modes, unicode, 512-token-boundary truncation, near-empty)"
  - "Three RED Wave 0 vitest suites pinning the D-04/D-05/D-06 resolver contract, the D-01/D-02 fp32-only vendoring contract, and the D-07/D-08 golden-hash/determinism contract"
affects: [09-embedding-model-embedder plan 02, plan 03, plan 04, plan 05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Extension-interface pattern for opt-in embedder capabilities: AsymmetricEmbedder extends Embedder rather than widening the base interface, keeping DeterministicEmbedder and every existing call site untouched"
    - "Throwing skeleton modules (Error('not implemented: <module>')) to keep repo-wide typecheck green across wave-by-wave implementation"
    - "existsSync-guarded fixture loading for golden-hash test data not yet generated, producing a clear RED message instead of an import/compile error"

key-files:
  created:
    - src/embeddings/transformer-embedder.ts
    - src/embeddings/embeddings-config.ts
    - src/embeddings/model-vendor.ts
    - src/embeddings/embedder-resolver.ts
    - tests/fixtures/embedding-golden-set.json
    - tests/embeddings/embedder-resolver.test.ts
    - tests/embeddings/model-vendor.test.ts
    - tests/embeddings/transformer-embedder.golden.test.ts
  modified:
    - src/embeddings/embedder.ts

key-decisions:
  - "AsymmetricEmbedder added as an appended, opt-in extension interface (Pattern 1 from RESEARCH) rather than widening the base Embedder — verified via diff that the change to embedder.ts is purely additive"
  - "transformer-embedder.ts skeleton intentionally has zero @huggingface/transformers references (including in comments) so it typechecks independently of the plan-02 dependency install"
  - "embedder-resolver.test.ts writes the embeddings-config sidecar file directly via node:fs rather than through writeEmbeddingsConfig (also a throwing skeleton), so the RED failure surfaces from resolveEmbedder itself, not from test setup"

patterns-established:
  - "Sidecar config path convention: embeddingsConfigPath(databasePath) => `${databasePath}.embeddings.json`, mirroring tune-command.ts's `${databasePath}.tune.json`"

requirements-completed: [REQ-044, REQ-051]

# Metrics
duration: 22min
completed: 2026-07-21
---

# Phase 9 Plan 01: Wave 0 Contracts and RED Scaffolds Summary

**Appended D-03's AsymmetricEmbedder contract to the existing Embedder module, added four throwing skeleton modules, committed a 15-entry D-08 golden-set fixture, and landed three RED vitest suites pinning the resolver/vendoring/golden-hash contracts for Phase 9's later waves.**

## Performance

- **Duration:** 22 min
- **Started:** 2026-07-21T19:40:00Z
- **Completed:** 2026-07-21T20:02:42Z
- **Tasks:** 3
- **Files modified:** 9

## Accomplishments
- `AsymmetricEmbedder` interface + `isAsymmetricEmbedder` guard exported from `src/embeddings/embedder.ts`, verified additive-only via diff (base `Embedder`/`DeterministicEmbedder` byte-identical)
- Four throwing skeleton modules (`transformer-embedder.ts`, `embeddings-config.ts`, `model-vendor.ts`, `embedder-resolver.ts`) compile cleanly under `npm run typecheck`, giving later plans a stable contract to implement against
- Committed `tests/fixtures/embedding-golden-set.json`: 15 texts, 12 passage-mode / 3 query-mode, covering unicode (emoji + Japanese script), a >512-token long-truncation entry, and a near-empty entry
- Three new vitest suites (`embedder-resolver.test.ts`, `model-vendor.test.ts`, `transformer-embedder.golden.test.ts`) exist, compile, and fail RED (22 failing tests, zero skips) against the unimplemented skeletons

## Task Commits

Each task was committed atomically:

1. **Task 1: Add AsymmetricEmbedder contract and throwing skeleton modules** - `0d4af5a` (feat)
2. **Task 2: Commit the D-08 golden-set fixture** - `bac429e` (test)
3. **Task 3: Wave 0 RED test scaffolds** - `a6aa9f8` (test)

_Note: Task 3 is `tdd="true"` but is itself the RED half of the plan-spanning TDD cycle — GREEN lands in plans 02-05 as each skeleton is implemented._

## Files Created/Modified
- `src/embeddings/embedder.ts` - appended `AsymmetricEmbedder` interface + `isAsymmetricEmbedder` guard; base `Embedder`/`DeterministicEmbedder` unchanged
- `src/embeddings/transformer-embedder.ts` - `TransformerEmbedder` skeleton implementing `AsymmetricEmbedder`, no `@huggingface/transformers` import yet
- `src/embeddings/embeddings-config.ts` - `EmbeddingsConfig` type, sidecar path helper (implemented), read/write (throwing skeletons)
- `src/embeddings/model-vendor.ts` - `BGE_SMALL_EN_V1_5_MANIFEST` (placeholder revision/hashes) + `vendorModel` throwing skeleton
- `src/embeddings/embedder-resolver.ts` - `EmbedderHealth` type, `resolveEmbedder`/`probeEmbedderHealth` throwing skeletons
- `tests/fixtures/embedding-golden-set.json` - 15-entry D-08 golden-set fixture
- `tests/embeddings/embedder-resolver.test.ts` - RED: default/enabled/broken resolution contract
- `tests/embeddings/model-vendor.test.ts` - RED: fp32-only vendoring + hash-mismatch contract
- `tests/embeddings/transformer-embedder.golden.test.ts` - RED: quantized-hash + exact-byte-hash determinism contract, existsSync-guarded golden-hashes fixture load

## Decisions Made
- Kept `transformer-embedder.ts` free of any literal `@huggingface/transformers` string (including comments) since the plan's acceptance criteria grep for that string with an expected count of 0
- Golden test's `beforeAll` catches `TransformerEmbedder.init()`'s throw into a local `initError` variable rather than letting `beforeAll` itself fail, so each `it.each` case reports its own clear "init must succeed" assertion instead of vitest's generic beforeAll-failure output for every case

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- `node_modules` was empty at session start (as flagged in the parallel-execution notice); ran `npm ci` before running typecheck/tests, per the plan's stated Wave-1 expectation. No packages were added or modified.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plans 02-05 have a stable, typechecked contract (`AsymmetricEmbedder`, `TransformerEmbedder`, `EmbeddingsConfig`, `BGE_SMALL_EN_V1_5_MANIFEST`, `EmbedderHealth`) to implement against
- Golden-set fixture is committed and stable; plan 05 must generate `tests/fixtures/embedding-golden-hashes.json` from a real vendored-model run to turn the golden suite GREEN
- `model-vendor.ts`'s manifest still has `"PIN_AT_VENDOR_TIME"`/`"PIN"` placeholders — plan 02/03/04 must replace these with real revision/sha256 values captured from a live Hugging Face Hub fetch, not guessed

---
*Phase: 09-embedding-model-embedder*
*Completed: 2026-07-21*

## Self-Check: PASSED

All created files verified present on disk; all four task/summary commit hashes (0d4af5a, bac429e, a6aa9f8, 2a35050) verified present in git log.
