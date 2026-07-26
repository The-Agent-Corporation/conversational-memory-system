# Phase 11: Derivation Input Hygiene - Context

**Gathered:** 2026-07-26
**Status:** Ready for planning
**Source:** Synthesized from `11-SCOPE-INSERT.md` + `11-MEASUREMENT.md` (scope-insert express path), with three open questions resolved interactively.

<domain>
## Phase Boundary

Derivations are built from conversational content. Consecutive tool-call runs collapse into compact activity descriptions, isolated tool calls keep their text, neither drives topic labels, and harness-injected scaffolding is excluded from derivation input — while the canonical event timeline stays complete, immutable, and auditable.

**In scope:** deterministic event classification; tool-run collapse in the contraction path; removing tool activity from topic-label computation; excluding synthetic content from summarization/embedding/trace discovery/injection; rule versioning; audit reporting of exclusion rationale; resumable retroactive rebuild of existing derivations.

**Out of scope:** import-time filtering or deletion of any canonical event; quarantine replay implementation; vector/ANN work (Phases 12–14); changes to the proposal/review contract; re-importing source history; the missing Codex import; refreshing the 6-day-stale corpus.
</domain>

<decisions>
## Implementation Decisions

### Layering
- Hygiene is a **derivation-layer filter, never an import-time drop** (D-1). Every event continues to be imported and stays queryable. Only what feeds summarization changes.
- Excluded ≠ deleted (D-4). Excluded content stays in the canonical timeline, reachable through direct event queries and audit.

### Tool activity (REQ-052)
- A run of **≥2 consecutive tool-call events** within a contraction slice collapses to **one** derived activity line naming distinct tools and counts, never arguments (e.g. `ran 12 terminal commands, 3 file edits`).
- A **single isolated tool call keeps its existing text** — one deliberate action between two messages carries the "why."
- **Neither form feeds topic-label extraction or topic-change detection** (D-2, amended after measurement). Both attach to the surrounding conversational span as content only.
- Run boundaries follow canonical order within the slice, so the rule is deterministic and slice-local.

### Classification (REQ-053)
- Deterministic anchored rules, **no model, no network**. Emits `conversational` | `tool_activity` | `synthetic_injected` plus the matched rule ID.
- **Computed at contraction time; only the rule version is persisted** (resolved 2026-07-26). Classification is a pure function of `(content, eventKind, ruleVersion)`, so it is recomputed on demand rather than stored per event. No schema migration, no 292k-row backfill, no new sync surface. `memory explain` recomputes classification to report the exact rule that excluded an event.
- Accepted cost: "list every excluded event" is a scan, not an indexed query.
- Rule set carries a **version string**; a version bump marks affected derivations stale, mirroring how `parserVersion` already works for importers.
- **Conservative by default** — a rule fires only on unambiguous harness markers (anchored prefixes, structural wrappers). Anything unmatched stays `conversational`.

### Confirmed synthetic rules (measured hit counts)
User-role: `cron-session-tag` `[cron:` 7,909 · `harness-system` `[SYSTEM:` 5,561 · `automated-followup` `### Task:` + "follow-up questions" 2,210 · `system-reminder-only` 1,786 · `skill-invocation` `[IMPORTANT: The user has invoked` 1,038 · `city-harness-preamble` 274 · `context-compaction` 262 · `automated-task-block` 168 · `skill-body-injection` 127 · `local-command-stdout` 109 · `session-continuation` 86.

Assistant-role (measured 2026-07-26, resolving open question 2): `silent-sentinel` `[SILENT]` 2,784 · `structured-json-emission` (assistant message whose content is a bare JSON object — agent report output, not prose) 3,023. Thinking-only blocks are **not** imported at all (they sit in quarantine), so they need no rule.

### Rebuild (REQ-054)
- **Full rebuild**, not selective (resolved by measurement). 59% of summaries disappear and survivors' text changes, so a selection predicate buys nothing.
- Resumable, idempotent, checkpointed — reuse the Phase 10 backfill pattern.
- Must leave no duplicated or orphaned summaries, vectors, or trace assignments.

### Quarantine contract
- Phase 11 **states the contract and tests it; replay stays out of scope** (resolved 2026-07-26). Any future replayed `tool.result` record enters as `tool_activity`, never as conversational content. A test enforces this so a later replay cannot silently re-inject 23,878 tool outputs into summaries.

