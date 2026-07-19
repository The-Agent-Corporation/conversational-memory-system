---
phase: 04-continuous-local-daemon
plan: "10"
subsystem: database
tags: [sqlite, daemon, source-grants, scheduler, reconciliation, person-isolation]
requires:
  - phase: 04-continuous-local-daemon
    provides: Durable daemon source health records, approved-grant lifecycle authority, and periodic scheduler reconstruction
provides:
  - Atomic projection of exact approved grants into durable daemon source state
  - Deterministic person/candidate source-state identities with exact health preservation
  - Grants-only scheduler enrollment and live revocation/replacement reconciliation
  - Equivalent in-memory and reopened-SQLite behavior without daemon-only seeding
affects: [phase-04-verification, daemon-startup, periodic-rescan, once-mode]
tech-stack:
  added: []
  patterns: [authoritative durable projection, clone-staged replacement, short BEGIN IMMEDIATE reconciliation, explicit-person scheduler reconstruction]
key-files:
  created: []
  modified:
    - src/storage/memory-store.ts
    - src/storage/in-memory-store.ts
    - src/storage/sqlite-store.ts
    - src/daemon/source-state.ts
    - src/daemon/scheduler.ts
    - tests/daemon/daemon-store.test.ts
    - tests/daemon/scheduler.test.ts
key-decisions:
  - "Daemon source state is derived inside the store from current approved grants rather than accepting caller-supplied approval data."
  - "Retry and degraded health survives only an exact grant/person/candidate/scope match; replacement creates fresh healthy state and revocation removes runnable state."
  - "Every safety rescan reconciles only explicitly registered people, immediately queues newly enrolled grants, and preserves existing watcher and power-cadence behavior."
patterns-established:
  - "Active daemon sources are an idempotent person-owned projection of durable grants, not independently seeded operational records."
  - "SQLite registry replacement occurs inside one short BEGIN IMMEDIATE transaction; in-memory behavior stages and swaps an equivalent validated set."
requirements-completed: [REQ-017, REQ-018, REQ-021]
coverage:
  - id: D1
    description: "Approved grants reconcile atomically into exact person-owned source state across both stores, including health preservation, revocation, replacement, isolation, and SQLite reopen."
    requirement: REQ-017
    verification:
      - kind: integration
        ref: "tests/daemon/daemon-store.test.ts#reconciles approved grants into an exact person-owned active source registry"
        status: pass
      - kind: integration
        ref: "tests/daemon/daemon-store.test.ts#reconstructs a grants-only active source registry after SQLite close/reopen"
        status: pass
    human_judgment: false
  - id: D2
    description: "Scheduler reconstruction and safety rescans enroll newly approved grants and remove revoked grants without manual daemon-state seeding."
    requirement: REQ-018
    verification:
      - kind: integration
        ref: "tests/daemon/scheduler.test.ts#enrolls grants-only state for explicitly registered people during reconstruction"
        status: pass
      - kind: integration
        ref: "tests/daemon/scheduler.test.ts#reconciles newly approved and revoked grants on the next safety rescan"
        status: pass
    human_judgment: false
  - id: D3
    description: "Reconciliation remains content-free, exact-grant authorized, person-isolated, and compatible with the complete daemon scheduling surface."
    requirement: REQ-021
    verification:
      - kind: integration
        ref: "npx vitest run tests/daemon"
        status: pass
      - kind: other
        ref: "npm run typecheck && git diff --check"
        status: pass
    human_judgment: false
duration: 6min
completed: 2026-07-18
status: complete
---

# Phase 4 Plan 10: Approved-Grant Source Registry Reconciliation Summary

**Exact approved grants now become durable, schedulable daemon sources automatically through atomic person-owned reconciliation in both memory and SQLite stores.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-18T15:36:00Z
- **Completed:** 2026-07-18T15:42:47Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments

- Added a host-neutral `MemoryStore.reconcileDaemonSourceStates(personId, now)` authority that derives active state only from currently approved grants and atomically removes stale rows.
- Preserved retry/degraded health only for exact grant/person/candidate/scope matches while resetting replacements and excluding revoked or cross-person grants.
- Wired source-state and scheduler reconciliation so a grants-only Phase 2/3 database becomes runnable at startup and newly approved or revoked grants take effect on the next authoritative safety rescan.
- Proved backend equivalence, byte-stable idempotency, ordinary SQLite close/reopen persistence, power cadence, fairness, content-free state, and person isolation with synthetic tests.

