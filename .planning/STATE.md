---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Vector-Native Traces + Semantic Recall
current_phase: 11
current_plan: 1
status: gaps_found
stopped_at: Completed 11-06-PLAN.md
last_updated: "2026-07-26T23:19:06.615Z"
last_activity: 2026-07-26
progress:
  total_phases: 15
  completed_phases: 8
  total_plans: 71
  completed_plans: 70
  percent: 53
---

# Project State

**Current phase:** 11
**Current plan:** 1
**Status:** Ready to execute
**Last updated:** 2026-07-26

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
- **GAP-11-A (blocking, found 2026-07-26):** the live rebuild left 87,727 superseded summaries holding pre-hygiene tool-call text, and retrieval never filters on `state` — `applyRetrievalBoundary` (`src/retrieval/memory-retriever.ts:142`) filters `personId`/`scopeIds` only, `rankMemories` filters `score > 0` only. Superseded summaries are therefore still retrieved and injected, breaking REQ-053's injection clause. Reproduced in isolation. Pre-existing bug, made active by the rebuild. Next: `/gsd:plan-phase 11 --gaps`.
- **Live corpus rebuilt 2026-07-26**: 292,407 events -> 50,551 active summaries / 74.1 MB, exactly matching the simulation. Canonical events unchanged. Backup at `~/.memory/aaron.db.pre-phase11` — keep until GAP-11-A is closed. DB migrated to `user_version: 2`.
- Live corpus is also 6 days stale (last import 2026-07-20) and Codex was never imported at all (4,738 session files, no grant).

## Known Constraint

(Cleared 2026-07-26 — the `.git/index.lock` write restriction no longer applies; commits work normally.)

## Session

**Last session:** 2026-07-26T23:19:06.603Z
**Stopped at:** Completed 11-06-PLAN.md
**Resume file:** None

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

## Current Position

Phase: 11 (derivation-input-hygiene) — GAPS FOUND
Plan: 3 of 7
Status: Ready to execute
Last activity: 2026-07-26
