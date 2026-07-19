---
phase: 04-continuous-local-daemon
plan: "13"
subsystem: daemon
tags: [historical-bootstrap, contraction-facade, stable-job, foreground-authority, proposed-only]
requires:
  - phase: 04-continuous-local-daemon
    provides: generation-aware stable-person contraction from Plan 04-12
  - phase: 04-continuous-local-daemon
    provides: guarded historical-bootstrap contraction authority from Plan 04-17
  - phase: 04-continuous-local-daemon
    provides: staged proposed-only publication from Plan 04-18
provides:
  - HistoricalBootstrapper compatibility facade over the authoritative ContractionRunner
  - Stable production person-job enrollment for one-shot bootstrap callers
  - One explicit post-contraction ProposalScheduler drain with proposed-only atomic publication
affects: [daemon-verification, memory-bootstrap, status-command, proposal-review]
tech-stack:
  added: []
  patterns: [compatibility facade, stable per-person job, explicit narrow foreground authority, zero-threshold explicit proposal drain]
key-files:
  created: []
  modified:
    - src/bootstrap/historical-bootstrapper.ts
    - tests/bootstrap/historical-bootstrapper.test.ts
key-decisions:
  - "Historical bootstrap detects compatibility work from canonical events versus person-thread turns, then creates or merges the same stable person job ID used by production imports."
  - "The old bootstrap checkpoint remains a read-compatible mirror only; contraction job/checkpoint state is authoritative for resume and bounded rewind."
  - "Explicit one-shot proposal review uses ProposalScheduler with zero timing thresholds, preserving guarded staged publication without changing daemon quiet/hourly cadence."
patterns-established:
  - "Compatibility APIs may mirror legacy result state, but all immediate derivation must flow through ContractionRunner slices."
  - "Foreground bootstrap selects exact person operation historical-bootstrap before any job mutation and reuses it for contraction and proposal commits."
requirements-completed: [REQ-019, REQ-020, REQ-022]
coverage:
  - id: D1
    description: HistoricalBootstrapper delegates every immediate derivation slice to the stable production ContractionRunner job while preserving one-shot results.
    requirement: REQ-022
    verification:
      - kind: integration
        ref: "tests/bootstrap/historical-bootstrapper.test.ts#delegates immediate work in slices and drains proposals once after completion"
        status: pass
      - kind: integration
        ref: "tests/bootstrap/historical-bootstrapper.test.ts#is a no-op on rerun and resumes the active topic when history is appended"
        status: pass
    human_judgment: false
  - id: D2
    description: Append, earlier-event rewind, restart-style no-op, provenance, and person isolation retain deterministic compatibility behavior.
    requirement: REQ-019
    verification:
      - kind: integration
        ref: "tests/bootstrap/historical-bootstrapper.test.ts"
        status: pass
      - kind: integration
        ref: "tests/service/source-lifecycle-service.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: Changed bootstrap drains proposals exactly once after immediate completion through explicit foreground authority and keeps every review object proposed.
    requirement: REQ-020
    verification:
      - kind: integration
        ref: "tests/bootstrap/historical-bootstrapper.test.ts#delegates immediate work in slices and drains proposals once after completion"
        status: pass
      - kind: integration
        ref: "tests/bootstrap/historical-bootstrapper.test.ts#rejects wrong foreground authority before durable mutation"
        status: pass
      - kind: integration
        ref: "tests/daemon/proposal-scheduler.test.ts"
        status: pass
    human_judgment: false
duration: 6min
completed: 2026-07-18
status: complete
---

# Phase 4 Plan 13: Historical Bootstrap Compatibility Facade Summary

**Historical bootstrap now reuses the stable person contraction job and guarded staged proposal publisher, leaving one authoritative incremental derivation engine.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-18T16:46:00Z
- **Completed:** 2026-07-18T16:52:14Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Deleted the legacy full-prefix event loop, direct turn/anchor/topic/summary writes, per-event bootstrap checkpointing, and direct SleepReviewer proposal writes from `HistoricalBootstrapper`.
- Preserved the constructor, `bootstrap(personId)`, result shape, compatibility checkpoint/status surface, deterministic summarizer injection, append no-op behavior, and earlier-event reset signal while routing all derivation through bounded `ContractionRunner` slices.
- Reused the exact production stable per-person contraction job identity, including generation advancement for earlier changed history and durable suffix resume for appends.
- Added exact foreground-authority validation before mutation plus one explicit post-immediate proposal drain through staged, atomic, proposed-only `ProposalScheduler` publication.
- Added synthetic delegation, multi-slice/single-drain, invalid-authority zero-mutation, append/no-op, bounded earlier rewind, provenance, and cross-person regression coverage.

## Task Commits

Git commits were intentionally not attempted. The parent required execution on the shared main working tree with Git metadata read-only and explicitly prohibited commit retries or claimed hashes.

