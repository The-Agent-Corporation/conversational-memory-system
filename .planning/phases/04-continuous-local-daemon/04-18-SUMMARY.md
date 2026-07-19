---
phase: 04-continuous-local-daemon
plan: "18"
subsystem: daemon
tags: [proposal-scheduler, isolated-staging, lease-authority, atomic-publication, proposed-only]
requires:
  - phase: 04-continuous-local-daemon
    provides: durable stable-job proposal cadence from Plan 04-12
  - phase: 04-continuous-local-daemon
    provides: independent daemon lease liveness from Plan 04-14
  - phase: 04-continuous-local-daemon
    provides: token-guarded atomic proposal commit from Plan 04-16
provides:
  - Isolated person-owned staging for box and trace proposal computation
  - One exact authority-guarded publication of proposed review objects plus cadence state
  - Token-turnover, expiry, mismatch, proposed-only, and replacement-owner replay proof
affects: [04-13, 04-19, daemon-verification, historical-bootstrap, proposal-review]
tech-stack:
  added: []
  patterns: [isolated InMemoryStore staging, compute-then-guarded-commit, exact authority propagation, fail-closed provenance validation]
key-files:
  created:
    - tests/daemon/proposal-scheduler.test.ts
  modified:
    - src/daemon/proposal-scheduler.ts
    - src/sleep/sleep-reviewer.ts
    - src/daemon/daemon-command.ts
    - tests/daemon/contraction-runner.test.ts
key-decisions:
  - "Proposal review computation receives only active person-owned derived metadata in an isolated InMemoryStore; authoritative state is untouched until commitProposalRun."
  - "ProposalScheduler requires explicit daemon or historical-bootstrap authority and publishes one due stable job per run through the atomic store contract."
  - "Every staged output must remain proposed, match the exact person, and reference summaries with complete scope and canonical provenance."
patterns-established:
  - "Staged review seam: SleepReviewer.stageProposals may mutate its supplied store, while ProposalScheduler always supplies an isolated staging store."
  - "Proposal publication seam: computation, validation, and optional model awaits precede one compare-and-set commit coupling outputs, checkpoint, and job cadence."
requirements-completed: [REQ-019, REQ-020, REQ-021, REQ-022]
coverage:
  - id: D1
    description: Proposal computation performs zero authoritative writes and publishes only proposed person/scope/provenance-owned outputs through one atomic commit.
    requirement: REQ-022
    verification:
      - kind: integration
        ref: "tests/daemon/proposal-scheduler.test.ts#stages proposed person and scope owned review output before one guarded publication"
        status: pass
    human_judgment: false
  - id: D2
    description: Token turnover or expiry leaves boxes, traces, proposals, job, checkpoint, and cadence metadata unchanged.
    requirement: REQ-021
    verification:
      - kind: integration
        ref: "tests/daemon/proposal-scheduler.test.ts#rejects token turnover with zero proposal or cadence mutation then replays once under the replacement owner"
        status: pass
      - kind: integration
        ref: "tests/daemon/proposal-scheduler.test.ts#rejects expired authority and person or provenance mismatches before publication"
        status: pass
    human_judgment: false
  - id: D3
    description: Replacement owner replay publishes exactly one idempotent proposed-only result and advances cadence once without network or external models.
    requirement: REQ-019
    verification:
      - kind: integration
        ref: "npx vitest run tests/daemon"
        status: pass
    human_judgment: false
duration: 8min
completed: 2026-07-18
status: complete
---

# Phase 4 Plan 18: Guarded Proposal Publication Summary

**Proposal review now computes in an isolated person-owned store and publishes proposed-only outputs plus cadence state through one exact lease-guarded atomic commit.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-07-18T16:36:00Z
- **Completed:** 2026-07-18T16:44:26Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Added an isolated staging path containing only the selected person's active summaries, boxes, anchors, proposed proposals, and traces; no canonical event content or authoritative mutation enters review computation.
- Replaced direct `SleepReviewer` writes and separate job/checkpoint saves with one `commitProposalRun` call carrying the exact daemon or narrow foreground authority, expected state, proposed outputs, and next cadence state.
- Added synthetic proofs for token turnover and expiry, person/job/scope/provenance mismatches, approved/rejected output rejection, zero-mutation old-owner behavior, and exactly-once replacement-owner replay.
- Preserved deterministic local planning, ten-minute quiet/hourly cadence, human review gates, and stable-job idempotency across the complete daemon suite.

## Task Commits

Git commits were intentionally not attempted. The parent required execution on the shared main working tree with Git metadata read-only and explicitly prohibited repeated commit attempts or claimed hashes.

1. **Task 1: Stage proposal computation away from the authoritative store** - unavailable (read-only Git metadata)
2. **Task 2: Publish proposals only through the guarded atomic commit** - unavailable (read-only Git metadata)

**Plan metadata:** unavailable (read-only Git metadata)

## Files Created/Modified

- `src/daemon/proposal-scheduler.ts` - Builds exact person-owned staging state, validates proposed-only scope/provenance, and invokes one guarded atomic proposal publication.
- `src/sleep/sleep-reviewer.ts` - Adds a complete staged review seam over the existing box and trace planners.
- `tests/daemon/proposal-scheduler.test.ts` - Proves staging isolation, token turnover/expiry rollback, mismatch rejection, proposed-only enforcement, and owner-B replay.
- `src/daemon/daemon-command.ts` - Supplies the daemon's exact immutable authority to the production proposal scheduler.
- `tests/daemon/contraction-runner.test.ts` - Supplies explicit narrow foreground authority to existing compatibility cadence tests.

