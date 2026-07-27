---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Vector-Native Traces + Semantic Recall
current_phase: 11
current_plan: 13
status: executing
stopped_at: "Plan 11-13 Task 1 complete (recall probe run); result is negative and GAP-11-D raised; Task 2/3 (owner authorization + live prune) NOT run - halted at the gate"
last_updated: "2026-07-27T15:35:00.000Z"
last_activity: 2026-07-27
progress:
  total_phases: 15
  completed_phases: 8
  total_plans: 79
  completed_plans: 77
  percent: 53
---

# Project State

**Current phase:** 11
**Current plan:** 1
**Status:** Ready to execute
**Last updated:** 2026-07-27

## Completed

- v1.0 (Phases 1-7) complete: host-neutral canonical timeline, four history importers, resumable checkpoints, deterministic historical bootstrap, source lifecycle controls, continuous local daemon, generic sixteen-tool MCP interface, zero-knowledge multi-device sync, and the operator surface (`memory` CLI, guided init, REQ-039 audit surface, migration, health/tune, encrypted backup).
- Dogfooding 292,407 canonical events / 135,366 summaries validated the pipeline end-to-end, exposed and fixed O(n²) scaling hotspots (import, contraction, box/trace), and exposed the shared-term trace algorithm's combinatorial pathology — motivating v1.1.
- v1.1 research complete: STACK, FEATURES, ARCHITECTURE, PITFALLS, SUMMARY all written to `.planning/research/`.
- v1.1 ROADMAP.md written: Phases 8-14 derived from REQ-041..051, dependency-ordered per research SUMMARY.md/ARCHITECTURE.md build order.

## Active Work

