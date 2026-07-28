# Phase 11 Plan 21 — Corrected Recall Probe Baseline (probeVersion 2)

**Produced:** 2026-07-27 by Plan 11-21, using the harness Plan 11-19 corrected.
**Supersedes for measurement purposes:** `11-RECALL-PROBE.md` (probeVersion 1). That document is
retained unedited as the evidence trail; see `11-MEASUREMENT-CORRECTION.md` for which of its numbers
survive the correction and which do not.

The frozen query set (`11-RECALL-QUERIES.md`) is byte-unchanged. Only the measurement changed.

## What probeVersion 2 measures differently

| | v1 harness | v2 harness |
|---|---|---|
| Harness-text oracle | 3 hand-rolled `includes()` patterns | the shipped `classifyEvent` / all 13 `SYNTHETIC_RULES` |
| Scope | `packet.selectedMemory` only (rank 0) | every item in the packet, attributed by rank |
| Attribution | boolean per query | per item: rank, kind, id, score, classification, `markersFound` |
| Fidelity | n/a | reconstruction asserted equal to the real packet before use |

## Columns

| Label | Database | Summary states | Notes |
|---|---|---|---|
| `before-v2` | `cp -c` clone of `~/.memory/aaron.db.pre-phase11` | `{compacted: 135366}` | Pre-hygiene. Original verified unchanged (4,962,574,336 bytes, 2026-07-26 19:26) before and after. |
| `after-filter-v2` | `cp -c` clone of `~/.memory/aaron.db.pre-anchor-prune` | `{compacted: 50551, superseded: 87727}` | The post-rebuild / pre-anchor-prune state, recovered from the backup taken 2026-07-27 11:23. Original verified unchanged. |
| `current-v2` | `~/.memory/aaron.db` (live, read-only) | `{compacted: 50551, superseded: 87727}` | Post anchor prune (26,643 anchors deleted, 19,268 retained). |
| `final-v2` | `~/.memory/aaron.db` (live) | `{compacted: 49253, superseded: 89120}` | Post the owner-authorized live rebuild of 2026-07-28 (Plan 11-25 Task 3, `504685d`) at `hygiene-rules/v3`. Added by Plan 11-26. |
| `post-v4` | `~/.memory/aaron.db` (live) | `{compacted: 49314, superseded: 89059}` | Post the owner-authorized `hygiene-rules/v4` rebuild **and** the 330-anchor prune of 2026-07-28 (Plan 11-29, `11-REBUILD-V4.md`). Added by Plan 11-29. |

All five columns were produced by the SAME v2 harness (`11-recall-probe.ts`, byte-unchanged since Plan
11-19) against the SAME frozen query set (`11-RECALL-QUERIES.md`, byte-unchanged) and ARE comparable
with each other — **with one qualification stated in "Comparability qualification" below, which affects
the `product-unhygienic` column only.**
None of them is comparable to any number in `11-RECALL-PROBE.md`.

## Totals

| arm | elapsed | packet items | items w/ tool-call | unhygienic items | Q w/ tool-call | Q w/ unhygienic | top-item tool-call | top-item harness |
|---|---|---|---|---|---|---|---|---|
| `before-v2` | 2,940,407.9 ms | 36 | 19 (52.8%) | 6 | 9/12 | 4/12 | 9/12 | 4/12 |
| `after-filter-v2` | 1,044,483.0 ms | 34 | 22 (64.7%) | 3 | 10/12 | 3/12 | 10/12 | 3/12 |
| `current-v2` | 762,497.0 ms | 33 | **6 (18.2%)** | 6 | **4/12** | 4/12 | 4/12 | 4/12 |

## Per-query detail

Columns: packet items · items containing tool-call text · unhygienic items · ranks of unhygienic items · kind of the top item · elapsed.

### before-v2

| Q | items | tool-call | unhyg | unhyg ranks | top kind | elapsed ms |
|---|---|---|---|---|---|---|
| Q1 | 3 | 3 | 0 | [] | anchor | 297,683.6 |
| Q2 | 3 | 0 | 2 | [1, 2] | summary | 81,782.5 |
| Q3 | 3 | 2 | 0 | [] | anchor | 79,432.9 |
| Q4 | 3 | 2 | 1 | [1] | anchor | 112,448.7 |
| Q5 | 3 | 1 | 1 | [1] | anchor | 36,612.1 |
| Q6 | 3 | 0 | 0 | [] | anchor | 702,353.7 |
| Q7 | 3 | 2 | 0 | [] | anchor | 447,964.1 |
| Q8 | 3 | 2 | 0 | [] | anchor | 162,568.1 |
| Q9 | 3 | 3 | 0 | [] | anchor | 486,346.6 |
| Q10 | 3 | 3 | 0 | [] | summary | 169,350.2 |
| Q11 | 3 | 0 | 0 | [] | summary | 320,725.1 |
| Q12 | 3 | 1 | 2 | [1, 2] | anchor | 43,140.3 |

### after-filter-v2

