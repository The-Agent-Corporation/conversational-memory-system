# Plan 11-18 Summary — Owner-authorized live anchor prune + frozen probe re-run

**Plan:** 11-18 (wave 15, gap closure for GAP-11-D)
**Status:** COMPLETE
**Date:** 2026-07-27

## What was done

1. Produced the authorization evidence (dry-run, backup stat, suite/typecheck state) — recorded in
   `11-ANCHOR-PRUNE.md`.
2. Ran the live anchor prune against `~/.memory/aaron.db` with `--confirm-backup`.
3. Re-ran the frozen 12-query recall probe against the pruned corpus.
4. Recorded results in `11-RECALL-PROBE.md` (`after-anchor-prune`), closed GAP-11-D, raised GAP-11-E.

## Prune receipt (verbatim)

```
prunedCount: 26,643   (tool_activity 8,911 + synthetic_injected 17,732)
skippedByReason: { retained_conversational: 19,268 }
freedPayloadBytes: 214,615,234   batches: 92
backupPath: ~/.memory/aaron.db.pre-anchor-prune (5,031,448,576 bytes)
```

Anchors 45,911 → 19,268. Arithmetic: 45,911 − 26,643 = 19,268 ✓. The retained count equals the
conversational count the preview predicted, exactly. No `person_mismatch` / `person_unattributed`
skips fired (single-person corpus); both remain live, tested refusal paths per ADR 0051.

## Probe results

| | before | after-filter | after-anchor-prune |
|---|---|---|---|
| containsToolCallText | 9 / 12 | 10 / 12 | **4 / 12** |
| containsHarnessText | 1 / 12 | 0 / 12 | 1 / 12 |
| Total elapsed | 1,509,789.1 ms | 523,680.4 ms | **388,816.5 ms** |

Per-query elapsed times are in `11-RECALL-PROBE.md`.

## Honest verdict on SC7

**GAP-11-D is closed. SC7 is NOT met.**

The anchor path is fixed: no query's top-ranked memory is a raw `[Tool call: ...]` payload any more,
and Q1 — byte-identical at 0.92 confidence across both prior runs — now returns genuine prose at 0.73.

The four surviving tool-call queries (Q1, Q3, Q4, Q10) all have **non-empty `sourceSummaryIds`**
(2, 3, 2, 3), so the residual text is summary-derived, not anchor-derived. That is a different defect
and is raised as **GAP-11-E** rather than being absorbed into this plan as a caveat.

Two anomalies are recorded in both `11-RECALL-PROBE.md` and `11-GAP-11-E.md` rather than smoothed
over: harness text went 1 → 0 → 1 (Q2 likely had a harness summary masked by a since-pruned anchor),
and Q12's preview is visibly `<task-notification>` scaffolding while `containsHarnessText` reports
false — suggesting the probe's harness detector under-counts across all three runs.

## Deviation from the plan as written

Plan 11-18 Task 1 was authored as a checkpoint that produces evidence and then asks the owner. The
asking half was satisfied before dispatch: the orchestrator ran the dry-run, found it under-reported
the blast radius (25,792 vs the 26,643 apply would delete), and the owner chose to fix that asymmetry
before authorizing. The evidence half was still produced and recorded as the audit trail.

Consequent fix landed before the prune (`b7ae28b`, attributed to 11-17): both stores'
`summarizeAnchorDerivationClasses` now enrich `role`/`eventKind` from the canonical event exactly as
`commitUnhygienicAnchorPrune` does, with a parity case pinning
`preview.unhygienicCount === receipt.prunedAnchorIds.length`. The owner authorized against the
corrected figure.

A fresh backup (`~/.memory/aaron.db.pre-anchor-prune`) was taken from the *current* state before
applying, rather than relying on `aaron.db.pre-phase11` — the latter predates the Phase 11 summary
rebuild, and ADR 0051 records that no `rebuild-anchors` command exists, so a pruned anchor is not
regenerable and the backup is the only recovery path.

## Verification

- Frozen query set byte-unchanged: `11-RECALL-QUERIES.md` and `11-recall-probe.ts` do not appear in
  this plan's diff.
- `npm run typecheck` clean.
- `npx vitest run` green except the pre-existing `tests/mcp/mutation-tools.test.ts` timeout flake
  (passes in ~350–440 ms in isolation; fails only under full-suite parallel load; last touched by
  Plan 05-04, long before Phase 11; reproduces with Phase 11 changes stashed). Logged in
  `deferred-items.md`, not fixed — out of scope.

## Follow-ons

- **GAP-11-E** — summary-sourced tool-call text (blocks SC7).
- **11-13 Tasks 2/3** — the superseded-*summary* prune remains withheld. Unrelated to SC7: superseded
  summaries are already excluded from retrieval, so pruning them reclaims storage only.
- **Plan 11-14** (wave 16) — owner SC7 sign-off. The honest input is "anchor path closed, summary path
  still leaking."
- **SDK indexing bug** — `gsd-sdk query phase-plan-index 11` reports plan 11-14 as wave 1 when its
  frontmatter says `wave: 16` (verified with a real YAML parser), and `state.advance-plan` has written
  nonsensical `current_plan` values. Waves were sequenced by hand from frontmatter for this reason.
  Worth filing upstream.