- Phases 8-10 complete (vector storage, embedder, backfill). Backfill machinery is built but has NOT been run against the live corpus (`~/.memory/aaron.db` is still at schema version 1, no vector table).
- **Phase 11 — Derivation Input Hygiene inserted 2026-07-26.** Corpus audit found 64% of canonical events are tool calls, 38% of summaries contain verbatim `[Tool call:` argument text, and ~49% of "user" turns are harness-injected scaffolding — roughly 7% of the corpus is human-authored. Former Phases 11-14 renumbered to 12-15; REQ-052/053/054 added. See `.planning/phases/11-derivation-input-hygiene/11-SCOPE-INSERT.md`.
- **Phase 11 planned 2026-07-26**: 7 plans / 5 waves, plan-checker PASSED (1 warning, see below). Simulation against the live corpus projects 135,366 -> 55,930 summaries (-59%) and 228.9 MB -> 77.6 MB (-66%). Next: `/gsd:execute-phase 11`.
- **Phase 11 warning RESOLVED 2026-07-26 (owner decision).** The plan-checker warning on 11-02 — that it satisfied CONTEXT decision 6 implicitly via stable-id upsert rather than by extending `ContractionCheckpoint` — was resolved in favor of the **literal checkpoint extension**. The implicit form is eventually-correct but persists an observable intermediate summary carrying a still-growing tool count. 11-02 was replanned: `ContractionCheckpoint` gains `pendingToolRun` (JSON payload field, no DDL, no schema-version bump), a non-complete slice withholds a trailing open run from derivation text, a drift guard fails closed to the rewind path on late inserts, and corpus-end always flushes. 11-01 gained an `openToolRunStart` export; 11-02 is now 4 tasks and also touches `src/daemon/types.ts` + `src/storage/sqlite-store.ts`. Recorded as an addendum in `11-CONTEXT.md`; `11-VALIDATION.md` gained 5 rows. **Phase 11 has no open warnings — ready to execute.**
- **GAP-11-A CLOSED 2026-07-27** by plans 11-08 through 11-12. `src/retrieval/retrievable-state.ts` is the single source of truth for retrievable `MemoryState` values; the predicate is enforced in `applyRetrievalBoundary`, `MemoryQueryService.loadAuthorizedMemory`, `SubjectExpansionService.resolveSummary`, and both stores' `findNearestSummaries`. Filtered `listSummaries` + migration 3 (`idx_summaries_person_state`) removed the per-query full scan. `commitSupersededSummaryPrune` and `memory prune-superseded` (dry-run default, fail-closed backup gate) are built and green. ADRs 0049 and 0050. The live prune has NOT been run — it is gated on Plan 11-13 Task 2.
- **GAP-11-B (blocking Plan 11-13, found 2026-07-27, CLOSED 2026-07-27):** `dedupeRankedMemory` → `isAnchorCoveredBySummary` (`src/retrieval/memory-retriever.ts:319-348`) is O(anchors × summaries) with expensive per-pair work — `normalizedMemoryText(summary.text)` is recomputed per anchor over ~800 KB strings, and the `.includes()` substring search runs *before* the cheap `sharesBox`/`sharesThread` guards that could reject the pair. Measured ~48,900 pairs/sec against the real corpus; the frozen 12-query recall probe extrapolates to hours-to-days per run, and Task 1 needs two runs. Separate from GAP-11-A and not fixed by 11-10 (which only bounded the initial fetch; this is downstream in ranking and also depends on anchors, which have no state filter). Reproduces on the current live corpus — an active defect on every host injection request today. Fix direction: hoist the normalization and reorder the `&&` chain — both behavior-preserving, since all three predicates are pure. Owner chose "fix the hotspot first" 2026-07-27. Closed by Plan 11-15: ~1.3M pairs/sec measured (~30x naive), sufficiency floor cleared. See `.planning/phases/11-derivation-input-hygiene/11-GAP-11-B.md`.
- **Plan 11-13 Task 1 run 2026-07-27 — RESULT NEGATIVE, GAP-11-D RAISED.** The frozen 12-query recall probe ran against a scratch copy of `~/.memory/aaron.db.pre-phase11` (`before`) and the live corpus (`after-filter`). `containsToolCallText` went from 9/12 (before) to **10/12** (after-filter) — Phase 11's summary-hygiene rebuild and the GAP-11-A state filter did NOT reduce tool-call text reaching injection packets; Q1's selected memory is byte-identical between the two runs. Root cause confirmed by reading code: `AnchorDetector.detectForTurn` (`src/anchors/anchor-detector.ts`) is called unconditionally on every ingested turn in `src/integrations/hermes/adapter.ts:89`, with no hygiene gate (unlike topic labeling, which checks `drivesTopicLabel` three lines above it). Anchors carry raw `turn.content` verbatim, including `[Tool call: ...]` text, and those anchors outrank hygienic summary text in `rankMemories`. This refutes the `conversation-resumer.ts` hypothesis noted below — that code is a separate resume flow never called by `prepareInjection`. **The live prune (Task 3) cannot close this gap**: it deletes superseded summary rows only; anchors are a separate, unfiltered store entity. See `.planning/phases/11-derivation-input-hygiene/11-GAP-11-D.md` and `11-RECALL-PROBE.md`. Plan 11-13 is **PARTIALLY COMPLETE** — Task 1 done, Task 2 (owner authorization) and Task 3 (execute prune) NOT run; do not mark 11-13 complete in ROADMAP.
- **Live corpus rebuilt 2026-07-26**: 292,407 events -> 50,551 active summaries / 74.1 MB, exactly matching the simulation. Canonical events unchanged. Backup at `~/.memory/aaron.db.pre-phase11` — keep until GAP-11-A is closed. DB migrated to `user_version: 2`.
- Live corpus is also 6 days stale (last import 2026-07-20) and Codex was never imported at all (4,738 session files, no grant).

## Known Constraint

(Cleared 2026-07-26 — the `.git/index.lock` write restriction no longer applies; commits work normally.)

## Session

**Last session:** 2026-07-27T15:35:00.000Z
**Stopped at:** Plan 11-13 Task 1 complete (recall probe run, before/after-filter captured); result is negative — GAP-11-D raised (anchor detection bypasses derivation-input hygiene). Task 2 (owner authorization) and Task 3 (execute live prune) NOT run — halted at the gate, both because this execution was not authorized for the destructive step and because the evidence shows the prune would not close the gap. Next: owner reviews `11-GAP-11-D.md` and `11-RECALL-PROBE.md`, scopes a follow-up plan for anchor hygiene, and decides whether to proceed with 11-13 Task 2/3 regardless.
**Resume file:** .planning/phases/11-derivation-input-hygiene/11-13-PLAN.md (Task 2)