## Decisions Made

- Staging contains derived metadata only. It deliberately excludes canonical events, turns, native paths, source roots, raw histories, and model responses while retaining exact summary scope and canonical-event provenance needed for validation.
- A scheduler run publishes at most one complete dirty stable job. This keeps each review computation coupled to one exact expected job/checkpoint pair and one atomic cadence transition.
- An empty valid review result still advances the due job's cadence once; zero generated candidates is a completed review, not a reason to keep rerunning the same due work.
- Foreground compatibility is explicit through operation `historical-bootstrap`; missing authority or any other foreground operation cannot become a bypass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Wired production daemon authority into ProposalScheduler**
- **Found during:** Task 2 production-call-site review
- **Issue:** Requiring authority only inside the scheduler without updating production construction would leave daemon proposal work unable to use the guarded commit or tempt an unsafe implicit fallback.
- **Fix:** Passed the same immutable database/owner authority already shared by source and contraction runners into `ProposalScheduler`.
- **Files modified:** `src/daemon/daemon-command.ts`
- **Verification:** Complete daemon suite and global typecheck pass.
- **Commit:** unavailable because Git metadata is read-only

**2. [Rule 3 - Blocking] Migrated existing cadence tests to explicit compatibility authority**
- **Found during:** Task 2 typecheck and regression integration
- **Issue:** Existing `ProposalScheduler` cadence tests constructed the scheduler without authority after the contract became mandatory.
- **Fix:** Selected the narrow `historical-bootstrap` foreground authority already used by the surrounding compatibility contraction tests.
- **Files modified:** `tests/daemon/contraction-runner.test.ts`
- **Verification:** All 11 contraction-runner tests and 101 daemon tests pass.
- **Commit:** unavailable because Git metadata is read-only

---

**Total deviations:** 2 auto-fixed (1 missing critical functionality, 1 blocking migration)
**Impact on plan:** Both changes complete the planned explicit-authority contract at real and existing compatibility call sites without adding product scope.

## Issues Encountered

- The checkout was substantially dirty before execution with completed Phase 4 work and earlier project changes. Only the five plan-related files and this summary were touched; nothing was cleaned, reverted, staged, or committed.
- The first GREEN regression exposed a valid zero-candidate review case. Validation was corrected to require provenance references whenever staged outputs exist while allowing an empty successful review to advance cadence once.

## TDD Gate Compliance

- RED: the new proposal scheduler file produced three expected failures—no staging hook, successful stale-token publication, and successful expired-token publication.
- GREEN: isolated staging, explicit authority, proposed-only validation, and atomic commit wiring make all 7 proposal tests, 11 contraction tests, 11 sleep-reviewer tests, and 101 daemon tests pass.
- RED/GREEN commits are unavailable because Git metadata is read-only.

## Verification

- `npx vitest run tests/daemon/proposal-scheduler.test.ts tests/daemon/contraction-runner.test.ts` - 18 passed.
- `npx vitest run tests/sleep/sleep-reviewer.test.ts` - 11 passed.
- `npx vitest run tests/daemon` - 101 passed across 8 files.
- `npm run typecheck` - passed with no diagnostics.
- `git diff --check` - passed.

## Privacy and Isolation Review

- Staging filters every derived input to the exact requested `personId`, excludes superseded summaries, and rejects summaries missing non-empty scope IDs, canonical event IDs, or source turn ranges.
- Every generated box, trace, and proposal must be `proposed`, match the exact person, and reference only the staged person's provenance-complete summaries before publication.
- Old-owner turnover and expiry tests confirm zero authoritative box, trace, proposal, checkpoint, job, `lastProposalRunAt`, `proposalDirty`, or scheduling mutation; replacement owner replay publishes once.
- Tests use synthetic people, scopes, summaries, owner tokens, jobs, and injected clocks only. No real history, source root, client/case content, credential, network, OpenRouter key, external model, or live OS service was accessed.
- Native histories remain read-only and all results remain human-reviewable; no approval or rejection transition was added.

## Known Stubs

None.

## Threat Flags

No unplanned threat surface was introduced. Optional review computation to SQLite authority and staged review objects to human approval are the plan's declared trust boundaries and are covered by passing turnover and proposed-only tests.

## Next Phase Readiness

- Plan 04-13 can replace the legacy historical bootstrap proposal drain with `ProposalScheduler` using explicit `historical-bootstrap` authority.
- Plan 04-19 can couple scheduler completion to the same exact daemon authority without revisiting proposal computation or cadence state.
- The parent orchestrator retains ownership of STATE/ROADMAP/requirements updates and any later Git commits from a metadata-writable environment.

## Self-Check: PASSED

- All five implementation/test files and `04-18-SUMMARY.md` exist.
- The summary declares `status: complete`, includes every plan requirement, and records the read-only Git limitation without claiming hashes.
- Focused proposal/contraction/sleep tests, the complete daemon suite, global typecheck, and diff hygiene pass.
- Tests prove zero authoritative pre-commit mutation, proposed-only person/scope/provenance validation, stale-owner rollback, and exactly-once replacement-owner replay.

---
*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-18*