| Q | items | tool-call | unhyg | unhyg ranks | top kind | elapsed ms |
|---|---|---|---|---|---|---|
| Q1 | 3 | 3 | 0 | [] | anchor | 142,627.5 |
| Q2 | 3 | 2 | 0 | [] | anchor | 38,377.7 |
| Q3 | 3 | 3 | 0 | [] | anchor | 23,970.4 |
| Q4 | 3 | 3 | 0 | [] | summary | 67,864.3 |
| Q5 | 1 | 0 | 0 | [] | anchor | 22,288.1 |
| Q6 | 3 | 1 | 0 | [] | anchor | 206,988.7 |
| Q7 | 3 | 1 | 1 | [0] | anchor | 167,379.4 |
| Q8 | 3 | 0 | 1 | [0] | anchor | 76,946.0 |
| Q9 | 3 | 3 | 0 | [] | anchor | 139,076.1 |
| Q10 | 3 | 2 | 0 | [] | summary | 54,547.3 |
| Q11 | 3 | 2 | 0 | [] | anchor | 78,676.5 |
| Q12 | 3 | 2 | 1 | [2] | anchor | 25,741.0 |

### current-v2

| Q | items | tool-call | unhyg | unhyg ranks | top kind | elapsed ms |
|---|---|---|---|---|---|---|
| Q1 | 3 | 2 | 0 | [] | anchor | 108,037.6 |
| Q2 | 3 | 0 | 2 | [1, 2] | summary | 24,887.5 |
| Q3 | 3 | 2 | 1 | [2] | summary | 10,852.7 |
| Q4 | 3 | 1 | 1 | [2] | summary | 52,546.0 |
| Q5 | 1 | 0 | 0 | [] | anchor | 11,802.4 |
| Q6 | 3 | 0 | 0 | [] | anchor | 138,134.3 |
| Q7 | 3 | 0 | 0 | [] | anchor | 139,034.7 |
| Q8 | 3 | 0 | 0 | [] | anchor | 56,196.6 |
| Q9 | 2 | 0 | 0 | [] | anchor | 108,317.2 |
| Q10 | 3 | 1 | 0 | [] | summary | 40,469.1 |
| Q11 | 3 | 0 | 0 | [] | summary | 59,887.7 |
| Q12 | 3 | 0 | 2 | [0, 1] | summary | 12,331.4 |

## What the corrected measurement establishes

**1. The harness under-count was real and large.** On the identical pre-hygiene corpus, the v1
detector reported harness text in 1/12 queries; the 13 shipped rules report **4/12**. Q7 and Q8 in
the v1 `after-filter` run were the demonstrated misses — both top memories begin `### Task:`
(`automated-task-block`) and were recorded `false`.

**2. Whole-packet scanning changed less than expected.** Packets hold only ~3 items, so
"whole packet" and "top item only" cannot diverge much: for tool-call text both read 9/12 in
`before-v2`. Defect 2 was real but small in effect. The per-item view is still the more informative
one — 19/36 items (52.8%) carried tool-call text before, 6/33 (18.2%) now — and it is what makes the
attribution below possible.

**3. The anchor prune produced a large, real improvement.** Items containing tool-call text fell from
22/34 (64.7%) at `after-filter-v2` to 6/33 (18.2%) at `current-v2`. That is measured on one harness
across two states, so it is a sound comparison.

**4. Elapsed time fell across the board** — 2,940,408 ms → 1,044,483 ms → 762,497 ms — despite the v2
harness ranking every query twice (once to reconstruct for attribution, once through the real
`prepareInjection`, with an equality assertion between them).

## Correction (2026-07-27, after Plan 11-22): the two predicates name DIFFERENT queries

The totals table above reports `Q w/ tool-call` and `Q w/ unhygienic` as 4/12 each for `current-v2`.
Those are two different predicates over two different item sets, and they coincidentally share a
total. They do not name the same queries:

| predicate | queries |
|---|---|
| `toolCallItemCount > 0` | Q1, Q3, Q4, Q10 |
| `unhygienicItemCount > 0` | Q2, Q3, Q4, Q12 |
| overlap | Q3, Q4 only |
| **union — queries carrying ANY unhygienic content** | **Q1, Q2, Q3, Q4, Q10, Q12 = 6/12** |

**The honest headline for `current-v2` is 6/12, not 4/12.** Reporting the two columns separately
without their union understates the contamination rate. SC7 sign-off must state which predicate it is
judged against, or judge against the union; Plan 11-22's finding recommends reconciling this and that
recommendation is adopted here.

## Attribution of the residue in `current-v2` (evidence for Plan 11-22)

Recorded as observation, not diagnosis. Plan 11-22 owns the root cause.

Every contaminated item in `current-v2` is `kind: summary` with an id prefixed `historical_summary_`:

| Q | rank | item id | tool-call | classification | markersFound |
|---|---|---|---|---|---|
| Q1 | 1 | `historical_summary_015a8c0126ac90404eb9f` | true | conversational | [] |
| Q1 | 2 | `historical_summary_069babea134604e241f1a` | true | conversational | [] |
| Q3 | 0 | `historical_summary_0719251073aa374a981e0` | true | conversational | [] |
| Q3 | 2 | `historical_summary_e189f4cde7f7ba30fcfee` | true | conversational | `['task-notification']` |
| Q4 | 0 | `historical_summary_67d56fcbf796b6df1b9d0` | true | conversational | [] |
| Q10 | 1 | `historical_summary_a42dfe862bbe5a5479ddf` | true | conversational | [] |

Two facts follow directly from the table and are worth stating precisely:

- **Every one classifies `conversational` while carrying tool-call text.** The contamination is
  therefore invisible to `classifyEvent` as applied to the summary body.
- **Q3 rank 2 has `markersFound: ['task-notification']` and still classifies `conversational`.** The
  v2 rule added by Plan 11-20 *detects the marker in the body* but does not fire, because every
  `SYNTHETIC_RULE` is an anchored `startsWith` and the marker is not at the start of the text.

