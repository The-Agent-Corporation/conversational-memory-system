---
phase: 09-embedding-model-embedder
plan: 06
subsystem: embeddings
tags: [embeddings, health, status, daemon, docs, ci]

# Dependency graph
requires:
  - phase: 09-embedding-model-embedder
    provides: "plan 04's probeEmbedderHealth(databasePath): non-throwing EmbedderHealth probe"
provides:
  - "embedder: EmbedderHealth field on MemoryStatusCommandResult, surfaced via memory status/health"
  - "npm run test:golden — the documented local phase gate for the real-model golden suite"
  - "docs/embeddings.md — operator + CI documentation for enable/disable, offline guarantee, determinism, golden gate, CI-cache snippet"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "status-command.ts consumes only the non-throwing probeEmbedderHealth, never the throwing resolveEmbedder, keeping the health surface crash-proof per D-06"
    - "docs/embeddings.md documents a ready-to-enable GitHub Actions actions/cache snippet since this repo has no .github/workflows/ yet — the local npm run test:golden is the actual gate today"

key-files:
  created:
    - tests/bootstrap/status-embedder-health.test.ts
    - docs/embeddings.md
  modified:
    - src/bootstrap/status-command.ts
    - package.json

key-decisions:
  - "The npm test full-suite run still shows the same 20 pre-existing real-model-dependent failures documented in plan 04's summary (1 in embedder-resolver.test.ts, 2 in model-vendor.test.ts, 17 in transformer-embedder.golden.test.ts) — no network/vendored model available in this environment. This plan's own new tests (status-embedder-health.test.ts) are fully green without a real model, since the enabled-broken case only needs a config sidecar pointing at a nonexistent model directory."

patterns-established: []

requirements-completed: [REQ-044]

# Metrics
duration: 20min
completed: 2026-07-21
---

# Phase 9 Plan 06: Embedder Health on Status/Health + Golden Gate + Docs Summary

**Surfaced embedder health (provider/model/revision/enabled/healthy/reason) on `memory status` via the non-throwing `probeEmbedderHealth`, added the `npm run test:golden` local phase gate, and wrote `docs/embeddings.md` covering enable/disable, the offline guarantee, the determinism contract, and a ready-to-enable CI-cache snippet.**

## Performance

- **Duration:** 20 min
- **Tasks:** 2
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments
- `MemoryStatusCommandResult` gains an `embedder: EmbedderHealth` field; `runMemoryStatusCommand` calls `probeEmbedderHealth(parsed.databasePath)` in its existing `Promise.all` batch and includes it in the returned object — no `resolveEmbedder` (the throwing resolver) anywhere in the health path (`grep -c "resolveEmbedder" src/bootstrap/status-command.ts` == 0).
- New `tests/bootstrap/status-embedder-health.test.ts` covers both required cases: a fresh db with no embeddings config resolves `enabled:false, healthy:true, reason:null`; an `enabled:true` config pointed at a nonexistent model directory resolves `healthy:false` with a non-null string `reason`, and `runMemoryStatusCommand` itself **resolves** rather than rejecting — proving the D-06 "daemon skip + unhealthy, everything else keeps running" contract at the status-command boundary.
- `package.json` gained `test:golden` (`MEMORY_MODEL_PATH=./tests/fixtures/models vitest run tests/embeddings/transformer-embedder.golden.test.ts`, `vitest run` not watch mode) — only the scripts block was touched, no dependency changes.
- `docs/embeddings.md` (187 lines) documents: enable/disable/show CLI usage and the vendor-then-persist sequencing; the offline guarantee (`allowRemoteModels` false everywhere except the one-shot `enable` command; daemon/MCP never touch the network); the D-05/D-06 enabled-but-broken split (`resolveEmbedder` hard-errors vs. `probeEmbedderHealth` never throws) and the `memory status` embedder block shape; the D-07 determinism contract (pinned fp32/CLS-pooling/session-options, quantized cross-arch hash + exact same-machine byte-hash); the local `npm run test:golden` gate (no CI exists in this repo); and a ready-to-enable GitHub Actions `actions/cache` snippet keyed on the pinned model revision for D-08.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add embedder health block to the status/health command** - `a0aa49b` (feat)
2. **Task 2: Golden-run npm gate + operator/CI documentation** - `03ab0f4` (docs)

## Files Created/Modified
- `src/bootstrap/status-command.ts` - added `embedder: EmbedderHealth` field + `probeEmbedderHealth` call in `runMemoryStatusCommand`'s existing parallel read batch
- `tests/bootstrap/status-embedder-health.test.ts` - new: disabled-default and enabled-broken (never-throwing) coverage
- `package.json` - added `test:golden` script (scripts block only)
- `docs/embeddings.md` - new: operator + CI documentation

## Decisions Made
- Reused `probeEmbedderHealth`'s existing signature (`databasePath` only) directly inside the status command's `Promise.all` batch rather than threading it through as a separate sequential await, keeping the existing parallel-read performance characteristics of `runMemoryStatusCommand` intact.
- The enabled-broken test case constructs the broken state via `writeEmbeddingsConfig` pointing `modelPath` at a directory that was never vendored, rather than depending on a real (missing, in this environment) vendored model — this keeps the test's RED/GREEN status independent of network/model availability, consistent with how `probeEmbedderHealth` itself is designed to be exercised without a real model per plan 04's precedent.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- `node_modules` was empty at session start; ran `npm ci` first per the parallel-execution notice. No packages were added or modified.
- Full `npm test` run shows the same 20 real-model-dependent failures documented in plan 04's summary (`embedder-resolver.test.ts` x1, `model-vendor.test.ts` x2, `transformer-embedder.golden.test.ts` x17) — no network/vendored model in this environment. This plan's own new test file is unaffected and fully green (2/2 tests pass). `npm run typecheck` exits 0.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `memory status`/health now exposes embedder provider/model/revision/enabled/healthy/reason; the daemon (out of scope here, per plan objective — Phase 11) can consume the same `probeEmbedderHealth` for its own skip-and-mark-unhealthy tick behavior without any further changes to this plan's files.
- `npm run test:golden` and `docs/embeddings.md` are in place as the repeatable local phase gate ahead of `/gsd:verify-work` for this phase.

---
*Phase: 09-embedding-model-embedder*
*Completed: 2026-07-21*

## Self-Check: PASSED

All created/modified files verified present on disk (`src/bootstrap/status-command.ts`, `tests/bootstrap/status-embedder-health.test.ts`, `package.json`, `docs/embeddings.md`); both task commit hashes (a0aa49b, 03ab0f4) verified present in `git log`.
