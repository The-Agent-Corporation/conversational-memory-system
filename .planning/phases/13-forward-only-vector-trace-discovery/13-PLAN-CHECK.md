# Phase 13 — Pre-execution plan check

**Checked:** 2026-08-04 · 12 plans (`13-01` … `13-12`), 7 waves, commit `159ec15`
**Inputs read:** all 12 PLAN.md, `13-CONTEXT.md`, `13-RESEARCH.md`,
`.planning/phases/12-daemon-incremental-embedding/12-CLOSING.md`, `12-PLAN-CHECK.md`, ROADMAP Phase 13
(`:459-472`), `CLAUDE.md`, `AGENTS.md`, `docs/adr/0054-contraction-slice-spine-and-window.md`,
REQ-046/047/048. Every load-bearing source claim below was verified in the tree. Two read-only
filesystem observations were taken against `~/.memory/` (`ls`/`stat` only; nothing opened, nothing
written).

## Verdict

**ISSUES FOUND — not ready to execute. 6 blockers, 13 warnings, 3 info.**

None of the six blockers requires re-architecting the phase. Four are local edits; two (B2, B3) are
genuine design holes at seams no plan owns, and both are cheap to close now and expensive to
discover during the wave-6/wave-7 live run.

What is already sound, and should not be re-litigated in revision:

- **Requirement coverage complete.** REQ-046 in 01/05/07/08/09/10/11/12, REQ-047 in
  02/03/04/05/06/10/11/12, REQ-048 in 08/10/12. No requirement is uncovered.
- **The core cost argument is right and is structural, not aspirational.** `SummaryVectorIndex`
  holding no store reference (13-07) is a stronger guarantee than any budget, and it is the correct
  answer to the 154-hour shape.
- **D-13-1 is defensible and is applied consistently** (see Q1).
- **Every non-checkpoint task has an `<automated>` verify.** No watch-mode flags. No timing
  assertions anywhere — explicitly forbidden in 13-03, 13-04, 13-06, 13-10, with ADR 0054 cited.
- **All three owner-gated plans (13-04, 13-09, 13-12) have real blocking checkpoints** with
  `resume-signal`s that require pasted numbers rather than an "approved".
- **Locked decision 3 is honoured:** GAP-12-E (13-01) and GAP-12-D (13-02) are both wave 1, and
  13-01 touches zero knobs on the term matcher (verified: `git diff --numstat` gates on
  `trace-candidate-core.ts` and `trace-proposal-planner.ts` in both the task and the plan-level
  verification block).
- **Scope is sane.** ≤4 tasks and ≤8 files per plan; 13-12 is the only borderline one (W12).

---

## Answers to the ten questions

### 1. The SC2 reading (D-13-1) — defensible, consistently applied, and the D-13-1a corollary does not leak

**The reading is correct.** 13-03's three reasons hold up:

- SC5 ("cost per cycle stays flat as new summaries arrive at growing corpus size") is unsatisfiable
  under a call-count-only reading, so the row-count reading is the only one that makes SC2 and SC5
  simultaneously true. That is a sound disambiguation, not a stretch.
- The `createStagingStore` shape SC2 names by name was **already one call per table** — verified at
  `proposal-scheduler.ts:83-103` and in its own docstring ("1,089 MB of heap for a single call").
  A call-count reading would have declared that gap closed while it was open. This is the decisive
  argument and the planner leads with the weaker one.

**Consistency across twelve plans: yes.** `assertFlatCost` (13-03) has no `max`, no ratio, no
tolerance, and 13-05, 13-06, 13-10, 13-11 all import it rather than defining a local one — 13-10
Task 3 forbids a local cost assertion by name. The one plan that could have weakened it (13-10,
which is graded by it) is the one that forbids it most explicitly.

**D-13-1a does not create the loophole, but it does create two blind spots the plans do not name.**
The exemption is bounded correctly — `assertOncePerProcess` asserts `calls === 1` independent of
cycle count, and it lives in the shared contract module rather than inside the plan that benefits
from it, which is the right structural choice. But:

- **`daemon once` makes "once per process" mean "once per cycle."** `daemon.ts:246` `runOnce` has
  its own loop and calls `proposalScheduler.runDue` at `:332`. One invocation = one process = one
  cycle, so every `memory daemon once` pays a full corpus warm-up. 13-12 Part B step 9 uses exactly
  that command to measure the cycle. No plan bounds or names this. (W3)
- **The warm-up's true cost is invisible to the contract.** 13-05 Task 2 has
  `listSummaryVectorScanPage` call the retrievable-id helper **per page** — O(retrievable summaries)
  each time, so a 57-page warm-up on the live corpus pays that sweep 57 times. The counting store
  counts *returned* rows, not rows visited inside `SqliteStore`, so `assertFlatCost` cannot see it.
  The plan says "cache only if 13-09 shows it matters" but 13-09 measures page-read wall time, not
  this term specifically. (W4)

### 2. The 154-hour trap — structurally impossible for the shape named, and the 50/500 test does distinguish O(1) from O(n) **only where the plans add a zero-assertion**

**Structural, not merely tested.** Three independent defences, and the first is the real one:
`SummaryVectorIndex` imports nothing from `src/storage/` except a type (13-07 acceptance criterion
greps for it), so the module that does the scanning **cannot issue a query at all**. That is the
correct kind of guarantee.

**But the count-equality test does NOT distinguish O(1) from O(n) on its own for the forward path.**
A per-summary `findNearestSummaries` inside a daemon cycle would issue `evaluationBudget` (32) calls
and return `topK` rows at *both* 50 and 500 — `assertFlatCost` passes. The planner appears to know
this: 13-10 Task 3 and 13-11 Task 1 both add `findNearestSummaries === 0` and `listSummaries === 0`
outright, and those are the assertions actually doing the work. Worth stating plainly in ADR 0055,
because the plans currently present `assertFlatCost` as the guard and the zero-assertions as an
extra.

For the **bootstrap**, equality does bite: a per-summary call is 50 vs 500 calls and fails. Good.

Two remaining softnesses, both non-blocking: `listTraces()`/`listProposals()` are in 13-10's
`assertFlatCost` list but return 0 rows at both fixture sizes, so that assertion is vacuous in the
dimension that actually grows in production (accepted traces over months) — which is precisely the
R9 cost the cap exists to bound. (W5)

### 3. Trace identity and SC4 — the scheme is right; the "SC4 holds by construction" claim is true for traces and **false for proposals**, and 13-10's own test will catch it

**The identity scheme genuinely matches rather than mints.** `mintTraceId(personId, seed, ordinal)`
with the id **recorded, not recomputed**, plus membership-overlap coverage lookup, is the correct
complement pair. The payoff is verified: `approveTraceProposal`
(`proposal-reviewer.ts:226-262`) is already an upsert by `payload.traceId` preserving
`existing?.createdAt`, so a stable id makes re-acceptance an update at zero cost to SC3. The
fail-closed seed-drift rule is the right call and the repo does have late-insert paths.

**"Discovery never mutates a trace" is true.** I checked every write path in the twelve plans:
`commitProposalRun` writes `parsed.traces`, and `stageProposals` returns `traces: []`
(`sleep-reviewer.ts:140`, unchanged by any plan); the planner is pure and holds no store; the
bootstrap writes only a checkpoint (D-13-4); the Hermes path writes proposals. Nothing writes a
`MemoryTrace` outside human acceptance. So `listTraces()` deep-equality across a discovery run holds.

**But SC4's proposal half does not hold, and it fails in exactly the scenario SC4 describes.** See
B3: the extension path reuses `proposal_trace_${traceId}`, and `commitProposalRun` upserts by id
(`sqlite-store.ts:838-842` → `saveProposal`). Add one new similar summary between runs → the
candidate is a strict superset of an existing proposed proposal's member set →
`coveringTraceIdFor` returns nothing → `resolveTraceIdForCandidate` returns `extend` → a proposal
with the **same id and different `sourceSummaryIds`** overwrites the pre-existing one. 13-10 Task 3's
own acceptance criterion — "every pre-existing proposal entry is deep-equal to its snapshot" and
"the proposal diff contains only additions" — cannot pass.

