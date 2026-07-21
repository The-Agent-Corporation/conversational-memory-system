---
phase: 10-embedding-backfill
plan: 03
subsystem: operations
tags: [cli, embeddings, backfill, resumability, sqlite]

# Dependency graph
requires:
  - phase: 10-embedding-backfill plan 01
    provides: "MemoryStore.saveSummaryVectors(records[]) transactional batch write"
  - phase: 09-embedding-model-embedder
    provides: "resolveEmbedder(databasePath) D-05 hard-error contract; Embedder.embed()"
  - phase: 08-vector-storage-foundation
    provides: "listSummaryIdsMissingVector(provider, model) resume-key query; SummaryVectorRecord shape"
provides:
  - "memory backfill-embeddings CLI command: resolveEmbedder -> missing set -> batch embed+save -> stdout progress"
  - "runBackfillEmbeddingsCommand(options, deps?) with injectable onBatchComplete/progressSink for testing"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "resolveEmbedder called exactly once per run; its provider/model instance drives both the missing-set query and every written record — never re-resolved mid-loop, never hardcoded"
    - "Missing-set-as-checkpoint: listSummaryIdsMissingVector queried once at start is both the resume key and the total-for-progress denominator; no separate checkpoint table"
    - "Per-batch transactional commit (Plan 01's saveSummaryVectors) is the atomicity unit — a mid-batch kill leaves the store's own resume-key query as the source of truth on restart"

key-files:
  created:
    - src/operations/backfill-embeddings-command.ts
    - tests/operations/backfill-embeddings-command.test.ts
  modified:
    - src/cli/command-registry.ts

key-decisions:
  - "A summary missing personId throws (fail loud) rather than substituting an 'unscoped' sentinel or the caller's own personId, since T-10-05 requires zero cross-scope leakage risk from mis-tagging."
  - "A summary id present in the missing-set query but absent from the in-memory id->Summary map (removed between query and processing) is skipped defensively rather than thrown, matching the plan's explicit non-throwing case for that specific race."
  - "batchSize is an optional constructor option (default 500) rather than hardcoded, letting the test suite exercise small batches (5) for the kill/resume and progress-monotonicity assertions without waiting on 500-record batches."

patterns-established:
  - "CLI commands built on resolveEmbedder + per-summary embed() + batched store writes follow the embeddings-command.ts OptionsSchema/parseArgs/main/entrypoint idiom exactly, including the process.exitCode=1 on-throw contract."

requirements-completed: [REQ-042]

# Metrics
duration: 18min
completed: 2026-07-21
---

# Phase 10 Plan 03: Backfill Embeddings Command Summary

**Built `memory backfill-embeddings`: resolves the active embedder once, queries the missing-vector resume key, and embeds+persists in transactional batches — delivering SC1 (zero-missing full run), SC2 (kill-mid-run/resume with no duplicate writes), SC3 (idempotent rerun), and SC4's live-stdout progress half, all via the missing-set-as-checkpoint pattern with no separate checkpoint table.**

## Performance

- **Duration:** 18 min
- **Started:** 2026-07-21T21:15:00Z
- **Completed:** 2026-07-21T21:33:00Z
- **Tasks:** 3 completed
- **Files modified:** 3

## Accomplishments

- `runBackfillEmbeddingsCommand(options, deps?)` in `src/operations/backfill-embeddings-command.ts`: opens a `SqliteStore`, resolves the embedder exactly once (letting D-05 hard-errors propagate uncaught), queries `listSummaryIdsMissingVector(embedder.provider, embedder.model)` once as the resume key, loads all summaries into an id→Summary map, and processes the missing ids in `batchSize` (default 500) slices — embedding each via `embedder.embed(summary.summaryText)` (never `embedQuery`), tagging each `SummaryVectorRecord` with the summary's own `personId`/`scopeIds`, committing each batch through Plan 01's transactional `saveSummaryVectors`, and emitting one JSON progress line per batch.
- Fail-loud contract: a summary with no `personId` throws immediately rather than being tagged with a sentinel or a caller-supplied override, satisfying T-10-05.
- Defensive skip contract: a missing-set id absent from the loaded summary map (removed between query and processing) is silently skipped, never throws.
- Injectable test seams: `deps.onBatchComplete` (called after each committed batch — used to simulate a mid-run kill) and `deps.progressSink` (defaults to `process.stdout.write`), matching the plan's exact interface.
- Standard `parseArgs`/`main`/entrypoint idiom mirrored from `embeddings-command.ts`, including `process.exitCode = 1` on uncaught throw.
- Registered `"backfill-embeddings"` in `src/cli/command-registry.ts`'s dispatch `REGISTRY`, dynamically importing the new module.
- 6-case integration test suite over a real seeded `SqliteStore` + `DeterministicEmbedder`: full-corpus completion (SC1), kill-mid-run via injected `onBatchComplete` throw then resume (SC2), idempotent zero-write rerun with `saveSummaryVectors`/`saveSummaryVector` spies (SC3), per-batch progress monotonicity (SC4 live half), per-person scope-tagging correctness, and missing-personId fail-loud rejection.

