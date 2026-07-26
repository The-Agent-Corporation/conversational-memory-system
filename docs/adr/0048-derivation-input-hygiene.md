# ADR 0048: Derivation Input Hygiene

## Status

Accepted

## Context

The canonical event timeline is complete and immutable, but derivation (summarization,
embedding, trace discovery, injection) does not have to consume it uniformly. The live
292,407-event corpus measured in `11-MEASUREMENT.md` classified as 63.8% `tool_activity`
(186,548 events — 33,176 runs of >=2 consecutive tool calls covering 168,852 events, plus
17,696 isolated singles), 29.5% `conversational` (86,329), and 6.7% `synthetic_injected`
harness scaffolding (19,530 events: `cron-session-tag`, `harness-system`,
`automated-followup`, `system-reminder-only`, `skill-invocation`, and seven smaller rules).

Two problems compounded:

1. **Verbatim tool argument text dominated summarization volume.** Every tool call's raw
   arguments flowed into the same summarizer input as human conversation.
2. **Tool and harness noise fragmented real conversations.** `TopicMonitor.isTopicChange`
   (`src/topic/topic-monitor.ts:177`) closes a topic span whenever the next event's topic
   label shares zero significant words with the current label. A collapsed activity line
   like `[Activity] ran 12 tool calls: 8 terminal, 4 read` shares no vocabulary with the
   surrounding conversation, so — even after collapsing run text — it still opened its own
   span. Measurement showed this precisely: collapsing runs alone cut summary *volume* by
   61% but summary *count* by only 14%. The other 45 points of count reduction come only from
   removing tool/synthetic events from topic-label computation entirely. **An implementation
   that collapses runs but still lets activity lines open their own span hits the volume
   target and misses the count target** — this is the wrong variant, and REQ-052/053's
   measured targets are architected around detecting it.

Target (measured, not estimated, by replaying the full corpus through the real
`TopicMonitor` and `DeterministicSummarizer`): 135,366 -> 55,930 summaries (-59%), 228.9 MB
-> 77.6 MB (-66%), with ~11,571 residual summaries still containing `[Tool call:` — the
isolated singles inside conversational spans, which is intended, not leftover noise.

## Decision

**Hygiene is a derivation-layer filter, never an import-time drop (D-1).** Every event is
still imported, stored, and queryable. Only what feeds summarization, embedding, trace
discovery, and injection changes. Excluded content is excluded from derivation, not deleted
(D-4) — it remains reachable through direct canonical-event queries and `memory explain`.

### Classification (REQ-053)

One pure, deterministic module — `src/topic/derivation-hygiene.ts` — classifies an event or
turn into `conversational | tool_activity | synthetic_injected` from `(content, eventKind,
role)` alone. No model, no network, no randomness (REQ-040). Anchored, conservative rules:
unmatched content stays `conversational`. `HYGIENE_RULE_VERSION` versions the rule table.

**Classification is computed at contraction time; only the rule version is persisted.**
Classification is a pure function, so it is recomputed on demand rather than stored per
event — no schema migration, no 292k-row backfill, no new sync surface, and `memory explain`
can recompute the exact rule that excluded any event on demand. The accepted cost is that
"list every excluded event" is a scan rather than an indexed query.

### Tool-run collapse and label exclusion (REQ-052, amending the original D-2)

- A run of **>=2 consecutive tool-call events** collapses to **one** derived activity line
  naming distinct tools and counts, never arguments (`collapseText`).
- An **isolated single tool call keeps its existing text** verbatim — one deliberate action
  between two messages carries the "why."
- **Neither form feeds topic-label extraction or topic-change detection.** Both attach to
  the surrounding conversational span as content only. This is the count-reduction
  mechanism, not the collapse itself — see Context above.
- `synthetic_injected` events are excluded from derivation entirely: dropped before both
  label computation and summarization/embedding/trace/injection input.
- Run boundaries are computed by one shared walk (`computeSegments`) used by both
  `derivationContents` (the text a span derives) and `openToolRunStart` (whether a window
  ends inside a still-growing run), so the two views of "where a run begins" can never
  disagree.