### 4. The cap and the backlog (D-13-2) — nothing is lost in the daemon's steady state; the recomputability claim is asserted, and its only mechanism has an unstated destructive side effect

Rejecting resolution (a) for head-of-line blocking is right, and the reasoning is the sharpest
paragraph in the phase.

**Arithmetic check on permanent loss:** at `evaluationBudget: 32` × `topK: 20`, a forward cycle
produces ≤640 candidates against a 1,000-entry backlog, so `backlogDropped > 0` in a *daemon* cycle
requires an already-near-full backlog. In practice the drop happens once, in the bootstrap. So the
D-13-2 design does honour "the next cycle must be able to reach what this one suppressed".

**The recomputability claim is asserted in three places (13-06, 13-08, 13-11) and mechanized in
none.** No test in any plan re-runs a bootstrap after a drain and asserts the next tier reappears.
Worse, the only mechanism is `--reset`, which 13-11 defines as "deletes the checkpoint first" — and
the checkpoint is *one row* holding the backlog, the bootstrap position **and the forward cursor**.
So the documented recovery procedure silently resets forward-only discovery to the beginning of the
corpus. No plan states this. (W6, and it shares a root cause with B2.)

### 5. Wave 1 scope — 13-01 has not tuned the matcher; the `hermes:sleep` guard is **justified but over-built**

**GAP-12-E is a clean holding action.** 13-01 names all six knobs it is not touching
(`BROAD_TRACE_TERMS`, `NON_DISCRIMINATING_DOCUMENT_FLOOR`, `NON_DISCRIMINATING_DOCUMENT_FRACTION`,
`maxDocumentFrequencyFor`, `minimumTraceSummaries`, `minimumConfidence`), gates on a zero-line
`git diff --numstat` for both matcher files, and implements the switch as an **injected default**
rather than an opt-out — which is the right shape for T-13-03. The switch location (scheduler
wiring, not inside `SleepReviewer.proposeTraces`) matches RESEARCH's recommendation and is verified
to keep `tests/sleep/sleep-reviewer.test.ts:186-207` green.

**Ruling on the self-flagged `hermes:sleep` refusal guard: not scope creep in principle, but the
implementation as specified should be cut back.** Refusing to invoke a pass is categorically not
tuning it, and CONTEXT's hazard (a human detonating an 18-minute all-pairs scan on the live corpus
by hand) is real. But three things make the current specification worse than the alternative:

1. **It has no cheap input.** `MemoryStore` has no summary-count method (verified: the only
   aggregate methods are `summarizeSupersededSummaries:231` and the anchor counter at `:251`), so
   13-01's own fallback is "use `listSummaries({ states: NON_SUPERSEDED_STATES })`" — a 56,706-row
   load added to the very path being protected from a corpus-scale operation.
2. **It adds and then deletes a public contract field.** `traceDiscoverySkipped` lands on
   `HermesSleepResult` in 13-01 and is deleted in 13-12 (`grep` gate in its acceptance criteria).
3. **`SHARED_TERM_TRACE_GUARD_SUMMARIES = 2_000` is a number about the matcher's blow-up curve** —
   defensible as a refusal threshold, but it will read to a future maintainer as the tuning knob
   CONTEXT forbids, notwithstanding the docstring.

The equivalent-safety, lower-cost version is the one already chosen for the daemon: pass
`NullTraceProposalPlanner` (or skip `proposeTraces`) in the Hermes path for the duration of the
phase, with no count, no constant, no response field. That is one line and needs no removal in
13-12. Recommend the planner take it. (W7)

### 6. GAP-12-D — the fix does converge, and idempotence is asserted mechanically

**The maths is correct.** `decayed = round(min(strength, 1 × 0.5^(age/halfLife)))`. Run 1 gives
`s1 ≤ d(t)`; run 2 at the same `t` gives `min(s1, d(t)) = s1`, `decaySummary` returns null, no write.
Rounding does not break it (`round(min(round(d), d)) = round(d)`). At `t+H`, `d` halves regardless of
how many passes ran between — R8(b) holds. Verified against the live code at
`sleep-reviewer.ts:206-223` and `:304-346`; the plan's line citations are accurate.

**Idempotence is asserted mechanically, twice over, and the plan is right that these are two
different claims:** `updatedSummaries: []` **and** zero `saveSummary` calls via a counting write
store; plus the ten-invocations-at-one-timestamp regression test, which is the exact shape that
produced 5,138 → 1,679. The monotonicity test (a weak, recently-accessed summary must not be
*raised*) is the non-obvious one and it is present. This is the strongest-specified plan in the set.

Two notes, neither blocking: the fix is a real **semantic** change beyond idempotence — strength
becomes a recency-derived bound rather than an accumulator, so a mid-strength summary now decays
*less* per pass and reaches `stale` later. `strengthen()` (`memory-retriever.ts:407-408`) still
raises on retrieval and is unaffected. (W8) And Task 2's push-down is verified as a call-site-only
change: `SummaryFilter` already carries `states`, so `git diff src/storage/` staying empty is
achievable as written.

### 7. Migration 6 and the ADR 0054 planner trap — the guards are the right guards, but they are at the wrong scale and in the wrong order

13-06 Task 3 is well-designed as a *set*: five assertions, four of them "still uses", grouped with a
STOP-on-failure rule and an extend-before-landing convention. The threat is correctly identified —
migration 6 adds a `person_id`-leading index to `summary_vectors`, the table both
`findNearestSummaries` (`sqlite-store.ts:1814-1820`) and `listSummaryVectorScanPage` read on every
call. That is the same shape as the 388× incident.

**Two defects, and B4 records them:**

- **Scale.** All five assertions run against a temp-file fixture of a few hundred rows. SQLite's
  planner choice is row-count dependent, and 13-04 Task 3 step 6 says so in its own words: *"A plan
  that is index-covered on 500 rows and not on 145,765 is exactly the failure mode this step exists
  to find."* 13-04 therefore requires `explain query plan` **against the clone**. 13-06 requires no
  such thing for the riskier index, and 13-12's checkpoint — the only later step that touches real
  row counts — never runs `explain query plan` either.
- **Order.** 13-04 writes the plan assertions in Task 1 and changes code in Task 2, explicitly so
  the first run is a measurement rather than a confirmation. 13-06 inverts it: migration 6 lands in
  Task 2, guards in Task 3.

### 8. Both stores — the rule is honoured in production code and violated in the test seam

