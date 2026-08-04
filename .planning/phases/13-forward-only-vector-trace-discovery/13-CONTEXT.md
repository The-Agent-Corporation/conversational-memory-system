# Phase 13 — Forward-Only Vector Trace Discovery: Context and Locked Decisions

**Created:** 2026-08-04, after the Phase 12 closing state was recorded
(`.planning/phases/12-daemon-incremental-embedding/12-CLOSING.md`). The decisions below were made
by the owner in session before planning. They are **LOCKED inputs to the planner, not open
questions.**

## Goal (ROADMAP, unchanged)

Recurring cross-session traces are discovered via nearest-neighbor similarity over summary
embeddings, evaluated forward-only against new summaries so the full corpus is never rescanned or
restaged after bootstrap, while the existing proposal/review contract is preserved exactly.

Requirements: REQ-046, REQ-047, REQ-048.

## State of the world, measured 2026-08-04 on `~/.memory/aaron.db` (read-only, not assumed)

| fact | value |
|---|---|
| summaries, `compacted` | **56,706** |
| summaries, `superseded` | 89,059 |
| summaries, total rows for person `aaron` | **145,765** |
| `summary_vectors` rows | **56,706** — one per compacted summary, complete |
| **traces** | **0** |
| **boxes** | **0** |
| **proposals** | **0** |

**This is a greenfield build, not a migration.** Nothing has ever been accepted into a trace or a
box on this corpus. The 449,103-trace figure in `12-CLOSING.md` was measured on throwaway clones
and was never committed to the live database. The planner must not plan a migration, a purge, or a
backfill of existing trace assignments — there are none.

## The primitive already exists, and its cost model is the phase's central hazard

`MemoryStore.findNearestSummaries(FindNearestSummariesQuery)` was built in Phase 8/9 and is
already correct: it filters by `(provider, model, personId)`, enforces `allowedScopeIds`, applies
a fail-closed retrievable-state sweep (GAP-11-A, T-11-26/27), sorts by score with a deterministic
id tiebreak, and honours `topK` / `minimumScore`.

**It is also per-call full-table, in two directions.** `sqlite-store.ts:1813` loads every vector
row for the person, and `:1827` loads every summary payload for the person, on *every single
call*. Measured on the live corpus:

| per `findNearestSummaries` call | cost |
|---|---|
| load 56,706 vector rows | 1.61 s |
| load 145,765 summary payload rows | **7.04 s** |
| `JSON.parse` those payloads | 1.18 s |
| resident heap after both loads | 1,296 MB |
| **total, before any arithmetic** | **~9.8 s** |

A bootstrap that called it once per summary would cost **56,706 × 9.8 s ≈ 154 hours**. That is not
a slower version of the old problem; it is a worse one. **Naively calling the existing primitive in
a loop is the single most likely way this phase fails**, and it is the same shape as the
`createStagingStore` restage that Phase 13 SC2 exists to close.

The arithmetic itself is cheap once the vectors are resident:

| with vectors already in memory | cost |
|---|---|
| unpack 56,706 × 384 to `Float32Array` | 0.43 s |
| one full 56,706-way cosine scan | **74 ms** |
| 56,706 such scans | **69.9 min** |
| vector payload alone (56,706 × 384 × 4) | 87 MB |

So the bootstrap is an overnight job measured in **tens of minutes**, not hours — provided the
corpus is loaded **once** and scanned many times, rather than reloaded per query. Two standard
reductions apply and should be considered rather than assumed: pre-normalising each vector once
reduces cosine to a dot product (~2×), and pair symmetry means only `j > i` need be scanned
(~2×). Neither is required for the job to fit an overnight window; both should be measured, not
projected. **The 1.9× optimistic projection in ADR 0054 is the standing precedent here: sample
measurements have under-predicted full-run cost on this corpus before.**

