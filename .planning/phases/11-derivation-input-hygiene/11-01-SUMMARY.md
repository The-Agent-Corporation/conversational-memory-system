---
phase: 11-derivation-input-hygiene
plan: 01
subsystem: derivation
tags: [classification, hygiene, topic-monitor, deterministic, pure-function]

# Dependency graph
requires: []
provides:
  - "src/topic/derivation-hygiene.ts — the single shared pure classify/collapse module"
  - "classifyEvent, derivationContents, openToolRunStart, toolNameOf, collapseText, drivesTopicLabel, SYNTHETIC_RULES, HYGIENE_RULE_VERSION exports"
  - "11-hygiene-sim.ts rewired onto the production module (no more parallel rule table)"
affects: [11-02-contraction-runner, 11-03-hermes-adapter, 11-04-pre-compactor, 11-05-explain-service, 11-06-rebuild-command]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure classification module: no store/clock/network/randomness imports, a function of (content, eventKind, role) only"
    - "Shared synthetic-drop + run-detection walk (computeSegments) reused by both derivationContents and openToolRunStart so the two can never disagree about where a tool run begins"
    - "Rule table promoted verbatim from a measured simulation prototype rather than re-derived, to keep measured targets valid"

key-files:
  created:
    - src/topic/derivation-hygiene.ts
    - tests/topic/derivation-hygiene.test.ts
  modified:
    - .planning/phases/11-derivation-input-hygiene/11-hygiene-sim.ts

key-decisions:
  - "Promoted the rule table, toolNameOf, and collapseText from 11-hygiene-sim.ts verbatim (identical predicates, ordering, output string) so implementation output stays comparable to the measured 55,930-summary / 77.6 MB targets."
  - "Added two assistant-role-gated rules (silent-sentinel, structured-json-emission) not present in the measured sim run; documented in-code and in the sim's report output that these will shift the Plan 06 re-measurement."
  - "derivationContents and openToolRunStart share one internal computeSegments walk rather than each re-implementing synthetic-drop + run-detection, structurally preventing the two from disagreeing about where a run starts."
  - "Tool-activity detection checks eventKind === 'tool_call' OR role === 'tool' OR (eventKind absent AND content starts with '[Tool call: '), covering both first-class CanonicalEvent input and legacy/replayed rows lacking eventKind, satisfying the quarantine-replay guard test."

patterns-established:
  - "Pure content-classification module shape (mirrors src/imports/secret-redactor.ts): exported pure functions over plain strings/objects, zero IO."
  - "Rule-version constant (HYGIENE_RULE_VERSION) mirrors PROCESSOR_VERSION/parserVersion idiom for future staleness-marking use in Plan 02+."

requirements-completed: [REQ-052, REQ-053]

# Metrics
duration: 3min
completed: 2026-07-26
---

# Phase 11 Plan 01: Derivation Hygiene Classifier Summary

**Single pure `src/topic/derivation-hygiene.ts` module classifying events into conversational/tool_activity/synthetic_injected with rule id + version, collapsing tool runs to argument-free activity lines, and exposing `openToolRunStart` for Plan 02's slice-boundary handling — with the measurement sim rewired to import it.**

## Performance

- **Duration:** ~3 min (18:18:42 - 18:21:18 UTC-4)
- **Started:** 2026-07-26T22:18:42Z
- **Completed:** 2026-07-26T22:21:18Z
- **Tasks:** 3
- **Files modified:** 3 (2 created, 1 modified)

## Accomplishments
- Created the one shared, pure, deterministic classify/collapse module every other Phase 11 plan will import
- Promoted the measured rule table, `toolNameOf`, and `collapseText` verbatim from `11-hygiene-sim.ts` so future measurement stays comparable, then added the two confirmed assistant-role rules
- Exported `openToolRunStart`, sharing its synthetic-drop + run-detection walk with `derivationContents`, unblocking Plan 02's checkpoint-based slice-boundary handling
- Rewired `11-hygiene-sim.ts` onto the production module, eliminating the parallel rule-table copy that RESEARCH flagged as the top anti-pattern risk

## Task Commits

Each task was committed atomically (TDD: RED then GREEN, then a refactor commit for the sim rewire):

1. **Task 1: Wave 0 — RED unit tests for classify + collapse** - `d992043` (test)
2. **Task 2: Implement src/topic/derivation-hygiene.ts** - `039a9e9` (feat)
3. **Task 3: Rewire 11-hygiene-sim.ts onto the production module** - `aec6ea6` (refactor)

_Task 2 is `tdd="true"`; RED (Task 1) and GREEN (Task 2) gate commits both present and in order._

## Files Created/Modified
- `src/topic/derivation-hygiene.ts` - New pure module: `HYGIENE_RULE_VERSION`, `classifyEvent`, `SYNTHETIC_RULES`, `toolNameOf`, `collapseText`, `derivationContents`, `openToolRunStart`, `drivesTopicLabel`, `ClassifiableEvent` interface
- `tests/topic/derivation-hygiene.test.ts` - 34 unit tests covering every synthetic rule, rule ordering, determinism, quarantine-replay contract, collapse/isolated behavior, and open-run detection
- `.planning/phases/11-derivation-input-hygiene/11-hygiene-sim.ts` - Deleted local `SYNTHETIC_RULES`/`classify`/`toolNameOf`/`collapseText`; now imports all four (plus `HYGIENE_RULE_VERSION`) from the production module; report header prints the rule version and a note about the new assistant-role rules

## Decisions Made
- See `key-decisions` in frontmatter above. No decisions required user input — all followed the plan's explicit behavior spec.

## Deviations from Plan

None - plan executed exactly as written. One micro-adjustment: reworded a code comment that said "no store, clock, network, Date.now, or randomness" to "no store, no wall-clock reads, no network, no randomness" because the literal string "Date.now" in the comment (not real code) was tripping the acceptance-criteria grep (`grep -cE "...|Date\.now"`) as a false positive. This is a wording-only change with no functional effect; not a deviation from behavior, but noting it since it touched the exact file the acceptance criteria greps.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `src/topic/derivation-hygiene.ts` is ready for Plan 02 (`contraction-runner.ts` + `ContractionCheckpoint.pendingToolRun`) to import `classifyEvent`, `derivationContents`, and `openToolRunStart` directly.
- No consumer wired yet, as intended — full test suite unchanged in composition (819 = 785 baseline + 34 new; 4 skipped, no regressions) and `npm run typecheck` clean.
- `openToolRunStart` is verified against every open/closed/synthetic-tail case Plan 02 depends on for its slice-boundary withholding logic.

---
*Phase: 11-derivation-input-hygiene*
*Completed: 2026-07-26*

## Self-Check: PASSED

All created files verified present; all task commit hashes verified in git log.
