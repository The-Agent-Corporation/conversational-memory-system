# Phase 12 — Pre-execution plan check

**Checked:** 2026-07-28 · 7 plans (`12-01` … `12-07`), 6 waves, commit 67dfbb4
**Inputs read:** all 7 PLAN.md, `12-CONTEXT.md` (incl. 2026-07-28 addendum), `12-RESEARCH.md` (incl.
superseded-in-part banner), `12-GAP-12-A.md`, `12-GAP-12-B.md`, ROADMAP Phase 12, REQ-043/REQ-045.
Every load-bearing source claim was verified in the tree. One read-only measurement was taken against
`~/.memory/aaron.db` (`readOnly: true`; nothing written).

## Verdict

**ISSUES FOUND — not ready to execute. 3 blockers, 10 warnings, 1 info.**

None of the blockers require re-architecting the phase; all are local edits. What is already sound:

- Requirement coverage complete — REQ-043 in 12-02/03/04/06/07, REQ-045 in 12-01/02/03/05/06/07.
- Dependency graph acyclic, wave numbers = max(deps)+1 throughout.
- Scope sane — every plan ≤3 tasks, ≤6 files.
- Every non-checkpoint task has an `<automated>` verify; no watch-mode flags; checkpoints correctly
  use `<human-check>`.
- All four locked decisions have implementing tasks; no deferred idea appears (no prune, no retrieval
  ranking change, no vector sync).
- Both owner-gated live plans have real blocking checkpoints with inode-verified backup gates.

## Answers to the seven questions

1. **SC coverage.** SC1/SC2/SC3 provably covered. SC3's negative is asserted properly: pinning
   `SyncOperationKindSchema.options` to the exact 7 values (verified `src/storage/sync-contracts.ts:18-26`)
   **does** fail if the enum is widened — that is the load-bearing assertion; outbox deep-equality is a
   valid second line. **SC4 is not covered as written** — see F1.
2. **Ordering.** Sound. No plan leaves an unrecoverable state, and **no ordering in this set can create a
   mixed-provider vector store**: 12-03's "disabled or unhealthy ⇒ no embedder ⇒ zero writes" means the
   daemon can never write hash vectors, and the only mixed path (backfill before enable) occurs in no
   plan and is explicitly forbidden. Note the CONTEXT phrasing is slightly off — `embedder-resolver.ts`
   does not detect mixed-provider stores; D-05 only means "never silently fall back." The protection here
   is structural, not enforced.
3. **The seam.** Departure is sound; the claim checks out. `drainSlice` has exactly three production
   callers: `daemon-command.ts:313` (gets the embedder), `rebuild-derivations-command.ts:156` via
   `new ContractionRunner(store, { authority })` at `:145` — **no option, verified** — and
   `historical-bootstrapper.ts:135` via the runner built at `:117`, also without it. Nothing embeds
   unintentionally. The cited precedent `rebuild-derivations-command.ts:167-175` is real, but 12-03 copies
   only half of it (F6).
4. **The crash hole.** Window covered for the create case; the pass is genuinely budgeted (K=200 +
   15-min interval) and is **not** the `createStagingStore` shape (`proposal-scheduler.ts:83-103` loads and
   re-parses five tables; 12-04 forbids `listSummaries()` and greps for it). But the *query* it runs each
   tick is a full-corpus payload scan — measured, F3 — and the upsert-failure case is uncovered, F5.
5. **Both-stores parity.** Genuinely tested. `tests/storage/summary-vectors.test.ts:66-93` already runs a
   backend matrix over `InMemoryStore` and `SqliteStore`, plus a `cross-store exact parity` describe at
   `:409`; 12-02's parity test drops into an existing shape. Gap: `listSummariesByIds` parity is in the
   behavior list but not the acceptance criteria (F10).
6. **Test-blindness.** 12-01 fixes the original instance well (the direct
   `embedder.model === (await embed()).model` tripwire is the right assertion). Partially repeated in
   12-03/12-04 (F9).
7. **Live-corpus safety.** Gates are real and blocking; four backups inode-verified; `stat -f %Sm`
   local-time labelling called out by name. Gaps: no WAL handling (F7), no stated rollback (F8), and one
   acceptance criterion that cannot hold (F4).

---

## Findings

### BLOCKERS

