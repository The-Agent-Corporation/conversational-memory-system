---
phase: 04-continuous-local-daemon
plan: "17"
subsystem: daemon
tags: [lease-authority, source-import, contraction, atomic-commit, replay, privacy]
requires:
  - phase: 04-continuous-local-daemon
    provides: Atomic lease-authority storage contracts, stable contraction generations, and strict producer inputs from Plans 04-12, 04-14, and 04-16
provides:
  - Exact daemon database and owner-token propagation through all four approved source import formats
  - Lease-guarded append and late-rewind contraction publication after awaited derivation work
  - Deterministic stale-owner zero-mutation and replacement-owner replay proofs
  - Explicit operation-scoped foreground authority for approved import and historical contraction compatibility
affects: [04-13, 04-18, 04-19, daemon-verification, historical-bootstrap]
tech-stack:
  added: []
  patterns: [captured write authority, shared staged-import commit, async pre-commit turnover hook, replacement-owner replay]
key-files:
  created: []
  modified:
    - src/daemon/approved-source-runner.ts
    - src/imports/codex-importer.ts
    - src/imports/claude-importer.ts
    - src/imports/openclaw-importer.ts
    - src/imports/hermes-importer.ts
    - src/daemon/contraction-runner.ts
    - src/daemon/daemon-command.ts
    - tests/daemon/source-runner.test.ts
    - tests/daemon/contraction-runner.test.ts
key-decisions:
  - "Write authority is captured when the daemon loop is constructed and the same immutable databaseId/ownerToken pair is retained through awaited source and contraction work."
  - "All four import formats continue to stage through their native read-only adapters and converge on one shared authority-aware commitStagedGrantBatch seam."
  - "Foreground compatibility is explicit: approved-import is the only import operation and historical-bootstrap is the only contraction operation."
patterns-established:
  - "Awaited work may compute freely, but publication receives the exact authority selected before work and relies on the atomic store to reject stale ownership before mutation."
  - "Turnover tests rotate ownership at an injected pre-commit hook, compare the complete durable publication surface, then replay idempotently under the replacement owner."
requirements-completed: [REQ-017, REQ-019, REQ-021, REQ-022]
coverage:
  - id: D1
    description: Every approved source format carries exact daemon authority into the shared atomic import commit and rejects token turnover with zero publication.
    requirement: REQ-017
    verification:
      - kind: integration
        ref: "tests/daemon/source-runner.test.ts#rejects token-A publication after native reads for every format and lets token B replay once"
        status: pass
    human_judgment: false
  - id: D2
    description: Append and late-rewind contraction publication rejects stale owners and converges without duplicates under the replacement owner.
    requirement: REQ-022
    verification:
      - kind: integration
        ref: "tests/daemon/contraction-runner.test.ts#rejects append and late-rewind publication after token turnover, then converges under the replacement owner"
        status: pass
    human_judgment: false
  - id: D3
    description: Missing, cross-person, and wrong-operation foreground authority fails closed before import or contraction mutation.
    requirement: REQ-021
    verification:
      - kind: integration
        ref: "tests/daemon/source-runner.test.ts#requires explicit approved-import authority for foreground source imports"
        status: pass
      - kind: integration
        ref: "tests/daemon/contraction-runner.test.ts#rejects missing, wrong foreground-operation, and cross-person contraction authority before mutation"
        status: pass
    human_judgment: false
duration: 5min
completed: 2026-07-18
status: complete
---

# Phase 4 Plan 17: Guarded Source and Contraction Runners Summary

**All four read-only history importers and incremental contraction now retain the daemon's exact lease token through awaited computation, reject stale-owner publication atomically, and replay once under the replacement owner.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-07-18T16:31:00Z
- **Completed:** 2026-07-18T16:35:50Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments

- Propagated one immutable daemon authority from daemon-loop construction through exact-pair source dispatch, all four importer adapters, staging, and `commitImportBatch`.
- Made contraction validate explicit daemon or narrow foreground authority before work and publish computed turns, summaries, anchors, supersessions, checkpoint, and job through `commitContractionSlice` with that same authority.
- Added synthetic token-A-to-token-B turnover after native reads and derivation computation, complete zero-mutation snapshots, new-owner replay, idempotency, unaffected-prefix, native-source hash, and wrong-authority proofs.

## Task Commits

Git commits were intentionally not attempted. The shared execution environment exposes Git metadata read-only, and the parent explicitly required implementation, verification, and summary creation without commit retries or claimed hashes.

1. **Task 1: Carry daemon authority through all source import commits** - unavailable (read-only Git metadata)
2. **Task 2: Carry daemon authority through contraction slice publication** - unavailable (read-only Git metadata)

**Plan metadata:** unavailable (read-only Git metadata)

## Files Created/Modified

