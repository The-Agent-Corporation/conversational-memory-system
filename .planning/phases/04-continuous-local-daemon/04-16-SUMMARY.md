---
phase: 04-continuous-local-daemon
plan: "16"
subsystem: database
tags: [daemon, lease-authority, sqlite, atomic-commit, rollback, zod]
requires:
  - phase: 04-continuous-local-daemon
    provides: strict durable job/checkpoint producers and backend-equivalent atomic stage commits from Plans 04-05, 04-11, and 04-15
provides:
  - Strict daemon and narrow foreground write-authority schemas
  - Lease-guarded import, contraction, reconciliation, due-refresh, source-outcome, proposal, and work-outcome contracts
  - Backend-equivalent stale-token zero-mutation rejection and replacement-owner idempotent replay
  - SQLite close/reopen proof using the persisted database/token/expiry authority
affects: [04-17, 04-18, 04-19, daemon-verification]
tech-stack:
  added: []
  patterns: [authority-discriminated atomic input, injected authoritative store clock, clone-staged validation, BEGIN IMMEDIATE lease guard]
key-files:
  created: []
  modified:
    - src/daemon/types.ts
    - src/storage/memory-store.ts
    - src/storage/in-memory-store.ts
    - src/storage/sqlite-store.ts
    - tests/daemon/daemon-store.test.ts
    - src/imports/codex-importer.ts
    - src/daemon/contraction-runner.ts
    - tests/daemon/source-runner.test.ts
    - tests/daemon/contraction-runner.test.ts
key-decisions:
  - "Daemon authority is the exact databaseId/ownerToken pair; freshness is evaluated from the backend-injected clock inside the atomic critical section."
  - "Foreground compatibility is explicit and operation-scoped: approved-import for imports and historical-bootstrap for contraction/proposal publication."
  - "Scheduler and source-state atomic contracts accept only daemon authority and compare complete expected person-owned state before publication."
patterns-established:
  - "SQLite starts BEGIN IMMEDIATE, reads indexed lease owner/expiry, and rejects stale authority before its first durable mutation."
  - "InMemoryStore validates the same authority before cloning/staging and swaps live arrays only after all expected-state and ownership checks pass."
requirements-completed: [REQ-019, REQ-021, REQ-022]
coverage:
  - id: D1
    description: Every atomic daemon mutation contract requires exact explicit write authority and enforces its operation-specific branch.
    requirement: REQ-021
    verification:
      - kind: integration
        ref: "tests/daemon/daemon-store.test.ts#rejects database mismatch and forbidden foreground authority with zero mutation"
        status: pass
    human_judgment: false
  - id: D2
    description: Token turnover rejects import, contraction, reconciliation, due refresh, source outcome, proposal, and work outcome with zero mutation on both backends.
    requirement: REQ-019
    verification:
      - kind: integration
        ref: "tests/daemon/daemon-store.test.ts#rejects stale lease authority before every atomic daemon mutation and replays under the replacement owner"
        status: pass
    human_judgment: false
  - id: D3
    description: Replacement-owner replay is idempotent and persisted SQLite authority is revalidated after close and reopen.
    requirement: REQ-019
    verification:
      - kind: integration
        ref: "tests/daemon/daemon-store.test.ts#revalidates persisted SQLite lease authority after close and reopen"
        status: pass
    human_judgment: false
duration: 11min
completed: 2026-07-18
status: complete
---

# Phase 4 Plan 16: Atomic Lease Authority Summary

**Every daemon stage and scheduler-state publication now has a domain-specific atomic contract that rejects stale database/owner tokens before mutation and permits deterministic replay by the replacement owner.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-07-18T16:17:30Z
- **Completed:** 2026-07-18T16:28:23Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments

- Added a strict `WriteAuthority` union: daemon writes carry exact `databaseId` and `ownerToken`; foreground writes carry exact `personId` and one named compatibility operation.
- Added complete expected/next-state atomic contracts for approved-grant reconciliation, due-source refresh, source health/degradation/latch outcomes, proposed-only publication, and daemon work outcomes alongside guarded import and contraction.
- Made both stores consult their injected authoritative clock inside the atomic critical section and reject missing, expired, replaced, or database-mismatched daemon authority before any live/durable mutation.
- Proved zero-mutation turnover behavior, idempotent owner-B replay, forbidden foreground rejection, proposed-only enforcement, and SQLite authority durability after reopen.

## Task Commits

Git commits were intentionally not attempted. The shared execution environment exposes Git metadata read-only, and the parent explicitly required implementation, tests, and summary creation without repeated commit attempts or claimed hashes.

1. **Task 1: Define explicit authority and complete atomic stage contracts** - unavailable (read-only Git metadata)
2. **Task 2: Reject stale authority inside both atomic backends** - unavailable (read-only Git metadata)

**Plan metadata:** unavailable (read-only Git metadata)

## Files Created/Modified

