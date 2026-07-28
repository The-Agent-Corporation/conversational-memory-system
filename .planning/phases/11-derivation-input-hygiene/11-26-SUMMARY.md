---
phase: 11-derivation-input-hygiene
plan: 26
subsystem: measurement
tags: [recall-probe, derivation-hygiene, gap-closure, measurement]
requires:
  - "11-25 (the live rebuild applied to ~/.memory/aaron.db)"
  - "11-19 (the corrected v2 probe harness)"
  - "11-23 (the recorded acceptance target)"
provides:
  - "the final-v2 probe column — the evidence input to Plan 11-14's owner SC7 sign-off"
  - "GAP-11-E's disposition"
affects:
  - "11-14 (owner SC7 sign-off) — this is its evidence"
tech-stack:
  added: []
  patterns:
    - "three separately-labelled hygiene predicates instead of one union figure"
    - "advisory predicate hits inspected individually before counting"
key-files:
  created:
    - .planning/phases/11-derivation-input-hygiene/probe-v2/final-v2.json
    - .planning/phases/11-derivation-input-hygiene/probe-v2/final-v2.md
  modified:
    - .planning/phases/11-derivation-input-hygiene/11-RECALL-PROBE-V2.md
    - .planning/phases/11-derivation-input-hygiene/11-GAP-11-E.md
    - .planning/phases/11-derivation-input-hygiene/deferred-items.md
    - .planning/STATE.md
    - .planning/ROADMAP.md
decisions:
  - "GAP-11-E closes on the measured tally, with the one remaining product-unhygienic object named as an anchor already tracked under a separate open owner decision rather than absorbed into this closure"
  - "The three predicates are reported separately and labelled; the old 6/12 union is retired as a headline"
  - "The product-unhygienic column is declared not strictly comparable across arms, since the probe classifies with run-time product code"
metrics:
  duration: ~25min
  completed: 2026-07-28
---

# Phase 11 Plan 26: Final Post-Remediation Measurement Summary

Re-ran the frozen 12-query recall probe against the rebuilt live corpus with a byte-unchanged
instrument and recorded the tally as measured: **zero `[Tool call: ` text anywhere in the packet set**
(0/12 queries, 0/33 items, from 4/12 and 6/33), **two product-unhygienic items in Q1 and Q3 that are one
single pre-existing anchor**, and three advisory probe-suspicious queries whose every hit was inspected
individually.

## What was measured

`final-v2`, 689,217.8 ms across 12 queries against `~/.memory/aaron.db` at `hygiene-rules/v3`,
`{compacted: 49253, superseded: 89120}`, embedder `deterministic/keyword-hash-v1`.

Per the acceptance target recorded in `11-REMEDIATION-DECISION.md`'s addendum — quoted verbatim in both
`11-RECALL-PROBE-V2.md` and `11-GAP-11-E.md`: "**SC7 should be judged on tool-call +
product-unhygienic.** `probe-suspicious` is advisory: each hit must be inspected individually before it
counts against the criterion, because the fix that would 'close' it is the over-matching one this phase
deliberately rejected."

| figure | predicate | items | queries |
|---|---|---:|---:|
| tool-call | `containsToolCallText` | **0 / 33** | **0 / 12** |
| product-unhygienic | `derivationClass === "synthetic_injected"` | **2 / 33** | **2 / 12** (Q1, Q3) |
| *probe-suspicious (advisory)* | `markersFound.length > 0` | *4 / 33* | *3 / 12* (Q1, Q2, Q3) |

Four-column comparison, all four arms on the same harness and query set:

| arm | elapsed ms | items | tool-call | product-unhyg | probe-susp |
|---|---:|---:|---:|---:|---:|
| `before-v2` | 2,940,407.9 | 36 | 19 (9/12 Q) | 0 | 6 (4/12 Q) |
| `after-filter-v2` | 1,044,483.0 | 34 | 22 (10/12 Q) | 2 (2/12 Q) | 3 (3/12 Q) |
| `current-v2` | 762,497.0 | 33 | 6 (4/12 Q) | 0 | 6 (4/12 Q) |
| **`final-v2`** | **689,217.8** | **33** | **0 (0/12 Q)** | **2 (2/12 Q)** | **4 (3/12 Q)** |

## The result is mixed and is reported mixed

Six tool-call items eliminated across Q1/Q3/Q4/Q10 and four probe-suspicious summary items across
Q4/Q12. Against that, **Q1 and Q3 each regressed by one product-unhygienic item.** The regression is
recorded in the same table as the gains in `11-RECALL-PROBE-V2.md`.