Note also that the `:1827` summary-payload query has **no supporting index** — it is
`json_extract(payload, '$.personId') = ?` over 145,765 rows, and it returns superseded rows only to
discard them. If a bootstrap holds a retrievable-id set in memory for the duration, it pays this
once instead of 56,706 times.

## Locked decision 1 — one-time full bootstrap, then strictly forward-only

The existing 56,706 summaries **are** bootstrapped against each other in a single bounded,
**resumable** pass. Pure forward-only was considered and rejected: it satisfies the ROADMAP goal
literally while producing nothing useful on the real corpus for months, because every summary that
exists today would remain permanently traceless.

Requirements on the bootstrap:

- **Resumable via a checkpoint**, in the same spirit as contraction's. It must survive a crash, a
  kill, and a restart without redoing completed work and without double-proposing.
- **Loads the corpus once.** It must not call `findNearestSummaries` per summary. Whether that
  means a new bulk-oriented store method, an in-memory index built once, or an extension to the
  existing method is the planner's call — but the 154-hour shape must be structurally impossible,
  and that must be provable by a test that asserts on **call counts or query counts**, not on
  elapsed time. (ADR 0054's precedent: a timing assertion passes on a small fixture regardless.)
- **Runs offline / on demand**, not inside a normal daemon cycle. It is an overnight job.
- **Idempotent.** Running it twice must not produce duplicate traces or duplicate proposals.

After bootstrap, the daemon is **strictly forward-only**: a cycle evaluates only summaries created
or changed since the last successful pass, against existing neighbours. This is Phase 13 SC2 and it
is non-negotiable — no rescan, no restage, no full-corpus load per cycle.

## Locked decision 2 — top-k above threshold, plus a HARD per-cycle proposal cap

Trace formation is top-k nearest neighbours above a similarity threshold. On top of that there is a
**hard cap on the number of trace proposals emitted per cycle**, highest-similarity first.

The cap exists because a threshold alone is exactly what failed with shared terms. Under the old
algorithm, sweeping min-shared-terms from 2 to 10 changed trace *membership* while
`proposals + skipped` stayed pinned at 449,103 — the knob did not control the thing it appeared to
control. **A cap is a bound the owner sets directly; a threshold is a hope about the data.**

Requirements on the yield policy:

- The cap is a **configured number**, defaulting to something a human can actually review
  (order of 20 per cycle — the planner should propose the default and justify it, and it must be
  overridable).
- Emission is deterministic: highest similarity first, with a stable tiebreak, so the same corpus
  produces the same proposals.
- Suppressed candidates must be **counted and reported**, never silently dropped. ADR 0054's "no
  silent caps" applies: a receipt that reports 20 proposals while hiding that 4,000 were suppressed
  reads as coverage when it is truncation.
- The cap bounds *emission*, not *correctness*. A capped cycle is not a failed cycle, and the next
  cycle must be able to reach what this one suppressed rather than losing it permanently.

The similarity threshold itself must be **chosen against measured data on a clone** before the
daemon runs against the live corpus — not picked from intuition and not tuned in production.

## Locked decision 3 — GAP-12-D and GAP-12-E land first, in wave 1

Both gaps carried forward from Phase 12 are **in scope for Phase 13, in its first wave**, before
the vector discovery work.

- **GAP-12-E — neutralise the all-pairs trace pass.** Until vector discovery replaces it, the
  daemon's proposal review must not run shared-term trace discovery on this corpus. Interim
  position is boxes-only. This is a **holding action with an expiry date, not a fix**: the planner
  must not tune, threshold, or otherwise attempt to rescue the term matcher. Landing it first is
  what makes the daemon runnable, so the rest of Phase 13 can be planned and measured against a
  daemon that actually runs.
- **GAP-12-D — summary decay is not idempotent.** `sleep-reviewer.ts:304` `decaySummary` computes
  `strength × 0.5^(ageHours / halfLifeHours)` with `ageHours` measured from
  `lastAccessedAt ?? retrievedAt ?? createdAt` — a field decay itself never advances — so N runs
  apply `0.5^(N·age/halfLife)` and compound instead of converging. Observed: 5,138 hot summaries
  after one pass, **1,679 after two**, on the same clone. Latent today (no scheduler invokes
  `decaySummaries`) but blocking the moment recency is used to bound a pass, which is the natural
  route to SC5.

  Note for whoever fixes it: `NON_SUPERSEDED_STATES` includes `stale`, so **decay alone does not
  shrink the review candidate set**. Whatever bounds a pass must be an explicit predicate, not a
  side effect of decay.

## Preserved exactly — the review contract

Phase 13 SC3 is a compatibility constraint and the planner must treat it as a hard fence.
Vector-derived proposals carry the **identical** `TraceCandidate` / `MemoryProposal` shape, flow
through the **unchanged** review/accept/reject decision path, and add a human-readable rationale
explaining why the summaries were linked.

The repo-wide invariant applies with full force: proposals move through explicit reviewed status
transitions. **Nothing in this phase may auto-approve a trace or silently mutate one.**

Trace *identity* must not repeat the old design's mistake. Under `trace-candidate-core.ts` a
trace's identity is the slug of its first four shared terms — a tuple very nearly unique per pair,
which is *why* 5,138 summaries produced 449,103 distinct traces and why no threshold could reduce
that count. Whatever identifies a vector-derived trace must be stable across runs and must be
capable of matching an *existing* trace rather than minting a new one, or SC4 (running twice with
one new summary changes no pre-existing assignment) cannot hold.

## Out of scope, explicitly

- **No ANN library, no new vector index, no `sqlite-vec`.** 87 MB of vectors and a 74 ms brute-force
  scan do not justify a dependency, and adding one would need its own ADR. If a future corpus size
  changes that, it is a later phase.
- **No re-embedding.** The corpus's vectors are complete and current; Phase 12 owns keeping them so.
- **No retrieval changes.** Semantic recall is Phase 14.
- **No prune of the 89,059 superseded summaries** (ADR 0052 locked decision 3 stands).
- **GAP-11-F's 151 contaminated corpus rows** remain untouched.
- **No new `person_id`-leading index on `canonical_events`** without a query-plan test. ADR 0054's
  planner trap cost 388× and broke two optimizations at once without failing a single assertion.

## Operational fences (unchanged from Phase 12, restated because they bind)

- All experimentation on `cp -c` APFS clones. The live corpus is verified at every checkpoint.
- Never open `~/.memory/aaron.db` non-read-only without a fresh verified backup — migrations run in
  the `SqliteStore` constructor when `!readOnly`.
- The existing backups in `~/.memory/` and `~/cms-pre-rewrite-backup/` are not to be deleted, moved,
  or overwritten.
- Secrets are redacted as `[REDACTED]`; no raw keys, tokens, or client documents are persisted.
- The daemon is currently **stopped**, and stays stopped until GAP-12-E lands.

## Success criteria (ROADMAP, verbatim — the planner plans backward from these)

1. New trace proposals are produced from nearest-neighbor-above-threshold similarity over summary
   embeddings, not the shared-term all-pairs candidate algorithm.
2. A daemon trace-discovery cycle evaluates only summaries created/changed since the last
   successful pass against existing neighbors — it does not reload, rescan, or restage the entire
   person corpus to find new traces (closing the `createStagingStore` full-corpus-restage gap, not
   just replacing the candidate algorithm).
3. Vector-derived trace proposals carry the identical `TraceCandidate` / `MemoryProposal` shape as
   before, flow through the unchanged review/accept/reject decision path, and include a
   human-readable rationale explaining why the summaries were linked.
4. Running the trace-discovery step twice with exactly one new summary added between runs leaves
   every pre-existing trace assignment unchanged — no nightly churn, no collapse into an unbounded
   mega-trace.
5. Trace-discovery cost per daemon cycle stays flat as new summaries arrive at growing corpus size,
   rather than growing with total corpus size.