**F1 — SC4's "relative to its peers" clause has no acceptance criterion anywhere, and the research
question that flagged it was never resolved.**
*Affects:* `12-RESEARCH.md:492-499` (A3), `12-RESEARCH.md:741` (Open Question 4), all plans.
The research explicitly recommended "stating that reading explicitly in the plan… **Flag for owner
confirmation**." 12-03 Task 3 (`12-03-PLAN.md:292-293`) carries forward **only** A4 (the daemon-health
reading). A3 is silently answered "no peer comparison" by omission, and `## Open Questions` carries no
`(RESOLVED)` marker. REQ-045 is fully satisfied (provider + model + version recorded; 12-05/12-07 assert
the composed identity on live data), but `/gsd:verify-work 12` will read SC4 literally and find nothing
that makes a peer's model identity observable.
*Fix:* add the A3 reading to ADR 0052 (12-03 Task 3) alongside A4, marked pending owner confirmation; have
12-07 Task 3 amend ROADMAP SC4 to the confirmed reading (it already edits that file); add an acceptance
criterion in 12-02 Task 2 that the persisted/reported `model` contains the pinned revision — the
mechanical half of stale-model detection.

**F2 — 12-04 Task 2's wiring instruction is unimplementable in the code shape 12-03 creates.**
*Affects:* `12-04-PLAN.md:176-178` vs `12-03-PLAN.md:212-218`; `src/daemon/daemon-command.ts:286-323`.
12-04 says to "omit the dependency entirely, matching how `syncReplication` is conditionally spread at
`daemon-command.ts:319-322`." But `syncReplication` is spread **synchronously into the
`new DaemonLoop({...})` constructor** at `:318-322`, while 12-03 resolves the embedder in an **async
memoized initializer awaited inside the returned `run`/`runOnce`** (`:325-327`) — after the loop is
already constructed. The criterion "`embeddingRepair` is optional and absent when no embedder is resolved"
cannot hold. An executor will pick a workaround silently, and the plausible wrong one is a second
`resolveEmbedder` call — a second ONNX session, exactly what T-12-23 forbids.
*Fix:* always spread `embeddingRepair: { runDue: async () => repairRunner?.runDue() }` reading the same
closure variable 12-03 declares, and restate the criterion as "no-ops when no embedder is resolved"; or
make `createLoop` async and resolve above the constructor (wider — touches the `DaemonCommandDependencies`
type and its test doubles).

**F3 — the state-predicated missing-set query is 11× slower than the query it replaces, is unindexed, and
the daemon runs it every 15 minutes. Measured, not projected.**
*Affects:* `12-02-PLAN.md:135-140`, `12-04-PLAN.md:125`, `src/storage/sqlite-store.ts:1692-1704`.

Read-only against the live corpus, 2026-07-28:

| query | rows | wall clock |
|---|---:|---|
| current (`select id from summaries where not exists …`) | 138,373 | **351 ms** |
| planned (`… json_extract(payload,'$.state') in (?,?,?) and not exists …`) | 49,314 | **3,817 ms** |

`explain query plan` shows `SCAN summaries USING INDEX sqlite_autoindex_summaries_1` — today's query is a
covering id-only scan; adding `json_extract(payload,'$.state')` forces reading the `payload` column of all
138,373 rows out of a 5.0 GB table. The only candidate index, `idx_summaries_person_state`
(`schema-migrations.ts:58-59`), leads on `json_extract(payload,'$.personId')` and cannot serve a
state-only predicate — and `listSummaryIdsMissingVector` takes no `personId`. So 12-04's resident repair
pass adds a ~4 s full-payload scan every tick forever, including in steady state when nothing is missing,
and every `memory status` call pays it too. That is not "bounded by the number of new summaries."
*Fix:* (a) add a schema v4 migration
`create index if not exists idx_summaries_state on summaries (json_extract(payload,'$.state'), id)` in
12-02 and re-measure; (b) push the budget into the query as a `limit` parameter so the repair path stops
after K matches instead of materializing 49,314 ids to slice 200 off the front; (c) record the measured
query time in 12-06's rehearsal artifact as a gate.
**Sequencing caveat if (a) is adopted:** migrations run on `new SqliteStore(...)`, and 12-05 Task 1 opens
the live DB (`memory daemon status`) **before** the `pre-phase12` backup exists in Task 2. Reorder so the
backup precedes any open, or the first schema write to a 5 GB live corpus happens unbacked.

### WARNINGS

**F4 — 12-05 Task 3's "database file is byte-unchanged by this plan" criterion cannot hold.**
*Affects:* `12-05-PLAN.md:235`. `memory daemon stop` writes the stop request and lease release; every
`SqliteStore` open runs `pragma journal_mode = WAL` (`sqlite-store.ts:197`) and touches `-shm`/`-wal`. As
written this triggers a false stop.
*Fix:* restate as "no summary or `summary_vectors` row is written; row counts identical before and after",
and expect mtime churn.