### Two seams, one shared module

Both live derivation paths import `src/topic/derivation-hygiene.ts` directly — no local rule
table is duplicated anywhere:

- `ContractionRunner.drainSlice` (`src/daemon/contraction-runner.ts`) gates
  `TopicMonitor.observe` on `drivesTopicLabel`, tracks an explicit per-span `[windowStart,
  windowEnd)` raw provenance window separate from a narrower `derivationEnd` text window, and
  gates anchor generation on the same `derivationEnd` boundary.
- The live Hermes bridge (`src/integrations/hermes/adapter.ts`) gates its own
  `TopicMonitor.observe` call the same way; `src/compaction/pre-compactor.ts` feeds the
  summarizer `derivationContents`-transformed turns. Both are the running-agent path
  (AGENTS.md), so behavior changes here affect live agent memory immediately, not just batch
  contraction.

### Provenance invariance

`sourceCanonicalEventIds` (and a span's raw `[windowStart, windowEnd)` window) always covers
the **complete raw event set**, including collapsed run members, withheld pending-run
members, and excluded synthetic events. Only the TEXT fed to the summarizer is narrowed via
a separate `derivationEnd` index. `DerivationInvalidator`, `affectedStartIndex`, and
`summaryIntersectsAtOrAfter` all key off the full raw list — a content decision never
narrows what a summary's deletion/rewind provenance depends on.

### Tool runs straddling a slice boundary — the `pendingToolRun` decision

`ContractionCheckpoint` gains a `pendingToolRun: { startEventId, eventCount, toolCounts,
ruleVersion } | null` field, persisted in the checkpoint's existing JSON payload (no DDL, no
schema-version bump; `in-memory-store.ts` untouched). When a slice's trailing active span
ends inside a still-open tool run, that run is **withheld from the summary's derivation text
entirely** and recorded in the checkpoint; on resume, the runner re-derives the open run and
fails closed to the rewind/invalidation path if the checkpoint's recorded `startEventId` no
longer heads an open run (a late import landing inside a withheld run). A run at the end of
the corpus (`complete === true`) always flushes — it cannot grow further. Anchors for a
withheld run are deferred and re-emitted (idempotently, by deterministic id) when the run
closes.

**This was deliberately NOT implemented as upsert-and-correct** — an earlier draft of Plan
11-02 relied on `summaryForSpan` recomputing the active span's window from `allEvents` every
slice, so a provisional summary written mid-run would be upserted with the complete run on
the next slice. Reviewed and **rejected by the project owner on 2026-07-26** in favor of the
literal checkpoint extension above.

**Rationale for the record:** the upsert-and-correct design is eventually-correct but not
per-slice-correct. It durably persists an intermediate summary carrying a tool count that is
still growing (`ran 120 tool calls` for a run that will reach 300). That state is
observable — a crash leaves it as the final persisted value, Phase 12's incremental embedder
can embed it, and `memory explain` can report it as authoritative. The same gap applies to a
length-1 tail at a slice boundary, where an isolated single (keep verbatim) and the head of a
growing run (collapse) are indistinguishable until the next event arrives. The literal
`pendingToolRun` extension guarantees no intermediate/growable tool count is ever durable,
observable, or embeddable — only a fully-closed run's final count is ever persisted.

### Rebuild (REQ-054)

**Full rebuild, not selective** — 59% of summaries disappear and survivors' text changes
under the hygiene rules, so a selection predicate buys nothing. `memory rebuild-derivations`
detects staleness via `ContractionRunner.PROCESSOR_VERSION` (which embeds
`HYGIENE_RULE_VERSION`, so a rule-version bump automatically marks every existing checkpoint
stale through the existing rewind/invalidation path), bumps the contraction job's generation
with `earliestAffected` rewound to the first canonical event, and drives the same
`drainSlice` loop `HistoricalBootstrapper` uses — resumable, idempotent, checkpointed. After
each slice, `deleteSummaryVectors` runs against `ContractionSliceResult.supersessions`
(`kind === "summary"`) so a rebuild leaves no orphaned vectors.

