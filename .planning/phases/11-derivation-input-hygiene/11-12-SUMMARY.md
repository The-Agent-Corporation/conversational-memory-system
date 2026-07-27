---
phase: 11-derivation-input-hygiene
plan: 12
subsystem: operations
tags: [cli, prune, deletion, gap-closure, resumable, backup-gate]

# Dependency graph
requires:
  - phase: 11-derivation-input-hygiene
    provides: "commitSupersededSummaryPrune / listSupersededSummaryIds / summarizeSupersededSummaries (Plan 11-11) — the only sanctioned removal path this command wraps"
  - phase: 11-derivation-input-hygiene
    provides: "the resumable/checkpointed command shape established by memory rebuild-derivations (Plan 11-05)"
provides:
  - "memory prune-superseded CLI command (REQ-052/053/054, GAP-11-A closure): dry-run default, fail-closed backup gate, resumable/idempotent batched prune loop"
  - "ADR 0050 recording the prune-vs-archive decision, the safety contract, and the revival/rebuild interactions"
affects: ["11-13 (the live prune against the owner's 87,727-summary corpus, gated on explicit authorization)", "11-14"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dry-run default with a read-only reference-set scan for reporting only (never authorizing deletion) — computeReferencedSummaryIds loads boxes/traces/proposals/summaries once and intersects against the paged superseded-id cursor purely to report referencedSkipCount; the actual eligibility recompute lives entirely inside commitSupersededSummaryPrune's own transaction"
    - "Fail-closed backup gate: statSync exists/isFile/size>0, all three checked before any --apply code path can reach the prune loop"
    - "Id-cursor resumability with no checkpoint table: the cursor advances to the highest id in each page regardless of skips (so a reference-protected row can never wedge the loop), and each page re-queries live state so an interrupted run simply resumes"

key-files:
  created:
    - src/operations/prune-superseded-command.ts
    - tests/operations/prune-superseded-command.test.ts
    - docs/adr/0050-pruning-superseded-derivations.md
  modified:
    - src/cli/command-registry.ts

key-decisions:
  - "Prune, not archive (ADR 0050): superseded summaries are pure derivations fully reproducible from the immutable canonical timeline via memory rebuild-derivations, so an archive table would duplicate the exact pre-hygiene text REQ-053 removes while doubling the person/scope-isolation surface."
  - "referencedSkipCount in dry-run mode is computed by the command itself via a read-only scan (listBoxes/listTraces/listProposals/listSummaries), not by the store — this is reporting only and never used to decide what gets deleted; the store's own transaction remains the sole deletion authority."
  - "The cursor always advances to the highest id in the current page, whether or not every id in that page was actually pruned — this is what makes both resumability (T-11-44) and DoS-safety against a wedged referenced row (T-11-43) hold with a single mechanism."

requirements-completed: [REQ-052, REQ-053, REQ-054]

# Metrics
duration: ~20min
completed: 2026-07-27
---

# Phase 11 Plan 12: `memory prune-superseded` Command Summary

**Built `memory prune-superseded` (REQ-052/053/054, GAP-11-A closure): a dry-run-by-default, backup-gated, resumable/idempotent operator command wrapping Plan 11-11's `commitSupersededSummaryPrune` — the command that will eventually remove the live corpus's 87,727 superseded rows (~155 MB) — plus ADR 0050 recording the prune-vs-archive decision and its revival/rebuild interactions.**

## Performance

- **Duration:** ~20 min (three atomic task commits)
- **Tasks:** 3
- **Files modified:** 4 (3 created, 1 modified)
- **Test suite:** 935 passed, 4 skipped (106 files passed, 1 skipped) — full unmodified regression green
- **New tests:** 10, all green (cases a-j from the plan's task 1 spec)

## Accomplishments

- `tests/operations/prune-superseded-command.test.ts` seeds a 300-superseded/50-active/5-stale mixed corpus (10 superseded summaries carrying vectors, 5 referenced by a box, 5 referenced by an approved trace, 5 with injections) plus canonical-event/turn/anchor control counts against a real `SqliteStore` in a `mkdtemp` dir. Ten cases: dry-run default with a full-snapshot equality assertion, apply-without-`--confirm-backup` refusal (naming the flag), apply-with-nonexistent/-empty-backup refusal, apply prunes with control-count and referenced/active/stale preservation assertions, referenced-summary `skippedByReason` reporting, interrupted-vs-uninterrupted resumability equality, idempotent second run with a zero-call `commitSupersededSummaryPrune` spy, stale-never-a-candidate across both dry-run and apply, fail-loud on an unknown person, and monotonic per-batch progress lines.
- `src/operations/prune-superseded-command.ts` implements `runPruneSupersededCommand`/`main` mirroring `rebuild-derivations-command.ts`'s shape (zod `.strict()` options, `onBatchComplete`/`progressSink` deps, `try/finally { store.close() }`, `parseArgs`, `import.meta.url` entrypoint). Dry-run (default) calls `summarizeSupersededSummaries` plus a read-only `computeReferencedSummaryIds` scan for reporting only. `--apply` requires `--confirm-backup <path>`, gated by `statSync` (exists / is a regular file / size > 0) before any deletion path is reachable. The prune loop pages `listSupersededSummaryIds` and commits each page through `commitSupersededSummaryPrune` — the command owns zero deletion SQL (`grep -c "delete from\|deleteIds(" src/operations/prune-superseded-command.ts` returns 0) — accumulating `prunedCount`/`deletedVectorRows`/`deletedInjectionIds`/`freedPayloadBytes`/`skippedByReason`, advancing the cursor to the highest id in each page regardless of skips.
- Registered `"prune-superseded": () => import("../operations/prune-superseded-command.js")` in `src/cli/command-registry.ts`'s closed static allow-list, next to `rebuild-derivations`.
- `docs/adr/0050-pruning-superseded-derivations.md` records the prune-vs-archive decision and justification, the five-part safety contract, explicit "Revival" and "Rebuild" interaction sections, and a "Recovery" section naming the `~/.memory/aaron.db.pre-phase11` retention condition and the `rebuild-derivations` recovery path.

## Task Commits

1. **Task 1: RED command tests** - `26de1b7` (test)
2. **Task 2: Implement `memory prune-superseded`** - `f2a5178` (feat) — includes the `commit-to-subrepo`-scoped registry edit and a Rule 3 fix to the Task 1 test file's `CanonicalEvent` import
3. **Task 3: ADR 0050** - `01165d7` (docs)

## Files Created/Modified

- `src/operations/prune-superseded-command.ts` (new) - `runPruneSupersededCommand`/`main`, dry-run reporting, fail-closed backup gate, resumable/idempotent batched prune loop.
- `tests/operations/prune-superseded-command.test.ts` (new) - Ten-case integration suite over a real `SqliteStore`.
- `docs/adr/0050-pruning-superseded-derivations.md` (new) - The prune-vs-archive decision, safety contract, revival/rebuild interactions, recovery story.
- `src/cli/command-registry.ts` - Adds the `"prune-superseded"` entry.

## Decisions Made

See `key-decisions` in frontmatter above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] Corrected `CanonicalEvent` import path in the Task 1 test file**
- **Found during:** Task 2, running `npm run typecheck` after implementing the command
- **Issue:** The RED test file imported `CanonicalEvent` from `../../src/domain/types.js`, but `CanonicalEvent` is exported from `../../src/domain/canonical.js` (the schemas module split noted in `CLAUDE.md`'s architecture map: `canonical.ts` is the canonical-event spine, `types.ts` holds the derived objects). `tsc --noEmit` failed with `TS2305: Module has no exported member 'CanonicalEvent'`.
- **Fix:** Split the import into `import type { CanonicalEvent } from "../../src/domain/canonical.js";` and the existing `types.js` import for the remaining types.
- **Files modified:** `tests/operations/prune-superseded-command.test.ts`
- **Verification:** `npm run typecheck` clean; full `npx vitest run` still green (935 passed, 4 skipped).
- **Committed in:** `f2a5178` (part of Task 2's commit, since the test file was already committed under Task 1 and this is a follow-on blocking fix discovered while implementing Task 2)

---

**Total deviations:** 1 auto-fixed (Rule 3 — an import-path typo caught by the type checker, not a defect in the command implementation or test logic itself).
**Impact on plan:** None beyond the import fix — no scope change, no new behavior added beyond what the plan specified. All ten RED cases passed on the first implementation attempt with no test-logic changes needed.

## Issues Encountered

None beyond the import-path fix documented above.

## User Setup Required

None. No schema migration, no new configuration, no external service. This plan builds machinery only — nothing in this plan reads, writes, or connects to `~/.memory/aaron.db` or any path derived from `MEMORY_DB`; every test seeds and tears down its own temp-file `SqliteStore`, and every backup-gate test uses a scratch file written to a `mkdtemp` directory, never a real database backup.

## Next Phase Readiness

- `memory prune-superseded` is ready for Plan 11-13's live-corpus prune, gated on the owner's explicit authorization and an already-verified backup path.
- The command's dry-run output (`candidateCount`, `estimatedBytes`, `referencedSkipCount`) can be run against the live 4.6 GB database first, with zero risk, to preview the real 87,727-row / ~155 MB deletion before Plan 11-13 ever passes `--apply`.
- `npx vitest run` (106 files, 935 tests, 4 skipped) and `npm run typecheck` are both green with no new warnings.
- No blockers for Plan 11-13 or 11-14.

## Self-Check: PASSED

All 4 claimed created/modified files found on disk; all 3 claimed commit hashes (`26de1b7`, `f2a5178`, `01165d7`) found in `git log --oneline`.

---
*Phase: 11-derivation-input-hygiene*
*Completed: 2026-07-27*