## Task Commits

Git metadata is read-only in this execution environment, so the required RED/GREEN task commits and final metadata commit could not be created. The parent task explicitly identified `.git/index.lock` as unavailable and instructed against repeated commit retries. All implementation, tests, and this summary remain in the shared dirty worktree for the parent orchestrator or user to commit later.

The TDD gates were still exercised on disk:

1. **Task 1 RED:** `daemon-store.test.ts` failed 3 tests because `reconcileDaemonSourceStates` did not exist.
2. **Task 1 GREEN:** store suite passed 16/16 after contract and backend implementation.
3. **Task 2 RED:** `scheduler.test.ts` failed 3 tests because grant enrollment and `reconcileApproved` did not exist.
4. **Task 2 GREEN:** combined store/scheduler suite passed 28/28 with typecheck green.

## Files Created/Modified

- `src/storage/memory-store.ts` - Added the authoritative reconciliation contract.
- `src/storage/in-memory-store.ts` - Added validated clone-staged exact-active-grant replacement while preserving unrelated people.
- `src/storage/sqlite-store.ts` - Added transactional approved-grant enumeration, stale-row removal, replacement, and durable return state.
- `src/daemon/source-state.ts` - Added deterministic `daemonSourceStateId`, fresh source-state construction, and `reconcileApproved(personId)`.
- `src/daemon/scheduler.ts` - Reconciles registered people before due reconstruction and queues only new active grants immediately.
- `tests/daemon/daemon-store.test.ts` - Added shared backend, revocation, replacement, idempotency, isolation, and reopened-SQLite proofs.
- `tests/daemon/scheduler.test.ts` - Added grants-only startup, live grant change, sole enrollment seam, and privacy assertions.

## Decisions Made

- The store is the approval boundary: callers provide only `personId` and time, while the transaction enumerates authoritative approved grants itself.
- Source-state IDs are deterministic from person and candidate; multiple simultaneous approved grants for one person/candidate fail closed rather than overwrite each other.
- Reconciliation removes stale due work but preserves active watcher prompts, so watch hints remain a latency optimization and periodic rescans remain correctness authority.

## Deviations from Plan

None - the plan was executed as written.

## Issues Encountered

- The worktree contained substantial pre-existing Phase 3/4 changes and untracked planning/source files before execution. Only the seven plan-owned files and this summary were changed for 04-10; unrelated dirty work was preserved.
- Git commits were unavailable because `.git` is read-only and cannot create `index.lock`. No commit hashes are claimed, and implementation verification was unaffected.

## Verification

- `npx vitest run tests/daemon/daemon-store.test.ts tests/daemon/scheduler.test.ts` - 28 passed across 2 files.
- `npx vitest run tests/daemon` - 70 passed across 7 files.
- `npm run typecheck` - passed.
- `git diff --check` - passed.

## Privacy and Isolation Checks

- Reconciliation enumerates grants only for the explicit registered `personId`; it neither reads nor deletes another person's source state.
- Only approved exact grant identities and immutable scope IDs become runnable; revoked and replaced grants are removed before scheduling.
- Durable rows contain controlled identities, health categories, counts, and timestamps only. They do not copy source locators, conversation bodies, raw errors, secrets, or native history content.
- Tests use synthetic grants, people, temporary SQLite databases, and fake time. No real history, native source, external model, network service, or live macOS service was accessed or modified.
- Approval and proposal review boundaries remain unchanged; reconciliation never approves a grant or proposal.

## Known Stubs

None.

## Next Phase Readiness

- The approved-grant enrollment gap from `04-VERIFICATION.md` is closed and ready for phase re-verification.
- The other independently reported Phase 4 gaps (lease lifetime, late-event rewind, durable proposal cadence, and bootstrap delegation) are outside Plan 04-10 and remain for their dedicated gap-closure plans.

## Self-Check: PASSED

- All seven declared production/test files exist.
- `04-10-SUMMARY.md` exists with `status: complete`.
- Exact plan verification, broader daemon regression, typecheck, and diff hygiene checks all pass.
- Commit verification is intentionally unavailable and explicitly documented because the environment cannot write Git metadata.

---
*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-18*