- `src/daemon/types.ts` - Strict daemon/foreground authority union and domain-specific atomic input schemas.
- `src/storage/memory-store.ts` - Host-neutral guarded reconciliation, refresh, source-outcome, proposal, and work-outcome methods.
- `src/storage/in-memory-store.ts` - Injected-clock token validation, clone-staged state publication, ownership checks, rollback parity, and idempotent replay.
- `src/storage/sqlite-store.ts` - Indexed lease validation inside short `BEGIN IMMEDIATE` transactions before the first durable write.
- `tests/daemon/daemon-store.test.ts` - Shared backend turnover, replacement-owner replay, foreground rejection, proposed-only, and SQLite reopen tests.
- `src/imports/codex-importer.ts` - Explicit narrow foreground import authority pending Plan 04-17 daemon-token propagation.
- `src/daemon/contraction-runner.ts` - Explicit narrow foreground contraction authority pending Plan 04-17 daemon-token propagation.
- `tests/daemon/source-runner.test.ts` - Current compatibility fixture now declares foreground import authority.
- `tests/daemon/contraction-runner.test.ts` - Current compatibility fixture now declares foreground import authority.

## Decisions Made

- Store clocks, not caller-supplied comparison timestamps, decide whether a daemon lease is fresh. SQLite reads the indexed `owner_token` and `expires_at` columns while holding the immediate transaction.
- Foreground authority is never inferred from a missing token. Import accepts only `approved-import`; contraction and proposal publication accept only `historical-bootstrap`; scheduler/source-state APIs accept the daemon schema only.
- Expected/next records make every scheduler mutation compare-and-set and idempotent, including source registry replacement, cadence refresh, health/latch transitions, proposal cadence, and job completion/failure state.
- Proposed publication rejects non-proposed or cross-person boxes, proposals, and traces at the strict input/runtime boundary before mutation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Migrated current compatibility producers to explicit foreground authority**
- **Found during:** Task 1 typecheck
- **Issue:** Making authority required correctly exposed existing importer, contraction-runner, and synthetic fixture calls that omitted it; leaving them unchanged would keep the repository uncompilable until later runner-propagation plans.
- **Fix:** Added the narrow `approved-import` or `historical-bootstrap` foreground branch at current compatibility call sites. Plans 04-17 and 04-18 retain responsibility for carrying daemon authority through awaited work.
- **Files modified:** `src/imports/codex-importer.ts`, `src/daemon/contraction-runner.ts`, `tests/daemon/source-runner.test.ts`, `tests/daemon/contraction-runner.test.ts`
- **Verification:** Complete daemon suite and global typecheck pass.
- **Commit:** unavailable because Git metadata is read-only

---

**Total deviations:** 1 auto-fixed (1 Rule 3 blocking compile migration)
**Impact on plan:** The compatibility changes are narrow, explicit, and preserve the planned sequencing; daemon runner token propagation remains assigned to Plans 04-17 through 04-19.

## Issues Encountered

- The checkout was already substantially dirty with completed Phase 4 and earlier phase work. No unrelated change was cleaned, reverted, or staged.
- Git metadata remains read-only, so no task or summary commit was attempted or claimed.

## TDD Gate Compliance

- Existing authority-free contracts supplied the RED condition; strict required authority initially produced compile failures at every omitted call site.
- GREEN: 38/38 focused store tests, 90/90 daemon tests, global typecheck, and diff hygiene all pass.
- RED/GREEN commits are unavailable because Git metadata is read-only.

## Verification

- `npx vitest run tests/daemon/daemon-store.test.ts tests/storage/sqlite-store.test.ts` - 38 passed across 2 files.
- `npx vitest run tests/daemon` - 90 passed across 7 files.
- `npm run typecheck` - passed with no diagnostics.
- `git diff --check` - passed.

## Privacy and Isolation Review

- Authority and expected-state records contain only database/person/grant/candidate/scope/job identifiers, owner tokens, controlled state, canonical tuple metadata, and timestamps. No transcript, raw model output, native history body, raw error, client/case document, credential, or tool result was added.
- Every source-state transition validates exact person, candidate, grant, and scope ownership; import and contraction retain their existing source provenance and fail-closed derived ownership checks.
- Proposal publication accepts only proposed person-owned review objects. No box, trace, or proposal is auto-approved, and approval/rejection gates remain unchanged.
- Tests use synthetic people, source metadata, content, owner tokens, and temporary SQLite files only. No real history root, network service, external model, or live OS integration was accessed.

## Known Stubs

None.

## Threat Flags

No unplanned threat surface was introduced. The awaited-work-to-atomic-commit authority boundary and foreground-to-daemon compatibility boundary are both explicitly covered by the plan threat model and passing turnover tests.

## Next Phase Readiness

- Plan 04-17 can pass selected daemon authority through all four importer formats and contraction computation into these guarded commits.
- Plan 04-18 can stage proposal work and publish it through `commitProposalRun` without pre-commit authoritative writes.
- Plan 04-19 can replace direct scheduler/source-state saves with the guarded reconciliation, refresh, outcome, and work APIs.
- The parent orchestrator retains phase-level STATE/ROADMAP/requirements updates and later Git commits from a metadata-writable environment.

## Self-Check: PASSED

- All five plan-declared files and four required compatibility call-site files exist.
- `04-16-SUMMARY.md` exists with `status: complete`.
- Focused stores, complete daemon regression, global typecheck, and diff hygiene all pass.
- Turnover, replacement-owner replay, forbidden foreground, proposed-only, and SQLite close/reopen authority tests pass on synthetic data.
- Commit verification is intentionally unavailable and accurately documented without claiming a hash.

---
*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-18*