1. **Task 1: Turn HistoricalBootstrapper into a ContractionRunner facade** - unavailable (read-only Git metadata)
2. **Task 2: Retain one explicit review-only proposal drain** - unavailable (read-only Git metadata)

**Plan metadata:** unavailable (read-only Git metadata)

## Files Created/Modified

- `src/bootstrap/historical-bootstrapper.ts` - Compatibility facade, stable-job enrollment/merge, slice aggregation, legacy checkpoint mirror, explicit authority, and guarded proposal drain.
- `tests/bootstrap/historical-bootstrapper.test.ts` - Delegation and one-drain spies, wrong-authority rollback proof, and updated bounded-rewind compatibility coverage.

## Decisions Made

- Canonical event IDs, content hashes, and canonical sequence positions are compared with person-thread compatibility turns to detect direct one-shot caller changes without restoring a separate prefix processor.
- The contraction checkpoint and stable job are authoritative. The historical checkpoint is written once after immediate completion solely to preserve status and public result compatibility.
- Initial processing does not report a reset merely because `ContractionRunner` begins at the first event; reset remains a compatibility signal for a rewind of previously bootstrapped history.
- Explicit compatibility proposal work configures the scheduler's quiet/forced thresholds to zero instead of bypassing its staging, provenance validation, proposed-only gate, or atomic authority-checked commit.

## Deviations from Plan

None - plan executed as specified.

## Issues Encountered

- The legacy earlier-event test inserted an artificial provenance-incomplete summary and expected full-prefix supersession. The compatibility test was corrected to exercise the production bounded-rewind contract: preserve an unaffected real summary and prove the newly earlier canonical event is contracted. This removes a test dependency on the deleted legacy reset behavior.
- The checkout was already substantially dirty with prior phase work and unrelated tracked changes. Only the two plan-owned files and this summary were edited; nothing was cleaned, reverted, staged, or committed.

## TDD Gate Compliance

- RED: the new delegation/single-drain test observed the legacy direct pipeline, and the invalid-authority test observed durable mutation instead of rejection.
- GREEN: the facade and explicit authority path make all 6 bootstrap tests, 11 contraction tests, 101 daemon tests, and 299 repository tests pass.
- RED/GREEN commits are unavailable because Git metadata is read-only.

## Verification

- `npx vitest run tests/bootstrap/historical-bootstrapper.test.ts -t "delegat|no-op|append|earlier|person"` - 4 selected tests passed.
- `npx vitest run tests/bootstrap/historical-bootstrapper.test.ts tests/daemon/contraction-runner.test.ts` - 17 passed.
- `npx vitest run tests/service/source-lifecycle-service.test.ts` - 3 passed.
- `npx vitest run tests/daemon` - 101 passed across 8 files.
- `npm test` - 299 passed across 48 files.
- `npm run typecheck` - passed with no diagnostics.
- `git diff --check` - passed.

## Privacy and Isolation Review

- Bootstrap validates the requested person before work, selects exact person foreground authority, uses person-owned canonical reads and the stable person job, and relies on ContractionRunner's source/scope validation before every derived publication.
- Canonical event IDs, native session/event IDs, source IDs, immutable scope unions, content hashes, timestamps, trust, and provenance continue through the authoritative contraction engine and compatibility result.
- Proposal computation remains isolated from authoritative storage until `commitProposalRun`; every generated box, trace, and proposal must be proposed, exact-person owned, scope-compatible, and provenance-complete.
- No importer, native source, or source grant is mutated. Tests use only synthetic in-memory people, sources, events, scopes, jobs, and clocks; no real history, client/case material, credential, network, model, or live OS service was accessed.

## Known Stubs

None.

## Threat Flags

No unplanned threat surface was introduced. The compatibility-to-contraction and immediate-to-proposal boundaries are the plan's declared threat surfaces and are covered by delegation, exact-authority, proposed-only, provenance, and person-isolation tests.

## Next Phase Readiness

- The Phase 4 verifier can now treat `ContractionRunner` as the only immediate derivation authority for both daemon and one-shot bootstrap paths.
- Existing `memory:bootstrap` and status callers retain their public result/checkpoint contract without reviving per-slice proposal work.
- The parent orchestrator retains STATE, ROADMAP, requirement, and any later Git commit ownership.

## Self-Check: PASSED

- Both declared implementation/test files and `04-13-SUMMARY.md` exist.
- The source contains no legacy AnchorDetector, TopicMonitor, direct SleepReviewer, compact-span, per-event checkpoint, or independent full-prefix processing path.
- Focused bootstrap/contraction/lifecycle tests, the complete daemon suite, full repository suite, typecheck, and diff hygiene all pass.
- Commit verification is intentionally unavailable because Git metadata is read-only; no hash is claimed.

---
*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-18*
