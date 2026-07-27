---
phase: 11-derivation-input-hygiene
plan: 17
subsystem: operations
tags: [cli, operator-command, prune, dry-run, backup-gate, gap-closure]

# Dependency graph
requires:
  - phase: 11-derivation-input-hygiene
    provides: "commitUnhygienicAnchorPrune / listAnchorIds / summarizeAnchorDerivationClasses (Plan 11-16) — the store surface this command wraps"
  - phase: 11-derivation-input-hygiene
    provides: "prune-superseded-command.ts (Plan 11-12) — the exact shape mirrored: OptionsSchema, Deps, verifyBackup, parseArgs, main(argv), entrypoint guard"
provides:
  - "memory prune-unhygienic-anchors (REQ-052/053/054, GAP-11-D operator-command closure): dry-run default, fail-closed --confirm-backup gate, resumable batch loop over a person-scoped anchor-id cursor"
affects: ["11-18 (owner-authorized live anchor prune against ~/.memory/aaron.db is now unblocked)", "11-13/11-14 (SC7 sign-off can proceed once 11-18 lands)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Command mirrors prune-superseded-command.ts structure end to end: strict zod OptionsSchema, Deps with onBatchComplete?/progressSink?, DEFAULT_BATCH_SIZE=500/MAX_BATCH_SIZE=1000, statSync-based verifyBackup, fail-loud getPerson check before any branch, try/finally store.close(), --flag value and --flag=value parseArgs, JSON main(argv), import.meta.url entrypoint guard"
    - "Dry-run calls summarizeAnchorDerivationClasses directly (no page loop) since anchors carry no reference-protection class to pre-scan, unlike prune-superseded's referencedSkipCount computation"
    - "Apply also calls summarizeAnchorDerivationClasses once before the loop (cheap aggregate) purely for reporting context; the loop's own accounting (prunedCount/prunedByClass/skippedByReason/freedPayloadBytes) is independent and authoritative"
    - "listAnchorIds is inherently person-scoped, so the apply loop structurally cannot visit a second person's rows; person_mismatch/person_unattributed remain live store-level refusal paths the command's own cursor never exercises"

key-files:
  created:
    - src/operations/prune-unhygienic-anchors-command.ts
    - tests/operations/prune-unhygienic-anchors-command.test.ts
  modified:
    - src/cli/command-registry.ts

key-decisions:
  - "Case (h)'s idempotence corpus is entirely tool_activity/synthetic_injected (no conversational anchors), so after the first apply the person has zero remaining anchors and the second run's listAnchorIds returns an empty page immediately — zero commit calls, proven by a spy. A mixed corpus would still make commit calls on the second run (retained_conversational anchors get re-paged every time), which is expected and separately covered by case (f)."
  - "The apply path calls summarizeAnchorDerivationClasses once up front purely for informational totalCount/countsByClass reporting; it is never used to gate or bound the page loop, which terminates only on an empty listAnchorIds page (T-11-68)."

requirements-completed: [REQ-052, REQ-053, REQ-054]

# Metrics
duration: ~20min
completed: 2026-07-27
---

# Phase 11 Plan 17: Prune Unhygienic Anchors Operator Command (GAP-11-D Operator-Command Closure) Summary

**Built `memory prune-unhygienic-anchors` wrapping Plan 11-16's store methods exactly the way `memory prune-superseded` wraps `commitSupersededSummaryPrune` — dry-run default, fail-closed `--confirm-backup` gate, resumable person-scoped batch loop — so the live prune of 25,792+ (floor) unhygienic anchors in Plan 11-18 is a reviewed, previewable invocation rather than an ad-hoc script.**

## Performance

- **Duration:** ~20 min (two atomic task commits)
- **Tasks:** 2
- **Files modified:** 3 (2 created, 1 modified)
- **Test suite:** 995 passed, 4 skipped, 1 unrelated pre-existing flake (110 files) under full-suite load — see Deviations
- **New tests:** 10, all green, one case per `<behavior>` bullet (a)-(j)

## Accomplishments

- `src/operations/prune-unhygienic-anchors-command.ts` implements `runPruneUnhygienicAnchorsCommand(options, deps)` and `main(argv)`, mirroring `prune-superseded-command.ts` structurally: a `.strict()` zod `OptionsSchema` (`databasePath`, `personId`, `apply?`, `confirmBackupPath?`, `batchSize?`), `DEFAULT_BATCH_SIZE=500`/`MAX_BATCH_SIZE=1000`, `verifyBackup` via `statSync` (exists/`isFile()`/`size>0`), a fail-loud `getPerson` check before any branch, `try { ... } finally { store.close() }`, `parseArgs` supporting `--flag value` and `--flag=value`, and an `import.meta.url === pathToFileURL(process.argv[1]).href` entrypoint guard. Dry-run calls `summarizeAnchorDerivationClasses` and returns its counts directly — no page loop needed for reporting, since an anchor has no reference-protection class (ADR 0051). `--apply` requires a verified `--confirm-backup <path>` before the loop can run; the loop pages `listAnchorIds(personId, ...)` ascending, hands each page to `commitUnhygienicAnchorPrune`, accumulates `prunedCount`/`prunedByClass`/`freedPayloadBytes`/`skippedByReason`, advances the cursor to the highest id in the page regardless of skips, emits one JSON progress line per batch, and awaits `deps.onBatchComplete`. Owns no deletion SQL — every removal goes through `commitUnhygienicAnchorPrune`.
- `tests/operations/prune-unhygienic-anchors-command.test.ts` drives a real temp-file `SqliteStore` across ten cases (a)-(j): dry-run byte-identical snapshot; `--apply` without `--confirm-backup` refuses naming the flag; nonexistent and empty backup files each refuse; a valid backup prunes exactly the tool_activity+synthetic_injected anchors with control-entity (canonical events, turns, summaries, boxes, traces, proposals, injections) before/after equality; `retained_conversational` appears in `skippedByReason` while a second person's anchors survive untouched (proving the person-scoped cursor never visits them); an interrupted run (kill after batch 2) resumes to the same end state as an uninterrupted twin run; a second run over an all-unhygienic corpus makes zero `commitUnhygienicAnchorPrune` calls (spy-asserted); an unknown person fails loud in both dry-run and apply modes; and per-batch progress lines are monotonically non-decreasing. No test opens a real database or backup path — `grep -c "aaron.db\|\.memory/"` on the test file is 0.
- `src/cli/command-registry.ts` registers `"prune-unhygienic-anchors": () => import("../operations/prune-unhygienic-anchors-command.js")` beside `"prune-superseded"`, keeping the closed static allow-list's invariant that only existing modules are referenced.

## Task Commits

1. **Task 1: RED command suite** - `4b2ff5c` (test)
2. **Task 2: Implement the command and register it** - `91171ba` (feat)

## Files Created/Modified

- `src/operations/prune-unhygienic-anchors-command.ts` (new) — the `memory prune-unhygienic-anchors` command: dry-run default, fail-closed backup gate, resumable apply loop, `main(argv)` entrypoint.
- `tests/operations/prune-unhygienic-anchors-command.test.ts` (new) — ten-case suite over a real `SqliteStore` in a `mkdtemp` directory.
- `src/cli/command-registry.ts` — adds the `prune-unhygienic-anchors` entry to the closed CLI allow-list.

## Decisions Made

See `key-decisions` in frontmatter above.

## Deviations from Plan

None affecting scope, architecture, or acceptance criteria. One unrelated pre-existing flake observed and documented, not fixed (out of this task's scope):

### Deferred (out of scope, not auto-fixed)

**1. `tests/mcp/mutation-tools.test.ts` "05-04 Task 2 rolls back every durable effect at each injected transaction boundary" times out under full-suite load**
- **Found during:** Task 2's `npx vitest run` full-suite verify step, reproduced on two consecutive runs (995 passed / 1 failed / 4 skipped both times).
- **Isolated run is green:** `npx vitest run tests/mcp/mutation-tools.test.ts -t "05-04 Task 2 ..."` passes in 347ms standalone.
- **Why out of scope:** the file was last touched by Plan 05-04 (commit `e969499`), long before Phase 11; this plan touches only `src/operations/prune-unhygienic-anchors-command.ts`, its test file, and `src/cli/command-registry.ts`, none of which the failing test exercises. A timing flake under 111-file parallel CPU contention (5000ms default timeout), not a regression introduced by this plan — per the executor's scope-boundary rule, out-of-scope failures are logged, not fixed.
- **Logged in:** `.planning/phases/11-derivation-input-hygiene/deferred-items.md`.

**Total deviations:** 0 auto-fixed; 1 pre-existing flake logged and deferred.
**Impact on plan:** None. No plan code, contract shape, or acceptance criterion changed.

## Issues Encountered

None beyond the deferred flake documented above.

## User Setup Required

None. No schema migration, no new configuration, no external service. This plan touches no live database — every test seeds and tears down its own temp-file `SqliteStore`; nothing in this plan reads, writes, or connects to `~/.memory/aaron.db` or any path derived from `MEMORY_DB`.

## Next Phase Readiness

- `memory prune-unhygienic-anchors` is registered in the closed CLI allow-list and runs end to end via `npx tsx src/cli/bin.ts prune-unhygienic-anchors` (verified: exits non-zero naming the missing `--db` flag).
- Dry-run default and fail-closed backup gate are both proven by cases (a)-(d); resumability and idempotence by cases (g)-(h).
- Plan 11-18 (owner-authorized live anchor prune against `~/.memory/aaron.db`) is now unblocked — it has a reviewed, dry-runnable, backup-gated command to invoke rather than an ad-hoc script.
- `npx vitest run` (110 files, 995 passed, 4 skipped, 1 unrelated pre-existing flake documented above) and `npm run typecheck` are green.
- No blockers for Plan 11-18 from this plan's work.

## Self-Check: PASSED

Both claimed created files found on disk (`src/operations/prune-unhygienic-anchors-command.ts`, `tests/operations/prune-unhygienic-anchors-command.test.ts`); the modified file (`src/cli/command-registry.ts`) contains `"prune-unhygienic-anchors"`; both claimed commit hashes (`4b2ff5c`, `91171ba`) found in `git log --oneline`.

---
*Phase: 11-derivation-input-hygiene*
*Completed: 2026-07-27*