### Ordering
- This phase lands **before** daemon incremental embedding (Phase 12) and vector trace discovery (Phase 13), so embedding compute is never spent on content the system has already decided is not recallable (D-6).

### Resolved during research (2026-07-26)

- **Both contraction paths, one shared module.** Research surfaced a second live path: `src/integrations/hermes/adapter.ts:54` runs its own `TopicMonitor`, and `src/compaction/pre-compactor.ts` its own summarizer, entirely parallel to `ContractionRunner`. Classification and collapse live in **one pure module** applied at **both** seams, so memory quality never depends on which route ingested an event. The Hermes bridge is the live agent path — changes there affect running agent behavior (AGENTS.md), so it needs explicit test coverage.
- **Tool runs straddling a slice boundary must still collapse to one line.** `DEFAULT_CONTRACTION_LIMITS.maxEvents` is 250 and slices also end on a time budget, so a run can span two `drainSlice` calls at a point that varies with interruption timing. `ContractionCheckpoint` is **extended to carry pending-run state**. The alternative (accept two activity lines) would make output depend on where an interruption fell, directly violating success criterion 5. The unbounded simulation never encountered this case, so it is untested by the measurement.
- **Collapse text format is fixed and deterministic:** raw tool names with counts, ordered by count descending then name ascending, never arguments — matching `11-hygiene-sim.ts` so implementation output stays comparable to the measured targets.

### Addendum 2026-07-26 — decision 6 reaffirmed (owner sign-off)

The plan-checker flagged that Plan 11-02's first draft satisfied decision 6 *implicitly* — relying on `summaryForSpan` recomputing the active span's window from `allEvents` every slice, so a provisional summary written mid-run is upserted with the complete run next slice — rather than by extending `ContractionCheckpoint`. **The owner rejected the implicit form and reaffirmed the literal checkpoint extension.** Plan 11-02 was revised accordingly.

Rationale for the record: the implicit design is eventually-correct but not per-slice-correct. It durably persists an intermediate summary carrying a tool count that is still growing (`ran 120 tool calls` for a run that will reach 300). That state is observable — a crash leaves it final, Phase 12's incremental embedder can embed it, and `memory explain` can report it. The same gap applies to a length-1 tail at a boundary, where isolated-single (keep verbatim) and run-head (collapse) are indistinguishable until the next event arrives.

Implementation shape:
- `ContractionCheckpoint` gains `pendingToolRun: { startEventId, eventCount, toolCounts, ruleVersion } | null`. Checkpoints persist as a JSON `payload` blob, so this needs **no DDL and no schema-version bump** — only a `null` default for pre-existing payloads in the already-idempotent `migrateDaemonContractionPayloads`. `in-memory-store.ts` is untouched.
- A non-complete slice whose trailing active span ends inside an open tool run **withholds** that run from the summary's derivation text and records it in the checkpoint. Provenance is unaffected: `sourceCanonicalEventIds` still covers the full window.
- On resume the runner re-derives the open run and **fails closed to the rewind/invalidation path** if the recorded `startEventId` no longer heads an open run there — the guard against a late import landing inside a withheld run.
- `complete === true` always flushes: a run at the end of the corpus cannot grow.
- Consequence carried into Plan 11-02 Task 4: anchors for a withheld run are also deferred and re-emitted (idempotently, by deterministic id) when the run closes, so the anchor set is slice-size-independent.
</decisions>

<canonical_refs>
## Canonical References

- `.planning/phases/11-derivation-input-hygiene/11-SCOPE-INSERT.md` — evidence, design decisions D-1..D-6, open questions
- `.planning/phases/11-derivation-input-hygiene/11-MEASUREMENT.md` — measured impact, variant comparison, fidelity check
- `.planning/phases/11-derivation-input-hygiene/11-hygiene-sim.ts` — simulation harness; re-runnable to validate the implementation against the same numbers
- `.planning/REQUIREMENTS.md` — REQ-052, REQ-053, REQ-054
- `src/daemon/contraction-runner.ts:142-160` — where events are observed into `TopicMonitor`; the integration point for classification and collapse
- `src/daemon/contraction-runner.ts:295-340` — `summaryForSpan` / `turnFromEvent`; where span content becomes summary text
- `src/topic/topic-monitor.ts:140-190` — `extractTopicLabel` / `isTopicChange`; the zero-word-overlap rule that causes fragmentation
- `src/summarization/summarizer.ts` — `DeterministicSummarizer.buildSummaryText` (first 3 non-empty contents)
- `src/imports/tool-call-record.ts:25` — `createToolCallEvent`, the source of `[Tool call: …]` content
- `src/service/derivation-invalidator.ts` — existing invalidation machinery to reuse for rebuild
- `docs/adr/` — a new ADR (0048) is expected for the hygiene contract
</canonical_refs>

