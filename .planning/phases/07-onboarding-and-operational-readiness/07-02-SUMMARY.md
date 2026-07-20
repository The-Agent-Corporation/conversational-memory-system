---
phase: 07-onboarding-and-operational-readiness
plan: 02
subsystem: bootstrap
tags: [cli, onboarding, consent, tdd]

# Dependency graph
requires:
  - phase: 07-onboarding-and-operational-readiness
    plan: 01
    provides: "src/cli/command-registry.ts closed subcommand registry (attachment point for `init`)"
provides:
  - "src/bootstrap/init-command.ts: runInitCommand/main -- guided memory init (discover -> per-source consent -> approve -> bootstrap -> offer daemon)"
  - "`init` subcommand wired into the CLI dispatcher"
affects: [07-03, 07-04, "any future plan that needs a scripted first-run onboarding entry point"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Sequenced orchestration over existing command functions (discover -> approve -> bootstrap -> daemon start), never a parallel Promise.all, because ordering IS the correctness guarantee (per-source consent must gate the grant before any bootstrap/import runs)"
    - "Injectable decision hooks (consent, offerDaemon) default to an interactive node:readline/promises stdin prompt but accept a synchronous/async override, keeping the orchestrator deterministic and testable without a real TTY"
    - "One SqliteStore opened by init itself (for the approve step); runBootstrapCommand/runDaemonCommand each open/close their own SqliteStore by path, exactly like every other composed command in this codebase (history-import-command.ts is the precedent for this multi-store-same-file composition style)"

key-files:
  created:
    - src/bootstrap/init-command.ts
    - tests/bootstrap/init-command.test.ts
  modified:
    - src/cli/command-registry.ts

key-decisions:
  - "init's own bootstrap step never imports source content itself -- it only calls the existing HistoricalBootstrapper aggregation over whatever canonical events already exist for the person. Actual content import for newly-approved sources is left to the daemon's periodic ApprovedSourceRunner cycle, which is why the plan's interface list omits history-import-command.ts entirely: granting (approve) is what unlocks future daemon-driven import, not init itself."
  - "A source whose discovery step throws (e.g. ~/.claude does not exist on this machine) is treated as 'not present' and silently excluded from the discovered list, rather than aborting the whole init run -- Rule 2 addition so a user without every agent installed can still complete onboarding for the sources they do have."
  - "offerDaemon is unconditionally invoked (daemonOffered is always true) even when zero sources were approved, since starting the daemon is independently useful (e.g. it will still process the compatibility bootstrap/proposal loop and later pick up sources approved through subsequent `source:revoke`-adjacent commands)."

requirements-completed: [REQ-040]

# Metrics
duration: 25min
completed: 2026-07-20
---

# Phase 7 Plan 2: Guided `memory init` Onboarding Summary

**`src/bootstrap/init-command.ts` sequences discover -> per-source consent -> `SourceLifecycleService.approve` -> `runBootstrapCommand` -> offer-daemon over existing command functions only, with injectable consent/offer hooks and zero new runtime dependencies.**

## Performance

- **Duration:** 25 min
- **Started:** 2026-07-20T19:44:00Z (continuing 07-01 session context)
- **Completed:** 2026-07-20T19:59:54Z
- **Tasks:** 2
- **Files modified:** 3 (1 new command module, 1 new test file, 1 registry edit)

## Accomplishments

- `runInitCommand(options)` discovers every configured source (default: `claude-code`, `openclaw`, `hermes` at their default OS paths) BEFORE requesting consent for any of them, so the user sees the full picture before deciding on the first one.
- Per-source consent is obtained through an injectable `consent(candidate)` hook (default: interactive `node:readline/promises` stdin prompt showing application, source path, and session count). A declined source is recorded in `declinedCandidateIds` and never reaches `SourceLifecycleService.approve` or any import path -- proven by a passing test that inspects the durable grant table mid-run.
- Approved sources flow through the existing `SourceLifecycleService(store).approve(...)` grant path (same service `source-revoke-command.ts` already uses for `.revoke`), never a bypass.
- `runBootstrapCommand` runs once, only when at least one source was approved, processing whatever canonical events already exist for the person into initial summaries/proposals (actual new-source import is a daemon-cycle concern, not init's).
- The daemon start is always offered via an injectable `offerDaemon(context)` hook (default: interactive stdin prompt); accepting it calls the existing `runDaemonCommand({ subcommand: "start", ... })`. The test never accepts, so the real daemon/launchctl path is never exercised in CI.
- `init` is registered in `src/cli/command-registry.ts`, making `memory init` reachable via the Plan 07-01 dispatcher.
- Full suite (`npm test`): 79 files / 678 tests pass; `npm run typecheck` clean.

## Task Commits

Each task was committed atomically:

1. **Task 1: Wave 0 -- failing init orchestration test** - `bf66399` (test)
2. **Task 2: Implement init orchestrator and register `init`** - `7a98271` (feat)

## TDD Gate Compliance

RED gate: `bf66399` (`test(07-02): ...`) -- confirmed red via `Cannot find module .../init-command.js` before implementation existed.
GREEN gate: `7a98271` (`feat(07-02): ...`) -- both tests in `tests/bootstrap/init-command.test.ts` pass, plus the full 678-test suite has no regressions.
No REFACTOR commit was needed (no follow-up cleanup after GREEN).

## Files Created/Modified

- `src/bootstrap/init-command.ts` - `runInitCommand`/`main` guided onboarding orchestrator: discover (all sources) -> per-source consent -> approve (grant, approved sources only) -> bootstrap (once, if anything was approved) -> offer daemon start (always offered, injectable decision)
- `tests/bootstrap/init-command.test.ts` - two-scenario contract test: (1) one approved + one declined source, asserting discover-before-grant ordering via a mid-consent store read, declined-source zero-grant/zero-import guarantee, approve-and-bootstrap-before-daemon-offer ordering via a mid-offer store read, and exact call-order array; (2) an all-declined run asserts zero grants and a `null` bootstrap result
- `src/cli/command-registry.ts` - added `init: () => import("../bootstrap/init-command.js")` to the closed `REGISTRY` map

## Decisions Made

- init's bootstrap step deliberately does not import new source content -- it only runs `HistoricalBootstrapper` over already-existing canonical events. This matches the plan's `<interfaces>` section, which lists only `runHistoryDiscoverCommand`, `SourceLifecycleService.approve`, `runBootstrapCommand`, and `runDaemonCommand` -- `history-import-command.ts` is intentionally absent. Granting a source (approve) is what makes it eligible for the daemon's own periodic `ApprovedSourceRunner` import cycle once the daemon is running.
- A per-source discovery failure (e.g. an application's default history directory does not exist on this machine) is caught and the source is simply omitted from `discovered`/consent, rather than aborting the whole `memory init` run. This is a Rule 2 addition (missing robustness) since the plan's happy-path interface list assumes every configured source resolves cleanly, but a real user will rarely have all three (`claude-code`, `openclaw`, `hermes`) installed at once.
- `offerDaemon` is always invoked, independent of whether any source was approved, and `daemonOffered` is always `true` in the result -- offering a daemon start is a fixed final onboarding step per the plan's objective ("...then offer to start the daemon"), not conditional on approval outcomes.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] TypeScript union-narrowing error on the default `sourceSpecs` fallback**
- **Found during:** Task 2, `npm run typecheck` after initial implementation
- **Issue:** `options.sources ?? DEFAULT_SOURCES.map((source) => ({ source }))` inferred `sourceSpecs` as a union of `InitSourceSpec[]` and an inline `{ source: ImportSource }[]` type (missing the optional `sourcePath` property structurally, not just as `undefined`), so `spec.sourcePath` failed to type-check inside the discovery loop.
- **Fix:** Added an explicit `InitSourceSpec[]` type annotation to the `sourceSpecs` declaration so both branches of the `??` are checked against the same declared type.
- **Files modified:** `src/bootstrap/init-command.ts`
- **Verification:** `npm run typecheck` clean.
- **Committed in:** `7a98271` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 3 - blocking type error, fixed before commit)
**Impact on plan:** None -- purely a type-annotation fix, no behavior change.

## Issues Encountered

None beyond the one auto-fixed type error above.

## User Setup Required

None - no external service configuration required. `memory init` uses only existing local code (REQ-040): no new runtime dependency was added.

## Next Phase Readiness

- `memory init` is reachable via `./bin/memory init --db <path> --person <person-id>` (interactive) or programmatically via `runInitCommand(options)` with injected `consent`/`offerDaemon` hooks (scripted/tested).
- `src/cli/command-registry.ts` now has 21 entries; later-wave plans (`explain`, `audit-log`, `backup`, `restore`, `export`, `tune`) each still just add their own entry, unaffected by this plan's edit.
- No blockers for 07-03 or 07-04.

---
*Phase: 07-onboarding-and-operational-readiness*
*Completed: 2026-07-20*

## Self-Check: PASSED
- FOUND: src/bootstrap/init-command.ts
- FOUND: tests/bootstrap/init-command.test.ts
- FOUND: init entry in src/cli/command-registry.ts
- FOUND: commit bf66399 (test)
- FOUND: commit 7a98271 (feat)