The mechanical implication — that anchored rules cannot fire on scaffolding embedded mid-body, and so
neither Plan 11-20's new rules nor any re-classification of existing summary text will clean these
items — is stated here as a consequence of the data. Whether that means the collapse rules leak, an
unfiltered summarizer input path exists, or these are simply summaries the rebuild never regenerated
(the `historical_summary_` prefix is suggestive but not conclusive) is exactly the question Plan 11-22
must answer with evidence before any remediation is chosen.

## Raw artifacts

`probe-v2/before-v2.{json,md}`, `probe-v2/after-filter-v2.{json,md}`, `probe-v2/current-v2.{json,md}`,
`probe-v2/final-v2.{json,md}`.
Each JSON records `probeVersion`, the database path, summary counts by state, total elapsed, and per
query the full `items[]` array with rank, kind, id, summaryIds, score, preview, classification and
`markersFound`.

---

# `final-v2` — post-remediation measurement (Plan 11-26, 2026-07-28)

**Run:** `2026-07-28T01:44:04Z`, 689,217.8 ms across 12 queries, against the live
`~/.memory/aaron.db` at `hygiene-rules/v3`, `{compacted: 49253, superseded: 89120}`,
embedder `deterministic/keyword-hash-v1`. Artifact: `probe-v2/final-v2.{json,md}`.

**What changed in the corpus since `current-v2`** (per `11-REBUILD.md`, Task 3): the owner-authorized
live `rebuild-derivations` run of 2026-07-28 (`504685d`), which applied all three GAP-11-E fixes at once
via `hygiene-rules/v3` — H-0 (SC1 reversed: an isolated tool call now collapses instead of being kept
verbatim), H-i (line-anchored `matchesEmbedded` rule matching), H-iii (the corpus reprocessed under the
v2/v3 rules it had never seen). Active summaries 50,551 → 49,253; superseded 87,727 → 89,120; **anchors
19,268 → 19,268, unchanged, zero resurrected.** No anchor was pruned, added, or altered between
`current-v2` and `final-v2`. Every corpus-side delta below is therefore a **summary**-side delta.

## The three predicates, reported separately

Per `11-REMEDIATION-DECISION.md`'s addendum, which is the recorded acceptance target and is quoted
verbatim here:

> **SC7 should be judged on tool-call + product-unhygienic.** `probe-suspicious` is advisory: each hit
> must be inspected individually before it counts against the criterion, because the fix that would
> "close" it is the over-matching one this phase deliberately rejected.

| figure | predicate | `final-v2` items | `final-v2` queries |
|---|---|---:|---:|
| **tool-call** | `containsToolCallText` (`[Tool call: ` substring) | **0 / 33** | **0 / 12** |
| **product-unhygienic** | `classification.derivationClass === "synthetic_injected"` | **2 / 33** | **2 / 12** (Q1, Q3) |
| *probe-suspicious (advisory)* | `markersFound.length > 0` | *4 / 33* | *3 / 12* (Q1, Q2, Q3) |

Both tally forms, as measured, with no rounding and no framing:

- **queries affected:** tool-call **0/12**; product-unhygienic **2/12**; probe-suspicious **3/12**.
- **total unhygienic items:** tool-call **0**; product-unhygienic **2**; probe-suspicious **4**, out of
  **33 packet items across 12 queries**.

The **2 product-unhygienic items are one and the same anchor row**, retrieved by two different queries.
There is exactly **one** distinct offending object in the entire packet set.

**No union figure is reported as a headline.** The old "6/12 union" mixed two standards and
`11-REMEDIATION-DECISION.md` forbids using it unqualified. For completeness: the union of all three
predicates over `final-v2` is Q1, Q2, Q3 = **3/12**, unioning predicates that do not share a standard —
`probe-suspicious` deliberately over-matches relative to the other two.

## Per-query detail — `final-v2`

Columns: packet items · items containing tool-call text · product-unhygienic items · probe-suspicious
items · ranks flagged by the probe's combined `unhygienicRanks` · kind of the top item · elapsed.

| Q | items | tool-call | product-unhyg | probe-susp | probe ranks | top kind | elapsed ms |
|---|---|---|---|---|---|---|---|
| Q1 | 3 | 0 | 1 | 1 | [0] | anchor | 98,614.5 |
| Q2 | 3 | 0 | 0 | 2 | [1, 2] | summary | 22,960.8 |
| Q3 | 3 | 0 | 1 | 1 | [0] | anchor | 11,102.5 |
| Q4 | 3 | 0 | 0 | 0 | [] | summary | 49,480.1 |
| Q5 | 1 | 0 | 0 | 0 | [] | anchor | 11,717.4 |
| Q6 | 3 | 0 | 0 | 0 | [] | anchor | 128,147.8 |
| Q7 | 3 | 0 | 0 | 0 | [] | anchor | 120,052.3 |
| Q8 | 3 | 0 | 0 | 0 | [] | anchor | 48,086.0 |
| Q9 | 2 | 0 | 0 | 0 | [] | anchor | 97,600.6 |
| Q10 | 3 | 0 | 0 | 0 | [] | summary | 36,209.7 |
| Q11 | 3 | 0 | 0 | 0 | [] | summary | 54,385.7 |
| Q12 | 3 | 0 | 0 | 0 | [] | summary | 10,860.3 |

## Four-column totals, one harness, all four arms