**F5 — the repair pass can heal a *missing* vector but never a *stale* one.**
*Affects:* `12-04-PLAN.md:124-131`, `12-03-PLAN.md:16-23`. A continuing topic's active-span summary is
re-emitted under the same id with changed text (`contraction-runner.ts:276-277`, `:593`). If the embed
stage fails or crashes on that upsert, the row still exists → never in the missing set →
`memory status` reports `missingVectors: 0` while the vector no longer matches its text. Once the topic
closes, that is permanent; the primary path self-heals only while the topic keeps producing slices.
*Fix:* at minimum record the limitation in ADR 0052; better, have the repair pass also consider vectors
whose `createdAt` precedes their summary's `updatedAt`, or have the embed stage's failure path record the
affected ids.

**F6 — 12-03 copies half of the precedent it cites: the daemon writes vectors on supersession but never
tombstones them.**
*Affects:* `12-03-PLAN.md:47-48`, citing `rebuild-derivations-command.ts:167-175`. That code calls
`store.deleteSummaryVectors(supersededSummaryIds)` from `slice.supersessions` post-commit; 12-03 adds the
symmetric write in the same region but not the delete. Correctness is safe (`findNearestSummaries`'
GAP-11-A sweep filters non-retrievable summaries), but stale vectors accumulate unboundedly and are
unreachable by the now state-predicated missing-set query. `slice.supersessions` is already in scope at
that point.
*Fix:* add the `deleteSummaryVectors(supersededSummaryIds)` call and a test to 12-03 Task 1.

**F7 — no plan mentions `aaron.db-wal` / `aaron.db-shm`; a `cp -c` of the main file alone can be an
inconsistent backup.**
*Affects:* `12-05-PLAN.md:146-148`, `12-06-PLAN.md:90-91`. The store runs in WAL mode. Today
`~/.memory/aaron.db-wal` is 0 bytes and `-shm` is 32,768 bytes, so a clone taken now is fine — but that is
a fact to verify at backup time, not assume.
*Fix:* in 12-05 Task 2 and 12-06 Task 1, assert the `-wal` is 0-length (or checkpoint it) after the daemon
stops and before cloning; record it in the artifact.

**F8 — no rollback path is stated.**
*Affects:* `12-05-PLAN.md:229`, `12-07-PLAN.md:226`. Both threat models say "restore-from-backup is the
only recovery path (ADR 0051)" but neither gives the sequence.
*Fix:* state it concretely in 12-07 Task 2 — stop daemon, move (never delete) the live file aside,
`cp -c ~/.memory/aaron.db.pre-phase12` into place, re-run `memory status` to confirm `summary_vectors: 0`.

**F9 — 12-03 and 12-04 specify "a deterministic fake embedder", the exact fixture shape that hid
GAP-12-A.**
*Affects:* `12-03-PLAN.md:253`, `12-04-PLAN.md:105-107`. 12-01 makes advertised == emitted true for all
embedders, so the risk is reduced — but 12-04's convergence test is the one place a two-key mismatch would
reappear, as an infinite 200-per-tick re-embed loop on the live corpus, and a coinciding-identity fake
makes it invisible.
*Fix:* reuse the differing-identity fake 12-01 Task 3 builds (non-empty revision).

**F10 — `listSummariesByIds` parity is in 12-02's behavior list but not its acceptance criteria.**
*Affects:* `12-02-PLAN.md:159-165`. Only missing-set parity is required. The existing backend matrix at
`tests/storage/summary-vectors.test.ts:66-93` makes adding it nearly free.
*Fix:* add "`listSummariesByIds` exercised through the both-stores backend matrix" to the criteria.

**F11 — the repair pass is wired only into `drainOne`, so `memory daemon once` never repairs — including
12-06's clone check.**
*Affects:* `12-04-PLAN.md:170`, `src/daemon/daemon.ts:246-262`. `runOnce` has its own contraction loop
that does not call `drainOne`. 12-06 Task 2's `memory daemon once` therefore exercises embedder
resolution but not the repair pass, while its acceptance criterion reads as if it does.
*Fix:* wire it into `runOnce` too, or state explicitly in 12-04 and 12-06 that repair is `run`-mode only.

**F12 — factual error in 12-02's action, and the source of an index assumption.**
*Affects:* `12-02-PLAN.md:136-138`. It says `findNearestSummaries` "reads it via
`json_extract(payload, '$.state')` at :1720-1725". It does not — `sqlite-store.ts:1718-1727` selects
`payload where json_extract(payload,'$.personId') = ?` and filters state in JS via `isRetrievableState`.
State has never been read in SQL anywhere. Ties directly to F3.
*Fix:* correct the instruction; the intent (reuse the allow-list, never hand-write `!= 'superseded'`) is
right and should stay.

