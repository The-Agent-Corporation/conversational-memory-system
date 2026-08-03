# ADR 0054: A Contraction Slice Reads the Spine, Not the Corpus

## Status

Accepted.

## Context

`ContractionRunner.drainSlice` processes a bounded slice — 250 events, or 2 s of monotonic time,
whichever comes first — and then commits. It began by loading **every** canonical event the person
owns:

```ts
const allEvents = context.preloadedEvents ?? await this.store.listCanonicalEvents(personId);
```

On the live corpus that is 292,407 events to process 250. Measured cost of one slice: **~22 s**, of
which **19.7 s** was that single call.

The cost was not parsing. Attribution against the real database:

| | |
|---|---|
| SQL fetch | **19.71 s** |
| `JSON.parse` | 1.56 s |
| Zod parse | 3.57 s |

`idx_canonical_events_person_order` was present and being used, so there was no sort — but it does
not cover `payload`, so every one of 292,407 rows was a separate table b-tree descent on a 5.0 GB
file.

**This was not merely slow, it was a correctness problem.** The daemon proves it holds the write
lease by renewing it from a 10 s `setTimeout` heartbeat, and `assertFreshDaemonAuthority` rejects
every write once the lease passes its 30 s TTL. `node:sqlite`'s `DatabaseSync` is synchronous, so a
22 s slice is 22 s during which the timer phase is barely reached. The worst observed heartbeat gap
was **32.7 s — longer than the TTL**, and slices were failing their own commits with
`Daemon write authority is missing, stale, or expired`. Cooperative yields (ADR-adjacent, committed
separately) reduced the gap but could not fix it, because no yield can subdivide one synchronous
19.7 s call.

Projected backlog drain at that cost: **8.6 hours**, and rising with the corpus, since every future
slice re-paid the full load. (Observed after this change: 54.3 min — see below. Both figures are
for a full generation-bumped rewind, the worst case.)

## Decision

### 1. A slice reads the *spine* for position and payloads only for its window

`listCanonicalEventKeys(personId)` returns `{ id, occurredAt, nativeSequence }` for every event, in
canonical order. Selecting only the three indexed columns makes it a covering-index scan that never
visits the table: **19.7 s → 0.80–1.23 s**.

Everything a slice needs in order to *locate* work — the id→index map, the resume point, the
affected start index, whether the pass is complete — is answerable from the spine. Content is
needed only for the events actually processed, and comes from the existing
`listCanonicalEventsByIds` (0.026 s for 250).

`SliceEventWindow` holds `[low, high)` while addressing events by **global** position, and
**throws** on out-of-range access. That is the safety argument for the type existing at all: an
off-by-one against a plain array would hand the summarizer a different event's text and persist the
result as memory. A crash is recoverable; silently wrong memory is not. `materializeWindow` also
asserts that the ids come back in spine order rather than trusting it.

The window's lower bound is the **restored active span's start**, not the resume point — a resumed
span is re-derived over its whole range, so it reads events an earlier slice already processed. A
span that opens *during* a slice cannot start before `startIndex`, so nothing earlier is needed.

### 2. The scope invariant is a statement about pairs, not about events

`assertEventScopes` looped over every materialized event checking that its source belongs to the
person and its scope matches the source's. That predicate only ever depends on the **distinct
`(sourceId, scopeId)` pairs**, of which the entire live corpus has **18**.

Expressed as SQL it is a `group by`, but `json_extract` still reads every payload (15.18 s), so
migration 5 adds an expression index over exactly that expression: **15.18 s → 0.024 s**. Additive
DDL, no table rewrite, 13.49 s one-time build on the full corpus.

The invariant is unchanged — same pairs, same comparison, same error — only the cost of obtaining
it. `coalesce(...,'personal')` in the index must match the query character for character, or SQLite
silently declines the index and the query degrades back to a full payload scan.

### 3. The open-run drift guard is evaluated over a bounded region

`pendingToolRunStillOpen` scanned from index 0 to the withheld run's boundary, which on a resumed
slice near the end of the corpus meant materializing essentially everything.

Only the run and the event immediately before it can affect the answer, so the **same**
`openToolRunStart` is applied to `[runStart - 1, boundary]`. If the predecessor is not tool
activity the run opens at relative index 1; if it is, the run extends earlier, `openToolRunStart`
returns 0, and the comparison fails — exactly as the full-prefix scan failed, and in the safe
direction (fall back to the full rewind/invalidation path).

`openToolRunStart` itself is untouched. **GAP-11-G was caused by re-implementing a hygiene walk in a
second place**, and this deliberately does not do that.