- `src/daemon/approved-source-runner.ts` - Validates explicit runner authority and passes it unchanged into exact-pair importer dispatch.
- `src/imports/codex-importer.ts` - Extends the shared staged-batch options and commit seam with authority and an awaited pre-commit turnover hook.
- `src/imports/claude-importer.ts` - Forwards shared authority-aware batch options after read-only Claude staging.
- `src/imports/openclaw-importer.ts` - Forwards shared authority-aware batch options after read-only OpenClaw staging.
- `src/imports/hermes-importer.ts` - Forwards shared authority-aware batch options after read-only Hermes SQLite staging.
- `src/daemon/contraction-runner.ts` - Requires exact daemon or `historical-bootstrap` authority and uses it for atomic slice publication after the computation hook.
- `src/daemon/daemon-command.ts` - Creates one owner token and supplies the same daemon authority to the loop, source runner, and contraction runner.
- `tests/daemon/source-runner.test.ts` - Covers four-format turnover, full import-state zero mutation, replacement replay, explicit foreground authority, and unchanged native fixtures.
- `tests/daemon/contraction-runner.test.ts` - Covers append and late-rewind turnover, full derivation/checkpoint/job zero mutation, replacement replay, unaffected prefix, and invalid authority.

## Decisions Made

- Authority is immutable operation context, not something re-read or inferred after an await. Freshness remains the atomic store's responsibility at the publication boundary.
- The deterministic hooks run after all source staging or contraction outputs are computed and immediately before the real store commit, allowing exact turnover proof without production-only fault behavior.
- Source importers retain one shared commit helper; no format-specific authorization branch or source write behavior was introduced.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Wired the production daemon constructor to the guarded runner contracts**
- **Found during:** Task 2 production-call-site review
- **Issue:** The plan's declared files did not include `daemon-command.ts`, but leaving its independently created runners without the loop's token would make real daemon work fail authority validation or fall back to unsafe inference.
- **Fix:** Generate one owner token, derive one daemon authority, and pass both to the loop and its source/contraction runners.
- **Files modified:** `src/daemon/daemon-command.ts`
- **Verification:** Full daemon suite and global typecheck pass.
- **Commit:** unavailable because Git metadata is read-only

---

**Total deviations:** 1 auto-fixed (1 Rule 2 missing critical production wiring)
**Impact on plan:** The additional file is the minimum production composition seam required for the planned authority contract; no lifecycle or scheduling behavior changed.

## Issues Encountered

- The checkout was already substantially dirty with completed Phase 4 and earlier work. No unrelated change was cleaned, reverted, staged, or committed.
- Git metadata is read-only, so task and summary commits are unavailable and no hashes are claimed.

## TDD Gate Compliance

- RED: Source turnover tests initially observed successful stale-owner publication; contraction turnover and invalid-authority tests likewise resolved instead of rejecting.
- GREEN: Authority propagation, pre-commit hooks, production token composition, and explicit foreground validation make all 21 focused runner tests and all 94 daemon tests pass.
- RED/GREEN commits are unavailable because Git metadata is read-only.

## Verification

- `npx vitest run tests/daemon/source-runner.test.ts -t "token|turnover|commit|codex|claude|openclaw|hermes"` - 2 selected tests passed.
- `npx vitest run tests/daemon/contraction-runner.test.ts -t "token|turnover|atomic|late|rewind|authority"` - 5 selected tests passed.
- `npx vitest run tests/daemon/source-runner.test.ts tests/daemon/contraction-runner.test.ts` - 21 tests passed.
- `npx vitest run tests/daemon` - 94 tests passed across 7 files.
- `npm run typecheck` - passed with no diagnostics.
- `git diff --check` - passed.

## Privacy and Isolation Review

- Tests use temporary synthetic Codex, Claude Code, OpenClaw, and Hermes histories plus content-free database/token identifiers. Native fixture hashes remain byte-identical, and no real personal history, external model, network service, credential, client/case document, or raw tool result was accessed or persisted.
- Exact person, grant, candidate, and immutable scope provenance continues through staging and atomic import. Contraction revalidates event/source person and scope dependencies before computation and store publication.
- Stale owners publish no source, canonical event, turn, quarantine transition, import checkpoint, receipt, contraction job, summary, anchor, box, trace, proposal, supersession, or contraction checkpoint mutation.
- Proposal and box/trace review gates remain unchanged; contraction publishes no automatic approval and deterministic packing behavior is unaffected.

## Known Stubs

None.

## Threat Flags

No unplanned threat surface was introduced. Native-read-to-import-commit and derivation-to-contraction-commit authority boundaries are the two trust boundaries registered in the plan and are covered by passing synthetic turnover tests.

## Next Phase Readiness

- Plan 04-13 can delegate historical bootstrap through the explicit `historical-bootstrap` foreground contraction authority without recreating a derivation loop.
- Plan 04-18 can apply the same captured-authority pattern to proposal publication.
- Plan 04-19 can rely on source and contraction stages rejecting stale owners before scheduler completion is recorded.
- The parent orchestrator retains phase-level STATE, ROADMAP, requirements, and Git metadata updates.

## Self-Check: PASSED

- All nine implementation/test files and `04-17-SUMMARY.md` exist on disk.
- The summary declares `status: complete` and records the exact focused and full-suite verification outcomes.
- Focused source/contraction tests, the complete daemon suite, global typecheck, and diff hygiene passed.
- Commit verification is intentionally unavailable because Git metadata is read-only; no hash is claimed.

---
*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-18*
