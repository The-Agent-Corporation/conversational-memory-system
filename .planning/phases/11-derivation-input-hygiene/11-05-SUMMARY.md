---
phase: 11-derivation-input-hygiene
plan: 05
subsystem: operations
tags: [rebuild, contraction, hygiene, cli, checkpoint, vectors]

# Dependency graph
requires:
  - "11-01: src/topic/derivation-hygiene.ts (HYGIENE_RULE_VERSION)"
  - "11-02: ContractionRunner.drainSlice hygiene-aware windowing, PROCESSOR_VERSION embedding HYGIENE_RULE_VERSION, ContractionSliceResult.supersessions"
provides:
  - "memory rebuild-derivations CLI command (REQ-054): full, resumable, checkpointed re-derivation of a person's summaries under the current hygiene rule version"
  - "ContractionRunner.PROCESSOR_VERSION exported for staleness detection by external callers"
affects: [11-06-live-corpus-rebuild-gate, 12-forward-only-vector-trace-discovery]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "The command owns no derivation loop: it only decides staleness (checkpoint missing/legacy/--force), bumps the contraction job's generation with earliestAffected rewound to the first canonical event, then drives ContractionRunner.drainSlice exactly like HistoricalBootstrapper's drain loop (preloaded events, shared eventIndexById, scopesAlreadyAsserted after slice 1)."
    - "Vector cleanup is the command's only side effect beyond driving drainSlice: after each slice, deleteSummaryVectors is called for slice.supersessions filtered to kind === \"summary\"."
    - "Three-way staleness branch: (checkpoint missing/legacy/--force) -> bump generation + full rewind; (checkpoint current, same generation, immediateStage !== \"complete\") -> resume without bumping; (checkpoint current and complete) -> no-op returning rebuilt: false."

key-files:
  created:
    - src/operations/rebuild-derivations-command.ts
    - tests/operations/rebuild-derivations-command.test.ts
  modified:
    - src/daemon/contraction-runner.ts
    - src/cli/command-registry.ts

key-decisions:
  - "Exported PROCESSOR_VERSION (additive, no behavior change) from contraction-runner.ts per the plan's explicit interface note, rather than duplicating the version string in the new command."
  - "Reused historicalContractionJobId(personId) for the job/checkpoint identity so a rebuild supersedes the existing derivation set instead of deriving a parallel one under a second job id."
  - "The RED test's 'no orphans' case forges a genuinely divergent legacy corpus (distinct summary ids under raw pre-hygiene [Tool call:/[SYSTEM: text) via direct store writes, rather than re-running current hygiene-aware code twice and only rewriting the checkpoint's processorVersion — a same-boundary continuing span legitimately upserts under the SAME deterministic id (id is a function of first-event-id + topic label, not content, per 11-RESEARCH Pitfall 5), so re-running identical code never exercises real supersession for that case."

patterns-established:
  - "Legacy-derivation-state test fixtures should forge divergent summary ids directly via store writes (saveContractionJob/saveContractionCheckpoint/saveSummary) when the test needs to assert supersession specifically, since running current code twice against an unchanged corpus only produces upserts under unchanged span boundaries."

requirements-completed: [REQ-054]

# Metrics
duration: ~25min
completed: 2026-07-26
---

# Phase 11 Plan 05: `memory rebuild-derivations` Command Summary

**Built `memory rebuild-derivations` (REQ-054/SC5): a resumable, idempotent, checkpointed full re-derivation of a person's summaries that detects staleness via `ContractionRunner`'s now-exported `PROCESSOR_VERSION`, bumps the contraction job's generation with a full rewind to the first canonical event, drives the existing `drainSlice` drain loop exactly like `HistoricalBootstrapper`, and tombstones vectors for every summary the slice reports superseded.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-07-26T18:53Z (approx, per task commit timestamps)
- **Completed:** 2026-07-26T19:00Z
- **Tasks:** 2
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments

- Wrote 6 RED SC5 integration tests directly against a real `SqliteStore` in a `mkdtemp` dir (completes full corpus, resumes after interruption with an interrupt-vs-uninterrupted equality comparison, idempotent rerun via prototype-level spies, no-orphan supersession/vector cleanup, monotonic progress, fail-loud on unknown person) — all failed (module absent) before implementation
- Exported `PROCESSOR_VERSION` from `contraction-runner.ts` (additive) so the new command can detect a stale checkpoint without duplicating the version string
- Implemented `runRebuildDerivationsCommand`/`main` in `src/operations/rebuild-derivations-command.ts`, mirroring `backfill-embeddings-command.ts`'s shape (zod `.strict()` options, `onBatchComplete`/`progressSink` deps, `try/finally { store.close() }`, `parseArgs`, `import.meta.url` entrypoint) and `historical-bootstrapper.ts`'s drain loop (preloaded events, shared `eventIndexById`, `scopesAlreadyAsserted` after the first slice)
- Registered `rebuild-derivations` in `src/cli/command-registry.ts`'s closed static allow-list
- All 6 RED cases now GREEN; targeted suites (`tests/operations/`, `tests/daemon/`, `tests/bootstrap/`) green at 174/174; `npm run typecheck` clean