### 4. `listCanonicalEventsByIds` pins the primary key with `+person_id`

Migration 5 gave SQLite a **second `person_id`-leading index**. It immediately preferred that index
for `where person_id = ? and id in (...)`, scanning all 292,407 of the person's index entries to
resolve a few hundred ids:

| | |
|---|---|
| `person_id = ?` (planner picks `idx_canonical_events_person_scope`) | **10.086 s** |
| `+person_id = ?` (planner picks the primary key) | **0.026 s** |

`+` marks the term unusable as an index lookup. The predicate is unchanged and still enforced in
SQL; only the planner's freedom to lead with it is removed.

## Consequences

### Measured effect

Live-corpus clone, same job:

| | before | after |
|---|---|---|
| steady-state slice | 22.4 s | **1.44 s** |
| first (rewind) slice | 27.8 s | 13.0 s |
| worst heartbeat gap | 32.7 s | 11.0 s (TTL 30 s) |
| `memory daemon once` | >12 min, failed | **117 s, `contractionSlices: 1`, `failures: []`** |

### Observed full drain, and where the projection was wrong

The numbers above are from an 8-slice sample. Extrapolating them gave "28 minutes to drain the
backlog", which was **1.9x optimistic**. A full generation-bumped rewind of the whole corpus on a
clone, under a real lease with a real heartbeat:

| | |
|---|---|
| slices | **1,170**, all 292,407 events |
| terminated | `complete: true`, no failures, job `state: complete`, `immediateDirty: false` |
| wall clock | **54.3 min** (projected 28) |
| slice mean / p50 / p95 / max | 2.78 s / 2.29 s / 6.14 s / **64.28 s** |
| cost drift | 5.47 s (first tenth) → **2.31 s** (last tenth) |
| heartbeats | 315, worst gap **21.1 s** against the 30 s TTL |
| summaries / vectors written | 50,483 / 50,483 |

Three things this shows that no sample could:

- **Cost does not drift upward.** It *falls* — the expensive slices are the early rewind ones, where
  supersession work is heaviest. A per-slice cost that grew with the checkpoint would have made the
  whole approach unsound however good the early slices looked.
- **The lease survives every slice, including a 64.28 s one.** That slice is four times over its own
  TTL and still committed, because the cooperative yields let the heartbeat run inside it. Worst gap
  across 1,170 slices was 21.1 s, and it came from that single initial rewind.
- **Re-derivation is idempotent.** 50,483 summaries were written and the corpus ended with exactly
  the counts it started with — 49,314 compacted, 89,059 superseded — because deterministic summary
  ids make a full re-derivation an upsert of the same rows.

The mean is 2.78 s rather than the sampled 1.44 s largely because a from-scratch rewind writes
~43 summaries per slice, and the post-commit embed stage is real ONNX work. An incremental daemon
slice, which writes far fewer, is the cheaper case the 1.44 s sample actually measured.

### The planner trap generalizes, and is the most important line in this ADR

Adding **any** `person_id`-leading index to `canonical_events` can silently steal
`where person_id = ? and id in (...)` away from the primary key. It cost 388× here and it broke
**two** separate optimizations at once — this window, and the import-diff path that had already
stopped loading every canonical event. Neither failed a test. Both would simply have been slow
again, indefinitely, with the original commits still in the history claiming a fix.

A query-plan test now guards it. Query-plan assertions are used rather than timing assertions
throughout this work, because both queries return *correct* results either way: the bug is invisible
to any assertion about output, and a timing assertion passes on a small fixture regardless.

### Found only by re-measuring

The first measurement after the rewrite showed slices still at ~21 s — the change appearing to have
done nothing. Had the design been trusted instead of re-measured, a rewrite that made the system
*worse* would have shipped with a commit message claiming a 15× win. The intermediate measurement is
the only reason the planner regression was caught at all.

### Not addressed here

- The first (non-resume) slice is still 13.0 s in the incremental case and up to 64.28 s on a full
  rewind, dominated by three full-table derivation loads inside `DerivationInvalidator` that cannot
  be narrowed without weakening a fail-closed integrity check. It runs once per rewind, not per
  slice, and cooperative yields keep the lease alive through it — but it is the single closest
  approach to the TTL that remains.
- `remainingContractions` stays at 1 after a successful slice, which is correct (the 250-event cap)
  but means a receipt alone never shows the queue reaching zero. Confirming that took a separate
  drain-to-completion run, not a `once` invocation.
- The embed stage is now a meaningful share of a slice on rewind-heavy work. It was deliberately
  placed post-commit by ADR 0052 and is not a liveness dependency, so this is a cost observation
  rather than a defect.