**F13 — 12-02 and 12-03 are both wave 2 and both `autonomous: true`, conflicting with a recorded CONTEXT
hazard.**
*Affects:* `12-CONTEXT.md:84-85` — "Only one agent may hold write access to the worktree at a time, and no
agent may use `git add -A`/`.`"; a broad stage already swept another agent's in-flight edits in Phase 11.
Their `files_modified` sets do not overlap (storage/bootstrap vs daemon/adr/tests-sync), so the risk is
staging collision, not edit collision.
*Fix:* run wave 2 serially, or add an explicit "stage only these paths" note to both plans.

### INFO

**F14 — revived summaries carry no vector until a repair tick.** `RETRIEVAL_CANDIDATE_STATES` includes
`stale` because `prepareInjection` can promote it to `revived` (`retrievable-state.ts:22-30`). 12-02
correctly excludes `stale` from the missing set, so a promoted summary is vector-less for up to one repair
interval plus backlog. Self-healing and consistent with `findNearestSummaries`, but unstated — worth a
line in ADR 0052.

## On the locked decisions

None of the four are challenged. Locked decision 3 (state predicate, no prune) is the right product fix;
F3 is a cost of *implementing* it, not an argument against it — the remedy is an index, not a prune.

## Recommendation

Return to the planner for F1, F2, F3, and — since they are one-line edits in the same files — F4–F13.
Nothing here changes the wave structure or the phase shape. Re-verify after revision.

---

# Re-check — revision `0ec1ded` (2026-07-28)

Focused re-check of the deltas only. Everything established sound in the first pass was not re-derived.
All source claims below were re-verified in the tree; two read-only probes were taken against
`~/.memory/aaron.db` (`readOnly: true` — which does **not** migrate, since `sqlite-store.ts:195-198` gates
`migrate()` on `!options.readOnly`).

## Verdict

**READY TO EXECUTE.** All 13 findings are closed. No blocker remains. One stale premise is noted below as
an operational note, not a finding — it makes the phase safer, not riskier.

## Fix-by-fix

| # | Status | Evidence |
|---|---|---|
| F1 SC4 | **Closed** | ADR 0052 gains decision 5 recording the A3 reading pending owner confirmation (`12-03` Task 3), with the correct argument that the literal reading contradicts SC3. Mechanical half now testable twice: `12-02` Task 2 asserts the reported `model` contains `ea104dac…` as a substring; `12-05` Task 3 asserts it on live data. `12-07` Task 3 amends ROADMAP SC4 inline, dated, pointing at ADR 0052, and handles the not-yet-confirmed case explicitly. SC4 now has a criterion that can pass. |
| F2 wiring | **Closed** | `12-04` Task 2 now always spreads `embeddingRepair: { runDue: async () => repairRunner?.runDue() }` reading `summaryEmbedder`; `12-03` Task 2 pins that variable name and records the synchronous-constructor/async-embedder shape at `daemon-command.ts:287,319-322,325-327` so the constraint is visible from both sides. Criterion restated as "no-ops when no embedder is resolved", asserted by a store spy showing zero queries, plus `resolveEmbedder` appearing exactly once. Implementable as written. |
| F3 index | **Closed** | v4 appended to `MIGRATIONS` as `create index if not exists idx_summaries_state_id on summaries (json_extract(payload,'$.state'), id)`; v1–v3 byte-unchanged asserted via `git diff`; `user_version` 3→4 and re-open idempotence asserted; `explain query plan` recorded as an acceptance criterion, with `USE TEMP B-TREE FOR ORDER BY` pre-labelled as expected so it is not misread as a half-failure. Gated again on a clone in `12-06` and on live data in `12-05`. **`limit` does not change backfill semantics:** `backfill-embeddings-command.ts:64` passes no options, and the plan requires an omitted `limit` to reproduce today's unbounded behavior exactly, with a prefix-identity assertion in both stores. The rename to `remainingInBatch` is a good catch — with a limited query `ids.length === budget` means "at least this many". |
| F4 | Closed | "Byte-unchanged" replaced by row-count invariance in `12-05`, `12-06`, with the mtime/WAL/index churn named explicitly. |
| F5 | Closed as accepted limitation — see adjudication below. |
| F6 | Closed | `deleteSummaryVectors(supersededSummaryIds)` added post-commit from `slice.supersessions`, ordered **after** the write so the tombstone wins when an id appears in both, with that case asserted. Ordering was decided rather than left to chance. |
| F7 WAL | Closed | `-wal` checked in `12-05` Task 1, re-checked immediately before the clone in Task 2, and again in `12-06` Task 1; non-zero stops the plan. |
| F8 rollback | Closed | Concrete sequence in `12-05` and `12-07`, with `mv` not `rm`, `-wal`/`-shm` moved alongside, and the correct judgement that a partial backfill is resumable and not a rollback trigger. |
| F9 | Closed | `DifferingIdentityEmbedder` exported from `tests/embeddings/fixtures.ts` by `12-01`; `12-03` and `12-04` are required to import it and forbidden a local double. |
| F10 | Closed | `listSummariesByIds` and the `limit` behavior both routed through the existing backend matrix at `tests/storage/summary-vectors.test.ts:66-93`. |
| F11 | Closed | Repair pass invoked in **both** `drainOne` and `runOnce` (`daemon.ts:246-262`), asserted separately; `12-06`'s `memory daemon once` check now expects `persisted: 0` from a pass that actually ran. |
| F12 | Closed | The false claim is corrected in place *and* labelled as the reason the index was nearly missed. |
| F13 | Closed structurally — `12-03` moved to wave 3 / `depends_on: ["12-02"]` and `12-04` to wave 4, so the phase is now fully serial (7 plans, 7 waves; ROADMAP updated). Explicit staging discipline added to every plan's verification block. `12-04`'s `depends_on` dropped `12-02`, but the order is preserved transitively (04→03→02→01). |
| F14 | Closed | Recorded as ADR 0052 decision 7. |

