# Phase 11 Plan 19 — Measurement Correction

**Purpose:** Plan 11-19 corrected three verified defects in `11-recall-probe.ts` (the harness behind
`11-RECALL-PROBE.md` and GAP-11-E). This document records what the defects were, what the corrected
probe measures instead, and — for every historical number produced by the old harness — whether it
survives the correction or is non-comparable. It edits no historical artifact; `11-RECALL-PROBE.md`
is unchanged by this plan.

---

## The three defects

### Defect 1 — the harness detector was a 3-rule subset of the 13 shipped rules

**Evidence:** pre-11-19 `11-recall-probe.ts:177-182` computed `containsHarnessText` as:

```js
selectedMemory.includes("[SYSTEM:") || selectedMemory.includes("[cron:") || selectedMemory.includes("[SILENT]")
```

against the 13-rule shipped classifier at `src/topic/derivation-hygiene.ts:56-72`
(`SYNTHETIC_RULES`). Ten rules — `skill-invocation`, `automated-followup`, `automated-task-block`,
`skill-body-injection`, `context-compaction`, `session-continuation`, `local-command-stdout`,
`system-reminder-only`, `city-harness-preamble`, `structured-json-emission` — were never tested by
the harness. Demonstrated miss: `11-RECALL-PROBE.md`'s `after-filter` run recorded Q7 and Q8 as
`containsHarnessText: false`, but both top matches begin `### Task:` (`automated-task-block` /
`automated-followup`), which the hand-rolled subset cannot see. GAP-11-E anomaly 2 independently
found the same class of miss on Q12's `<task-notification>` preview (defect 3 below, a different,
still-open miss).

**Fix:** the probe now classifies every selected item with `classifyEvent` (anchored) and separately
scans it for every `SYNTHETIC_MARKERS` entry (substring, catches scaffolding embedded mid-summary).
`SYNTHETIC_MARKERS` is exported from `src/topic/derivation-hygiene.ts` and consumed by
`SYNTHETIC_RULES` itself, so the probe and the product cannot drift apart again (T-11-60).

### Defect 2 — no per-item attribution; `sourceSummaryIds` was read as if it were per-item

**Evidence:** `packet.selectedMemory` (`src/retrieval/memory-retriever.ts:76`) is the join of every
selected item's text, so the old boolean genuinely did cover the whole packet — that part of the
prior reasoning was correct. What was missing is attribution: nothing recorded which memory, or
which rank, carried the offending text. Worse, `packet.sourceSummaryIds`
(`src/retrieval/memory-retriever.ts:77`) is `[...new Set(selected.flatMap((memory) =>
memory.summaryIds))]` — a **packet-wide union across every selected item**, not a property of
whichever item is unhygienic. GAP-11-E's central inference ("the four survivors all have non-empty
`sourceSummaryIds`, therefore the winning memory is summary-derived") reads a packet-wide union as if
it discriminated the *top-ranked* item specifically, which it cannot do once more than one item is
selected.

**Fix:** the probe reconstructs the real `selected: RankedMemory[]` by composing the four now-exported
pure functions `applyRetrievalBoundary -> rankMemories -> selectMemories -> addParentBoxContext`
(`src/retrieval/memory-retriever.ts:161,411,234,273`) in `prepareInjection`'s exact order, against the
same store state, strictly BEFORE calling `prepareInjection` for that query (reconstructing afterwards
would rank against state `prepareInjection` had already mutated via `saveInjection`, summary-access
bookkeeping, and deferred-revival promotion). Per item it now records `rank`, `kind`, `id`,
`summaryIds`, `traceId`, `boxIds`, `tokenCount`, `score`, a 200-char preview, `containsToolCallText`,
`classification` (`classifyEvent` output), and `markersFound`. A fidelity guard asserts
`reconstructed.map(m => m.text).join("\n\n") === packet.selectedMemory` and throws, naming the query
id, if it does not — the probe refuses to report an unattributable number rather than silently
degrading (T-11-59).

### Defect 3 — `<task-notification>` is in neither the probe nor the product's rules

**Evidence:** GAP-11-E anomaly 2: Q12's `after-anchor-prune` preview is literally
`<task-notification> <task-id>...`, visible harness scaffolding, and `SYNTHETIC_RULES`
(`src/topic/derivation-hygiene.ts:56-72`) has no rule matching it — this is a genuine gap in the
*product's* rule table, not a probe-detector miss like defects 1 and 2.

**Not fixed here.** This plan does not add a rule for `<task-notification>` — that is Plan 11-20's
scope (`src/topic/derivation-hygiene.ts` is explicitly out of scope for 11-19; see 11-19-PLAN.md's
critical constraints). This document names it so a reader does not mistake Plan 11-19's `markersFound`
/ `classification` fields as already covering it: a `<task-notification>` item will still classify
`conversational` and produce no `markersFound` entry until 11-20 lands.