### Quarantine contract

Phase 11 states the contract and tests it; replay implementation stays out of scope. Any
future replayed `tool.result` record must enter derivation as `tool_activity`, never as
conversational content, so a later replay cannot silently re-inject bulk tool output into
summaries. Cross-reference: ADR 0045 (bounded parser quarantine and replay) owns the
quarantine/replay mechanism itself; this ADR only constrains how a replayed record must be
classified once replay exists.

### Audit surface

`memory explain` gains an `event` subject reporting `{ derivationClass, ruleId, ruleVersion,
eventKind, role }`, recomputed live through the same shared `classifyEvent`, and the
existing `summarized` verb reports `hygieneRuleVersion` / `conversationalEventCount` /
`toolActivityEventCount` / `syntheticExcludedEventCount` / `excludedRuleIds` /
`missingSourceEventCount` for any summary's source events — so the exclusion rationale for
any canonical event is always recoverable (REQ-053), with zero schema changes.

## What was NOT done

- **No `derivationClass` column** on `canonical_events`. Classification stays a pure,
  on-demand recomputation from `(content, eventKind, role, HYGIENE_RULE_VERSION)`.
- **No import-time filtering or deletion.** D-1 and D-4 are absolute; every event is
  imported and remains queryable regardless of its derivation classification.
- **No change to `TopicMonitor`'s zero-word-overlap heuristic itself**, beyond excluding
  tool/synthetic events from ever invoking it. The heuristic's fragility toward genuine
  conversational topic drift is now documented (11-MEASUREMENT.md) but redesigning topic
  segmentation is explicitly out of scope for this phase.
- **No quarantine replay implementation.** Only the contract (replayed tool output must
  classify as `tool_activity`) is stated and tested.

## Consequences

- Phases 12 (incremental embedding) and 13 (vector trace discovery) operate on ~56k vectors
  instead of ~135k on the live corpus — less than half the ANN index, and far less
  near-duplicate mass from repeated tool-call boilerplate.
- Trace thresholds and top-K must be recalibrated after this phase; any tuning performed
  against the pre-hygiene 135k-summary corpus does not transfer.
- Retrieval quality improves independently of any vector work: conversations discussed
  across tool-heavy interruptions now stay in one summary instead of being split mid-topic,
  verified in `tests/retrieval/memory-retriever.test.ts`'s cross-session forward-recall
  assertion (Plan 06, SC7).
- `memory rebuild-derivations` must be run once against the live database to realize these
  numbers; re-deriving before Phase 12 begins avoids spending embedding compute on content
  the system has already decided is not recallable (D-6, ordering decision).
- Every future contraction-path or live-bridge change that reads `summary.summaryText`
  (`src/boxes/box-assigner.ts`, `src/traces/trace-candidate-core.ts`,
  `src/retrieval/memory-retriever.ts`, `src/retrieval/memory-query-service.ts`) is now
  reading hygiene-transformed text, not raw event content — reviewed and confirmed
  compatible in Plan 06's blast-radius sweep (REQ-052, REQ-053, REQ-054 traceability below).

## Requirement Traceability

| Requirement | Where |
|---|---|
| REQ-052 | Tool-run collapse (`collapseText`), isolated-single preservation, label exclusion (`drivesTopicLabel`) — `src/topic/derivation-hygiene.ts`, wired into `src/daemon/contraction-runner.ts` and `src/integrations/hermes/adapter.ts` |
| REQ-053 | Deterministic anchored classification (`classifyEvent`, `SYNTHETIC_RULES`), synthetic exclusion from derivation, versioned rule table, `memory explain`'s `event` subject and `summarized` hygiene detail |
| REQ-054 | `HYGIENE_RULE_VERSION`-driven staleness via `PROCESSOR_VERSION`, `memory rebuild-derivations` full/resumable/checkpointed rebuild, `deleteSummaryVectors` orphan cleanup |
