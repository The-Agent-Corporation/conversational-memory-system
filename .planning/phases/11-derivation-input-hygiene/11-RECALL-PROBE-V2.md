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

All three columns were produced by the SAME v2 harness and ARE comparable with each other.
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

`probe-v2/before-v2.{json,md}`, `probe-v2/after-filter-v2.{json,md}`, `probe-v2/current-v2.{json,md}`.
Each JSON records `probeVersion`, the database path, summary counts by state, total elapsed, and per
query the full `items[]` array with rank, kind, id, summaryIds, score, preview, classification and
`markersFound`.
