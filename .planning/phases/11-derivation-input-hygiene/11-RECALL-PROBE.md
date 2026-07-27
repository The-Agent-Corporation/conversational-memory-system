# Phase 11 Plan 13 — Recall Probe Results

Produced by `11-recall-probe.ts` against the frozen query set in `11-RECALL-QUERIES.md` (12 queries,
fixed `hostSessionId`/`requestedAt`/`maxMemoryTokens`, identical harness for every run). Raw artifacts:
the harness writes `<out>.json` and `<out>.md` (not a directory named `<out>`) — this file is hand-
assembled from those two JSON outputs, not a third harness run.

**Headline result: the state filter did NOT eliminate tool-call text from injection packets. The tally
got marginally worse, not better.** See "Diagnostic: where the tool-call text is coming from" below —
this is a confirmed root cause (anchors), not a probe defect, and it is the subject of GAP-11-D.

## Databases probed

| Label | Database | Summary counts by state | Notes |
|---|---|---|---|
| `before` | scratch copy of `~/.memory/aaron.db.pre-phase11` (`cp -c`, APFS clone) | `{"compacted":135366}` | Pre-hygiene backup; original backup file verified untouched (mtime/size identical: 4,962,574,336 bytes, 2026-07-26 19:26) before and after this run |
| `after-filter` | `~/.memory/aaron.db` (live, as of this probe) | `{"compacted":50551,"superseded":87727}` | Post-hygiene-rebuild, post-state-filter (Plan 11-10), prune NOT yet applied — the 87,727 superseded rows are present but unreachable |
| `after-prune` | N/A | N/A | **Not run. Live prune requires owner authorization (Task 2 of this plan) and, per the diagnostic below, would not change this result anyway — see "Why the prune doesn't fix this" below.** |

Embedder for both runs: `deterministic` / `keyword-hash-v1` (the always-on default; no embeddings sidecar
enabled on either database).

## Elapsed time (GAP-11-B evidence)

| | before (135,366 unfiltered summaries) | after-filter (50,551 active summaries) | ratio |
|---|---|---|---|
| Total (12 queries) | 1,509,789.1 ms (~25.2 min) | 523,680.4 ms (~8.7 min) | ~2.9x faster |

Before Plan 11-15 closed GAP-11-B, this extrapolated to hours-to-days per run (measured ~48,900
pairs/sec on the live corpus); the entire 12-query set — run against the LARGER pre-hygiene corpus —
now completes in ~25 minutes, and the smaller post-filter corpus in under 9 minutes. That is Plan
11-13's performance floor met with margin, on real data, not a synthetic benchmark.

## Per-query results

| Query | before packet | before conf | before ms | before toolCall | before harness | before srcIds | after-filter packet | after conf | after ms | after toolCall | after harness | after srcIds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Q1 | packet | 0.92 | 150,890.0 | **true** | false | 0 | packet | 0.92 | 73,109.8 | **true** | false | 0 |
| Q2 | packet | 0.47 | 42,014.5 | false | **true** | 3 | packet | 0.55 | 19,400.0 | **true** | false | 1 |
| Q3 | packet | 0.73 | 41,408.1 | **true** | false | 0 | packet | 0.92 | 11,664.0 | **true** | false | 0 |
| Q4 | packet | 0.55 | 61,961.8 | **true** | false | 2 | packet | 0.58 | 34,787.6 | **true** | false | 1 |
| Q5 | packet | 0.55 | 19,896.0 | **true** | false | 2 | packet | 0.55 | 12,145.8 | false | false | 0 |
| Q6 | packet | 0.73 | 359,473.4 | false | false | 1 | packet | 0.95 | 103,343.9 | **true** | false | 0 |
| Q7 | packet | 0.63 | 227,955.3 | **true** | false | 1 | packet | 0.79 | 82,952.1 | **true** | false | 1 |
| Q8 | packet | 0.55 | 87,053.3 | **true** | false | 1 | packet | 0.55 | 39,094.0 | false | false | 2 |
| Q9 | packet | 0.88 | 251,461.8 | **true** | false | 0 | packet | 0.88 | 69,899.5 | **true** | false | 0 |
| Q10 | packet | 0.70 | 86,162.6 | **true** | false | 1 | packet | 0.70 | 27,727.6 | **true** | false | 2 |
| Q11 | packet | 0.70 | 162,756.8 | false | false | 3 | packet | 0.73 | 38,263.4 | **true** | false | 1 |
| Q12 | packet | 0.31 | 18,755.5 | **true** | false | 2 | packet | 0.31 | 11,292.7 | **true** | false | 1 |

**Tally:**

| | containsToolCallText | containsHarnessText |
|---|---|---|
| before (12 queries) | 9 / 12 | 1 / 12 |
| after-filter (12 queries) | **10 / 12** | 0 / 12 |
| after-prune | not run | not run |