## Performance Metrics

| Phase | Plan | Duration | Notes |
|-------|------|----------|-------|
| Phase 05 P05 | 15min | 3 tasks | 12 files |
| Phase 05 P06 | 10min | 2 tasks | 4 files |
| Phase 05 P07 | 7min | 2 tasks | 3 files |
| Phase 05 P08 | 12min | 2 tasks | 9 files |
| Phase 05 P09 | 15min | 2 tasks | 6 files |
| Phase 11 P01 | 3min | 3 tasks | 3 files |
| Phase 11 P06 | 55min | 3 tasks | 4 files |
| Phase 11 P08 | 5min | 3 tasks | 6 files |
| Phase 11 P09 | 25min | 3 tasks | 8 files |
| Phase 11 P10 | 5min | 3 tasks | 8 files |
| Phase 11 P11 | 25min | 3 tasks | 4 files |
| Phase 11 P12 | 20min | 3 tasks | 4 files |
| Phase 11 P15 | 25min | 3 tasks | 3 files |
| Phase 11 P13 (partial) | 45min | 1/3 tasks | 2 files |

## Decisions

- [v1.1 Roadmap]: REQ-050 (embedding deletion propagation) is delivered entirely in Phase 14 — Phase 8 only designs the tombstoning-capable schema/query surface as infrastructure; the actual `commitSourceDeletion` wiring and correctness gate lands in Phase 14, per requirement-to-phase 1:1 mapping.
- [v1.1 Roadmap]: The `createStagingStore` full-corpus-restage gap (flagged independently by FEATURES + PITFALLS research) is folded into Phase 12 (Forward-Only Vector Trace Discovery) rather than given its own phase, since it's the other half of "forward-only" for the same success criterion.
- [v1.1 Roadmap]: Scope-boundary partitioning and embedding-determinism guards are cross-cutting concerns folded into the success criteria of the phases that introduce storage (8) and the embedder (9), rather than standalone phases, per PITFALLS.md guidance.
- [Phase 11]: Slice-straddling tool runs are handled by extending `ContractionCheckpoint` with `pendingToolRun`, not by stable-id upsert of a provisional summary. — Upsert is eventually-correct but durably persists a tool count that is still growing; a crash, Phase 12 incremental embedding, or `memory explain` can consume that intermediate state as final.
- [Phase 05]: Confirmation tickets retain only process-local token and intent digests and are consumed before writes.
- [Phase 05]: Mutation applications keep exact preview plans process-local and use only task-specific atomic store commits.
- [Phase 05]: Proposal authorization closes every recursive summary, box, and trace dependency against profile person and scopes.
- [Phase 05]: History ingest resolves configured aliases and stages existing importers one deterministic resource batch at a time.
- [Phase 05]: Read tools capture already-authorized services at registration and omit database, profile, person, and scope authority from every input.
- [Phase 05]: Read failures expose only stable content-free protocol codes while success text is derived from the same structured object.
- [Phase 05]: Keep proposal approval and rejection as separate fixed-purpose preview/execute pairs with no action discriminator.
- [Phase 05]: Expose only bounded effect counts and content-free receipts while exact identifiers remain inside confirmation binding.
- [Phase 05]: Mark previews mutating and all executes non-idempotent; only durable decisions, revocation, and deletion are destructive.
- [Phase 05]: Keep one read-only MCP store per explicit profile and use short-lived write connections only for task-specific atomic commits. — Minimizes interactive write authority while preserving exact preview-execute state.
- [Phase 05]: Resolve config and profile authority before STDIO connect and reserve stdout exclusively for SDK JSON-RPC. — Fails closed without contaminating the MCP transport or disclosing configuration.
- [Phase 05]: Require structural Vitest JSON plus exact five-row validation approval for final signoff. — Prevents prose, skipped tests, or malformed validation artifacts from appearing green.
- [Phase 05]: Authorize the union of declared, payload, recursive Summary, Box, Trace, and next-effect dependencies before constructing proposal decisions.
- [Phase 05]: Bind normalized startup scopes and exact present-or-absent dependency state, then revalidate it with one shared pure validator before either adapter writes.
- [Phase 11]: Promoted the rule table, toolNameOf, and collapseText from 11-hygiene-sim.ts verbatim so implementation output stays comparable to the measured 55,930-summary / 77.6 MB targets
- [Phase 11]: derivationContents and openToolRunStart share one internal computeSegments walk so they can never disagree about where a tool run begins
- [Phase 11]: Slice-straddling tool runs handled via literal ContractionCheckpoint.pendingToolRun (owner decision 2026-07-26), documented in ADR 0048 — Upsert-and-correct is eventually-correct but durably persists a still-growing tool count that a crash, incremental embedding, or memory explain could consume as final
- [Phase 11]: Retrievable memory states are active/compacted/revived; excluded are superseded/stale/proposed/approved/rejected/disputed — GAP-11-A: applyRetrievalBoundary never filtered on state, so the derivation-hygiene rebuild's 87,727 superseded summaries were still retrieved and injected; enforced centrally so traces/boxes inherit exclusion
- [Phase 11]: Stale summaries use deferred revival: promoted to revived on scoring above the selected floor but excluded from the packet that triggered the promotion — Excluding stale from retrievable states removes the only trigger for revived, which refreshBoxState depends on for box revival; dropping revival entirely was rejected as it makes revived permanently unreachable
- [Phase 11]: Reused the single isRetrievableState predicate everywhere in the GAP-11-A sweep (MCP read/search, subject expansion, both stores' findNearestSummaries); no duplicate predicate introduced
- [Phase 11]: findNearestSummaries loads the retrievable summary-id set once per call, not per candidate row, to avoid reintroducing an O(n) hotspot; no summary_vectors schema change, tombstoning at supersession remains primary
- [Phase 11]: conversation-resumer.ts left unchanged (expands to raw Turn[] with no MemoryState field, already reachable via direct canonical-event queries per D-4); its separate lack of person/scope authorization flagged as residual risk, out of this plan's scope
- [Phase 11]: SummaryFilter mirrors ProposalFilter/TraceFilter idiom; scopeIds subset applied in JS post-fetch, personId/states pushed into an index-backed SQL WHERE clause (migration 3)
- [Phase 11]: prepareInjection makes exactly one filtered listSummaries call per request; applyRetrievalBoundary remains the sole authority, the store filter is an optimization only (T-11-30)
- [Phase 11]: commitSupersededSummaryPrune recomputes eligibility authoritatively inside the transaction; caller's summaryIds list is never trusted
- [Phase 11]: freedPayloadBytes/payloadBytes uses JSON.stringify(parsedSummary).length in both stores, provably identical to SqliteStore's length(payload) column
- [Phase ?]: Prune, not archive (ADR 0050): superseded summaries are pure derivations reproducible from canonical events via rebuild-derivations.
- [Phase 11]: GAP-11-B closed (Plan 11-15): hoisted per-summary normalization and reordered dedupeRankedMemory's box/thread/substring conjunction cheap-first, proven behavior-preserving by a 200+-case differential oracle held unedited across the fix and the benchmark. — Measured ~1.3M pairs/sec (~30x naive), clearing Plan 11-13's 1,000,000 pairs/sec sufficiency floor on first measurement -- no escape hatch fired, no GAP-11-C raised.
- [Phase 11]: Plan 11-13's Task 2/3 (owner authorization + live prune) withheld rather than presented/run, given Task 1's evidence that the prune cannot satisfy the plan's must_have. — Anchors, not superseded summaries, are the confirmed source of tool-call text in injection packets (GAP-11-D); presenting the authorization checkpoint as originally scoped would misrepresent what the destructive step accomplishes.

## Current Position

Phase: 11 (derivation-input-hygiene) — EXECUTING
Plan: 2 of 15
Status: Ready to execute
Last activity: 2026-07-27