## Task Commits

1. **Task 1: RED SC5 rebuild tests** - `f61de6b` (test)
2. **Task 2: Implement rebuild-derivations-command.ts** - `f6e82a3` (feat)

## Files Created/Modified

- `src/operations/rebuild-derivations-command.ts` - New command: staleness detection (checkpoint missing/legacy-version/`--force` -> full rewind; in-flight-under-current-version -> resume; current-and-complete -> no-op), drives `ContractionRunner.drainSlice` to completion, calls `store.deleteSummaryVectors` per slice for superseded summary ids, emits one JSON progress line per slice
- `src/daemon/contraction-runner.ts` - `PROCESSOR_VERSION` changed from module-private `const` to `export const` (additive, no behavior change) — the only edit permitted to this file in this plan, per its explicit interface note
- `src/cli/command-registry.ts` - Added `"rebuild-derivations": () => import("../operations/rebuild-derivations-command.js")` next to `backfill-embeddings`
- `tests/operations/rebuild-derivations-command.test.ts` - New SC5 integration suite over a real `SqliteStore`; includes a dedicated `buildForgedLegacyCorpus` fixture for the "no orphans" case that hand-writes a legacy job/checkpoint/summaries with ids guaranteed not to collide with the rebuild's deterministically-computed ids

## Decisions Made

See `key-decisions` in frontmatter above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug in own RED test] "no orphans" case's universal-supersession assertion was unfalsifiable with same-code-twice fixture**
- **Found during:** Task 2, first green-run attempt against the Task 1 RED tests
- **Issue:** The Task 1 "no orphans" test built its pre-hygiene baseline by running `runBootstrapCommand` (current, already hygiene-aware code) and only rewriting the checkpoint's `processorVersion` to a legacy string. Since `summaryId` is a deterministic function of `(personId, firstEventId, topicLabel)` — not content — and both the initial run and the rebuild computed identical span boundaries and labels from identical code, most old summaries legitimately upserted in place under the SAME id (correct "continuing span" behavior per 11-RESEARCH Pitfall 5), rather than being superseded. The test's blanket "every pre-hygiene summary is superseded" assertion failed for those non-colliding-boundary summaries — not because the command was wrong, but because the fixture never produced a genuine id divergence.
- **Fix:** Replaced that test's setup with `buildForgedLegacyCorpus`, which directly writes a completed legacy `ContractionJob`/`ContractionCheckpoint` plus one hand-crafted `Summary` per topic window carrying raw `[Tool call:`/`[SYSTEM:` text under an id (`legacy_summary_N`) that can never collide with a hygiene-aware rebuild's real computed id. This reproduces the real-world divergence (pre-hygiene code let tool/synthetic events drive topic labels, changing span boundaries) that the original fixture failed to model, making full supersession the correct and observed outcome.
- **Files modified:** `tests/operations/rebuild-derivations-command.test.ts`
- **Commit:** `f6e82a3`

No other deviations — the command implementation matches the plan's `<behavior>` and `<action>` specs exactly, including reusing `historicalContractionJobId`, never calling `saveSummary`/`DerivationInvalidator` directly, and never touching `canonical_events`.

## Issues Encountered

- `tests/mcp/stdio-server.test.ts` fails in this worktree (2 tests: `MODULE_NOT_FOUND` for `tsx/dist/cli.mjs` and a spawn timeout) because `node_modules/tsx` is absent from this worktree checkout — a pre-existing worktree provisioning artifact unrelated to this plan's files, per the critical_notes. Not investigated further; the orchestrator's post-merge full suite is authoritative.

## User Setup Required

None.

## Next Phase Readiness

- `memory rebuild-derivations` is ready for Plan 06's manual live-corpus gate.
- `ContractionRunner.PROCESSOR_VERSION` is now a stable public export other REQ-054 consumers (e.g., `memory status`/`memory explain` staleness surfacing) can reuse without re-deriving the version string.
- Plan 04's `src/audit/explain-service.ts` was not touched, per the parallel-execution boundary.

---
*Phase: 11-derivation-input-hygiene*
*Completed: 2026-07-26*