The regression is not new contamination. Both Q1 r0 and Q3 r0 are the *same* anchor
(`anchor_personal_turn_event_1a2df6be…_decision`), raw `<task-notification>` scaffolding created
2026-07-19, present in both `aaron.db.pre-rebuild-v3` and `aaron.db.pre-anchor-prune`. It was absent
from `current-v2`'s packets entirely; it rose to rank 0 once the rebuild cleaned the tool-call summaries
that used to outrank it. Cleaning the summary path changed what wins ranking, and what won next was
already dirty. It is one of the known **350** anchors already carried into Plan 11-14 as open owner
decision (a).

## Deviations from Plan

None affecting the measurement. The plan was executed as written: probe run in the background with
polling, `final-v2` column appended, GAP-11-E dispositioned, STATE.md updated, `status` left
`executing`.

Two additions beyond the literal task list, both documentation-only:

**1. [Rule 2 — missing critical documentation] Comparability qualification on the `product-unhygienic`
column.** The probe classifies with the product code **as it exists at run time**, not at corpus-write
time. The first three arms ran at `hygiene-rules/v2`; `final-v2` ran at `v3`. Left unstated, the
four-column table would silently invite a comparison the data does not support. Verified with
`git diff a84eea7 f96ad9a -- src/topic/derivation-hygiene.ts` that v2→v3 changed only the matching
*strategy* and not the `SYNTHETIC_MARKERS` list, which makes `tool-call` and `probe-suspicious` fully
comparable and `product-unhygienic` not strictly so. Recorded in `11-RECALL-PROBE-V2.md` and STATE.md.

**2. [Rule 2 — out-of-scope finding, logged not fixed] `REQUIREMENTS.md` REQ-052 still encodes the
reversed SC1 carve-out.** Its text still reads "An isolated tool call shall retain normal
summarization", contradicting the owner's 2026-07-27 reversal, the amended ROADMAP SC1, and the shipped
v3 behaviour. Not fixed here: `REQUIREMENTS.md` is not in this plan's `files_modified`, and rewording a
requirement during a measurement plan is precisely the instrument-tampering shape T-11-93 exists to
prevent. Logged to `deferred-items.md` and suggested to Plan 11-14.

## Instrument integrity

`11-RECALL-QUERIES.md` and `11-recall-probe.ts` are **byte-unchanged** — `git diff --exit-code` clean on
both, checked before the run and again after. Neither was touched.

`~/.memory/aaron.db` before and after: inode **171672602**, size **5,031,448,576 bytes**, identical on
both sides. mtime advanced (21:36:32 → 21:55:36 local), which is expected rather than damage —
`prepareInjection` writes by design (`saveInjection`, summary access bookkeeping, deferred-revival
promotion), the harness header documents this, and `current-v2` was produced against the live database
the same way. No backup was read from, written to, moved, or deleted.

## Secret handling (GAP-11-F)

`probe-v2/final-v2.json` contained the plaintext Mission Control login in a summary preview —
faithfully reproduced into the rebuilt summaries from the untouched canonical events, exactly as
`11-REBUILD.md` predicted. **Redacted to `[REDACTED]` before `git add`** (1 occurrence; file still
parses as JSON). The `onrender.com` 64-hex API key did not appear in either artifact. Follow-up sweeps
for vendor key prefixes (`sk-`, `ghp_`, `AKIA`, `xox*`, JWT), bare 32/40/64-hex runs, and
`key|token|secret|password` assignments are clean on both files — the single bare 64-hex string is the
public Bun installer SHA-256. The corpus itself remains unremediated per the owner's decision; only the
committed artifacts were redacted.

## GAP-11-E disposition

**Closed**, scoped strictly to its own subject matter (summary-derived contamination), on which the
measured tally is 0 tool-call items and 0 product-unhygienic items. All three original open questions
have recorded answers; both recorded anomalies are resolved. The one remaining product-unhygienic
object is an anchor, explicitly named as outside this gap and left attached to the pre-existing
350-anchor owner decision rather than folded into the closure.

## No SC7 verdict

None appears in any artifact this plan produced — verified by grep across
`11-GAP-11-E.md`, `11-RECALL-PROBE-V2.md`, and `STATE.md`. `status` remains `executing`. Plan 11-14 is
the owner's sign-off and the only remaining Phase 11 work.

## Commits

- `fc89e4d` — `docs(11-26)`: measure the remediated corpus with the frozen probe
- `1016570` — `docs(11-26)`: close GAP-11-E on the measurement and point the phase at 11-14
- `eaedeec` — `docs(11-26)`: mark 11-26 complete in ROADMAP and log the stale REQ-052 text