---

## Comparability table

| Historical column | Source | Re-runnable with corrected harness? | Reason |
|---|---|---|---|
| `before` (pre-hygiene backup, 135,366 summaries) | `11-RECALL-PROBE.md` | **Non-comparable as recorded; re-runnable from the backup.** | `containsHarnessText` was measured against 3/13 rules (Defect 1); the corrected harness reads a different, wider predicate under the same field name. Re-running against `~/.memory/aaron.db.pre-phase11` (or the later `.pre-anchor-prune` backup, whichever precedes the query) with the corrected probe would produce a genuinely comparable number, but the number in the document today is not that number. |
| `after-filter` (hygiene rebuild + GAP-11-A state filter) | `11-RECALL-PROBE.md` | **Non-comparable as recorded; not independently re-runnable** — the live corpus has since moved past this state (anchor prune applied, Plan 11-18). Only re-runnable against a backup taken at that state, if one exists. | Same Defect 1 gap, plus Defect 2: the `sourceSummaryIds` column for this run was already being over-read for attribution before the anchor prune even happened. |
| `after-anchor-prune` (GAP-11-D closed, Plan 11-18) | `11-RECALL-PROBE.md`, `11-GAP-11-E.md` | **Non-comparable as recorded; re-runnable from the live corpus (`~/.memory/aaron.db`), which is the corpus this row describes and has not been further mutated by Plan 11-19.** | Same Defect 1 gap. This is the row GAP-11-E's four-survivor inference rests on — see below. Re-running it with the corrected harness is exactly what Plan 11-21 does; this plan does not re-run it (11-19-PLAN.md: "This plan touches NO live database"). |

**Plain statement for every later reader:** the `containsHarnessText` column is optimistic in **all
three** historical rows, because 10 of 13 rules were never tested by the old detector — so the
reported trend "1/12 → 0/12 → 1/12" is an artifact of which 3 patterns the detector happened to check,
not a real change in the underlying corpus between runs. Do not draw a conclusion from that trend.

The `containsToolCallText` column is different in kind: it DOES cover the whole packet (the boolean
tests the joined `selectedMemory` text against a single, correct literal), so it is not a
Defect-1-style undercount — but it is unattributed. It cannot say **which** selected memory carried
the tool-call text, so it cannot itself establish "the top-ranked item is a summary." That conclusion
requires attribution, which the old harness never had.

**Consequently:** GAP-11-E's inference that all four survivors (Q1, Q3, Q4, Q10) are summary-derived
because their `sourceSummaryIds` is non-empty does not follow from the evidence it cites, since
`sourceSummaryIds` is a packet-wide union over ALL selected items, not a property of whichever item
carries the tool-call text (Defect 2). The conclusion may still be true — by elimination, since the
unhygienic anchor path was closed and pruned in Plan 11-18, and if an anchor never enters `selected[]`
at all, the union argument degenerates into a correct one-item inference — but that has not been
established with attribution. **Plan 11-22 is what will establish it or refute it**, using this
plan's per-item `items[]` output against the same four queries.

---

## Open scope tension: SC3 vs. the isolated-tool-call decision vs. 11-13's must_have

ROADMAP.md's Phase 11 SC3 states: "Summaries built under the new rules contain no verbatim
harness-injected content and no `[Tool call:` argument text **from collapsed runs**." That predicate
is scoped to collapsed runs specifically. `11-CONTEXT.md`'s locked tool-activity decision states: "A
single **isolated** tool call keeps its existing text — one deliberate action between two messages
carries the 'why.'" Both explicitly tolerate `[Tool call:` text surviving for an isolated tool call;
neither forbids it outright.

`11-13-PLAN.md`'s must_have — "After the prune, no injection packet for any probe query contains
tool-call or harness-injected text" — is a **blanket** predicate with no isolated-call carve-out. It
is stricter than SC3, stricter than SC7 ("recall quality does not regress"), and stricter than the
locked decision in `11-CONTEXT.md`.

**This plan does not resolve that tension** — it names it so a later reader does not conflate "Plan
11-13's must_have failed" with "SC3 failed." **Plan 11-22 must classify each of the four (or however
many, post-11-20) offending items against SC3 and the locked decision specifically** — was the
surviving `[Tool call:` text collapsed-run overflow (an SC3 violation) or an isolated call kept
verbatim by design (not a violation)? — using this plan's `items[].classification` /
`items[].containsToolCallText` output to make that determination per item, not per packet.
