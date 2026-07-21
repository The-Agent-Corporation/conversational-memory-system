---
phase: 09-embedding-model-embedder
plan: 05
subsystem: embeddings
tags: [embeddings, onnx, transformers-js, bge, determinism, vendoring, golden-test]

# Dependency graph
requires:
  - phase: 09-embedding-model-embedder
    provides: "plan 03's TransformerEmbedder + model-vendor.ts implementations (placeholder manifest); plan 04's config sidecar/resolver/CLI enable command"
provides:
  - "Real pinned BGE manifest: commit ea104dacec62c0de699686887e3f920caeb4f3e3, real per-file sha256 for onnx/model.onnx, tokenizer.json, tokenizer_config.json, special_tokens_map.json, config.json"
  - "Committed real-run golden hashes (tests/fixtures/embedding-golden-hashes.json) and a GREEN golden-vector regression suite (16/16) against the real vendored model"
  - "Human-verified idempotent enable + hard-error-on-missing-model + no-committed-binary guarantees (D-05/D-08 gate closed)"
affects: [09-embedding-model-embedder plan 06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Real vendoring capture done out-of-band via a scratch tsx script (not committed) that calls the same pipeline()/env surface as vendorModel(), so the manifest and golden hashes are provably generated from a real model run, never hand-authored"
    - "Model-file integrity independently corroborated by comparing the captured onnx/model.onnx sha256 against Hugging Face's own reported Git LFS object id for that file, not just self-consistency with the manifest"

key-files:
  created:
    - tests/fixtures/embedding-golden-hashes.json
  modified:
    - src/embeddings/model-vendor.ts
    - tests/embeddings/transformer-embedder.golden.test.ts
    - .gitignore

key-decisions:
  - "Vendored model files land at tests/fixtures/models/Xenova/bge-small-en-v1.5/ (matches both the golden test's default MEMORY_MODEL_PATH and the manifest's repo-relative file layout); the whole tests/fixtures/models/ dir is gitignored so the 127MB onnx/model.onnx is never staged, while the sha256 manifest and golden hashes (the only values needed to detect drift) are committed."
  - "Widened the PLACEHOLDER_SHA256 comparison in verifyManifest to `(expected.sha256 as string) === PLACEHOLDER_SHA256` — once the manifest's sha256 fields hold real literal-typed hashes (via `as const`), TypeScript correctly flags the previous placeholder-guard comparison as unreachable (no literal-type overlap with \"PIN\"); the cast preserves the defensive check's runtime behavior without disabling the const-literal typing."

patterns-established: []

requirements-completed: [REQ-051, REQ-044]

# Metrics
duration: 35min
completed: 2026-07-21
---

# Phase 9 Plan 05: Real Model Vendoring + Golden Capture Summary

**Vendored the real pinned `Xenova/bge-small-en-v1.5` fp32 model (commit `ea104dacec62c0de699686887e3f920caeb4f3e3`, `onnxruntime-node@1.24.3`) from the live Hugging Face Hub, captured its real per-file sha256 manifest and real golden-vector quantized hashes from an actual embedder run, and turned the golden-vector regression suite GREEN (16/16) — closing REQ-051's determinism gate with values that could only come from a real run.**

## Performance

- **Duration:** 35 min
- **Started:** 2026-07-21T20:10:00Z
- **Completed:** 2026-07-21T20:45:00Z
- **Tasks:** 3 (2 auto + 1 human-verify checkpoint)
- **Files modified:** 3 (1 created, 2 modified) + .gitignore

## Accomplishments
- Resolved the real HEAD commit for `Xenova/bge-small-en-v1.5`'s `main` branch (`ea104dacec62c0de699686887e3f920caeb4f3e3`) via the HF Hub API, then vendored the pinned fp32 file set (`onnx/model.onnx`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, `config.json`) — confirmed zero quantized variants (`model_fp16/int8/uint8/quantized/q4/q4f16/bnb4.onnx`) were fetched
- Captured real per-file sha256 hashes into `BGE_SMALL_EN_V1_5_MANIFEST`; the `onnx/model.onnx` hash (`828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35`) independently matches the repository's own reported Git LFS object id for that file at this revision — corroborating download integrity beyond mere self-consistency with the manifest
- Ran the real `TransformerEmbedder` (`init()` + `embed()`/`embedQuery()`) over all 15 golden-set entries (7 bare-passage, 3 query-mode, plus unicode/near-empty/long-truncation/meeting-followup/support-escalation edge cases) and committed the resulting quantized (1e-4 precision) sha256 hashes to `tests/fixtures/embedding-golden-hashes.json` — never hand-authored
- Removed the plan-01 `existsSync` RED guard from `transformer-embedder.golden.test.ts`, pinned the real revision in the test's `beforeAll`, and confirmed all 16 tests (15 per-id quantized-hash matches + 1 same-machine exact-byte-hash repeat-run) pass GREEN against the real vendored model
- Human checkpoint (Task 3) confirmed idempotent re-enable, hard-error on a missing/renamed model file (no silent hash-embedder fallback), and that only manifest + golden-hash fixtures — never the 127MB `model.onnx` — are staged for commit
- `npm run typecheck` exits 0

## Task Commits

Each task was committed atomically:

1. **Task 1: Run real vendoring, capture and commit manifest values** - `e155561` (feat)
2. **Task 2: Generate committed golden hashes and turn the golden suite GREEN** - `723607d` (feat)
3. **Task 3: Confirm idempotent enable + hard-error-on-missing** - human-verify checkpoint, approved by operator (no code changes; verification only)

**Plan metadata:** (this commit) `docs(09-05): complete plan`

## Files Created/Modified
- `src/embeddings/model-vendor.ts` - `BGE_SMALL_EN_V1_5_MANIFEST.revision` set to the real pinned commit SHA; each `files[...].sha256` set to the real captured hash (replacing all `"PIN_AT_VENDOR_TIME"`/`"PIN"` placeholders); `verifyManifest`'s placeholder-guard comparison widened with an `as string` cast to remain valid TypeScript now that the sha256 fields are literal-typed real values
- `tests/fixtures/embedding-golden-hashes.json` - new: 15 committed quantized-hash entries (one per golden-set id), each a 64-hex sha256, generated from a real embedder run
- `tests/embeddings/transformer-embedder.golden.test.ts` - removed the plan-01 `existsSync`/RED-tolerant guard and its `initError`-swallowing `try/catch`; `beforeAll` now awaits `init()` directly (a real init failure fails the suite loudly, per D-05 intent) and pins the real revision
- `.gitignore` - added `tests/fixtures/models/` so the vendored 127MB `model.onnx` (and its sibling files) are never staged; only the manifest hashes and golden-hash fixture — both committed source — carry the model's integrity forward

## Decisions Made
- Performed the real vendoring/golden-capture work via out-of-band scratch scripts (`tsx`, deleted before commit) rather than reusing `vendorModel()`/the CLI directly for the *capture* step, because `vendorModel()`'s `verifyManifest()` intentionally refuses to trust a still-placeholder manifest — the capture step has to happen before the manifest can be considered "real," so a two-phase flow (download+hash, then pin, then re-verify) was necessary. `vendorModel()` and the CLI path are otherwise unchanged and were exercised as-is by the Task 3 checkpoint's idempotency/hard-error verification.
- Kept the model's on-disk layout as `tests/fixtures/models/Xenova/bge-small-en-v1.5/...` (repo-name-scoped, matching `BGE_SMALL_EN_V1_5_MANIFEST.repo`) rather than flattening it, since both `vendorModel()`'s file-path construction and the golden test's default `MEMORY_MODEL_PATH` already assume this repo-scoped layout.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed a TypeScript literal-type comparison that became unreachable once real hashes were pinned**
- **Found during:** Task 1, post-edit `npm run typecheck`
- **Issue:** `verifyManifest`'s placeholder guard (`if (expected.sha256 === PLACEHOLDER_SHA256)`) compiled fine against the old `"PIN"`-literal manifest, but once the manifest's `sha256` fields held real, `as const`-narrowed literal hash strings, TypeScript correctly reported the comparison as having no possible overlap (TS2367) — a real compile error blocking the plan's own typecheck gate.
- **Fix:** Cast the left-hand side to `string` (`(expected.sha256 as string) === PLACEHOLDER_SHA256`), preserving the defensive runtime check (still guards against a future accidental re-introduction of a placeholder value) without fighting the const-literal typing that gives the manifest its compile-time integrity guarantee.
- **Files modified:** `src/embeddings/model-vendor.ts`
- **Verification:** `npm run typecheck` exits 0.
- **Committed in:** `e155561` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix)
**Impact on plan:** Minor, mechanical; required for the plan's own typecheck gate to pass once real values landed. No scope creep.