<specifics>
## Measured Baseline and Target

The simulation harness replays all 292,407 events through the real `TopicMonitor` and summarizer. Its baseline pass reproduces the persisted corpus **exactly** — 135,366 summaries, 51,266 containing `[Tool call:` — so these targets are measured, not estimated.

| | Summaries | Volume |
|---|---|---|
| Today | 135,366 | 228.9 MB |
| Target after Phase 11 | **55,930 (−59%)** | **77.6 MB (−66%)** |

Corpus composition: `tool_activity` 186,548 (63.8%) · `conversational` 86,329 (29.5%) · `synthetic_injected` 19,530 (6.7%). Tool structure: 33,176 runs of ≥2 covering 168,852 events, plus 17,696 isolated singles.

Expected residual: ~11,571 summaries still containing `[Tool call:` — isolated singles inside conversational spans. That is the intended outcome, not leftover noise.

**Key mechanism to preserve in implementation:** collapse alone moves volume (−61%) but barely moves count (−14%). The count reduction comes from tool activity no longer driving topic labels. An implementation that collapses but still lets activity lines open their own span will hit the volume target and miss the count target — the plan must verify both.
</specifics>

<deferred>
## Deferred

- Quarantine replay implementation (contract only in this phase).
- Codex import — never run; 4,738 session files, no grant. Separate work.
- Refreshing the 6-day-stale corpus and running the Phase 10 backfill against it (the live DB is still at schema version 1 with no vector table).
- Any change to `TopicMonitor`'s zero-word-overlap heuristic itself beyond excluding tool activity from it. The heuristic's fragility is now documented but re-designing topic segmentation is its own phase.
- Import-time filtering, should it ever be wanted, remains explicitly rejected by D-1.
</deferred>

<scope_fence>
## Scope Fence

**Do not:**
- Drop, mutate, or filter canonical events at import time.
- Add columns to `canonical_events` or migrate the schema for classification.
- Delete or rewrite existing canonical events during rebuild.
- Change the proposal/review/accept contract or any trace shape.
- Introduce a model or network dependency into classification or summarization (REQ-040).
- Implement quarantine replay.
- Touch vector/ANN behavior beyond ensuring rebuilt summaries invalidate their vectors correctly.
</scope_fence>

<risk_summary>
## Risks

- **Rebuild correctness on a 5 GB live corpus.** A partial or non-idempotent rebuild could orphan vectors or trace assignments. Mitigation: checkpointed/resumable pattern from Phase 10, plus an interrupt-and-resume test asserting equality with an uninterrupted run.
- **Over-aggressive rules eating real conversation.** A prefix like `### Task:` can appear in genuine user text. Mitigation: conservative anchoring, rule-by-rule hit counts reviewed against the measured baseline, and a spot-check that no rule's hit count exceeds its measured expectation by a wide margin.
- **Silent divergence between simulation and implementation.** Mitigation: re-run `11-hygiene-sim.ts` after implementation; the real pipeline must land on 55,930 summaries / 77.6 MB for the same corpus.
- **Topic-label change altering unrelated behavior.** `TopicMonitor` output feeds anchors and spans beyond summaries. Mitigation: assert anchor behavior is unchanged for conversational events.
- **Provenance loss in `summaryForSpan`.** It reconstructs turns positionally (`sourceEvents[k]` sits at `startSequence + k`). Collapsing N events into one derived line breaks that assumption if handled naively. `sourceCanonicalEventIds` must remain the FULL raw event list so provenance and deletion-invalidation stay correct — only the text fed to the summarizer changes. Research flags this as the highest-risk detail.
- **Downstream consumers keying off summary text.** `src/boxes/box-assigner.ts`, trace candidate generation, and `src/retrieval/memory-retriever.ts` all read `summary.summaryText` directly, so count/content changes ripple into box assignment, trace candidates, and retrieval scoring. Success criterion 7 must be tested against these, not just against summary counts.
</risk_summary>