| arm | elapsed ms | items | tool-call items | product-unhyg items | probe-susp items | Q tool-call | Q product-unhyg | Q probe-susp |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `before-v2` | 2,940,407.9 | 36 | 19 (52.8%) | 0 | 6 | 9/12 | 0/12 | 4/12 |
| `after-filter-v2` | 1,044,483.0 | 34 | 22 (64.7%) | 2 | 3 | 10/12 | 2/12 | 3/12 |
| `current-v2` | 762,497.0 | 33 | 6 (18.2%) | 0 | 6 | 4/12 | 0/12 | 4/12 |
| **`final-v2`** | **689,217.8** | **33** | **0 (0.0%)** | **2** | **4** | **0/12** | **2/12** | **3/12** |

Named queries per predicate per arm:

| arm | tool-call | product-unhygienic | probe-suspicious |
|---|---|---|---|
| `before-v2` | Q1 Q3 Q4 Q5 Q7 Q8 Q9 Q10 Q12 | — | Q2 Q4 Q5 Q12 |
| `after-filter-v2` | Q1 Q2 Q3 Q4 Q6 Q7 Q9 Q10 Q11 Q12 | Q7 Q8 | Q7 Q8 Q12 |
| `current-v2` | Q1 Q3 Q4 Q10 | — | Q2 Q3 Q4 Q12 |
| **`final-v2`** | **—** | **Q1 Q3** | **Q1 Q2 Q3** |

Note the totals table in the earlier part of this document reports `before-v2`/`after-filter-v2`/
`current-v2` under the column headings `items w/ tool-call`, `unhygienic items`, `Q w/ unhygienic`.
Its `unhygienic` columns are the probe's COMBINED predicate (`synthetic_injected` OR
`markersFound.length > 0`), which is why its `unhygienic items` for `current-v2` reads 6 while this
table splits the same 6 into 0 product-unhygienic + 6 probe-suspicious. Same underlying data, decomposed.

### Comparability qualification — the `product-unhygienic` column

**This is a real limitation and it is stated rather than smoothed over.** The probe computes
`classification` and `markersFound` with the product code **as it exists at run time**, not as it
existed at corpus-write time. The first three arms ran at `hygiene-rules/v2`; `final-v2` ran at `v3`.

- The **tool-call** column is fully comparable across all four arms: `TOOL_CALL_PREFIX` is a literal
  substring test and did not change.
- The **probe-suspicious** column is fully comparable: `git diff a84eea7 f96ad9a -- src/topic/derivation-hygiene.ts`
  confirms v2 → v3 changed only the matching *strategy* (`startsWith` → `matchesEmbedded`); the
  `SYNTHETIC_MARKERS` list itself is unchanged, and `markersFound` is a bare `includes` over that list.
- The **product-unhygienic** column is **not strictly comparable**: v3's `matchesEmbedded` is a
  superset of v2's leading-anchored match, so a v3 hit is not proof the same item would have been a v2
  hit. For the one offender this actually matters for, the ambiguity is resolved by inspection rather
  than left open — see below.

## Per-item attribution of every flagged item in `final-v2`

| Q | rank | kind | id | tool-call | classification | ruleId | markersFound |
|---|---|---|---|---|---|---|---|
| Q1 | 0 | anchor | `anchor_personal_turn_event_1a2df6be…_decision` | false | **synthetic_injected** | `task-notification` | `['task-notification']` |
| Q2 | 1 | summary | `historical_summary_72ee7793622e…` | false | conversational | — | `['silent-sentinel']` |
| Q2 | 2 | summary | `historical_summary_b8edf3787d49…` | false | conversational | — | `['silent-sentinel']` |
| Q3 | 0 | anchor | `anchor_personal_turn_event_1a2df6be…_decision` | false | **synthetic_injected** | `task-notification` | `['task-notification']` |

Q1 rank 0 and Q3 rank 0 are **the same anchor id**.

### Inspection of the 1 product-unhygienic object (required before it counts)

`anchor_personal_turn_event_1a2df6becaf54cc1bd30060f77fd42070ceab4f5419bf77ad5f28f6e1fc9712b_decision`,
7,153 chars, `createdAt: 2026-07-19T19:10:26.265Z`. Its content begins at offset 0 with:

```
<task-notification>
<task-id>ad9fcda454611c95c</task-id>
<tool-use-id>toolu_01WJGjq9visnXBJrc3NTEQZ1</tool-use-id>
<output-file>/private/tmp/claude-501/…/tasks/ad9fcda454611c95c.output</output-file>
<status>completed</status>
<summary>Agent "Execute plan 08 of phase 06" finished</summary>
```

**This is genuine harness scaffolding, not prose about scaffolding.** It is a true positive and counts
as residual. Four facts establish where it came from, each checked directly rather than inferred:

1. **It is not summary-derived.** `kind: anchor`, `summaryIds: []`. GAP-11-E is a summary-path gap; this
   object is not on that path.
2. **It is not rebuild damage.** It is present in `~/.memory/aaron.db.pre-rebuild-v3` and in
   `~/.memory/aaron.db.pre-anchor-prune` — it predates both the rebuild and the anchor prune, and
   survived 11-18's prune because that prune classified under `hygiene-rules/v1`, in which the
   `task-notification` rule did not yet exist (Plan 11-20 added it in v2).