## The structural change — no remaining unbacked open

**No path in 12-01 through 12-05 opens the live database non-read-only before the `pre-phase12` backup
exists.** 12-01–12-04 are code/test plans whose verifies are `vitest`/`typecheck`/`test -f`/greps; their
store tests use `InMemoryStore` and temp-file `SqliteStore`. 12-05 Task 1 now forbids every `memory`
subcommand against the live DB and verifies the stop via `ps`/`launchctl`/`ls`/`stat`; Task 2 clones;
Task 3 owns the first open and treats the v4 migration as a measured step with a stated rollback.

I checked the one path the plans could not control — a `KeepAlive` LaunchAgent relaunching the daemon on
the new build between 12-02 landing and 12-05 Task 1, which would migrate the live corpus unbacked.
`launch-agent.ts:48-51` does set `KeepAlive: true`, **but that risk does not exist here:**

- no `com.conversational-memory.daemon.plist` in `~/Library/LaunchAgents/`
- no daemon process (`ps` for `tsx`/`bin/memory`/`conversational-memory` is empty)
- `daemon_lease` is **empty** and `pragma user_version` reads **3** (read-only probe)

## Operational note (not a finding)

`12-05` Task 1 is written to stop an *actively cycling* daemon ("`attempts: 4680`… do not assume it is
idle"). That was true when CONTEXT was written; it is not true now — nothing is running and no LaunchAgent
is installed. The task's acceptance criteria pass trivially. The executor should record "no daemon
running, no plist installed, `daemon_lease` empty" as the expected outcome rather than hunt for a
`launchctl` label that does not exist. A `readOnly: true` probe to confirm the empty lease is safe and does
not migrate — Task 1's "`pragma user_version` NOT read yet — that requires an open" is imprecise on that
point, though harmless.

## F5 adjudication — the planner's correction is accepted

Verified independently: `SummarySchema` (`src/domain/types.ts:104-129`) has `createdAt`, `version`,
`lastAccessedAt` — and **no `updatedAt`**; `contraction-runner.ts:447` sets `version: 1` unconditionally.
`lastAccessedAt` is a read-time field, not a write marker, so it is not a substitute. There is no monotonic
field to compare a vector's `createdAt` against. **My suggested detector was not implementable and the
correction is right.**

"Accepted limitation" is the right disposition **for this phase** — inventing a heuristic here would be
worse than the gap, and ADR 0052 decision 6 records it with the verified reason rather than as a vague
caveat. But it should *also* be a follow-up item with a named owner: the failure mode is silent
(`memory status` reports `missingVectors: 0` while a vector no longer matches its text), and the fix — a
stored content hash or an `updatedAt` on `SummarySchema` — is a one-field schema change that belongs with
the vector-native work in Phases 13–14. An ADR entry makes it discoverable; it does not make it owned.
**Recommendation:** keep the ADR record as written and file a `bd` issue pointing at ADR 0052 decision 6,
targeted at the phase that adds the field. Not a blocker for Phase 12.

## Bottom line

Execute. The revision closed every finding, and in three places (F3's `limit`, F6's write/delete ordering,
F11's `runOnce`) it went further than the finding asked.
