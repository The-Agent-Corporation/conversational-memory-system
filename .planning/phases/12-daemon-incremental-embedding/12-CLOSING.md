# Phase 12 — Closing State and Phase 13 Entry Conditions

Written 2026-08-04, after the post-12-07 daemon work. This is the record of what Phase 12
actually left behind on the live corpus, and what Phase 13 is entitled to assume.

## What Phase 12 set out to do, and did

The daemon keeps summary vectors current incrementally: a summary committed by a contraction
slice is embedded post-commit, and a bounded repair pass heals the hole left by a crash between
commit and embed. The live corpus carries a complete ONNX baseline — 49,314 vectors,
`completedFraction 1`, `missingVectors 0`, one `(provider, model)` pair across every row.

That much was true at 12-07. What was *not* true is that the daemon could run.

## What the post-12-07 work found, and fixed

Plan 12-07 deliberately did not start the daemon. Starting it exposed five defects, none of
which any plan owned, all now fixed and committed:

| | |
|---|---|
| `4c7773c` | `runOnce` returned success-shaped zeros while absorbing stage failures. It now reports them. |
| `973a41e` | A contraction slice starved its own 10 s lease heartbeat. Two unfiltered `listSummaries()` narrowed, cooperative yields added. 66 s → 34.3 s. |
| `bbc58a7` | `DerivationInvalidator`'s five full-table loads yield between passes. |
| `38e1edf` | `listCanonicalEventKeys` (19.7 s → 1.23 s) and `listCanonicalEventScopePairs` (15.18 s → 0.024 s, migration 5). |
| `07f34a2` | A slice reads the spine and materializes only its window. Steady slice **22.4 s → 1.44 s**; `memory daemon once` >12 min-failed → **117 s, `failures: []`**. See ADR 0054. |
| `0318f7c` | The macOS LaunchAgent ran `node` off a bare launchd PATH and exited 127 while `daemon start` reported success. |
| `15b0430` | Sleep review reads candidate queries instead of restaging a copy of the corpus. `createStagingStore` **1,089 MB → 0 MB**; `proposeBoxes` 43.1 s/2,358 MB → 2.1 s/1,388 MB. |

Live-corpus outcome: a verified `aaron.db.pre-migration5` backup was taken, migration 5 applied,
+56,400 events imported, and the daemon then drained the whole 56,166-event backlog to zero
(+7,392 summaries, +7,392 vectors) — before OOMing in the proposal review.

A full generation-bumped rewind on a clone terminated cleanly: 1,170 slices, 292,407 events,
54.3 min, per-slice cost *falling* 5.47 s → 2.31 s, worst heartbeat gap 21.1 s against a 30 s TTL,
and the corpus ended on exactly its starting counts — re-derivation is idempotent.

## Why the daemon still cannot be left running

`15b0430` removed the staged corpus copy, which was the largest allocation, but not the cause of
the remaining one. **Trace discovery is combinatorial and its output is unusable**, and that is
what Phase 13 exists to replace.

Measured on the live corpus at 5,138 retrievable summaries, sweeping the shared-term threshold:

| min shared terms | distinct traces |
|---|---|
| 2 | 449,103 |
| 3 | 166,594 |
| 4 | 108,690 |
| 5 | 77,595 |
| 6 | 60,009 |
| 8 | 40,209 |
| 10 | 29,320 |

`proposals + skipped` stayed pinned at **449,103 across every threshold**. Raising the threshold
prunes *members* from traces; it never removes a *grouping*. That is structural, not a tuning
miss: a trace's identity is the slug of its first four shared terms
(`trace-candidate-core.ts`), that tuple is very nearly unique per pair, and the pass is
all-pairs. At 56,706 summaries the trace pass ran 18+ minutes without completing.

`PARALLEL_TRACE_BACKFILL_THRESHOLD = 20_000` in `trace-proposal-planner.ts` carries a comment
asserting the daemon's ongoing runs "stay well below this (a handful of new summaries per
cycle)". On this corpus that is false, and it is the assumption the whole design rests on.

The corpus already holds 49,314 real bge-small vectors that this matcher never consults.

## Gaps carried into Phase 13

### GAP-12-D — summary decay is not idempotent

`sleep-reviewer.ts:304` `decaySummary` computes
`strength × 0.5^(ageHours / halfLifeHours)` where `ageHours` is measured from
`lastAccessedAt ?? retrievedAt ?? createdAt` — a field decay itself does not advance. Running it
N times therefore applies `0.5^(N·age/halfLife)`, compounding rather than converging.

Observed directly, and by accident: a clone decayed once reported **5,138** hot summaries; the
same clone decayed a second time reported **1,679**. The discrepancy was first read as a
measurement error and is not — it is the bug.

Severity: latent today (decay is never invoked by the daemon; `decaySummaries` has no scheduler
wiring), blocking the moment recency-scoping is used to bound any pass. Phase 13's SC5 —
flat per-cycle cost as the corpus grows — is most naturally satisfied by scoping to the recent
or retrievable set, which makes this a prerequisite rather than a nice-to-have.

Note also that `NON_SUPERSEDED_STATES` includes `stale`, so decay alone does **not** shrink the
review candidate set. Whatever bounds the pass must be an explicit predicate, not a side effect
of decay.

### GAP-12-E — trace discovery must be harmless before the daemon runs unattended

Until Phase 13 lands, the daemon's proposal review must not run the all-pairs trace pass on this
corpus. The interim position is boxes-only: leave trace discovery effectively off in the daemon
path. This is a holding action with an expiry date, not a fix — do not tune the term matcher.

## Phase 13 entry conditions

Phase 13's stated dependency is "Phase 12 (new summaries must already carry vectors by the time
trace discovery runs)". Against the live corpus:

- **Satisfied.** Every retrievable summary has a vector, under the composed model identity, and
  the daemon's post-commit embed stage keeps new ones current — proven by the drain that wrote
  7,392 summaries and 7,392 vectors.
- **Satisfied.** Contraction is fast enough that a daemon cycle completes, so there is a real
  cycle for trace discovery to be measured inside (ADR 0054).
- **Not satisfied, and owned by Phase 13.** `createStagingStore`'s full-corpus restage is named
  explicitly in Phase 13 SC2. `15b0430` removed the *staging copy*; the *rescan* of the whole
  person corpus to find candidates remains, and is exactly what forward-only discovery replaces.

## Not closed, and deliberately not claimed

- No `/gsd:verify-work 12` sign-off. This document is evidence, not a verdict.
- ADR 0052 decisions 4 and 5 remain `(pending owner confirmation)`.
- F11's `memory daemon once` repair check has now run for real (`117 s, failures: []`), but was
  never captured under the plan that owned it.
- The daemon is **stopped**. LaunchAgent unloaded, `daemon_lease` empty, no stray processes.
- GAP-11-F's 151 contaminated corpus rows are untouched.