3. **Its appearance is a ranking change, not a classifier artifact.** The marker sits at offset 0, so
   v2's leading-anchored matcher would have classified it `synthetic_injected` too — the v2→v3 matcher
   widening is not what surfaced it. It simply was **not in `current-v2`'s packets at all**: in
   `current-v2`, Q1 rank 0 was a different anchor and Q3's three items were all summaries. The rebuild
   rewrote or eliminated the summaries that previously outranked it, and it rose to rank 0.
4. **It is one of the known 350.** `11-REBUILD.md`'s second finding records exactly 350 anchors in the
   live corpus that classify `conversational` under v1 but `synthetic_injected` under v3, unchanged in
   count by the rebuild and already carried into Plan 11-14 as open owner decision (a).

**Consequence worth stating plainly rather than burying:** the top-ranked memory for Q1 and Q3 is raw
`<task-notification>` harness scaffolding. Tool-call text is gone from the packets; this particular
shape of harness text is not.

### Inspection of the 2 probe-suspicious-only items (advisory, per the recorded target)

Both are Q2 summaries flagged `['silent-sentinel']` by the probe's bare `includes` scan while the
product classifies them `conversational`. Every occurrence of the `[SILENT]` marker in both was located
and its line printed:

| item | occurrences | at a line start? | context |
|---|---:|---|---|
| `historical_summary_72ee7793622e…` (33,658 chars) | 4 | **0 of 4** | e.g. `` | D11 | **Noise suppression** … | ~40/79 spans were silent `[SILENT]` cron noise; … | `` — a markdown table cell; the other three are backtick-quoted mentions inside bullet prose about noise-suppression design |
| `historical_summary_b8edf3787d49…` (18,650 chars) | 2 | **0 of 2** | the same D11 table row, and `` - **Light:** … collapse/dedupe repetitive automated `[SILENT]` / heartbeat runs … `` |

**These are exactly the shape Plan 11-24 predicted and the expected residue, not a defect.** They are
design prose *discussing* the `[SILENT]` sentinel, always backtick-quoted and never at a line start, so
the product's line-anchored classifier correctly leaves them `conversational`. Making the probe's
verdict here "pass" would require the unanchored mid-sentence matching this phase deliberately
rejected, which would suppress legitimate memory. **They do not count against SC7** under the recorded
target, and no follow-on work is proposed for them.

## Compliant-by-design vs. genuinely residual

The acceptance target changed under this phase, so the split has to be read against the *revised* target,
not 11-CONTEXT.md's original one. `11-REMEDIATION-DECISION.md` Decision 1 **reversed ROADMAP SC1** as an
explicit owner override: "**Revise SC1 so an isolated tool call is collapsed rather than kept
verbatim**, closing H-0." **The isolated-tool-call compliant-by-design class therefore no longer
exists** — it was not merely unhit in this run, it was abolished, and the measurement confirms the
reversal took effect (0 tool-call items, from 6).

