# Plan 11-21 Summary — Re-baseline with the corrected harness

**Plan:** 11-21 (wave 19, gap closure for GAP-11-E)
**Status:** COMPLETE
**Date:** 2026-07-27

## What was done

Ran the frozen 12-query set through the Plan 11-19 corrected harness against three corpus states, and
recorded the results with per-item attribution in `11-RECALL-PROBE-V2.md`.

| arm | database | elapsed |
|---|---|---|
| `before-v2` | `cp -c` clone of `~/.memory/aaron.db.pre-phase11` | 2,940,407.9 ms |
| `after-filter-v2` | `cp -c` clone of `~/.memory/aaron.db.pre-anchor-prune` | 1,044,483.0 ms |
| `current-v2` | `~/.memory/aaron.db` live, read-only | 762,497.0 ms |

Both backups were cloned before use and verified byte-identical afterwards (pre-phase11
4,962,574,336 / 2026-07-26 19:26; pre-anchor-prune 5,031,448,576 / 2026-07-27 11:23). Neither original
was ever opened.

`11-RECALL-QUERIES.md` and `11-recall-probe.ts` are byte-unchanged.

## Results

| arm | items | tool-call items | unhygienic items | Q tool-call | Q unhygienic |
|---|---|---|---|---|---|
| `before-v2` | 36 | 19 (52.8%) | 6 | 9/12 | 4/12 |
| `after-filter-v2` | 34 | 22 (64.7%) | 3 | 10/12 | 3/12 |
| `current-v2` | 33 | 6 (18.2%) | 6 | 4/12 | 4/12 |

## What the correction proved, and what it did not

**Defect 1 (the 3-pattern harness detector) was real and large.** On the identical pre-hygiene corpus
the old detector reported harness text in 1/12 queries; the 13 shipped rules report 4/12 — a 4x
under-count. The predicted misses were confirmed: Q7 and Q8 both lead with `### Task:`
(`automated-task-block`).

**Defect 2 (top-item-only scanning) was real but small.** Packets hold only ~3 items, so whole-packet
and top-item measurement barely diverge — 9/12 either way for tool-call text in `before-v2`. The
orchestrator's earlier framing that "everything below rank 1 was unmeasured" was accurate but
overstated its significance: there are only two ranks below it. Recorded here rather than quietly
dropped, because the corrected framing is what a later reader should inherit.

**The anchor prune's improvement holds up under correct measurement.** Tool-call-bearing items fell
from 64.7% to 18.2% between `after-filter-v2` and `current-v2` — both measured on the v2 harness, so
this is a sound like-for-like comparison, unlike anything spanning the v1/v2 boundary.

## Evidence handed to Plan 11-22

All six contaminated items in `current-v2` are `kind: summary` with ids prefixed
`historical_summary_`, and every one classifies `derivationClass: conversational` while carrying
tool-call text. Q3's rank-2 item additionally reports `markersFound: ['task-notification']` — the rule
Plan 11-20 just added detects the marker in the body — yet still classifies conversational, because
every `SYNTHETIC_RULE` is an anchored `startsWith` and the marker is mid-body.

The mechanical consequence (anchored rules cannot fire on embedded scaffolding, so re-classifying
existing summary text cannot clean these) is stated in `11-RECALL-PROBE-V2.md` as a consequence of the
data. The root cause is NOT diagnosed here and no remediation is proposed — that is Plan 11-22's job,
and the `historical_summary_` prefix is suggestive of the never-regenerated hypothesis but is not
conclusive on its own.

## Deviation

The executor agent assigned to this plan stalled three times: after launching `before-v2`, after
`after-filter-v2` completed, and before assembling the documents. The orchestrator ran the
`current-v2` arm and wrote `11-RECALL-PROBE-V2.md` and this summary directly. No measurement was
re-run and no result was altered; the stalls cost wall-clock time, not data integrity. Worth noting
for future planning: this plan's arms take 13-49 minutes each, and an executor that launches a
long background job without a poll loop will sit idle indefinitely after it finishes.

## Verification

- Frozen query set and probe harness byte-unchanged (`git diff` clean for both).
- Both backups verified unchanged after cloning.
- `11-RECALL-PROBE-V2.md` records all three columns with per-rank, per-rule attribution.
- Comparability stated explicitly: the three v2 columns are comparable with each other and none is
  comparable to any number in `11-RECALL-PROBE.md`.

## Follow-ons

- **Plan 11-22** — GAP-11-E root cause, from the attribution above.
- **Plan 11-23** — owner decisions: the remediation shape, plus the `[phase:X]` rule question Plan
  11-20 deliberately deferred (~1,676 events).