Harness-injected text (`[SYSTEM:`, `[cron:`, `[SILENT]`) dropped from 1/12 to 0/12 — the state filter
does help there (Q2's `after-filter` top match is no longer the harness-flagged summary it was in
`before`). But tool-call text got worse on the raw count, and byte-identical in the worst case: **Q1's
`after-filter` `selectedMemory` preview is byte-identical to its `before` preview** — same `[Tool call:
Write] {"file_path":".../06-01-SU...` text, same 0.92 confidence, same 0 `sourceSummaryIds`. The state
filter changed what's stored (87,727 superseded summaries excluded from the retrievable set) but did not
change what got selected for Q1, Q3, Q9 at all.

**This is a negative result against the plan's must_have**: "After the prune, no injection packet for
any probe query contains tool-call or harness-injected text" is currently FALSE for 10/12 queries, and
per the diagnostic below the prune itself cannot make it true.

## Diagnostic: where the tool-call text is coming from

**Question:** why does `prepareInjection` still select raw `[Tool call: ...]` text as the top-ranked
memory for most queries, when Phase 11's derivation-hygiene rebuild collapsed tool-call runs out of
summary text?

**Answer, confirmed by reading the retrieval and anchor-detection code (not speculation):**

`sourceSummaryIds: 0` on Q1, Q3, Q6, Q9 (after-filter) means the top-ranked, selected `RankedMemory` is
not `kind: "summary"` — `rankSummary` always sets `summaryIds: [summary.id]` (length 1), so a `0`-length
`sourceSummaryIds` on the winning item can only come from `kind: "anchor"` (`summaryIds: []` in
`rankAnchor`, `src/retrieval/memory-retriever.ts:505`) or `kind: "box_context"` (also `summaryIds: []`,
`src/retrieval/memory-retriever.ts:303`). Anchor text traces straight back to `Anchor.content`, which
`buildAnchor` (`src/anchors/anchor-detector.ts:50-69`) sets to `content: turn.content` — **the raw
`Turn` content, verbatim, with no hygiene transform applied.**

`turn.content` for a tool-call turn is exactly the `[Tool call: ${name}] ${argumentSummary}` string
produced at import time by `createToolCallEvent` (`src/imports/tool-call-record.ts:38-40`) — this is the
same literal format the probe's `containsToolCallText` flag detects.

Critically, `AnchorDetector.detectForTurn(turn)` is called **unconditionally for every ingested turn**
in the live Hermes bridge (`src/integrations/hermes/adapter.ts:89`: `const anchorResult = turn ? await
this.anchorDetector.detectForTurn(turn) : { anchors: [] };`), with no `eventKind`/hygiene-classifier
gate. Contrast this with the topic-labeling call three lines above it (`adapter.ts:83-87`), which
explicitly checks `drivesTopicLabel({ content: event.content, eventKind: event.eventKind, role:
event.role })` before observing an event — the shared hygiene classifier that Phase 11 wired into
contraction and topic labeling was **never wired into anchor detection**. `detectAnchorTypes`
(`anchor-detector.ts:23-48`) runs its regex (`decided|decision|we will|...|because|therefore|...`)
against raw tool-call argument JSON — which routinely contains exactly those words, since a `Write` or
`Edit` tool call's payload is very often a planning doc, ADR, or commit message full of "decision",
"because", "confirmed", etc. That is why tool-call turns keep generating anchors that outscore genuine
summary text: the regex hits are dense in structured planning-doc JSON.

**This refutes STATE.md's standing hypothesis** that `conversation-resumer.ts`'s raw `Turn[]` expansion
was the leak path. `conversation-resumer.ts` is a separate resume-flow feature not on the
`prepareInjection` path the probe exercises at all — it was never implicated by this evidence.
Anchor detection is a distinct, confirmed mechanism, and it existed (and ran unfiltered) both before and
after Phase 11's summary-hygiene rebuild, which is exactly why the before/after-filter comparison shows
almost no improvement on the tool-call tally.

**Why the prune doesn't fix this:** `commitSupersededSummaryPrune` deletes superseded *summary* rows.
Anchors are a separate store entity (`store.listAnchors()` in `prepareInjection`, `memory-retriever.ts:40`)
with no state filter and no relationship to summary supersession — pruning summaries changes nothing
about which anchors exist or how they rank. The must_have "no injection packet contains tool-call or
harness text" cannot be satisfied by the live prune; it requires hygiene at the anchor-detection layer
itself (out of this plan's scope — see `11-GAP-11-D.md`).

## after-prune column

Not populated. The live prune was not authorized in this plan's Task 2 (see `11-13-SUMMARY.md`), and
per the diagnostic above it would not move the tool-call tally regardless of authorization — the prune
targets summaries, and the leak path identified here is anchors, a store entity the prune command never
touches.