## Task Commits

Each task was committed atomically:

1. **Task 1: Wave 0 — SC1-SC4 backfill integration tests (RED)** - `b8367d2` (test)
2. **Task 2: Implement backfill-embeddings-command.ts** - `20ea06b` (feat)
3. **Task 3: Register backfill-embeddings subcommand** - `edef604` (feat)

**Plan metadata:** (pending — committed alongside this SUMMARY per worktree protocol)

_TDD gate sequence verified in git log: `test(10-03)` commit `b8367d2` precedes `feat(10-03)` commit `20ea06b`._

## Files Created/Modified

- `src/operations/backfill-embeddings-command.ts` - New command: resolveEmbedder-once -> missing-set query -> batched embed+save -> stdout progress; injectable `onBatchComplete`/`progressSink`; CLI `main`/entrypoint idiom
- `tests/operations/backfill-embeddings-command.test.ts` - SC1-SC4 + scope-tagging + fail-loud integration tests over a seeded `SqliteStore`
- `src/cli/command-registry.ts` - Added `"backfill-embeddings"` entry to `REGISTRY`

## Decisions Made

- A summary missing `personId` fails loud (throws) rather than tagging a sentinel value — required by T-10-05's cross-scope leakage mitigation.
- A missing-set id absent from the loaded summary map is skipped defensively (not thrown), per the plan's explicit non-throwing race-condition case.
- `batchSize` is exposed as an optional option (default 500) so tests can exercise small batches without waiting on full 500-record transactions; production callers omit it and get the plan-specified default.

## Deviations from Plan

None — plan executed exactly as written. One cosmetic adjustment during self-verification: the inline comment above the `embed()` call was reworded from "NEVER embedQuery()" to avoid the literal substring "embedQuery" appearing anywhere in the file, matching the acceptance criterion `grep -c "embedQuery" ... returns 0` literally (the comment's intent — passage embedding only, never the asymmetric query variant — is unchanged).

## Issues Encountered

- Full-suite run (`npx vitest run`) surfaced 2 pre-existing failures in `tests/mcp/stdio-server.test.ts` (`MODULE_NOT_FOUND: node_modules/tsx/dist/cli.mjs`). Confirmed pre-existing and unrelated to this plan: the file `tests/mcp/stdio-server.test.ts` was last touched in an unrelated Phase 5 baseline commit (`1e5391c`), and `node_modules/tsx/dist/cli.mjs` is absent from this worktree's `node_modules` regardless of this plan's changes. Out of scope per the deviation rules' scope boundary (no files this plan touches are involved); not fixed. All 6 new tests plus the full non-MCP suite (766 passed) are green, and `npm run typecheck` is clean.

## User Setup Required

None — no external service configuration required. The full-corpus live-DB run, kill/restart drill, and zero-write rerun against the real 135,366-summary database are manual verification steps tracked in `10-VALIDATION.md`, not a task in this plan.

## Next Phase Readiness

- REQ-042's core deliverable (`memory backfill-embeddings`) is implemented, tested, and dispatchable through the unified CLI.
- SC4's point-in-time half (a `memory status` field) is Plan 02's responsibility, not this plan's.
- No blockers for the manual full-corpus validation run described in `10-VALIDATION.md`.

---
*Phase: 10-embedding-backfill*
*Completed: 2026-07-21*

## Self-Check: PASSED

All claimed files exist and all three task commits (b8367d2, 20ea06b, edef604) are present in git log.
