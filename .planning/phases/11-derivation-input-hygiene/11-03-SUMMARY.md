---
phase: 11-derivation-input-hygiene
plan: 03
subsystem: derivation
tags: [hermes-adapter, pre-compactor, topic-monitor, hygiene, live-bridge]

# Dependency graph
requires:
  - "src/topic/derivation-hygiene.ts (Plan 01) — drivesTopicLabel, derivationContents"
provides:
  - "Live Hermes bridge (HermesMemoryAdapter.processTimelineRow) gated by drivesTopicLabel"
  - "PreCompactor.compactCompletedTopic summarizer input hygiene-transformed via derivationContents"
  - "tests/integrations/hermes-adapter-hygiene.test.ts — live-path regression coverage"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Both derivation seams (daemon/contraction path and live Hermes bridge) import the SAME src/topic/derivation-hygiene.ts module — no local rule table duplicated (11-RESEARCH Pitfall 4)"
    - "Hygiene applied to derivation INPUT only, never to ingestion: every row still reaches this.service.ingestEvent(event) unconditionally, before any gating"
    - "Provenance fields (sourceTurnRanges, sourceTurnCount) always computed from the raw turn set; only the summarizer's text input is hygiene-transformed"

key-files:
  created:
    - tests/integrations/hermes-adapter-hygiene.test.ts
  modified:
    - src/integrations/hermes/adapter.ts
    - src/compaction/pre-compactor.ts
    - tests/compaction/pre-compactor.test.ts

key-decisions:
  - "In adapter.ts, control_signal events always call monitor.observe (they close spans); conversation_turn events call it only when drivesTopicLabel({content, eventKind, role}) is true. When skipped, topicResult is built as { current: monitor.current(hostSessionId), topicChanged: false, completed: null } so the caller's contract (currentTopic always populated when a topic is open) does not regress."
  - "Noted in-code that this live path never sets eventKind, so role: \"tool\" is the tool signal on this seam — consistent with the classifyEvent predicate in derivation-hygiene.ts which already checks role === \"tool\" as one of its three tool-activity conditions."
  - "In pre-compactor.ts, hygieneTurns = derivationContents(turnsInSpan).map(({index, content}) => ({...turnsInSpan[index], content})) is passed to summarizer.summarize as sourceTurns; PreCompactionResult.sourceTurnCount and summary.sourceTurnRanges remain derived from the raw turnsInSpan, per the plan's explicit behavior spec — hygiene changes text, never provenance."

requirements-completed: [REQ-052, REQ-053]

# Metrics
duration: 12min
completed: 2026-07-26
---

# Phase 11 Plan 03: Live Hermes Bridge Hygiene Summary

**Applied the shared `src/topic/derivation-hygiene.ts` classifier to both live-bridge seams — `HermesMemoryAdapter.processTimelineRow` gates its `TopicMonitor.observe` call by `drivesTopicLabel`, and `PreCompactor.compactCompletedTopic` feeds the summarizer hygiene-collapsed turn content — so tool/harness rows no longer fragment topics or leak argument text on the running-agent path, matching the daemon/contraction path exactly.**

## Performance

- **Duration:** ~12 min
- **Tasks:** 2 (TDD: RED then GREEN)
- **Files modified:** 4 (1 created, 3 modified)

## Accomplishments

- `HermesMemoryAdapter.processTimelineRow` now gates the live `TopicMonitor` the same way the
  daemon path gates contraction input: `control_signal` events always observe (span closure via
  `/new`, reset, compress still works); `conversation_turn` events observe only when
  `drivesTopicLabel` returns true. Skipped rows still return the current open topic (never a
  silent `null`) and are still ingested into the canonical timeline unchanged.
- `PreCompactor.compactCompletedTopic` now runs `derivationContents(turnsInSpan)` and passes the
  hygiene-collapsed turns to the summarizer, while `sourceTurnRanges`/`sourceTurnCount` remain
  computed from the raw turn set — hygiene changes text only, never provenance.
- New `tests/integrations/hermes-adapter-hygiene.test.ts` drives the real `HermesMemoryAdapter`
  against an `InMemoryStore` with a `DeterministicSummarizer` (no network) and pins: tool rows
  don't open/close spans but are ingested, a `[SYSTEM: ...]` harness row doesn't open/close a
  span, and a `/new` control-signal row still closes the span.
- Extended `tests/compaction/pre-compactor.test.ts` with: a run of 3 tool turns collapsing to one
  `[Activity] ran 3 tool calls:` line with argument text absent, an isolated tool turn kept
  verbatim, and a `<system-reminder>` turn dropped entirely, all while `sourceTurnRanges` stays
  the span's full raw range.
- No local rule table, classifier, or collapse logic was reimplemented — both seams import
  `drivesTopicLabel` / `derivationContents` directly from `src/topic/derivation-hygiene.ts`.

## Task Commits

Each task was committed atomically (TDD: RED then GREEN):

1. **Task 1: RED live-path hygiene tests** - `1e38236` (test)
2. **Task 2: Gate the live TopicMonitor and hygiene the PreCompactor** - `0b60fe8` (feat)

Task 2 is `tdd="true"`; RED (Task 1) and GREEN (Task 2) gate commits both present and in order.

## Files Created/Modified

- `src/integrations/hermes/adapter.ts` - Imports `drivesTopicLabel`; branches `monitor.observe`
  by event type/classification; builds a synthetic `TopicMonitorResult` from `monitor.current()`
  when observation is skipped.
- `src/compaction/pre-compactor.ts` - Imports `derivationContents`; builds `hygieneTurns` from
  `turnsInSpan` and passes them to `summarizer.summarize`; keeps `sourceTurnRanges`/
  `sourceTurnCount` derived from the raw `turnsInSpan`.
- `tests/integrations/hermes-adapter-hygiene.test.ts` - New file: 3 tests covering tool-row
  gating + ingestion fidelity, harness-row gating, and control-signal closure.
- `tests/compaction/pre-compactor.test.ts` - 3 new tests: tool-run collapse, isolated tool
  verbatim, synthetic drop, all asserting provenance is unchanged.

## Decisions Made

See `key-decisions` in frontmatter above. All followed the plan's explicit behavior spec; no
decisions required user input.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

- Full-suite `npx vitest run` surfaced a pre-existing failure in
  `tests/mcp/stdio-server.test.ts` (subprocess-spawn STDIO lifecycle test) unrelated to this
  plan's files (`src/integrations/hermes/`, `src/compaction/pre-compactor.ts`). Out of scope per
  the executor's scope-boundary rule — not fixed, logged to
  `.planning/phases/11-derivation-input-hygiene/deferred-items.md` for follow-up verification
  against `main` before the next phase touches `src/mcp/`.
- `npm run hermes:smoke` (end-to-end live-bridge harness) still passes with the gated adapter and
  hygiene-transformed pre-compactor in place.

## User Setup Required

None.

## Next Phase Readiness

- Both derivation seams (`ContractionRunner` via Plan 02, running in parallel, and the live
  Hermes bridge here) now share one hygiene module with no drift risk.
- `tests/integrations/`, `tests/compaction/`, and `tests/resume/` all green (58 tests); full
  local suite at 806 passed / 21 skipped + the one pre-existing unrelated `mcp/stdio-server`
  failure noted above. `npm run typecheck` clean.
- Files owned by Plan 02 (`src/daemon/*`, `src/storage/*`) were not touched by this plan.

---
*Phase: 11-derivation-input-hygiene*
*Completed: 2026-07-26*
