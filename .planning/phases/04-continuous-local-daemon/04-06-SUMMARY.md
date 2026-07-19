---
phase: 04-continuous-local-daemon
plan: "06"
subsystem: imports
tags: [daemon, source-grants, atomic-import, canonical-events, quarantine]
requires:
  - phase: 04-continuous-local-daemon
    provides: Wave 0 approved-source contracts and Wave 1 atomic daemon storage
  - phase: 03-source-lifecycle-control-plane
    provides: durable approval, revocation, immutable scopes, and parser quarantine
provides:
  - Exact-pair approved-source dispatch with no background approval mutation
  - Incremental atomic batch import for Codex, Claude Code, OpenClaw, and Hermes
  - Changed-only receipts with durable asynchronous contraction jobs
affects: [04-07-daemon-scheduler, 04-09-daemon-loop, phase-05-mcp]
tech-stack:
  added: []
  patterns: [durable-grant authority, isolated staging before atomic commit, changed-only canonical receipts]
key-files:
  created:
    - src/daemon/approved-source-runner.ts
  modified:
    - src/imports/codex-importer.ts
    - src/imports/claude-importer.ts
    - src/imports/openclaw-importer.ts
    - src/imports/hermes-importer.ts
key-decisions:
  - "Command-layer candidate verification remains unchanged; daemon batch methods trust only the already-asserted exact durable grant and never rediscover or mutate approval."
  - "Importers stage bounded source parsing locally, then publish canonical events, compatibility turns, quarantine changes, checkpoint, receipt, and contraction job through one exact-grant store commit."
  - "Receipts and jobs contain only new or materially changed canonical events; no-op replay commits checkpoint state with empty changed ranges."
patterns-established:
  - "Every daemon source open is preceded by SourceLifecycleService.assertApproved and every commit compare-checks the same grant id, person, candidate, and updatedAt version."
  - "Native sources remain read-only and source scanning returns after durable job enqueue without running contraction or proposal generation."
requirements-completed: [REQ-017, REQ-019]
coverage:
  - id: D1
    description: "All four exact approved application and format pairs import incrementally with stable changed-only receipts, partial-record safety, rotation handling, Hermes high-water marks, redaction, and no native-store mutation."
    requirement: REQ-019
    verification:
      - kind: integration
        ref: "tests/daemon/source-runner.test.ts#ApprovedSourceRunner"
        status: pass
      - kind: integration
        ref: "npx vitest run tests/daemon/source-runner.test.ts tests/imports/codex-history.test.ts tests/imports/multi-source-history.test.ts tests/imports/universal-import-bootstrap.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "ApprovedSourceRunner fails closed before source access or atomic commit across unsupported formats, revocation, person, candidate, scope, and grant-version boundaries without calling approve."
    requirement: REQ-017
    verification:
      - kind: integration
        ref: "tests/daemon/source-runner.test.ts#checks approval before opening and again inside the atomic commit"
        status: pass
      - kind: integration
        ref: "tests/daemon/source-runner.test.ts#dispatches all four exact durable grant pairs without ever reapproving"
        status: pass
    human_judgment: false
duration: 12min
completed: 2026-07-17
status: complete
---

# Phase 4 Plan 6: Approved Source Runner Summary

**Exact durable grants now drive incremental read-only imports for all four native history formats, with changed-only receipts and contraction jobs committed atomically before source scans return.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-17T19:45:00Z
- **Completed:** 2026-07-17T19:56:57Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Added daemon batch methods to Codex, Claude Code, OpenClaw, and Hermes importers while preserving their explicit command APIs and candidate-verification behavior.
- Added exact application/format dispatch that asserts approval before opening a locator, never calls approval mutation, isolates individual source failures, and revalidates the exact grant version inside the atomic store commit.
- Made incremental checkpoints, bounded redacted quarantine changes, canonical records, person-thread compatibility turns, changed-only receipts, and contraction jobs one durable batch boundary.
- Kept contraction and proposal work asynchronous; the approved-source runner returns immediately after the import/job commit.

## Task Commits

Git commits are unavailable because this execution environment cannot create the Git index lock. No staging or repeated commit attempt was made.

1. **Task 1: Add bounded atomic importer batch sinks** - unavailable (read-only Git index lock)
2. **Task 2: Dispatch exact approved grants without approval mutation** - unavailable (read-only Git index lock)

**Plan metadata:** unavailable (read-only Git index lock)

## Files Created/Modified

- `src/daemon/approved-source-runner.ts` - Exact grant dispatch, controlled outcomes, source failure isolation, and approval-free batch execution.
- `src/imports/codex-importer.ts` - Codex durable-grant batch entrypoint plus shared staged atomic-commit translation.
- `src/imports/claude-importer.ts` - Claude Code durable-grant batch entrypoint.
- `src/imports/openclaw-importer.ts` - OpenClaw durable-grant batch entrypoint.
- `src/imports/hermes-importer.ts` - Hermes durable-grant batch entrypoint with incremental row high-water state.

## Decisions Made

- Used an isolated in-memory staging store to reuse the established MemoryService identity, redaction, parser, checkpoint, and quarantine rules without exposing partially parsed records to the authoritative store.
- Seeded only the approved candidate's existing sources, checkpoints, and quarantine records into staging so repeated scans remain incremental while all source-derived publication still occurs through `commitImportBatch`.
- Kept unsupported exact pairs and absent or revoked grants as controlled privacy-safe categories; arbitrary thrown text is never included in runner outcomes.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The first temporarily-absent-source run produced the generic category because an empty discovery set becomes a controlled “no import checkpoint” error rather than a direct filesystem `ENOENT`. The error classifier now maps both forms to `temporarily_absent`; the focused contract passes.
- Full-project `npm run typecheck` remains blocked only by Wave 0 imports for production modules assigned to Plans 04-07 through 04-09. The 04-06 implementation is exercised successfully through Vitest's TypeScript transform and all focused import/runner tests.
- Atomic task and metadata commits could not be created because the Git index lock is read-only.

## TDD Gate Compliance

- **RED:** Supplied by Plan 04-02; the approved-source suite failed on the absent production runner.
- **GREEN:** PASS - 24/24 focused source-runner and importer tests pass.
- **REFACTOR:** The shared staged-commit path removed four copies of atomic publication logic while preserving importer-specific parsing.
- **Commits:** Unavailable because the Git index lock cannot be written.

## User Setup Required

None - no network, external model, real history, or live operating-system service is required.

## Next Phase Readiness

- Plans 04-07 and 04-09 can schedule `runGrant(personId, candidateId)` as the single approved source execution boundary.
- Durable changed ranges are ready for Plan 04-08's incremental contraction runner.
- Full typecheck should be rerun after the remaining planned daemon modules exist.

## Self-Check: PASSED

- FOUND: `src/daemon/approved-source-runner.ts`
- FOUND: all four importer batch entrypoints.
- PASS: 24/24 focused daemon/importer tests.
- PASS: approval spies record no mutation; revocation before open and at commit writes no canonical event or checkpoint.
- PASS: synthetic native fixture hashes remain byte-identical after all-source execution.
- PASS: no source scan invokes contraction or proposal generation.
- EXPECTED PHASE-IN-PROGRESS BLOCKER: full typecheck references not-yet-implemented Plans 04-07 through 04-09 modules.

---
*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-17*