13-05 and 13-06 both declare on `MemoryStore` first, implement in `SqliteStore` **and**
`InMemoryStore`, and test cross-store agreement (13-05 Task 3's `describe.each` over six exclusion
categories; 13-06's cursor parity with ≥3 rows sharing a `created_at`). 13-05 Task 1's acceptance
criterion — *"`npm run typecheck` now FAILS for BOTH stores, and that failure is this task's proof
that the CLAUDE.md two-implementation rule is being enforced by the compiler"* — is the best
expression of that rule I have seen in this repo.

**And it is exactly why B1 is a blocker:** `tests/support/counting-store.ts` (13-03) is specified as
a full structural `implements MemoryStore` with no `Proxy`, precisely so a new store method breaks
`tsc`. 13-05 adds one method and 13-06 adds four — neither lists `counting-store.ts` in
`files_modified`, and both require `npm run typecheck` clean.

Gap: the checkpoint trio (`save`/`get`/`deleteTraceDiscoveryCheckpoint`) has cross-store agreement
in 13-06's `<behavior>` but not in its `<acceptance_criteria>` — the same F10 shape from Phase 12.
(W9)

### 9. Wave/dependency soundness — acyclic and file-disjoint within every wave; two declarations are wrong

**Same-wave file overlap: verified zero.** W1 `{traces,daemon,hermes}` vs `{sleep-reviewer}`;
W2 `tests/support/` vs `{sqlite-store, tests/storage}`; W4 `{schema,storage}` vs `{traces}`;
W5 `{vector-trace-planner, summary-provenance, proposal-scheduler}` vs `{scripts, defaults}`;
W6 `{daemon/*, sleep-reviewer}` vs `{operations, cli}`. Clean. `vector-query-plans.test.ts` is
touched by 13-04/13-05/13-06 but in three different waves.

Graph is acyclic. Two declaration errors:

- **13-03 and 13-04 are `wave: 2` with `depends_on: []`** — wave should be `max(deps)+1 = 1`. Either
  they depend on wave 1 (then say so) or they are wave 1. (W1)
- **13-11 `depends_on: ["13-08"]` understates its real dependencies.** It consumes
  `listSummaryVectorScanPage` (13-05), the checkpoint schema and store methods (13-06),
  `SummaryVectorIndex` (13-07), and — hard — `DEFAULT_TRACE_SIMILARITY_THRESHOLD` plus the measured
  per-row scan time that sizes `batchLeftRows`, both from **13-09**, which is not an ancestor.
  Wave ordering saves it in practice; the declaration is still wrong. (W2)

### 10. Owner-gated live-corpus plans — no unbacked writable open, but the backup itself is incomplete

**No plan opens `~/.memory/aaron.db` non-read-only except 13-12, and only after a verified backup.**
Traced every path: 13-04 Task 3 and 13-09 Task 2 operate on `cp -c` clones; 13-09's harness is
read-only by construction and refuses a `~/.memory/` path without `--allow-live-readonly`; migration
6 (13-06) applies to the live file only via 13-12. Backups are listed read-only and re-confirmed at
the end. `readOnly: true` genuinely does not migrate (`sqlite-store.ts:195-198` gates `migrate()` on
`!options.readOnly`).

**But the backup protocol has a hole, and it is not theoretical.** 13-09 step 3 —
`cp -c ~/.memory/aaron.db ~/.memory/aaron.db.pre-phase13` — copies the main file only, with no
`-wal`/`-shm` siblings and no zero-length-WAL assertion. Observed 2026-08-04, read-only:

```
-rw-r--r--  9,228,832  Aug  3 14:36  /Users/aaronwhaley/.memory/aaron.db-wal
```

**9.2 MB of uncheckpointed WAL.** A `cp -c` of the main file alone right now is an inconsistent
backup — and this is the file 13-12 Part A step 3 names as the sole precondition for the first
writable open of the live corpus, and the sole rollback path. The house practice already knows
better: `~/.memory/aaron.db.pre-anchor-prune-wal` and `-shm` exist alongside their main file. This is
Phase 12 finding F7 reappearing after being closed. (B5)

Second, smaller: 13-12 accepts 13-09's backup on **existence + integrity**, not freshness. 13-09 is
wave 5 and 13-12 is wave 7; the daemon is stopped, but `memory hermes:sleep` opens the live database
**writable** (`sleep-command.ts:56`, `new SqliteStore(path)` with no read-only option) and imports
can run. A stale rollback target loses everything in between. (W10)

---

## Findings

### BLOCKERS

**B1 — 13-05 and 13-06 add five `MemoryStore` methods and neither updates the counting store, which
13-03 deliberately made non-optional.**
*Affects:* `13-03-PLAN.md:119-151`, `13-05-PLAN.md:7-12`, `13-06-PLAN.md:7-15`.
13-03 specifies explicit per-method delegation and forbids a `Proxy` *specifically* so that "adding a
store method without deciding how it is counted becomes a build failure". 13-05 adds
`listSummaryVectorScanPage`; 13-06 adds `save`/`get`/`deleteTraceDiscoveryCheckpoint` and
`listSummaryVectorIdsCreatedAfter`. Neither lists `tests/support/counting-store.ts` in
`files_modified`, both assert `npm run typecheck` clean, and every plan carries "stage only this
plan's `files_modified`". As written, 13-05 Task 2 cannot reach a clean typecheck.
*Fix:* add `tests/support/counting-store.ts` to `files_modified` and to the relevant task's `<files>`
in both 13-05 and 13-06, with an acceptance criterion that the new methods are counted (rows as well
as calls) — 13-06's `assertFlatCost` over `listSummaryVectorIdsCreatedAfter` already depends on it.

**B2 — nothing initializes the forward cursor when the bootstrap completes, so the first live daemon
cycles re-walk the entire corpus from the beginning. SC2's literal criterion fails on real data and
no test covers the handoff.**
*Affects:* `13-06-PLAN.md:196-197` (`cursor` "Null before the first successful cycle"),
`13-11-PLAN.md:209-212` (final batch sets `bootstrapComplete: true` and
`bootstrapAfterSummaryId` — never `cursor`), `13-10-PLAN.md:194` (step 4 reads the cursor).
A null cursor means `listSummaryVectorIdsCreatedAfter` starts from the beginning of the
`(created_at, summary_id)` enumeration. The live corpus's 56,706 vector rows were written by the
Phase 10/12 backfill and all sort *before* any new summary, so the first forward cycle evaluates
summaries #1-32 of history — not "summaries created since the last successful pass". At
`evaluationBudget: 32` and a 60-minute forced interval that is roughly 1,772 cycles / ~74 days of
re-walking before the daemon reaches genuinely new work, while its receipt reports a healthy cycle
every hour. This is the head-of-line-blocking failure D-13-2 rejects, arriving through a different
door. It also makes `--reset` (W6) far more destructive than 13-11 presents it.
*Fix:* have 13-11's final batch set `cursor` to the maximum `(createdAt, summaryId)` present in the
index at bootstrap completion, atomically with `bootstrapComplete: true`; and add a test in 13-10 or
13-11 covering the handoff — bootstrap to completion, add one new vector, run one forward cycle,
assert exactly one summary was evaluated. That test is the SC2 evidence for the live corpus and
currently no plan owns it.

**B3 — extension proposals reuse `proposal_trace_${traceId}` and overwrite the pre-existing
proposal, which contradicts 13-10 Task 3's own SC4 acceptance criterion in exactly the scenario SC4
describes.**
*Affects:* `13-08-PLAN.md:280` (`id: proposal_trace_${traceId}`), `13-08-PLAN.md:243-245` (the
"extend" case with union membership), `13-10-PLAN.md:325-329` (SC4 assertions).
Verified: `buildTraceProposal` (`trace-proposal-planner.ts:131`) uses that id convention;
`commitProposalRun` upserts proposals by id (`sqlite-store.ts:838-842` → `saveProposal`);
`hasExistingProposal` (`proposal-utils.ts:47-49`) matches only `state === "proposed"`. Add one new
summary similar to an existing trace's members — SC4's literal test scenario — and the candidate is a
**strict superset** of the existing proposed proposal's member set, so coverage does not suppress it,
`resolveTraceIdForCandidate` returns `extend`, and a proposal with the same id and a larger
`sourceSummaryIds` replaces the snapshot. 13-10's criteria "every pre-existing proposal entry is
deep-equal to its snapshot" and "the proposal diff contains only additions" cannot both hold.
*Fix:* decide it explicitly rather than letting the executor discover it under a failing test. Either
(a) an extension proposal carries a distinct id (e.g. `proposal_trace_${traceId}_${ordinal}` or a
membership-derived suffix) so the pre-existing proposal is untouched and the diff is additions-only —
note `approveTraceProposal` upserts by `payload.traceId`, not by proposal id, so acceptance still
merges correctly; or (b) suppress extension of an already-*proposed* grouping until it is decided
(covered-by-proposal ⇒ skip on any overlap, not only on containment), and restate SC4's criterion to
match. Either way the choice belongs in 13-08's `<action>` and in ADR 0055's D-13-3.

**B4 — migration 6's ADR 0054 guard runs only at fixture scale, and lands after the migration it
guards; the phase's own standard (13-04) is stricter for a smaller change.**
*Affects:* `13-06-PLAN.md:238-320` (Task 2 adds the migration) versus `:322-369` (Task 3 adds the
guards); `13-04-PLAN.md:99-148` (guards first) and `:243-246` (clone-scale `explain query plan`).
SQLite's index choice is row-count dependent, which is why 13-04 requires the plan to be re-checked
against the clone at 145,765 rows. Migration 6 adds a `person_id`-leading index to `summary_vectors`
— the exact shape ADR 0054 `:158-165` records as costing 388×, breaking two optimizations, and
failing no assertion — and it is guarded only at a few hundred rows. 13-12's checkpoint runs the
bootstrap and a daemon cycle on the clone but never runs `explain query plan`.
*Fix:* (a) reorder 13-06 so the five plan assertions are written and run **before** the migration is
appended, matching 13-04; (b) add a clone-scale `explain query plan` step to 13-12 Task 3 Part B
(after step 5, before step 7) covering all five queries against the migration-6 clone, with the same
STOP-on-failure rule; (c) state in 13-06 Task 3 that fixture-scale plans are necessary and not
sufficient.

**B5 — `~/.memory/aaron.db.pre-phase13`, the sole rollback target for the phase's only writable open
of the live corpus, is specified as a main-file-only copy with no WAL handling. The WAL is currently
9.2 MB.**
*Affects:* `13-09-PLAN.md:200-203` (step 3), `13-12-PLAN.md:282-287` (Part A step 3).
Measured read-only, 2026-08-04: `~/.memory/aaron.db-wal` is **9,228,832 bytes**. 13-04 and 13-12's
*clone* steps say "plus `-wal`/`-shm` siblings"; 13-09's *backup* step does not, and 13-12 accepts
that backup as its precondition. `pragma integrity_check` on the copied main file will happily return
`ok` while the copy is missing the last 9 MB of committed transactions. Phase 12 raised this as F7
and closed it; Phase 13 reintroduces it.
*Fix:* in 13-09 step 3 and 13-12 Part A step 3: checkpoint the WAL (`pragma wal_checkpoint(TRUNCATE)`
on a read-only-safe path, or simply confirm the daemon is stopped and copy all three files), assert
`-wal` is 0-length **or** copy `-wal`/`-shm` alongside, and record the three file sizes in
`13-ENABLE.md`. Make a non-zero unhandled `-wal` a stop condition, as Phase 12 did.

**B6 — 13-12's Hermes swap is unimplementable as written: `sleepHermesMemory` has no `personId` or
`allowedScopeIds`, and the swap would write the Phase-13 checkpoint from a path holding no daemon
lease.**
*Affects:* `13-12-PLAN.md:238-247`, against `src/integrations/hermes/sleep-command.ts:13-27,46-83`.
Verified: `SleepOptionsSchema` is `{ databasePath, input }`; `HermesSleepRequestSchema` carries no
person or scope field; `SleepReviewer` is constructed without a `writeStore` and `proposeTraces` is
called with **no `personId`** (`:76-81`). `TraceDiscoveryRunnerOptions` (13-10) requires
`personId`, `provider`, `model`, `allowedScopeIds`. An executor will improvise — and the plausible
improvisation is a sentinel or first-person lookup, which is the class of mistake T-10-05/T-12-22
exist to prevent. Separately, 13-12 says the Hermes path "writes its checkpoint", while 13-11 Task 1
correctly refuses to run alongside the daemon because "two writers to one checkpoint is a lost-update
bug waiting for a bad night" — 13-12 creates exactly that writer without a lease check.
*Fix:* state the `personId`/`allowedScopeIds` source explicitly (a required request field, or a
documented single-person resolution with an explicit error when ambiguous — never a sentinel), and
decide the checkpoint question deliberately: either the Hermes path is read-only with respect to the
checkpoint (discovery runs, proposals are written, cursor and backlog untouched) — which is the
conservative choice and matches "human-invoked, no contraction job" — or it takes the same lease
check 13-11 requires. Record whichever in ADR 0055.

### WARNINGS

**W1 — 13-03 and 13-04 declare `wave: 2` with `depends_on: []`.** Wave should be `max(deps)+1`.
*Fix:* either declare the wave-1 dependency or move both to wave 1 (they are file-disjoint from
13-01/13-02, so wave 1 is safe and shortens the critical path).

**W2 — 13-11's `depends_on` omits 13-05, 13-06, 13-07, and 13-09**, the last of which supplies both
`DEFAULT_TRACE_SIMILARITY_THRESHOLD` and the measured per-row cost that sizes `batchLeftRows`.
*Fix:* `depends_on: ["13-08", "13-09"]` at minimum.

**W3 — `memory daemon once` makes D-13-1a's once-per-process warm-up a once-per-cycle full corpus
load, and 13-12 Part B step 9 measures the cycle with exactly that command.** `daemon.ts:246-332`
verified. Nothing bounds or names it.
*Fix:* name it in 13-10's docstring and ADR 0055's D-13-1b, and have 13-12 step 9 report warm-up time
separately from cycle time so the number is not misread as steady-state cost.

**W4 — the per-page retrievable-id sweep in `listSummaryVectorScanPage` is O(retrievable summaries)
per page and is invisible to the cost contract.** `13-05-PLAN.md:224-227` acknowledges it and defers
to "measurement in 13-09", but 13-09 measures aggregate page-read wall time, not this term.
*Fix:* have 13-09's harness report the warm-up's page count and per-page time so the term is visible,
and state the intended remedy (per-call-chain cache, never store-lifetime) in ADR 0055.

**W5 — `listTraces` / `listProposals` in 13-10's `assertFlatCost` list are vacuous at fixture
scale** (0 rows at both 50 and 500), which is the one dimension that genuinely grows in production
and the reason R9 makes the cap load-bearing.
*Fix:* seed the SC5 fixture with a fixed number of pre-existing traces/proposals at *both* sizes so
the assertion means something, and state in ADR 0055 that these are flat in corpus size and linear in
accepted-derivation count.

**W6 — `--reset` deletes the forward cursor along with the backlog, and that is the only documented
mechanism for the "recomputable, not lost" claim.** `13-11-PLAN.md:196` ("`--reset` deletes it
first") against `13-06-PLAN.md:192-206` (one row holds cursor + bootstrap position + backlog).
No test asserts recomputability anywhere.
*Fix:* make `--reset` reset only the bootstrap fields (or offer `--reset-bootstrog`-style granularity),
document the side effect in `--help`, and add one test in 13-11 that drains a backlog, re-runs, and
asserts the next tier reappears — otherwise ADR 0055's recomputability claim is unbacked.

**W7 — the `hermes:sleep` corpus-size refusal guard (13-01 Task 2) is over-built for a holding
action:** it needs a full `listSummaries` load it was meant to avoid, adds a public response field
that 13-12 deletes, and introduces a matcher-adjacent constant CONTEXT's readers will misread.
*Fix:* replace with the daemon's own remedy — inject `NullTraceProposalPlanner` (or skip the trace
pass) in the Hermes path — and delete `SHARED_TERM_TRACE_GUARD_SUMMARIES`, `traceDiscoverySkipped`,
and the count entirely. One line, no removal work in 13-12.

**W8 — 13-02's fix changes decay semantics beyond idempotence and the plans do not say so
outside a docstring.** Strength becomes a recency-derived *bound*; a mid-strength summary decays less
per pass and reaches `stale` later than today. `strengthen()` (`memory-retriever.ts:407-408`) is
unaffected.
*Fix:* state the behaviour change in the summary and in ADR 0055's "not addressed here", so a later
reader does not attribute a changed `stale` population to something else.

**W9 — the checkpoint trio's cross-store agreement is in 13-06's `<behavior>` but not its
`<acceptance_criteria>`** (the Phase 12 F10 shape). Only the cursor parity is required.
*Fix:* add "`save`/`get`/`deleteTraceDiscoveryCheckpoint` exercised through the both-stores matrix"
to the criteria.

**W10 — 13-12 accepts `aaron.db.pre-phase13` on existence + integrity, not freshness.** It is taken
in wave 5 and used in wave 7; `hermes:sleep` opens the live database **writable**
(`sleep-command.ts:56`) and imports can run in between.
*Fix:* require a row-count comparison between backup and live at 13-12 Part A step 3, or simply take a
fresh backup there and keep the wave-5 one.

**W11 — backlog drain is gated on a due contraction job.** `runDue` returns
`{ ran: false }` before any discovery when `dueJobs` is empty (`proposal-scheduler.ts:44-46`), and
13-10 Task 2 inserts discovery *after* `stageProposals`. On an idle corpus the bootstrap's 1,000-entry
backlog never drains, and the phase's headline deliverable is invisible.
*Fix:* acceptable in practice for a daily-use corpus, but state the coupling in ADR 0055, and have
13-12 Part B/C report backlog size per cycle so the drain rate is observable rather than assumed.

**W12 — 13-12's `files_modified` omits files it modifies or deletes:**
`tests/integrations/hermes-sleep-command.test.ts` and `tests/integrations/hermes-smoke-harness.test.ts`
(both explicitly changed by Task 2), and `src/traces/parallel-trace-backfill.ts` /
`src/traces/trace-backfill-worker.mjs` (both deleted). Every plan carries a "stage only this plan's
`files_modified`" rule, so this is a staging conflict, not a formality. 13-12 also carries 4 tasks
across 8+ files, the largest in the set.
*Fix:* complete the list; consider splitting Task 3's live run out of the ADR/fence plan.

**W13 — `13-RESEARCH.md`'s `## Open Questions` section carries no `(RESOLVED)` marker and none of the
six questions carries an inline resolution**, although the plans do answer all six (OQ1→D-13-5,
OQ2→13-01, OQ3→D-13-2, OQ4→dissolved by D-13-4 — verified: `saveBootstrapCheckpoint`
(`sqlite-store.ts:1145-1158`) takes no `WriteAuthority`, so the Phase-13 checkpoint trio needs none
either, OQ5→D-13-3/D-13-4, OQ6→13-07's equal-or-subset policy).
*Fix:* mark the section `## Open Questions (RESOLVED)` with each answer and the deciding plan, so
`/gsd:verify-work 13` does not read them as open.

### INFO

**I1 — 13-05 Task 2's behavior references `limit: Infinity`** ("Concatenating pages equals a single
`limit: Infinity`-sized call"). `limit` is bound into `limit ?`; `node:sqlite` will not accept a
non-integer. Use a large integer or restate as "a single call with `limit >= rowCount`".

**I2 — SC2's "created/**changed**" half is served by `summary_vectors.created_at` advancing on
re-embed**, which is correct — `saveSummaryVector`'s upsert sets `created_at = excluded.created_at`
(`sqlite-store.ts:1685`) and `embedding-repair.ts:136` passes the embedder's timestamp. But ADR 0052
decision 6 (Phase 12's accepted F5 limitation) means a *changed* summary whose vector upsert failed
keeps a stale row, is never in the missing set, and therefore never crosses the cursor again. Worth
one line in ADR 0055's "not addressed here".

**I3 — all five success criteria are owned by a single task** (13-10 Task 3,
`tests/daemon/trace-discovery-cost.test.ts`), with SC1/SC3 additionally supported by 13-08 and the
13-12 fence. Structuring it as five `describe` blocks quoting the criteria verbatim is the right call
and makes `/gsd:verify-work 13` cheap. Noted as a concentration risk only: if that one task is
descoped under context pressure, the phase has no other SC evidence.

---

## Success-criterion ownership matrix

| SC | Owning plan / task | Mechanically catches failure? |
|---|---|---|
| SC1 — proposals from similarity, not shared terms | 13-10 T3 (`SC1` block) + 13-08 T2 + 13-12 T2 fence | **Yes.** Rationale regex is weak alone, but the `src/`-wide fence (13-12) and the separate-class decision (13-08) make the term path unreachable. |
| SC2 — cycle evaluates only new summaries, no corpus reload | 13-10 T3 (`SC2` block) | **Partly.** `listSummaries === 0` / `findNearestSummaries === 0` / `assertOncePerProcess` are strong. But B2 means the criterion's *literal* claim fails on the live corpus, and no test covers the bootstrap→forward handoff. |
| SC3 — identical shape, unchanged review path, human rationale | 13-10 T3 (`SC3` block) + 13-08 T2 | **Yes.** Key-set equality against a real shared-term proposal, plus validate→commit→approve end to end, plus re-acceptance asserted as an update. Strongest-covered criterion in the phase. |
| SC4 — two runs, one new summary, no pre-existing assignment changes | 13-10 T3 (`SC4` block) | **No — see B3.** The trace half holds by construction and is correctly asserted. The proposal half is contradicted by the extension path. |
| SC5 — per-cycle cost flat as corpus grows | 13-10 T3 (`SC5` block) via `assertFlatCost` | **Partly.** Equality on calls and rows at 50/500 is the right form. Blind to internal scans (W4), vacuous for `listTraces`/`listProposals` (W5), and exempts the warm-up — which `daemon once` makes per-cycle (W3). |

No success criterion is owned only by prose. SC2 and SC4 have owners whose acceptance criteria will
not pass as written.

## On the locked decisions

All three are honoured and none is contradicted.

- **LD1 (one-time bootstrap, then strictly forward-only)** — implemented by 13-11 and 13-10.
  Resumable ✓ (three kill points, exact-resume assertion), loads once ✓ (structural), offline ✓
  (daemon-lease refusal), idempotent ✓ (structurally, via D-13-4's zero emissions). The "must be
  provable by a test that asserts on call counts or query counts, not elapsed time" requirement is
  met exactly. **B2 is a gap in the *seam between* the two halves, not in either half.**
- **LD2 (top-k above threshold + hard cap)** — cap is a configured 20 with a justified default and an
  R9-citing test; suppression is counted in seven categories with a mechanical accounting invariant;
  the threshold is measured on a clone with the owner reading pairs (13-09), which is a genuinely
  good plan. "No silent caps" is satisfied.
- **LD3 (GAP-12-D and GAP-12-E first, in wave 1)** — both in wave 1, and 13-01 does not tune the
  matcher. CONTEXT's note that "whatever bounds a pass must be an explicit predicate, not a side
  effect of decay" is directly implemented by 13-02 Task 2.

No deferred item appears: no ANN library, no `sqlite-vec`, no re-embedding, no retrieval change, no
prune, no GAP-11-F work, and no `canonical_events` index (13-06 greps for it).

## Recommendation

Return to the planner for **B1–B6**, and — since W1, W2, W9, W12, W13 are one-line frontmatter or
criteria edits in the same files — for the warnings as well. B2 and B3 need a design decision written
into 13-11/13-08 respectively before execution; the other four are local.

Nothing here changes the wave structure or the phase shape. The measurement discipline (13-03, 13-09),
the structural-impossibility argument (13-07), and the identity design are all sound and should be
carried forward unchanged. Re-verify after revision.

---

# Re-check — revision of 2026-08-04 (working tree, commit base `159ec15`)

Focused re-check of the deltas. Everything established sound in the first pass was not re-derived.
All source claims below were re-verified in the tree. One read-only filesystem observation was
repeated against `~/.memory/` (`ls`/`stat` only).

## Verdict

**ISSUES FOUND — 3 blockers, 3 warnings, 5 info. Not ready to execute.**

**All six original blockers are closed**, and four of them are closed better than the finding asked:
B1 caught a row-counting blind spot I did not name, B2 gained a real-data check at 13-12 step 8b, B4
gained an *asserted* baseline rather than a recorded one, and B5 named the 9.2 MB WAL measurement in
the plan text so the next reader cannot treat it as hypothetical. Eleven of thirteen warnings closed.

The three new blockers all originate in **one** fix. D-13-6 part 2 (pending-proposal suppression)
closed the overwrite symptom and introduced a new permanent-loss path that contradicts a locked
decision; and the backlog's position in the pipeline, which was survivable before, now carries weight
it cannot bear. This is precisely the failure mode the coordinator asked me to look for.

## Blocker-by-blocker

| # | Status | Evidence |
|---|---|---|
| **B1** counting store | **Closed, and better than asked** | `tests/support/counting-store.ts` is now in `files_modified` **and** the implementing task's `<files>` in both 13-05 and 13-06 (five methods, correctly counted — I mis-stated four in the first pass; `getLatestSummaryVectorCursor` is the fifth). The tripwire contract is stated in the module docstring in those words (13-03 Task 1), so the instruction is at the point of failure. **The flagged blind spot is genuinely handled, not merely noted:** 13-05's action states that `SummaryVectorScanPage` is not an array, that the generic `Array.isArray` branch would contribute 0, and that rows must be counted as `page.summaryIds.length` — with a matching acceptance criterion ("wraps the new method and counts rows as `page.summaryIds.length`, asserted by a test"). 13-06 gives a per-method decision for all five (`listSummaryVectorIdsCreatedAfter` → `result.length`; cursor getter and checkpoint getters → 0; setters → 0). Without this, `assertFlatCost`'s row dimension would have been silently vacuous for the phase's most important read — the fix is load-bearing. |
| **B2** bootstrap→forward handoff | **Closed. The two lines are genuinely independent.** 13-11 D-13-7 writes `bootstrapComplete`, `bootstrapAfterSummaryId` and `cursor` in **one** checkpoint write from `getLatestSummaryVectorCursor`, with `complete && cursor === null` asserted unreachable. 13-10 does not consume that guarantee — it independently treats "cursor null AND corpus non-empty" as `skipped: "cursor-uninitialised"` and "vectors but no checkpoint" as `skipped: "bootstrap-required"`, asserting that `listSummaryVectorIdsCreatedAfter` is never called with a null watermark. The two share no code path: one writes state, the other refuses to read a bad state. A regression in either is caught by the other. **The handoff test proves what it claims** — 13-11 asserts the cursor equals `getLatestSummaryVectorCursor(...)`, that `bootstrapComplete` became true in the *same* write, then adds exactly one summary+vector and asserts **exactly one** summary evaluated ("not 'few', the number one"). The B2 negative (kill before completion → refuse) is also present, and 13-12 step 8b re-checks it on the real corpus with "32 evaluated here is B2 recurring and is a stop condition". The new primitive is verified implementable: `order by created_at desc, summary_id desc limit 1` is served by migration 6's `idx_summary_vectors_person_created`. |
| **B3** extension overwrites | **Part 1 closed and correct. Part 2 introduced N1 and N2.** Part 1 verified independently: `approveTraceProposal` upserts by `payload.traceId` (`proposal-reviewer.ts:226-262`), while `commitProposalRun` upserts proposals by `id` (`sqlite-store.ts:838-842` → `saveProposal`) — so the two id spaces are genuinely distinct where it matters, and a membership-derived proposal id makes a different membership an **addition** while an identical membership stays an exact-content upsert. `hasExistingProposal` (`proposal-utils.ts:47-49`) still works for exact repeats. The audit-safety half is covered by its own named test ("a candidate that would extend an already-`approved` trace never produces a proposal whose id collides with the `approved` record; assert the approved record is byte-unchanged") — that is the sharper half and it is asserted. Part 2's suppression, however, is a drop with no return path (**N1**) and it now depends on an ordering the backlog bypasses (**N2**). |
| **B4** migration 6 planner trap | **Closed, and stronger than the finding asked.** 13-06 Task 2 now captures the three "still uses" plans at schema v5 **before** migration 6 exists, and — the part that matters — *asserts* each captured plan references its expected index rather than merely recording it ("a baseline captured from an already-broken plan would guard nothing"). Task 3 diffs against the captured text, "not against 'some index'", with a STOP rule. Clone-scale sufficiency is 13-12 Part B step 5b, correctly placed *before* anything else touches the clone, comparing against 13-06's captured baselines. The plan's own comment states fixture scale is necessary and not sufficient and names 5b as the sufficient check. The v5-pin route is real: `runSchemaMigrations(database, migrations)` takes a migrations array (`schema-migrations.ts:125-127`) and `tests/storage/schema-migrations.test.ts:115` already passes a custom one. |
| **B5** backup consistency | **Closed in substance — one defect in the fallback command (N3).** The 9.2 MB WAL measurement is quoted in both plans; `sqlite3 .backup` is correctly chosen as primary (consistent by construction, absorbs WAL, runs no application code so no constructor migration); verification is three-way including **row-count parity against live**, which is the check `integrity_check` cannot do; a non-zero unhandled `-wal` is an explicit stop condition; and W10 is closed by a fresh `aaron.db.pre-phase13-live` at wave 7 that keeps the wave-5 backup and **reports the row-count divergence between them** as the writable activity in between. That last touch is better than the finding asked for. |
| **B6** Hermes swap | **Closed by deferral, correctly.** The swap is cut to `13-DEFERRED.md` with both reasons recorded (no `personId`/`allowedScopeIds` in `HermesSleepRequestSchema`, verified; a second checkpoint writer holding no lease). 13-01 Task 2 is now the null planner permanently — one line, no count, no constant, no response field — with `grep -rn "SHARED_TERM_TRACE_GUARD\|traceDiscoverySkipped" src/ tests/` returning nothing as an acceptance criterion. The withdrawal is written up honestly, naming all three reasons rather than silently dropping it. |

## The four pinned expectations — handled, and the two updates are correct

Verified against the tree, not just against the plan's claim:

| Expectation | Disposition | Correct? |
|---|---|---|
| `tests/traces/trace-proposal-planner.test.ts:72-76`, `:79-105` | unedited | **Yes.** They construct `DeterministicTraceProposalPlanner` directly; nothing in 13-01 touches that class (gated by a zero-line `git diff --numstat`). |
| `tests/sleep/sleep-reviewer.test.ts:186-207` | unedited | **Yes.** It constructs `new SleepReviewer(store)` with no options, so it still gets the default `DeterministicTraceProposalPlanner` (`sleep-reviewer.ts:93-95`, unchanged). The switch is at the two *call sites*, not in the reviewer. |
| `tests/integrations/hermes-sleep-command.test.ts:177`/`:208` | **changed** | **Correct, not made-to-pass.** `sleepHermesMemory` constructs the reviewer at `sleep-command.ts:66`; injecting the null planner there genuinely makes `proposedTraceIds` empty. The new expectation asserts a real new behaviour, carries an inline comment naming GAP-12-E, the plan, ADR 0055 **and the old value**, and is accompanied by two tests that make the change meaningful rather than merely green: the bundle-overrides-default precedence test (an explicitly requested OpenRouter `tracePlanner` must still win — verified against `selectProposalPlanners` at `:107-120`, which returns `null` for `deterministic` mode and a bundle otherwise, so the spread order is the whole behaviour) and an `include_proposals: false`-versus-default equivalence test. |
| `tests/integrations/hermes-smoke-harness.test.ts:52` | **changed** | Same, and it is in `files_modified` now. |

**`npm run hermes:smoke` is a stated acceptance criterion** — in Task 2's `<automated>` verify, in its
`<acceptance_criteria>`, and in the plan-level `<verification>` block, which additionally notes that the
harness pinned the old id and must be left passing. Three places. Confirmed.

One arithmetic slip: the plan says "all **four** pinned expectations" while listing three unedited plus
two changed (I5).

## New findings

### BLOCKERS

**N1 — D-13-6 part 2 drops `suppressedByPendingProposal` candidates with no return path, and the plan's
stated return mechanism is false under its own cursor semantics. This reopens locked decision 2.**
*Affects:* `13-08-PLAN.md:131-137` (the claim), `:320-328` (the pipeline).
13-08 step 5 skips pending-suppressed candidates; only step 7's cap remainder reaches
`mergeBacklog`. So a pending-suppressed candidate is **dropped**, not backlogged. The plan says it
"returns on the cycle after the pending proposal is accepted or rejected" — but D-13-2 advances the
cursor **unconditionally over every evaluated summary** (`13-06-PLAN.md`'s own decision, and
`13-10-PLAN.md`'s "cursor advances even when every candidate was suppressed"), so forward-only
guarantees those members are never evaluated again. The candidate does not return; it is gone until a
`--reset-bootstrap` full re-scan.
`13-CONTEXT.md:122-123` is a locked decision and it is explicit: *"the next cycle must be able to reach
what this one suppressed rather than losing it permanently."* Coverage-suppression (already handled)
and rejection-suppression (deliberately permanent) are both fine. Pending-suppression is the one
category that is meant to be *temporary*, and it is the one with no mechanism to come back.
*Fix direction:* route pending-suppressed candidates into the backlog rather than dropping them, so the
next cycle re-competes them — which requires N2's fix to be correct, because a backlog entry must be
re-checked against the pending state before emission.

**N2 — backlog entries enter the pipeline at step 6, after coverage, pending, and rejection resolution,
so a drained entry is emitted against the state of the cycle that created it.**
*Affects:* `13-08-PLAN.md:320-328` (steps 5 and 6), `13-11-PLAN.md` (the bootstrap fills the backlog).
Step 5 resolves coverage / pending / rejection over **fresh** candidates. Step 6 merges
`request.backlog` in at ordering time. No plan re-validates backlog entries. The consequences are not
hypothetical on this corpus: the bootstrap fills up to 1,000 entries drained at 20 per cycle over ~50
cycles, and the owner is accepting and rejecting throughout that window. An entry drained on cycle 40
was resolved against cycle 0's state, so it can be emitted after its grouping was **rejected** —
defeating the rejection memory 13-07 exists to provide, which the plan itself calls "the dominant
churn source" — or after a live trace already covers it, or while a pending proposal over an
overlapping set is undecided. In the first pass this was survivable; D-13-6 part 2 makes correctness
depend on that ordering, so it is now load-bearing.
*Fix direction:* apply step 5's resolution to the merged set (fresh + backlog) rather than to fresh
candidates alone, and state the re-validation explicitly in the pipeline; add a test that rejects a
grouping between the cycle that backlogged it and the cycle that drains it, asserting it is not
emitted.

**N3 — the `-wal`/`-shm` fallback command in the backup protocol is not a runnable command, and pasting
it mutates live files. It appears in both live-corpus plans.**
*Affects:* `13-09-PLAN.md:224-225`, `13-12-PLAN.md` Part A step 3.
Written as `cp -c ~/.memory/aaron.db{,-wal,-shm}` followed by the prose "into their `.pre-phase13`
names". Brace expansion yields **three source paths and no destination**. A shell will read the third
as the destination — `cp -c aaron.db aaron.db-wal aaron.db-shm` — and overwrite the live
`~/.memory/aaron.db-shm` with the live `aaron.db-wal`. The `-shm` is rebuildable and the daemon is
stopped, so this is recoverable rather than fatal; but it is a paste-and-mutate hazard in the one step
whose entire purpose is to avoid touching live files, and it sits inside a blocking human checkpoint
where the operator is following instructions literally. This is the only step in the phase where the
instruction text itself is the risk.
*Fix:* write the three copies explicitly, one line each, with both source and destination named — and
state that the fallback requires the daemon confirmed stopped (which the surrounding text already
does).

### WARNINGS

**N4 — 13-11's B2 handoff test drives 13-10's runner, but both are wave 6.** `13-11-PLAN.md:184-192`
runs "one forward cycle (Plan 13-10's runner)" and asserts 13-10's `skipped:` reason strings, while
`depends_on: ["13-08", "13-09"]`. Same-wave plans run in parallel, so 13-11's own acceptance criteria
are unsatisfiable until 13-10 exists. **No same-wave `files_modified` overlap was introduced** — I
re-checked all five multi-plan waves and every pair is disjoint — so this is an ordering declaration,
not a collision.
*Fix:* `13-11 depends_on: ["13-08", "13-09", "13-10"]`, wave 7; or move the handoff test into 13-10 and
say so in both plans.

**N5 — the pending-overlap index has no owning module.** D-13-6 part 2 needs "does any live *proposed*
trace proposal share a member with this candidate". 13-07 is unrevised and its `buildTraceCoverage`
exposes `coveringTraceIdFor` (contains-all) and `partialTraceIdsFor` (**traces** only, at-least-one).
Neither answers the proposal-side any-overlap question, and 13-08 lists no 13-07 file in
`files_modified`, so an executor will build a second membership index inside the planner — the
GAP-11-G shape this phase names four separate times.
*Fix:* say where it lives. Either extend `buildTraceCoverage` with an `overlappingProposalIdFor`
(a 13-07 edit, wave 4, so 13-08 consumes it) or state explicitly that 13-08 owns it and why a second
index is acceptable here.

**W5 (carried forward, not closed) — `listTraces` / `listProposals` remain vacuous in the flat-cost
assertion.** `13-10-PLAN.md:364-367` still builds both SC5 fixtures with zero pre-existing traces and
proposals, so those two entries in the `assertFlatCost` list compare 0 against 0 — in the one dimension
that actually grows in production and that R9 makes the emission cap load-bearing for. The R9 reasoning
is recorded in ADR 0055 and in a dedicated test, so this is documentation-complete and
assertion-incomplete.
*Fix:* seed a fixed number of pre-existing traces and proposals at **both** corpus sizes.

### INFO

**I1 — D-13-1c is a genuine improvement and should survive review.** 13-10's SC2 block now carries a
comment stating why `listSummaries === 0` and `findNearestSummaries === 0` carry the guarantee and
`assertFlatCost` does not ("equality guards a *growing* read; the zero-assertions guard a *repeated*
one. Neither substitutes for the other"). That was my Q2 finding, written up more precisely than I put
it.

**I2 — 13-06 Task 2 says "opens a `SqliteStore` pinned to version 5", which the constructor does not
allow** (`sqlite-store.ts:2634` calls `runSchemaMigrations(this.database)` with the default array). The
plan's own fallback covers it, and a cleaner route exists and is not named: `runSchemaMigrations(raw,
MIGRATIONS.filter(m => m.version <= 5))` against a raw `DatabaseSync`, the shape
`tests/storage/schema-migrations.test.ts:115` already uses.

**I3 — `limit: Infinity` survives in 13-05's behavior text** (`:198`). `limit` is bound into `limit ?`;
`node:sqlite` will not take a non-integer.

**I4 — `13-DEFERRED.md` is referenced by 13-01 (wave 1) and created by 13-12 (wave 7).** Correct as an
output, dangling as a citation for six waves. Harmless; worth a "will exist at phase close" note.

**I5 — 13-01 says "all four pinned expectations" while listing three unedited plus two changed.** The
dispositions are individually correct; the count is not. Same slip in `13-RESEARCH.md`'s resolved
Open Question 1.

## Locked decisions

**One is reopened.** `13-CONTEXT.md:122-123` (locked decision 2) — *"the cap bounds emission, not
correctness. A capped cycle is not a failed cycle, and the next cycle must be able to reach what this
one suppressed rather than losing it permanently."* N1's pending-suppression drop violates it, and N2
means even backlogged suppressions are re-offered without re-checking the state that suppressed them.
Both are the same fix.

Locked decisions 1 and 3 are intact and were strengthened: LD1's resumability now includes the handoff
(D-13-7) and the mechanized recomputability test 13-11 gained for W6; LD3's GAP-12-E holding action got
simpler and GAP-12-D's semantic change is now stated for ADR 0055 rather than buried in a docstring.
No deferred idea appeared: still no ANN library, no re-embedding, no retrieval change, no prune, no
`canonical_events` index (13-06 still greps for it).

## Recommendation

Return to the planner for **N1, N2, N3**. N1 and N2 are one design decision in `13-08` — re-validate the
merged (fresh + backlog) set through step 5's resolution, and route pending-suppressed candidates into
the backlog rather than dropping them — plus one test each. N3 is a two-line edit in two plans. N4 and
N5 are declaration-level and should be fixed in the same pass.

Nothing here changes the wave structure or the phase shape, and nothing established in the first pass
regressed. The revision closed six blockers cleanly and improved four of them beyond the finding; the
remaining work is confined to the emission pipeline's treatment of suppressed candidates, which is
where the phase's locked decision lives and therefore where it is worth being exact.

---

# Third pass — N1/N2/N3/N4 (2026-08-04)

Scoped to the four fixes and to regressions they could have caused. Nothing already passed was
re-reviewed.

## Verdict

**PASS — ready to execute. No blockers. 2 warnings, 2 info.**

All four are closed, and N2's fix is materially better than the finding asked for: re-resolving the
merged set was the correctness requirement, and D-13-8 delivers it while making the bootstrap's
`listSummariesByIds` cost **zero** rather than paying for a 1,000-entry re-resolution every cycle.

## Fix-by-fix

**N1 — closed, and the test genuinely distinguishes counted from retained.**
The rename to `deferredByPendingProposal` is not cosmetic: the terminality table (`13-08-PLAN.md:147-152`)
now makes each category's disposition a declared property rather than an emergent one, and it correctly
separates the two terminal-by-design categories (`suppressedByCoverage` — nothing to come back for;
`suppressedByRejection` — permanence is the point) from the two that route to `mergeBacklog`. Step 3
carries the inline "this branch must not drop" marker at the exact line where the bug lived.

The three-cycle test is discriminating, on all three counts I checked:

- **Counted-vs-retained is separated.** The deferral test asserts the candidate is counted **and**
  "present in the returned backlog", with the acceptance criterion spelling out that these are two
  different claims "and N1 was exactly the gap between them". Cycle 2 then asserts it is *still* in the
  backlog — so a one-cycle-only retention that decayed away would fail.
- **The no-new-pairs construction actually holds.** With `pairs: []`, step 1 produces zero fresh
  candidates, so the merged working set in step 2 *is* the backlog. An emission in cycle 3 therefore has
  exactly one possible source. This is an observation, not an assertion in prose.
- **The mirror rejection branch is right.** Cycle 3's rejected variant asserts {A,B,C} is emitted while
  {A,B} and {A} are not — which is exactly 13-07's equal-or-subset policy: the strict superset is new
  evidence and gets one offer; the equal set and the subset are permanently suppressed. And the approved
  variant is consistent too: `coveringTraceIdFor({A,B,C})` requires contains-all, so an accepted {A,B}
  trace does not cover it, and it correctly takes the extend branch.

**N2 — closed. The split is sound, with one wording defect (W-A below).**
I checked the load-bearing claim — *coverage, pending and rejection resolution need only summary ids* —
against 13-07's actual signatures rather than the plan's summary of them:

| resolution | input | needs a `Summary`? |
|---|---|---|
| `buildTraceCoverage` → `coveringTraceIdFor(summaryIds)` | built from `traces` + `proposals`, queried by id list | **No** |
| pending-overlap index | `summaryId → proposalId` from `listProposals({state:"proposed"})` | **No** |
| `buildRejectionMemory` → `isSuppressed(summaryIds)` via `rejectionKey` | sorted id list hash | **No** |
| `sortSuppressedCandidates` | score, then joined sorted member ids | **No** |
| `mergeBacklog` dedupe | member set | **No** |

And the converse: `hasCompleteSummaryProvenance` (personId/scopeIds/sourceCanonicalEventIds/
sourceTurnRanges), `hasNonContiguousRanges` (sourceTurnRanges + createdAt), and proposal building
(`summaryText`, turn ranges, keywords) all genuinely need `Summary` objects, and all three are in
phase two. The claimed boundary is the real boundary, with the one exception in W-A.

**The enqueue-time implementation genuinely fails the specified test.** Cycle 1 backlogs {A,B} as
`suppressedByCap`; the owner rejects {A,B} between cycles; cycle 2 runs with no new pairs. Under
enqueue-time resolution the entry bypasses step 3 and is emitted — the test asserts *not* emitted, counted
as `suppressedByRejection`, and **removed** from the backlog. All three assertions fail under the old
shape, and the third one also catches a half-fix that suppresses without evicting. The coverage mirror is
present. The `candidatesConsidered === 10` fixture (5 fresh / 7 backlog / 2 dedupe) closes the accounting
hole a merged pipeline could otherwise hide.

The bounded-pool arithmetic checks out: `emissionCap × overSelectFactor × maxTraceMembers` = 20 × 2 × 12 =
480 ids, flat in corpus size, and `listSummariesByIds === 0` at `emissionCap: 0` follows directly from an
empty pool — a real consequence of the split, not a coincidence. Over-selection is the right answer to
"a provenance drop must not waste an emission slot", which the one-phase shape could not express.

**N3 — closed in both plans, and the hazard is correctly re-characterised.**
`13-09-PLAN.md:222-236` and `13-12-PLAN.md:373-387` both carry three explicit `cp -c` lines with both
source and destination named, per-line exit-code checks, an `ls -l` confirmation that all three
destinations exist and are non-empty, and a non-zero exit listed among the stop conditions. **I accept the
correction to my finding:** `cp a b c` with a non-directory final argument exits 1 before copying, so the
`-shm` mutation I described does not occur. The real hazard — an unchecked failure leaving the backup
silently absent while the next step opens the live corpus writable believing a rollback exists — is worse
in context and is now the stated one. Both plans keep the brace form only as a named negative example, in
prose, immediately adjacent to the corrected commands. **No brace-expansion `cp` survives as an
instruction anywhere in the twelve plans** (verified by grep across all `13-*-PLAN.md`).

**N4 — verified. The graph is correct.**

| wave | plans | same-wave `files_modified` overlap |
|---|---|---|
| 1 | 13-01, 13-02 | none |
| 2 | 13-03, 13-04 | none |
| 3 | 13-05 | — |
| 4 | 13-06, 13-07 | none |
| 5 | 13-08, 13-09 | none |
| 6 | 13-10 | — |
| 7 | 13-11 | — |
| 8 | 13-12 | — |

Every `depends_on` edge points at a strictly earlier wave (checked mechanically: 03/04←w1; 05←w2;
06/07←w3; 08/09←w4; 10←w5; 11←{5,5,6} so w7 is valid and w6 would not have been; 12←{6,7}). Strictly
increasing wave numbers along every edge makes a cycle impossible. 13-11 and 13-12 are now singletons, so
the 13-11→13-10 code dependency that motivated the move is fully ordered. The two references you fixed
(`13-12-PLAN.md:365` and the T-13-65 threat row) both read wave 8.

## Warnings

**W-A — phase one's step 3 includes the mint branch, but minting needs `createdAt`, which is a `Summary`
field. The split is right; the step boundary is drawn one call too late.**
*Affects:* `13-08-PLAN.md:392-396` ("otherwise extend or mint… All of this is id-only — no `Summary` is
touched") against `13-07-PLAN.md:255` — `selectSeedSummary(members: ReadonlyArray<{ id: string; createdAt:
string }>)`, which `resolveTraceIdForCandidate`'s mint branch calls to pick the member minimising
`(createdAt, id)`. Neither `SummaryVectorIndex` (ids + vectors, no clock) nor
`listSummaryVectorIdsCreatedAfter` (returns ids only) supplies `createdAt`, and `ScoredPair`'s shape is
never specified.
This is **not** the silent under-resolution the split was checked for — `poolMemberIds` is the union of
pool member ids regardless of how identity resolved, so nothing under-resolves — and `tsc` will refuse the
call, so it surfaces loudly. But an executor facing that type error has two routes, and the wrong one
(synthesizing or omitting `createdAt`) silently destabilises trace identity, which is SC4's core.
Nothing in phase one needs the minted id: step 4 orders on score and member ids, step 5 over-selects, and
`mergeBacklog` dedupes on member set. And 13-06 already sanctions the fix —
`SuppressedTraceCandidateSchema.traceId` is `.nullable()` with the comment *"Null when the candidate would
mint."*
*Fix:* state that in phase one the mint branch resolves only to "will mint" (`traceId: null`) and that
`selectSeedSummary`/`mintTraceId` run in phase two where members exist; keep coverage and extend
resolution — both genuinely id-only — in phase one.

**W-B — two in-body wave references did not move.** `13-01-PLAN.md:80` says "waves 2-7"; the phase now runs
to wave 8. `13-12-PLAN.md:392` says the backup divergence is "the writable activity between waves 5 and 7";
it is now waves 5 and 8. Both cosmetic; both in text an executor reads.

## Info

**I-A — W5 is still open and still correctly deferred.** `13-10-PLAN.md`'s SC5 fixtures still carry zero
pre-existing traces and proposals, so `listTraces`/`listProposals` remain vacuous entries in the
`assertFlatCost` list. Documentation-complete, assertion-incomplete, and unchanged by this pass.

**I-B — the earlier INFO items stand** (I2 the v5-pin phrasing, I3 `limit: Infinity`, I4 the wave-1
citation of a wave-8 artifact, I5 the "four pinned expectations" arithmetic). None affects correctness.

## Bottom line

**Execute.** The three blockers are closed at the mechanism, not at the symptom: N1 changed where a
category goes rather than renaming what it is called, N2 changed when resolution happens rather than
adding a re-check, and N3 changed the instruction that was itself the risk. W-A is a one-sentence
boundary correction inside a design that is otherwise sound, and it fails loudly rather than silently.