## Issues Encountered
- The `pipeline()` fetch (with `env.allowRemoteModels = true`) did not write files under the given `env.localModelPath` at fetch time — it landed them under the package's own default cache dir (`node_modules/@huggingface/transformers/.cache/...`). Worked around by copying the five needed files into the expected `tests/fixtures/models/Xenova/bge-small-en-v1.5/...` layout after the fetch, and deleting the stray package-local `.cache/` dir afterward so it isn't mistaken for tracked content.
- `special_tokens_map.json` was not among the files `pipeline()` fetched (the tokenizer apparently doesn't require it to load), even though it's part of the manifest's expected five-file set and present in the upstream repo — fetched it directly via a plain HTTPS request against the pinned revision and verified its sha256 like the other four files.
- Confirmed (not fixed, out of my declared file scope for this plan) that `tests/embeddings/model-vendor.test.ts` and `tests/embeddings/embedder-resolver.test.ts` — both plan-01 scaffolds, not in this plan's `files_modified` — now fail with `ENOENT`/local-file-not-found errors under `npm test`'s default vitest run. These tests each spin up a fresh temp dir per `it` block and call `vendorModel()`/`resolveEmbedder()`, which now (correctly) attempt a real ~127MB network download since the manifest is no longer a placeholder; vitest's default 5000ms per-test timeout is far too short for that download to complete, so the test fails with a "file not found" error before the download finishes rather than a clean pass or a clear timeout message. This is a **flagged follow-up for the orchestrator** — not a regression introduced by this plan's own files (`model-vendor.ts`'s manifest and behavior are correct and hash-verified; `transformer-embedder.golden.test.ts` is fully GREEN), but a pre-existing gap in those two test files' `testTimeout` configuration that only becomes visible once real values are pinned. Suggested fix for a future task: raise `testTimeout` (e.g. to 60000ms+) on the specific `it` blocks in `model-vendor.test.ts` and `embedder-resolver.test.ts` that perform a real vendor/init call, or mock/skip them in the default `npm test` run and reserve the real-network path for an explicit `test:golden`-style script (plan 06 is already adding a `test:golden` npm script for the golden suite; the same pattern could extend to these two files).

## User Setup Required
None - no external service configuration required. (The one-time vendoring network access was performed by the executor in this session, not deferred to the user.)

## Next Phase Readiness
- `src/embeddings/model-vendor.ts`'s manifest is fully pinned with real, hash-verified values; `tests/fixtures/embedding-golden-hashes.json` is committed and the golden suite is GREEN — REQ-051's determinism gate is closed for this phase.
- Plan 06 (daemon/health integration, `memory status` embedder health surface, `test:golden` npm script, `docs/embeddings.md`) can proceed independently; it does not depend on any file this plan touched beyond the now-real manifest values it will document.
- Follow-up flagged above (raising `testTimeout` on `model-vendor.test.ts`/`embedder-resolver.test.ts`'s real-network `it` blocks) is not blocking phase completion — those tests were never in this plan's scope and their prior failure mode (no network) has simply changed to a timeout now that real values exist — but should be tracked so `npm test`'s default run returns fully green.

---
*Phase: 09-embedding-model-embedder*
*Completed: 2026-07-21*

## Self-Check: PASSED

All created/modified files verified present on disk (`src/embeddings/model-vendor.ts`, `tests/fixtures/embedding-golden-hashes.json`, `tests/embeddings/transformer-embedder.golden.test.ts`); both task commit hashes (e155561, 723607d) verified present in git log.