| class | count | items |
|---|---:|---|
| compliant-by-design (isolated tool call, SC1's old carve-out) | **0** | the carve-out was removed by the SC1 reversal; nothing is excused under it |
| **genuinely residual** (counts against the target) | **1 distinct object, 2 packet items** | the `task-notification` anchor at Q1 r0 / Q3 r0 |
| advisory-only, inspected and dismissed | 2 items | the two Q2 `[SILENT]`-mentioning summaries |

## Per-query delta, `current-v2` → `final-v2` — improvements and regressions together

Read `tc / pu / ps` = tool-call / product-unhygienic / probe-suspicious item counts.

| Q | `current-v2` tc/pu/ps (items) | `final-v2` tc/pu/ps (items) | Δtc | Δpu | Δps | attribution |
|---|---|---|---:|---:|---:|---|
| Q1 | 2/0/0 (3) | 0/1/1 (3) | **−2** | **+1** | **+1** | H-0/H-iii cleaned two tool-call summaries; **regression**: a pre-existing `task-notification` anchor rose to rank 0 in their place |
| Q2 | 0/0/2 (3) | 0/0/2 (3) | 0 | 0 | 0 | unchanged — the two `[SILENT]`-discussing summaries, the expected H-i residue |
| Q3 | 2/0/1 (3) | 0/1/1 (3) | **−2** | **+1** | 0 | as Q1: two tool-call summaries cleaned, the same anchor surfaced in their place |
| Q4 | 1/0/1 (3) | 0/0/0 (3) | −1 | 0 | −1 | H-0 collapsed the tool-call summary; the `task-notification` summary at rank 2 was replaced by a clean one (H-iii) |
| Q5 | 0/0/0 (1) | 0/0/0 (1) | 0 | 0 | 0 | already clean |
| Q6 | 0/0/0 (3) | 0/0/0 (3) | 0 | 0 | 0 | already clean |
| Q7 | 0/0/0 (3) | 0/0/0 (3) | 0 | 0 | 0 | already clean |
| Q8 | 0/0/0 (3) | 0/0/0 (3) | 0 | 0 | 0 | already clean |
| Q9 | 0/0/0 (2) | 0/0/0 (2) | 0 | 0 | 0 | already clean |
| Q10 | 1/0/0 (3) | 0/0/0 (3) | −1 | 0 | 0 | H-0/H-iii cleaned the tool-call summary |
| Q11 | 0/0/0 (3) | 0/0/0 (3) | 0 | 0 | 0 | already clean |
| Q12 | 0/0/2 (3) | 0/0/0 (3) | 0 | 0 | −2 | H-iii: both `task-notification` summaries replaced by clean ones — this is the `<task-notification>` scaffolding GAP-11-E anomaly 2 flagged, now gone from the summary path |

**The result is mixed and is reported mixed.** Six tool-call items were eliminated across Q1, Q3, Q4 and
Q10 and four probe-suspicious summary items across Q4 and Q12, with **zero tool-call items anywhere in
the packet set**. Against that, **Q1 and Q3 each regressed by one product-unhygienic item** — the same
pre-existing `task-notification` anchor, previously outranked by the tool-call summaries the rebuild
cleaned, now winning rank 0 in both. The corpus contains no more of that anchor than it did before; the
cleanup changed what wins ranking, and what won next was already dirty.

Direct evidence of the rebuild rewriting a summary in place: `historical_summary_069babea…` appears at
Q1 in both arms under the same id, `containsToolCallText: true` in `current-v2` and `false` in
`final-v2` — the SC1 reversal collapsing an isolated tool call inside an existing summary id, exactly as
`11-REBUILD.md` describes upsert-on-deterministic-id behaving.

**Elapsed continued to fall**: 2,940,408 → 1,044,483 → 762,497 → **689,218 ms**.

## Instrument integrity

`11-RECALL-QUERIES.md` and `11-recall-probe.ts` are **byte-unchanged** — `git diff --exit-code` on both
is clean, verified before the run and after it. Neither was touched by this plan.

`~/.memory/aaron.db` was `stat`-checked before and after: inode **171672602** and size
**5,031,448,576 bytes** identical on both sides. Its **mtime advanced** (2026-07-27T21:36:32 →
21:55:36 local), which is expected and not incidental damage: `prepareInjection` writes by design
(`saveInjection`, summary access bookkeeping, deferred-revival promotion), the probe's header documents
this, and `current-v2` was produced against the live database the same way. No backup was read from,
written to, moved, or deleted.

## Secret scanning (GAP-11-F)

`probe-v2/final-v2.json` was scanned before staging and **contained the GAP-11-F plaintext Mission
Control login in a summary preview**, reproduced faithfully into the rebuilt summaries from the
untouched canonical events, exactly as `11-REBUILD.md` warned it would be. The password was replaced
with `[REDACTED]` in the committed artifact (1 occurrence; the file still parses as JSON). The
`onrender.com` 64-hex API key did not appear in either artifact. A follow-up sweep for vendor key
prefixes (`sk-`, `ghp_`, `AKIA`, `xox*`, JWTs), bare 32/40/64-hex runs, and `key|token|secret|password`
assignments is clean on both files — the one bare 64-hex string in the JSON is the public Bun installer
SHA-256, not a credential. The underlying corpus is unremediated; only the committed artifacts were
redacted.

---

# `post-v4` — measurement after the v4 rebuild and the 330-anchor prune (Plan 11-29, 2026-07-28)

**Run:** `2026-07-28T14:47Z` → `14:58Z`, **673,084.3 ms** across 12 queries, against the live
`~/.memory/aaron.db` at `hygiene-rules/v4`, `{compacted: 49314, superseded: 89059}`, embedder
`deterministic/keyword-hash-v1`. Artifact: `probe-v2/post-v4.{json,md}`.

**What changed in the corpus since `final-v2`** (per `11-REBUILD-V4.md`): the owner-authorized
`hygiene-rules/v4` rebuild — which restored the 123 trailing-sentinel events' text to the derived
corpus after Plan 11-28 narrowed `silent-sentinel` to the sentinel-only shape (GAP-11-H) — followed by
the owner-authorized prune of the **330** unambiguous scaffolding anchors (329 `task-notification`,
1 `harness-system`). Summaries: active 49,253 → 49,314, superseded 89,120 → 89,059, total rows
unchanged at 138,373. **Anchors 19,268 → 18,938.** Unhygienic anchors 330 → 0. The 20 silent-sentinel
anchors, which carry real reasoning behind a trailing sentinel, were verified present by id after the
prune and were deliberately NOT deleted.

## The three predicates, reported separately

Per `11-REMEDIATION-DECISION.md`'s addendum, quoted verbatim in the `final-v2` section above: SC7 is
judged on tool-call + product-unhygienic; `probe-suspicious` is advisory and each hit must be
inspected individually.

| figure | predicate | `post-v4` items | `post-v4` queries |
|---|---|---:|---:|
| **tool-call** | `containsToolCallText` (`[Tool call: ` substring) | **0 / 33** | **0 / 12** |
| **product-unhygienic** | `classification.derivationClass === "synthetic_injected"` | **0 / 33** | **0 / 12** |
| *probe-suspicious (advisory)* | `markersFound.length > 0` | *2 / 33* | *1 / 12* (Q2) |

Both tally forms, as measured, with no rounding and no framing:

- **queries affected:** tool-call **0/12**; product-unhygienic **0/12**; probe-suspicious **1/12**.
- **total flagged items:** tool-call **0**; product-unhygienic **0**; probe-suspicious **2**, out of
  **33 packet items across 12 queries**.

**No union figure is reported as a headline**, per the recorded target. For completeness the union of
all three predicates is Q2 alone = 1/12, unioning predicates that do not share a standard.

### Comparability qualification — carried forward, and it applies to this column

`final-v2` ran at `hygiene-rules/v3`; **this column runs at `v4`.** The probe computes
`classification` and `markersFound` with the product code as it exists at run time, so
**`product-unhygienic` is not strictly comparable across arms measured at different rule versions.**
That caveat has real force here rather than being boilerplate: v4 differs from v3 precisely in the
`silent-sentinel` rule, so an item classified `synthetic_injected` at v3 could classify
`conversational` at v4 without the corpus changing at all.

It does **not** explain this column's result. The one product-unhygienic object in `final-v2` fired
the `task-notification` rule, which v4 did not touch — it is absent from `post-v4` because the row was
**deleted from the anchors table**, verified at id level, not because the classifier changed its mind.
The **tool-call** column remains fully comparable across all five arms (`TOOL_CALL_PREFIX` is a literal
substring test, unchanged). The **probe-suspicious** column remains fully comparable (`markersFound`
is a bare `includes` over an unchanged `SYNTHETIC_MARKERS` list).

## Per-query detail — `post-v4`

Columns: packet items · items containing tool-call text · product-unhygienic items · probe-suspicious
items · ranks flagged by the probe's combined `unhygienicRanks` · kind of the top item · elapsed.

| Q | items | tool-call | product-unhyg | probe-susp | probe ranks | top kind | elapsed ms |
|---|---|---|---|---|---|---|---|
| Q1 | 3 | 0 | 0 | 0 | [] | anchor | 99,640.9 |
| Q2 | 3 | 0 | 0 | 2 | [1, 2] | summary | 22,819.6 |
| Q3 | 3 | 0 | 0 | 0 | [] | summary | 10,933.7 |
| Q4 | 3 | 0 | 0 | 0 | [] | summary | 47,521.4 |
| Q5 | 1 | 0 | 0 | 0 | [] | anchor | 10,527.8 |
| Q6 | 3 | 0 | 0 | 0 | [] | anchor | 121,010.1 |
| Q7 | 3 | 0 | 0 | 0 | [] | anchor | 117,565.9 |
| Q8 | 3 | 0 | 0 | 0 | [] | anchor | 48,996.1 |
| Q9 | 2 | 0 | 0 | 0 | [] | anchor | 95,720.6 |
| Q10 | 3 | 0 | 0 | 0 | [] | summary | 35,664.2 |
| Q11 | 3 | 0 | 0 | 0 | [] | summary | 52,600.4 |
| Q12 | 3 | 0 | 0 | 0 | [] | summary | 10,083.6 |

## Five-column totals, one harness, all five arms

| arm | elapsed ms | items | tool-call items | product-unhyg items | probe-susp items | Q tool-call | Q product-unhyg | Q probe-susp |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `before-v2` | 2,940,407.9 | 36 | 19 (52.8%) | 0 | 6 | 9/12 | 0/12 | 4/12 |
| `after-filter-v2` | 1,044,483.0 | 34 | 22 (64.7%) | 2 | 3 | 10/12 | 2/12 | 3/12 |
| `current-v2` | 762,497.0 | 33 | 6 (18.2%) | 0 | 6 | 4/12 | 0/12 | 4/12 |
| `final-v2` | 689,217.8 | 33 | 0 (0.0%) | 2 | 4 | 0/12 | 2/12 | 3/12 |
| **`post-v4`** | **673,084.3** | **33** | **0 (0.0%)** | **0** | **2** | **0/12** | **0/12** | **1/12** |

Named queries per predicate:

| arm | tool-call | product-unhygienic | probe-suspicious |
|---|---|---|---|
| `before-v2` | Q1 Q3 Q4 Q5 Q7 Q8 Q9 Q10 Q12 | — | Q2 Q4 Q5 Q12 |
| `after-filter-v2` | Q1 Q2 Q3 Q4 Q6 Q7 Q9 Q10 Q11 Q12 | Q7 Q8 | Q7 Q8 Q12 |
| `current-v2` | Q1 Q3 Q4 Q10 | — | Q2 Q3 Q4 Q12 |
| `final-v2` | — | Q1 Q3 | Q1 Q2 Q3 |
| **`post-v4`** | **—** | **—** | **Q2** |

Note the `before-v2` / `after-filter-v2` / `current-v2` rows in the document's earlier totals table use
the probe's COMBINED predicate under the heading `unhygienic items`; the table here decomposes the
same underlying data, as the `final-v2` section explains.

## Per-item attribution of every flagged item in `post-v4`

| Q | rank | kind | id | tool-call | classification | ruleId | markersFound |
|---|---|---|---|---|---|---|---|
| Q2 | 1 | summary | `historical_summary_72ee7793622e…` | false | conversational | — | `['silent-sentinel']` |
| Q2 | 2 | summary | `historical_summary_b8edf3787d49…` | false | conversational | — | `['silent-sentinel']` |

**No item in any packet is product-unhygienic, and no item contains tool-call text.**

### Inspection of the 2 probe-suspicious items (required before they count)

These are the same two summaries `final-v2` flagged, at the same ids, re-inspected here rather than
carried over on trust. Every `[SILENT]` occurrence in each was located and its line printed:

| item | chars | occurrences | at a line start? | context |
|---|---:|---:|---|---|
| `historical_summary_72ee7793622e…` | 33,658 | 4 | **0 of 4** | e.g. `` | D11 | **Noise suppression** … ~40/79 spans were silent `[SILENT]` cron noise … | `` — a markdown table cell; the other three are backtick-quoted mentions inside bullet prose about noise-suppression design (`spans.noise_class` marks … `suppressed` for `[SILENT]`) |
| `historical_summary_b8edf3787d49…` | 18,650 | 2 | **0 of 2** | the same D11 table row, and `` - **Light:** … collapse/dedupe repetitive automated `[SILENT]` / heartbeat runs … `` |

Both are design prose *discussing* the `[SILENT]` sentinel, always backtick-quoted, never at a line
start — so the product's line-anchored classifier correctly leaves them `conversational`. Making the
probe's verdict here "pass" would require the unanchored mid-sentence matching this phase deliberately
rejected (GAP-11-E), which would suppress legitimate memory. Under the recorded target they are
**advisory only and do not count**. No follow-on work is proposed for them.

Worth stating: these two summaries are *about* the sentinel that Plan 11-28's `isSentinelOnly` fix
concerns, and they are still here, still classified `conversational`, after a rebuild at v4 — which is
the fix behaving as designed on the summary side as well as the event side.

## Per-query delta, `final-v2` → `post-v4` — improvements and regressions together

Read `tc / pu / ps` = tool-call / product-unhygienic / probe-suspicious item counts.

| Q | `final-v2` tc/pu/ps (items) | `post-v4` tc/pu/ps (items) | Δtc | Δpu | Δps | packet ids identical? | attribution |
|---|---|---|---:|---:|---:|---|---|
| Q1 | 0/1/1 (3) | 0/0/0 (3) | 0 | **−1** | **−1** | no — rank 0 replaced | the `task-notification` anchor at rank 0 was pruned; a clean `conversational` anchor (`anchor_personal_turn_event_6049b2ef…_decision`) took its place. Ranks 1–2 unchanged |
| Q2 | 0/0/2 (3) | 0/0/2 (3) | 0 | 0 | 0 | yes | unchanged — the two `[SILENT]`-discussing summaries, inspected and dismissed above |
| Q3 | 0/1/1 (3) | 0/0/0 (3) | 0 | **−1** | **−1** | no — rank 0 removed | the same pruned anchor; the two summaries that were ranks 1–2 moved up and a third clean summary (`historical_summary_7fd648a0…`) entered at rank 2 |
| Q4 | 0/0/0 (3) | 0/0/0 (3) | 0 | 0 | 0 | yes | already clean |
| Q5 | 0/0/0 (1) | 0/0/0 (1) | 0 | 0 | 0 | yes | already clean |
| Q6 | 0/0/0 (3) | 0/0/0 (3) | 0 | 0 | 0 | yes | already clean |
| Q7 | 0/0/0 (3) | 0/0/0 (3) | 0 | 0 | 0 | yes | already clean |
| Q8 | 0/0/0 (3) | 0/0/0 (3) | 0 | 0 | 0 | yes | already clean |
| Q9 | 0/0/0 (2) | 0/0/0 (2) | 0 | 0 | 0 | yes | already clean |
| Q10 | 0/0/0 (3) | 0/0/0 (3) | 0 | 0 | 0 | yes | already clean |
| Q11 | 0/0/0 (3) | 0/0/0 (3) | 0 | 0 | 0 | yes | already clean |
| Q12 | 0/0/0 (3) | 0/0/0 (3) | 0 | 0 | 0 | yes | already clean |

**No regression on any query.** Two improvements (Q1, Q3), both attributable to a single deleted row.

**The narrowness of the change is itself worth reporting, and cuts against an easy reading.** Ten of
twelve packets are **identical id-for-id** to `final-v2`. The v4 rebuild restored the 123 events' text
and produced 61 net new active summaries, yet **not one of those summaries reached any packet in this
query set** — the only packet-visible movement came from the anchor prune. That the restoration was
worth doing rests on the argument in `11-GAP-11-H.md` (it stops the system deleting genuine memory),
not on evidence from these 12 queries, which do not exercise it. This probe measures contamination,
and a restoration that adds no contamination correctly shows up as nothing.

**Elapsed continued to fall**: 2,940,408 → 1,044,483 → 762,497 → 689,218 → **673,084 ms**.

## Instrument integrity

`11-RECALL-QUERIES.md` and `11-recall-probe.ts` are **byte-unchanged** — `git diff --exit-code` on both
is clean, verified before the run and after it. Neither was touched by this plan.

`~/.memory/aaron.db` was `stat`-checked around the run: inode **171672602** and size
**5,031,448,576 bytes** unchanged. Its mtime advanced, which is expected and documented behavior of
`prepareInjection` (`saveInjection`, summary access bookkeeping, deferred-revival promotion), the same
way `current-v2` and `final-v2` were produced. No backup was read from, written to, moved, or deleted;
all four (`pre-v4`, `pre-rebuild-v3`, `pre-anchor-prune`, `pre-phase11`) remain intact.

## Secret scanning (GAP-11-F)

`probe-v2/post-v4.json` was scanned before staging and **contained the GAP-11-F plaintext Mission
Control login in a summary preview** — reproduced faithfully into the rebuilt summaries from the
untouched canonical events, exactly as `11-REBUILD.md` warned and exactly as happened for `final-v2`.
The password was replaced with `[REDACTED]` in the committed artifact (1 occurrence; the file still
parses as JSON). `probe-v2/post-v4.md` contained 0 occurrences and was not modified. A sweep for
vendor key prefixes (`sk-`, `ghp_`, `gho_`, `AKIA`, `xox*`, JWTs), `key|token|secret|password`
assignments, and bare 32/40/64-hex runs is otherwise clean on both files — the one bare 64-hex string
in the JSON is the public Bun 1.3.10 installer SHA-256 (`BUN_INSTALL_SHA`), not a credential. The
underlying corpus is unremediated; only the committed artifact is redacted.

## No SC7 claim is made here

This column is a measurement, not an acceptance. SC7 sign-off is Plan 11-14 and the owner's call.
