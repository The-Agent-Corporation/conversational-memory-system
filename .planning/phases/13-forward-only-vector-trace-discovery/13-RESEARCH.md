# Phase 13: Forward-Only Vector Trace Discovery — Research

**Researched:** 2026-08-04
**Domain:** Internal architecture — derivation subsystem replacement (traces), daemon bounded work, SQLite query cost
**Confidence:** HIGH for the code path and what tests pin (read directly, cited file:line). MEDIUM for the query-plan hypotheses in §4, which are reasoned from the DDL and not measured in this session. Live-corpus numbers are quoted from `13-CONTEXT.md` and were **not** re-measured, per instruction.

**Web research was not performed.** This is a brownfield internal-architecture question, an ANN library is explicitly out of scope (`13-CONTEXT.md:169-172`), and no new package is introduced. There is therefore **no Standard Stack section and no Package Legitimacy Audit** — nothing is installed by this phase. If the planner introduces a dependency, that gate must be run before it lands.

---

<user_constraints>
## User Constraints (from 13-CONTEXT.md)

### Locked Decisions

**Locked decision 1 — one-time full bootstrap, then strictly forward-only.** The existing 56,706 summaries **are** bootstrapped against each other in a single bounded, **resumable** pass. Pure forward-only was considered and rejected. Requirements on the bootstrap:

- **Resumable via a checkpoint**, in the same spirit as contraction's. It must survive a crash, a kill, and a restart without redoing completed work and without double-proposing.
- **Loads the corpus once.** It must not call `findNearestSummaries` per summary. Whether that means a new bulk-oriented store method, an in-memory index built once, or an extension to the existing method is the planner's call — but the 154-hour shape must be structurally impossible, and that must be provable by a test that asserts on **call counts or query counts**, not on elapsed time.
- **Runs offline / on demand**, not inside a normal daemon cycle. It is an overnight job.
- **Idempotent.** Running it twice must not produce duplicate traces or duplicate proposals.

After bootstrap, the daemon is **strictly forward-only**: a cycle evaluates only summaries created or changed since the last successful pass, against existing neighbours. This is Phase 13 SC2 and it is non-negotiable — no rescan, no restage, no full-corpus load per cycle.

**Locked decision 2 — top-k above threshold, plus a HARD per-cycle proposal cap.**

- The cap is a **configured number**, defaulting to something a human can actually review (order of 20 per cycle — the planner should propose the default and justify it, and it must be overridable).
- Emission is deterministic: highest similarity first, with a stable tiebreak.
- Suppressed candidates must be **counted and reported**, never silently dropped. ADR 0054's "no silent caps" applies.
- The cap bounds *emission*, not *correctness*. A capped cycle is not a failed cycle, and the next cycle must be able to reach what this one suppressed rather than losing it permanently.
- The similarity threshold must be **chosen against measured data on a clone** before the daemon runs against the live corpus.

**Locked decision 3 — GAP-12-D and GAP-12-E land first, in wave 1.**

- **GAP-12-E — neutralise the all-pairs trace pass.** Interim position is boxes-only. A **holding action with an expiry date, not a fix**: the planner must not tune, threshold, or otherwise attempt to rescue the term matcher.
- **GAP-12-D — summary decay is not idempotent.** `sleep-reviewer.ts:304` `decaySummary` compounds instead of converging. Note: `NON_SUPERSEDED_STATES` includes `stale`, so **decay alone does not shrink the review candidate set**. Whatever bounds a pass must be an explicit predicate, not a side effect of decay.

**Preserved exactly — the review contract (SC3, hard fence).** Vector-derived proposals carry the **identical** `TraceCandidate` / `MemoryProposal` shape, flow through the **unchanged** review/accept/reject decision path, and add a human-readable rationale. **Nothing in this phase may auto-approve a trace or silently mutate one.** Trace *identity* must be stable across runs and capable of matching an *existing* trace rather than minting a new one, or SC4 cannot hold.

**This is a greenfield build, not a migration.** traces 0, boxes 0, proposals 0. No migration, purge, or backfill of existing trace assignments is to be planned.

### Claude's Discretion

Explicitly delegated by CONTEXT to the planner:

- Which mechanism loads the corpus once (new bulk store method / in-memory index / extension to the existing method).
- The default value of the per-cycle proposal cap, and its justification.
- The similarity threshold value — but it must be chosen from measurement on a clone, not intuition.

### Deferred Ideas (OUT OF SCOPE)

- **No ANN library, no new vector index, no `sqlite-vec`.**
- **No re-embedding.** Phase 12 owns vector currency.
- **No retrieval changes.** Semantic recall is Phase 14.
- **No prune of the 89,059 superseded summaries** (ADR 0052 locked decision 3 stands).
- **GAP-11-F's 151 contaminated corpus rows** remain untouched.
- **No new `person_id`-leading index on `canonical_events`** without a query-plan test.

### Operational fences

All experimentation on `cp -c` APFS clones. Never open `~/.memory/aaron.db` non-read-only without a fresh verified backup — migrations run in the `SqliteStore` constructor when `!readOnly`. Existing backups are not to be deleted, moved, or overwritten. Secrets redacted as `[REDACTED]`. The daemon is **stopped** and stays stopped until GAP-12-E lands.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research support |
|----|-------------|------------------|
| REQ-046 | Recurring non-contiguous traces shall be discovered by nearest-neighbor similarity above a threshold over summary embeddings, replacing the shared-term all-pairs candidate algorithm. | §2 (current path, what is replaced), §4 (corpus-load options), §5 (identity) |
| REQ-047 | Ongoing trace discovery shall be forward-only and incremental — new summaries evaluated against existing neighbors — and shall never rescan or restage the full corpus after bootstrap. | §3 (cursor placement), §4, §6 R1 |
| REQ-048 | Vector-derived traces shall preserve the existing proposal, review, and reversible-decision flow and shall carry a human-readable rationale for why summaries were linked. | §2.4 (accept path, unchanged), §2.5 (what can stay), §7 (pinned tests) |

Success criteria are quoted verbatim in `13-CONTEXT.md:190-205` and are not restated here.
</phase_requirements>

---

## Project Constraints (from CLAUDE.md / AGENTS.md)

These bind the plan with the same force as a locked decision.

| Directive | Source | Consequence for this phase |
|-----------|--------|----------------------------|
| `MemoryStore` is implemented **in full** by both `sqlite-store.ts` and `in-memory-store.ts`; **any interface change means editing both** | CLAUDE.md "Architecture"; AGENTS.md | Every option in §4 that adds a store method costs two implementations plus a cross-store parity test |
| Multi-row writes go through named `commit*` methods whose shapes live in `mcp-mutation-contracts.ts`, `sync-contracts.ts`, `daemon/types.ts`; **never scatter ad-hoc writes** | CLAUDE.md | Bootstrap proposal publication must go through `commitProposalRun` or a new named `commit*`, not loose `saveProposal` calls |
| `schema-migrations.ts` owns versioned DDL | CLAUDE.md | Any index or table is migration 6, append-only, never mutating an earlier entry (`schema-migrations.ts:16-22`) |
| ESM `NodeNext`: **local TS imports use `.js`** | CLAUDE.md | Mechanical, but a common first-commit failure |
| Zod schemas are the validation boundary — parse at the edge | CLAUDE.md | New checkpoint/candidate shapes need Zod schemas, and `.strict()` has a back-compat consequence (§3) |
| Person/scope isolation is a hard invariant; retrieval and vector queries take explicit `personId` + `allowedScopeIds` | CLAUDE.md | Any new bulk vector read must carry the same boundary; see §6 R6 |
| Determinism: clocks and IDs injected; **no external LLM call may be required for a test to pass** | CLAUDE.md | The deterministic vector planner must be the always-on path; the OpenRouter planner (`openrouter-proposal-planner.ts:249`) stays an option |
| Proposals move through explicit reviewed status transitions — **never auto-approve or silently mutate** | CLAUDE.md; CONTEXT | Restates SC3; nothing in this phase writes `state: "approved"` |
| Each subsystem has an ADR; **add a new ADR for a new decision** | CLAUDE.md | This phase produces at least one new ADR (next free number is **0055**; 0054 is the highest present) |
| No build step; `npm test` = `vitest run`; Node 22+ `node:sqlite` `DatabaseSync` | CLAUDE.md | All measurement harnesses are `tsx` scripts or vitest, not compiled artifacts |

---

## Summary

Phase 13 replaces one algorithm inside one class, but the hard part is not the algorithm — it is that **the seam the algorithm sits behind is shaped as "here is the whole corpus."** `TraceProposalPlanner.proposeTraces` takes `summaries: Summary[]` (`trace-proposal-planner.ts:13-32`), and `SleepReviewer.loadCandidates` fills it with every non-superseded summary the person owns (`sleep-reviewer.ts:106-125`). A vector planner that honours that signature unchanged is still a full-corpus rescan; SC2 is a statement about the *interface*, not only about the implementation behind it. This is the single most important structural finding: the phase cannot succeed by swapping the body of `buildTraceCandidates`.

The good news is that everything *downstream* of candidate generation can stay. `TraceCandidate` (`trace-candidate-core.ts:5-12`), `buildTraceProposal`'s output shape (`trace-proposal-planner.ts:112-147`), `TraceProposalPayloadSchema` (`domain/types.ts:223-234`), `commitProposalRun` (`sqlite-store.ts:822-861`), `validateStagedReview` (`proposal-scheduler.ts:133-155`), and `approveTraceProposal` (`proposal-reviewer.ts:226-262`) are all agnostic to how candidates were found. SC3 is achievable without touching any of them. There is even a purpose-built injection point already pinned by a test: `SleepReviewerOptions.tracePlanner` (`sleep-reviewer.ts:52`, test at `tests/sleep/sleep-reviewer.test.ts:228-245`).

The two costs that dominate everything are both in `SqliteStore.findNearestSummaries` (`sqlite-store.ts:1813-1856`): the per-call vector load at `:1814-1820` and the per-call **full summary-payload** load at `:1826-1828` used only to compute a retrievable-id set. Neither is a defect for the one-query-at-a-time use the method was built for; both are fatal in a loop. Any design that keeps a per-summary call to this method inherits the 154-hour shape. The cheapest independent win available — orthogonal to whichever option §4 chooses — is to make that `:1826-1828` sweep an id-only, state-predicated query that migration 3's index can cover, rather than a payload scan filtered in JS.

**Primary recommendation to the planner:** treat "the planner interface stops taking `Summary[]`" as the phase's central structural change, decide the corpus-load mechanism (§4) and the trace-identity rule (§5) *before* writing any wave, and make the call-count test (§6 R1) a wave-1 artifact so every later wave is measured against it rather than after it.

---

## Architectural Responsibility Map

| Capability | Primary tier | Secondary tier | Rationale |
|------------|--------------|----------------|-----------|
| Vector similarity arithmetic (cosine, normalisation, top-k) | Pure module (`src/traces/` or `src/embeddings/`) | — | Deterministic, no I/O, unit-testable with no store; matches how `trace-candidate-core.ts` is already factored (pure, worker-safe, `:77-82`) |
| Loading vectors + retrievable-id set | Storage (`MemoryStore` + both impls) | — | Person/scope boundary and the GAP-11-A retrievable sweep must live where the existing one lives, or the predicate is duplicated (ADR 0054 §3's named failure) |
| Candidate → proposal shaping (confidence, rationale, dedupe) | Planner (`src/traces/`) | — | Mirrors `DeterministicTraceProposalPlanner` today; keeps the OpenRouter alternative viable |
| Scheduling, bounding, lease safety, checkpointing | Daemon (`src/daemon/`) | — | `ContractionRunner` / `EmbeddingRepairRunner` are the two precedents; the lease TTL is a daemon concern, not a planner one |
| Publication atomicity + validation | Storage `commit*` + `ProposalScheduler` | — | Unchanged by this phase; SC3 depends on it staying unchanged |
| Offline bootstrap job | CLI (`src/cli/command-registry.ts` + `src/operations/`) | Daemon (shares the pure scan module) | CONTEXT locks "runs offline / on demand, not inside a normal daemon cycle"; `backfill-embeddings-command.ts` is the exact precedent |
| Human review / accept / reject | `src/proposals/` + MCP + Hermes surfaces | — | Explicitly out of scope to change |

---

## 1. State of the world, as read from the code

Facts verified by reading the repo in this session (not re-measured against the database):

- `findNearestSummaries` exists in the interface (`memory-store.ts:333`) and in both stores (`sqlite-store.ts:1813`, `in-memory-store.ts:1282`). **It has no production caller.** The only references are tests, the interface, and two comments. Phase 13 is its first consumer.
- There is **no bulk vector read** on `MemoryStore`. The vector surface is `saveSummaryVector`, `saveSummaryVectors`, `getSummaryVector`, `listSummaryIdsMissingVector`, `listSummariesByIds`, `findNearestSummaries`, `deleteSummaryVectors` (`memory-store.ts:292-338`). Reading N vectors today means N `getSummaryVector` calls or one `findNearestSummaries` call that throws away everything below top-k.
- `DeterministicTraceProposalPlanner` is constructed with **no options** in production (`sleep-reviewer.ts:94`), so `parallelWorkers` is undefined and the parallel path at `trace-proposal-planner.ts:49-51` is **dead in the daemon** — the 20,000-summary threshold never fires there. `parallel-trace-backfill.ts` and `trace-backfill-worker.mjs` are reachable only from a caller that passes `parallelWorkers`, and I found none in `src/`.
- The daemon wires the scheduler with no `reviewerFactory` and no planner injection (`daemon-command.ts:359-362`), so the deterministic planners are hardwired through `SleepReviewer`'s defaults (`sleep-reviewer.ts:93-94`). Any GAP-12-E switch must go somewhere on that chain.
- `summaries` is a two-column table `(id text primary key, payload text)` (`sqlite-store.ts:2518-2521`). All structure is `json_extract`. Two expression indexes exist: `idx_summaries_person_state` on `(personId, state, id)` (migration 3, `schema-migrations.ts:53-62`) and `idx_summaries_state_id` on `(state, id)` (migration 4, `:63-80`). **There is no index on `createdAt`.**
- `summary_vectors` has a real `created_at` column and one index `idx_summary_vectors_provider_model_person (provider, model, person_id, summary_id)` (migration 2, `schema-migrations.ts:31-52`).
- Summary ids are deterministic and content-addressed, **not** time-ordered: `historical_summary_<sha256(personId, firstEventId, topicLabel)>` (`contraction-runner.ts:872-875`) and `summary_<hostSessionId>_<start>_<end>` (`pre-compactor.ts:79-86`).
- `Summary` has `createdAt`, `version`, `lastAccessedAt` and **no `updatedAt`**; `version` is set to `1` unconditionally (ADR 0052 §7, `domain/types.ts:114-139`). There is no monotonic write marker on a summary.

---

## 2. The exact current trace path, "a review runs" → "a trace proposal exists"

### 2.1 Entry

| # | Location | What happens |
|---|----------|--------------|
| 1 | `src/daemon/daemon.ts:193-204` (continuous) and `:327-338` (`runOnce`) | Person rotated by `proposalCursor`; `proposalScheduler.runDue(personId, this.captureAuthority())` behind `assertLeaseAuthority()`. A throw here **loses the write lease** (`:200-202`) — unlike the embedding-repair stage, which swallows (`:349-361`). Trace discovery is therefore a liveness dependency of the daemon today. |
| 2 | `src/daemon/daemon-command.ts:359-362` | Production construction: `new ProposalScheduler(store, { clock, authority: captured }).runDue(personId)`. No planner injection, no `reviewerFactory`. |

### 2.2 Scheduling and staging

| # | Location | What happens |
|---|----------|--------------|
| 3 | `proposal-scheduler.ts:108-117` `dueJobs` | Due iff `job.proposalDirty && !job.immediateDirty && job.state === "complete"`, and (quiet ≥ 10 min since `lastActivityAt`) or (forced ≥ 60 min since `lastProposalRunAt ?? createdAt`). Defaults at `:7`. |
| 4 | `proposal-scheduler.ts:100-106` `createStagingStore` | Post-`15b0430`: an **empty** `InMemoryStore` plus the person row. The 1,089 MB corpus copy is gone. Pinned by `tests/daemon/proposal-scheduler.test.ts:161-186`. |
| 5 | `proposal-scheduler.ts:49-51` | `new SleepReviewer(this.store, { writeStore: staging })` — reads durable, writes staged. |
| 6 | `proposal-scheduler.ts:51` | `reviewer.stageProposals({ personId, reviewedAt })`. |

### 2.3 The review itself — where the remaining full-corpus rescan lives

| # | Location | What happens |
|---|----------|--------------|
| 7 | `sleep-reviewer.ts:131-144` `stageProposals` | One `loadCandidates`, then `proposeBoxes`, then `proposeTraces`, both against the same `ReviewCandidates`. |
| 8 | **`sleep-reviewer.ts:106-125` `loadCandidates`** | **This is the SC2 target.** Five reads in `Promise.all`: `listSummaries({ personId, states: NON_SUPERSEDED_STATES })`, `listBoxes()`, `listAnchors()`, `listProposals({ state: "proposed" })`, `listTraces()`. Then a JS re-filter at `:118-124`. `NON_SUPERSEDED_STATES` (`domain/types.ts:81`) is every state except `superseded` — it **includes `stale`**, which is exactly the point GAP-12-D's note makes: decay cannot shrink this set. |
| 9 | `sleep-reviewer.ts:181-193` `proposeTraces` | Hands `candidates.summaries` — the whole set — to `tracePlanner.proposeTraces`, with `idNamespace: request.personId` (`:185`). |
| 10 | `sleep-reviewer.ts:195-201` | Stamps `personId` onto each proposal, `writeStore.saveProposal` per proposal. |

The class comment at `sleep-reviewer.ts:68-75` states the design assumption explicitly: *"Both planners cluster GLOBALLY — which summaries group together depends on the whole candidate set — so this cannot be narrowed to a recent window without changing which boxes and traces get proposed."* **Phase 13 falsifies that sentence for traces and leaves it true for boxes.** The comment must be corrected as part of the work, or the next reader will restore the coupling.

### 2.4 Candidate generation — what is being replaced

| # | Location | What happens |
|---|----------|--------------|
| 11 | `trace-proposal-planner.ts:42-51` | Chooses parallel vs single-threaded. Production always single-threaded (see §1). |
| 12 | `trace-candidate-core.ts:164-184` `buildTraceCandidates` | `significantTermsBySummary` (`:47-49`) → `buildTraceIndex` (`:56-75`) → `collectTracePartials` (`:83-132`) → `materializeTraceCandidates` (`:135-153`). |
| 13 | `trace-candidate-core.ts:56-75` `buildTraceIndex` | Inverted index over `significantTerms`, dropping terms above `maxDocumentFrequencyFor(n) = max(200, ceil(0.004·n))` (`:33-41`). |
| 14 | **`trace-candidate-core.ts:95-128` `collectTracePartials`** | The all-pairs loop. For each left index, union all postings with `candidateIndex > leftIndex` (`:98-102`), then for each right index compute `shared` (`:107`). |
| 15 | **`trace-candidate-core.ts:112-118`** | **Identity.** `continuityTerms = shared \ BROAD_TRACE_TERMS`; `titleTerms = dedupe(shared).slice(0, 4)`; `title = titleCase(titleTerms.join(" "))`; `traceId = "trace_" + slugify(title)`, suffixed with `namespaceSuffixFor(idNamespace)` = first 12 hex of `sha256(personId)` (`:43-45`) when a namespace is given. See §5. |
| 16 | `trace-candidate-core.ts:135-153` | Maps index-sets back to `Summary[]`, sorts members by id, computes `boxIds` via `matchingBoxIds` (`:155-161`). |
| 17 | `trace-proposal-planner.ts:53-103` | Five sequential skip gates: `continuityTerms.length < 2` (`:54`), `summaries.length < minimumTraceSummaries` default 2 (`:63`, `:43`), `!hasNonContiguousRanges` (`:72`, impl `:149-165`), `confidence < minimumConfidence` default 0.5 (`:81-92`, `:44`), duplicate trace/proposal (`:94-103`). |
| 18 | `trace-proposal-planner.ts:112-147` `buildTraceProposal` | `id = "proposal_trace_" + traceId`; `state: "proposed"`; `rationale = continuityReason = "Summaries share continuing terms: …"`; payload conforms to `TraceProposalPayloadSchema` (`domain/types.ts:223-234`). |

### 2.5 Publication and acceptance — unchanged by this phase

| # | Location | What happens |
|---|----------|--------------|
| 19 | `proposal-scheduler.ts:133-155` `validateStagedReview` | Rejects any staged object not `state: "proposed"` and person-owned (`:135-137`); resolves every referenced summary id via `listSummariesByIds` (`:147`) and re-asserts person ownership + non-superseded (`:148-153`); then `assertCompleteSummaryProvenance` (`:159-165`) requires **non-empty** `personId`, `scopeIds`, `sourceCanonicalEventIds`, and `sourceTurnRanges` on every cited summary. |
| 20 | `proposal-scheduler.ts:53-76` | CAS: reads `contraction_checkpoint_${job.id}`, sets `proposalStage: "complete"`, calls `store.commitProposalRun(input)`. |
| 21 | `sqlite-store.ts:822-861` `commitProposalRun` | `CommitProposalRunInputSchema` (`daemon/types.ts:218-237`) enforces `state === "proposed"` and exact `personId` on every box/proposal/trace. Exact-record CAS on job + checkpoint (`:832-838`), with an idempotent re-run short-circuit at `:833-836`. Single `begin immediate` transaction. |
| 22 | `proposal-reviewer.ts:226-262` `approveTraceProposal` | Parses `TraceProposalPayloadSchema`, `getTrace(payload.traceId)` (`:231`), upserts a `MemoryTrace` with `state: "approved"`, preserving `existing?.createdAt` (`:247`) — **this is already an upsert-by-traceId, so a stable id makes re-acceptance an update rather than a new trace.** `createdTraceIds` is empty when the trace already existed (`:260`). |
| 23 | `scoped-proposal-reviewer.ts:129-160` | The MCP/authority-scoped equivalent, same `payload.traceId` upsert semantics, transacted through a `commit*` closure. |

### 2.6 What must change vs. what can stay

**Must change:**

| Item | Why |
|------|-----|
| `TraceProposalPlanningRequest.summaries: Summary[]` (`trace-proposal-planner.ts:13-23`) | The interface *is* the full-corpus rescan. A vector planner needs vectors and a bounded working set, not every `Summary`. Either a new interface, or the planner becomes store-aware, or the reviewer stops driving traces at all. |
| `SleepReviewer.proposeTraces` (`:181-204`) driving traces from `ReviewCandidates` | Same reason. Note `loadCandidates` is still needed by `proposeBoxes` (`:146-158`), so removing the trace consumer does **not** remove the load — SC2 says "to find new traces", which is satisfiable, but the box path will remain the dominant cost of a review cycle. State this honestly in the plan rather than implying the load is gone. |
| `sleep-reviewer.ts:68-75` comment | Becomes false for traces. |
| Candidate generation (`trace-candidate-core.ts` all-pairs core) | REQ-046. |
| Trace identity derivation (`trace-candidate-core.ts:113-118`) | §5; SC4 depends on it. |
| `DeterministicTraceProposalPlanner`'s `continuityTerms.length < 2` gate (`:54-61`) | A vector candidate has no shared terms. If a vector planner reuses this class it is skipped 100% of the time. Strong argument for a **separate planner class** rather than a mode flag. |
| Daemon liveness coupling (`daemon.ts:200-202`) | A trace-discovery throw currently costs the write lease. Worth reconsidering while it is being rebuilt — but changing it is a behaviour change the planner should decide deliberately, not incidentally. |

**Can stay unchanged (and SC3 depends on it):**

`TraceCandidate` (`trace-candidate-core.ts:5-12`) · `matchingBoxIds` (`:155-161`) · `dedupeTurnRanges` (`proposal-utils.ts:33-41`) · `hasNonContiguousRanges` (`trace-proposal-planner.ts:149-165`) · `buildTraceProposal`'s output shape (`:112-147`) · `TraceProposalPayloadSchema` / `MemoryProposalSchema` / `MemoryTraceSchema` (`domain/types.ts:223-285`) · `validateStagedReview` · `commitProposalRun` · `approveTraceProposal` · `scoped-proposal-reviewer` · `DerivationInvalidator` (`derivation-invalidator.ts:100-105`) · the `tracePlanner` injection seam (`sleep-reviewer.ts:52`).

**Two shape constraints that will bite if not planned for:**

1. `TraceProposalPayloadSchema.keywords` is `z.array(...).min(1)` (`domain/types.ts:233`). A vector-derived trace has no keywords by construction. The payload cannot be published with `keywords: []`. Either the planner derives keywords another way (e.g. `significantTerms` intersection computed *after* vector selection, purely for display), or the schema gains an alternative — and a schema change ripples through both stores and the sync effect fingerprints.
2. `assertCompleteSummaryProvenance` (`proposal-scheduler.ts:159-165`) rejects publication if **any** cited summary has empty `scopeIds` or empty `sourceCanonicalEventIds`. `Summary.scopeIds` is `.optional()` (`domain/types.ts:117`). A vector-derived trace that pairs an older summary lacking `scopeIds` will fail at publication, not at generation — a late, confusing failure. The candidate selection should filter on the same predicate the publisher enforces.

---

## 3. Where a forward-only cursor / checkpoint belongs

### 3.1 The three precedents that already exist

| Precedent | Shape | Where | Fit for Phase 13 |
|-----------|-------|-------|------------------|
| **A. `ContractionCheckpoint`** | Zod `.strict()` object (`daemon/types.ts:109-124`) persisted as a JSON `payload` blob in `daemon_contraction_checkpoint (id, person_id, job_id, payload)` (`sqlite-store.ts:2424-2432`), read/written via `getContractionCheckpoint` / `saveContractionCheckpoint` (`sqlite-store.ts:478-493`) | Owns `proposalStage: pending\|running\|complete` (`:121`), already written by `commitProposalRun` (`proposal-scheduler.ts:60-62`) | **Good fit for the daemon's forward cursor; bad fit for the offline bootstrap.** See below. |
| **B. `HistoricalBootstrapCheckpoint`** | Zod object (`bootstrap/types.ts:16-25`) in `bootstrap_checkpoints (id, person_id, payload)` (`sqlite-store.ts:2499-2506`), with `save/get/deleteBootstrapCheckpoint` (`memory-store.ts:210-212`) | Independent of any job; explicitly a resumable-offline-pass checkpoint | **Closest structural precedent for the bootstrap.** Same table can hold a differently-prefixed id, or a new table can mirror it. |
| **C. No checkpoint at all — "the missing set *is* the checkpoint"** | `backfill-embeddings-command.ts:11-18`; `EmbeddingRepairRunner` (`embedding-repair.ts:62-66`: *"Forward progress is structural rather than cursor-based"*) | Works because `listSummaryIdsMissingVector` is ascending-by-id and each pass removes what it processes | **Attractive but unavailable today**: there is no per-summary "already trace-evaluated" marker, and CONTEXT warns decay cannot supply one. Achievable only by inventing such a marker, which is itself a schema decision. |

### 3.2 The concrete recommendation shape (planner decides; here are the constraints)

**Do not extend `ContractionCheckpointSchema` for the bootstrap.** Three concrete reasons, all verified:

1. `saveContractionCheckpoint` asserts the referenced contraction **job exists and is person-owned** (`sqlite-store.ts:480-481`). The offline bootstrap has no contraction job.
2. `commitProposalRun` performs an exact-record CAS on the checkpoint (`sqlite-store.ts:832-838`, `sameRecord(currentCheckpoint, parsed.expectedCheckpoint)`). A bootstrap writing a Phase-13 field into that same record out-of-band would make the daemon's next `commitProposalRun` throw `"Proposal run state changed"` — a real, silent-until-it-isn't collision.
3. `ContractionCheckpointSchema` is `.strict()` (`daemon/types.ts:124`) and rows are round-tripped through `getPayload(..., ContractionCheckpointSchema)` (`sqlite-store.ts:492`). Adding a **required** field makes every pre-existing row fail to parse. A new field must be `.optional()` or carry `.default()`. This is the back-compat trap, and it is a *code* trap, not a DDL one.

**Is a schema migration needed?** Verified answer: **not necessarily, and probably not for the checkpoint itself.**

- Both candidate checkpoint tables store an opaque `payload text`. A new checkpoint kind reusing `bootstrap_checkpoints` (distinct id prefix) needs **zero DDL**. A dedicated table needs DDL (migration 6) but that DDL is a `create table if not exists` with no table rewrite — the same additive shape as migrations 2-5.
- A migration **is** likely needed if the daemon's forward cursor is expressed as a *query predicate over arrival time*, because no such index exists:
  - `Summary.createdAt` lives only inside `payload` JSON, and **no index covers it**. A `createdAt > cursor` predicate is a `json_extract` scan over all 145,765 summary rows — structurally the same mistake as `sqlite-store.ts:1826-1828`.
  - `summary_vectors.created_at` is a real column but the only index leads `(provider, model, person_id, summary_id)` (`schema-migrations.ts:48-49`), so a `created_at >` range scan is not index-ordered.
  - Summary **ids are hashes, not monotonic in time** (`contraction-runner.ts:872-875`), so an id watermark is a valid *position in a fixed enumeration* (fine for the bootstrap's resume) but is **not** a "since last pass" watermark (wrong for the daemon's forward cycle). Do not conflate these two cursors; they are different objects and probably different records.

### 3.3 ⚠️ The ADR 0054 planner trap — flagged explicitly, as instructed

If the plan adds **any** index in migration 6, ADR 0054's most important consequence applies:

> *"Adding **any** `person_id`-leading index to `canonical_events` can silently steal `where person_id = ? and id in (...)` away from the primary key. It cost 388× here and it broke **two** separate optimizations at once. Neither failed a test. Both would simply have been slow again, indefinitely, with the original commits still in the history claiming a fix."* — `docs/adr/0054-contraction-slice-spine-and-window.md:155-165`

The generalization for Phase 13, and the two specific queries at risk:

| New index would be on | Existing query it could steal | Where |
|---|---|---|
| `summary_vectors (..., created_at, ...)` | `select … from summary_vectors where provider = ? and model = ? and person_id = ?` — currently served by `idx_summary_vectors_provider_model_person` | `sqlite-store.ts:1814-1820` |
| `summaries (…)` | `select id from summaries where json_extract(payload,'$.state') in (…) and not exists (…)` — currently covered by `idx_summaries_state_id`, measured 45 ms vs 4,090 ms uncovered | `sqlite-store.ts:1772-1789`; migration 4 rationale `schema-migrations.ts:66-74` |

Both queries return **correct** results either way, so the regression is invisible to every output assertion and to any timing assertion on a small fixture. The mitigation is the one ADR 0054 established and the repo already practises: `explain query plan` assertions, in the shape of `tests/storage/canonical-event-spine.test.ts:162-217`, covering **the new query and every query the new index could displace**. If migration 6 lands without those three assertions, this phase has re-run the 388× experiment.

---

## 4. Loading the corpus once, scanning it many times

`findNearestSummaries` as written pays two full loads on **every** call (`sqlite-store.ts:1814-1820` and `:1826-1828`) before any arithmetic. CONTEXT measures those at 1.61 s + 7.04 s + 1.18 s parse ≈ 9.8 s and 1,296 MB resident. Calling it per summary is the 154-hour shape. The realistic options, with honest trade-offs. **This is the planner's decision; I am not picking one.**

### Option A — new bulk store method

E.g. `listSummaryVectors(personId, provider, model, allowedScopeIds)` returning `SummaryVectorRecord[]` (or a packed variant).

| | |
|---|---|
| **Pro** | One SQL call for the whole job. `SummaryVectorRecord` (`memory-store.ts:85-95`) and `unpackFloat32Vector` (`embeddings/vector-codec.ts:17`) already exist. Leaves `findNearestSummaries` untouched, so its four boundary tests keep meaning what they mean. Call-count assertions are trivial (`calls === 1` regardless of N). |
| **Con** | Two implementations required (CLAUDE.md hard rule) plus a cross-store parity test — the existing parity block is `tests/storage/summary-vectors.test.ts:514-670`. |
| **Con** | `SummaryVectorRecord.vector` is `number[]` (`memory-store.ts:90`). 56,706 × 384 boxed JS numbers is **far** more than the 87 MB Float32 figure CONTEXT quotes (that figure is for `Float32Array` storage). Getting the 87 MB requires either a second raw-bytes accessor or accepting the boxed cost. Measure before assuming. |
| **Con, and the biggest one** | The GAP-11-A fail-closed retrievable sweep lives *inside* `findNearestSummaries` (`sqlite-store.ts:1829-1834`; `in-memory-store.ts:1286-1290`). A bulk method that omits it re-opens GAP-11-A **in a new place** — the precise failure ADR 0054 §3 names ("GAP-11-G was caused by re-implementing a hygiene walk in a second place"). Any bulk method must consume `isRetrievableState` / `RETRIEVABLE_MEMORY_STATES` (`retrieval/retrievable-state.ts:15,35-37`), not a re-derived predicate. |

### Option B — in-memory index built once, above the store

A `SummaryVectorIndex` module (pure, `src/traces/` or `src/embeddings/`) built once per job, holding a `Float32Array`, an id array, and a pre-computed retrievable/in-scope mask.

| | |
|---|---|
| **Pro** | Both arithmetic reductions CONTEXT names land naturally here: pre-normalising to unit length turns cosine into a dot product (~2×) and `j > i` symmetry halves the pair space (~2×). CONTEXT is explicit that both should be **measured, not projected** — ADR 0054's 1.9× optimistic sample is the standing precedent. |
| **Pro** | Pure and store-free, so it unit-tests like `trace-candidate-core.ts` does today (`:77-82` documents that as a deliberate property). |
| **Pro** | Naturally supports "scan many times against one resident corpus", which is exactly the bootstrap's need. |
| **Con** | Still needs *some* bulk read to populate it — this is not an alternative to A so much as a consumer of it (or of repeated bounded `listSummariesByIds`-style reads). |
| **Con** | It becomes a second place that decides retrievability and scope. Same GAP-11-G risk as A; same mitigation. |
| **Con** | Holds 87 MB+ resident for the job's lifetime. Fine for an overnight offline job; questionable inside a daemon cycle that already OOM'd twice at a 4 GB heap (`proposal-scheduler.ts:88-91`). If the daemon reuses this index, its residency is a new steady-state cost that must be measured, not assumed. |

### Option C — extend `findNearestSummaries`

E.g. accept `vectors: number[][]` (a batch of queries) or an opaque prepared-corpus handle.

| | |
|---|---|
| **Pro** | One code path, so the D-06/D-07 boundary filter physically cannot drift between the trace path and future semantic recall (Phase 14). The existing parity suite keeps covering it. |
| **Con** | Batching N queries amortizes the two loads by N. That **fixes the bootstrap** (one batch of 56,706) and **does not fix the daemon**, where N is a handful and the per-cycle cost stays O(corpus). SC2 forbids exactly that. |
| **Con** | Widens a security-sensitive method that four boundary tests pin (`tests/storage/summary-vectors.test.ts:235-360`) and that Phase 14 is about to become the primary consumer of. Changing it now couples two phases. |

### Option D — fix the `:1826-1828` sweep itself (orthogonal, combines with A/B/C)

Today the retrievable-id set is obtained by `select payload from summaries where json_extract(payload,'$.personId') = ?` and filtering in JS (`sqlite-store.ts:1826-1834`). It selects `payload`, so SQLite must visit the table for all 145,765 rows and JSON-parse them — CONTEXT measures 7.04 s + 1.18 s, and it returns 89,059 superseded rows only to discard them.

An id-only, state-predicated form —
`select id from summaries where json_extract(payload,'$.personId') = ? and json_extract(payload,'$.state') in (…RETRIEVABLE_MEMORY_STATES)` —
is exactly the column tuple of migration 3's `idx_summaries_person_state (personId, state, id)` (`schema-migrations.ts:53-62`), which is the same trick migration 4 used to take `listSummaryIdsMissingVector` from 4,090 ms to 45 ms.

| | |
|---|---|
| **Pro** | Needs **no new index** if the hypothesis holds — migration 3's index already exists. Makes every other option cheaper. Benefits Phase 14 too. |
| **Pro** | The predicate becomes the same allow-list expression already used at `sqlite-store.ts:1773`, reducing rather than increasing predicate duplication. |
| **⚠️ Con / caveat** | **This is a hypothesis, not a measurement.** I did not run `explain query plan` in this session. The expression strings must match the index's expressions *character for character* or SQLite silently declines the index (ADR 0054 §2 makes this point about `coalesce(...,'personal')`). The planner must verify with an `explain query plan` assertion before claiming the win, and must re-measure after — ADR 0054's "found only by re-measuring" (`:167-172`) exists because the first post-rewrite measurement showed no improvement at all. |
| **Con** | It changes a method Phase 14 will depend on, mid-Phase-13. Low risk (behaviour-preserving) but not zero. |

### A note on what "loaded once" has to mean

Whichever option is chosen, the **daemon** case and the **bootstrap** case have different shapes and probably different code:

- **Bootstrap:** one resident corpus, ~56,706 self-scans, bounded by a resumable cursor over a fixed enumeration. The 74 ms/scan × 56,706 ≈ 69.9 min figure from CONTEXT is the target, and CONTEXT warns it has under-predicted before.
- **Daemon cycle:** k new summaries (single digits), each scanned against the resident-or-loaded corpus. Loading 87 MB to score 3 vectors is a full-corpus load per cycle even if it is only *one* load — SC2 says the cycle "does not reload… the entire person corpus", so a per-cycle bulk read arguably violates it even at one call. **This is the sharpest ambiguity in the phase and the planner should resolve it explicitly**, e.g. by keeping the index resident across cycles, by scoping the per-cycle read to a candidate band, or by arguing that one bounded read is not a "reload". Do not let it be decided implicitly by whichever code gets written first.

---

## 5. Trace identity

### 5.1 Why the current slug fails SC4 — precisely

`trace-candidate-core.ts:113-118`:

```ts
const titleTerms = shared.filter((term, index, terms) => terms.indexOf(term) === index).slice(0, 4);
const title = titleCase(titleTerms.join(" "));
const baseTraceId = `trace_${slugify(title)}`;
```

Three independent defects, each fatal on its own:

1. **Identity is a function of the pair's content, not of the trace.** `shared` is computed per *pair* (`:107`). Two summaries that happen to share `{smith, pip, provider, bill}` produce `trace_smith_pip_provider_bill`; a third summary sharing `{smith, pip, provider, records}` with one of them produces a **different** trace. The 4-term tuple is very nearly unique per pair, which is why 5,138 summaries produced 449,103 traces and why sweeping the threshold from 2 to 10 changed *membership* while `proposals + skipped` stayed pinned at 449,103 (`12-CLOSING.md:44-56`). Raising a threshold prunes members; it never removes a grouping.
2. **Identity is order-dependent.** `shared = leftTerms.filter(t => rightTermSet.has(t))` (`:107`) preserves the **left** summary's term order, and left/right are decided by array index (`:95`, `:101`). `significantTerms` (`proposal-utils.ts:9-13`) preserves first-occurrence order of the source text. So `.slice(0, 4)` is a function of *word order in one summary's prose*.
3. **Identity is not stable under re-summarization.** A continuing topic re-emits a summary under the **same id** with **changed text** (ADR 0052 §7, `docs/adr/0052-…:168-186`). New text → new terms → new slug → new trace, while the old trace still exists pointing at the same summary id.

Net effect on SC4 ("running twice with exactly one new summary changes no pre-existing assignment"): the current scheme cannot satisfy it, and no threshold or cap makes it satisfy it.

### 5.2 What a stable vector-derived identity must satisfy

Three properties, all required simultaneously:

- **S1 — Growth-stable.** Adding a member must not change the id.
- **S2 — Collision-free enough.** Two genuinely different traces must not share an id, or acceptance silently merges them (`approveTraceProposal` upserts by `payload.traceId`, `proposal-reviewer.ts:231-249`).
- **S3 — Matchable.** A second run must be able to find that an existing trace already covers a pair, *before* it mints. The existing check (`trace-proposal-planner.ts:94-103`) does this by `traceId` only — which is exactly the unstable thing.

### 5.3 Candidate designs, with the failure mode of each

| # | Design | S1 | S2 | S3 | Failure mode |
|---|--------|----|----|----|--------------|
| 1 | **Member-set hash** — `sha256(sorted member ids)` | ✗ | ✓ | ✗ | **The current bug in a new costume.** Adding one summary changes the set, changes the id, mints a new trace, orphans the old. Named here so no one reaches for it as the "obvious deterministic" answer. |
| 2 | **Min member id** — lexicographic minimum of member ids | ✗ | ~ | ~ | Summary ids are sha256 hex (`contraction-runner.ts:872-875`), so a new member is ~uniform over the id space and becomes the new minimum of a k-member trace with probability ≈ 1/(k+1). For 2- and 3-member traces that is routine, not rare. |
| 3 | **Time-ordered seed** — minimum by `(createdAt, id)` over members | ✓ under forward-only growth | ~ | ~ | Under strictly forward-only arrival the earliest member never changes, so this is the design that *composes* with the phase's shape. Breaks on a **late-imported or backfilled** summary that lands earlier in time — a path this repo demonstrably has (the late-insert drift guard at `contraction-runner.ts:192-203` exists for it). Needs the same fail-closed treatment: if the computed earliest member changes, **keep the recorded id, do not re-mint**. |
| 4 | **Seed + disambiguator** — `trace_v1_<sha256(personId, seedSummaryId, disambiguator)>` | ✓ | ✓ if the disambiguator is not membership | ~ | A hub summary near many neighbours can seed several distinct traces, so a bare seed collides. The disambiguator must be something that does not change as the trace grows — e.g. an ordinal assigned at mint time and **recorded**, not recomputed. |
| 5 | **Recorded, not recomputed** — identity assigned once at mint and thereafter *looked up* by membership overlap against `listTraces()` + `listProposals({state:"proposed"})` | ✓ | ✓ | ✓ | The framing that actually satisfies S3. Cost is O(existing traces + proposed proposals), not O(corpus), so it is compatible with SC5. Requires the lookup to be by **membership overlap** ("does a live trace already contain both of these summaries?"), not by id. |

Designs 3/4 and 5 are complements, not alternatives: 3/4 answers "what id do I mint", 5 answers "should I mint at all". **Both questions have to be answered; answering only the first is what the current code does.**

### 5.4 A dedupe asymmetry that will surface as user-visible churn

- `hasExistingProposal` (`proposal-utils.ts:47-49`) matches only `state === "proposed"`, and `loadCandidates` loads only `{ state: "proposed" }` proposals (`sleep-reviewer.ts:111`).
- `trace-proposal-planner.ts:96` separately checks `traces.some(t => t.id === candidate.traceId && t.state !== "rejected")`.

So: a **rejected trace** suppresses re-proposal, but a **rejected proposal that never became a trace** does not. The user rejects it, and the next cycle proposes it again, forever. On the current all-pairs design nobody noticed because nothing ever got reviewed. On a capped-emission design that deliberately re-offers suppressed candidates next cycle (locked decision 2), this becomes the dominant source of review-queue churn. **The planner must decide the rejection-memory policy explicitly.**

---

## 6. Concrete risks, each with a mechanical test

### R1 — PRIORITY: a full-corpus load reappears, per cycle or per query

**What goes wrong:** any of — calling `findNearestSummaries` in a loop; a bulk read issued per new summary instead of per pass; a per-cycle bulk read that is technically one call but still O(corpus).

**Why a timing test cannot catch it:** ADR 0054 states the reason directly — *"a timing assertion passes on a small fixture regardless"* (`:165`), and it is flaky on a loaded machine (`tests/storage/canonical-event-spine.test.ts:158-161`).

**The test, asserting on counts:**

1. Wrap the store in a counting decorator implementing `MemoryStore` and delegating, incrementing a per-method counter. (Precedent for observing scheduler internals from a test: the `reviewerFactory` hook at `proposal-scheduler.ts:21` used by `tests/daemon/proposal-scheduler.test.ts:161-186`.)
2. Build fixtures at **two corpus sizes** — e.g. 50 and 500 summaries + vectors — each with the **same** number of new summaries (say 3).
3. Assert the counter maps are **equal** across the two sizes, not merely "small":
   `expect(counts500).toEqual(counts50)` for `{ findNearestSummaries, listSummaries, listSummariesByIds, <new bulk method> }`.

Equality across two sizes is the assertion that survives a fixture staying small. A ceiling (`toBeLessThan(10)`) does not — an O(n) implementation passes it at n=5.

4. **Second guard:** an `explain query plan` assertion on every new or modified store query, in the shape of `tests/storage/canonical-event-spine.test.ts:162-175`.

### R2 — the bootstrap is not resumable, or double-proposes

**Test:** run the bootstrap with an injected fault after batch 1 and restart. Two precedents for the hook exist: the fault-injection seam `this.options.faults?.reach("after_contraction_checkpoint")` (`contraction-runner.ts:448`) and the kill-simulation hook `onBatchComplete` (`backfill-embeddings-command.ts:35-37`). Assert:
- the union of proposal ids from run-1 + run-2 **equals** the id set from an uninterrupted run;
- no proposal id appears twice;
- `listProposals({ proposalType: "trace" })` has no duplicate `payload.traceId`.

Then run the completed bootstrap a **third** time from scratch and assert it emits **zero** new proposals (CONTEXT: "running it twice must not produce duplicate traces or duplicate proposals").

### R3 — SC4 churn: a second run changes a pre-existing assignment

**Test (this is the direct SC4 test):**
1. Snapshot `listTraces()` and `listProposals({ proposalType: "trace" })` as `id → sorted(summaryIds)`.
2. Add exactly one new summary + its vector.
3. Re-run discovery.
4. Assert every pre-existing entry is **deep-equal** to its snapshot, and that the diff contains only additions.

This is the test that catches an unstable identity rule, and it fails loudly under designs 1 and 2 in §5.3.

### R4 — the emission cap silently truncates

**Test:** fixture with, say, 3× the cap in above-threshold candidates. Assert:
- `proposals.length === cap`;
- the suppressed count is **reported** and equals `candidates − cap`;
- `proposals + suppressed === candidates` (the "no silent caps" invariant);
- running the identical fixture twice yields the identical proposal id **order** (determinism, locked decision 2).

Note this makes `ProposalScheduler.runDue`'s return shape `{ boxProposals, traceProposals, ran }` (`proposal-scheduler.ts:43`) insufficient — a suppressed count has to reach the receipt, and that is a visible contract change the planner should name rather than smuggle.

### R5 — the cap starves: suppressed candidates are never reachable again

**Test:** cycle 1 with 2× cap candidates; cycle 2 with **no** new summaries. Assert cycle 2 emits the remainder rather than zero.

**⚠️ This is in direct tension with a strict forward-only cursor.** If the cursor advances past summaries whose candidates were suppressed, those candidates are lost permanently — which violates CONTEXT's "the next cycle must be able to reach what this one suppressed rather than losing it permanently". Resolution requires either (a) the cursor advances only over fully-emitted work, or (b) suppressed candidates are persisted as a backlog. **This coupling between the cap and the cursor is the most important unresolved design question in the phase and should be settled before wave 2, not discovered in it.**

### R6 — the GAP-11-A boundary regresses through a new bulk read path

**Test:** extend the existing cross-store parity block (`tests/storage/summary-vectors.test.ts:514-670`) to any new method. Fixture must include a vector row whose summary is (a) `superseded`, (b) `stale`, (c) absent entirely, (d) owned by another person, (e) out of `allowedScopeIds`. Assert none appear, and that `SqliteStore` and `InMemoryStore` return **identical** results. Structurally, assert there is exactly one retrievability predicate by having the new path import `isRetrievableState` from `retrieval/retrievable-state.ts:35-37`.

### R7 — migration 6 steals a query plan (the ADR 0054 trap)

**Test:** three `explain query plan` assertions, per §3.3 — (a) the new query uses the new index; (b) `findNearestSummaries`' vector query still uses `idx_summary_vectors_provider_model_person`; (c) `listSummaryIdsMissingVector` still uses `idx_summaries_state_id`. Precedent: `tests/storage/canonical-event-spine.test.ts:188-217`; migration-level precedent in `tests/storage/schema-migrations.test.ts`.

### R8 — the GAP-12-D fix breaks pinned decay behaviour, or is not actually idempotent

Three tests currently pin decay: `tests/sleep/sleep-reviewer.test.ts:246` (decays old untouched summaries, marks weak ones stale), `:271` (**uses last access time when decaying retrieved summaries**), `:298` (does not decay when review time is not after the reference). The `:271` test pins the very field-selection rule (`lastAccessedAt ?? retrievedAt ?? createdAt`, `sleep-reviewer.ts:313`) that causes the compounding.

**Test for the fix:** (a) call `decaySummaries` twice with the clock **unchanged**; assert the second call returns `updatedSummaries: []`. (b) call it repeatedly while advancing the clock by exactly one half-life each time; assert strength halves **once per half-life of elapsed time**, not once per invocation.

**Constraint the planner must weigh:** the natural fix is a "decayed through" timestamp, but `SummarySchema` has no such field and no `updatedAt` (ADR 0052 §7, `docs/adr/0052-…:174-180`). Adding one is a domain-schema change that ripples into both stores, sync effect fingerprints, and every summary fixture. An alternative that avoids the schema change is to make decay a **pure function of `(referenceAt, now)`** recomputed from an unchanging baseline rather than applied to the previous result — worth evaluating, since `strength` would then be derived rather than accumulated.

### R9 — proposal volume poisons unrelated hot paths

`DerivationInvalidator.invalidateDependencies` issues an unfiltered `listProposals()` (`derivation-invalidator.ts:92`) and `listTraces()` (`:100`) **inside every rewind contraction slice**, and its own comment (`:25-38`) says these loads cannot be narrowed without turning a fail-closed integrity check into a fail-open one. `commitSupersededSummaryPrune` similarly loads all traces and proposals (`sqlite-store.ts:1254-1265`). At 449,103 proposals these become unusable. This is a second, independent reason the hard cap is load-bearing — not merely a reviewability nicety.

**Test:** not directly count-testable; enforce it at the emission boundary via R4 and record the reasoning in the ADR so a future "let's raise the cap" change knows what else it is raising.

### R10 — GAP-12-E is implemented as deletion or as tuning

CONTEXT forbids tuning the term matcher and calls the holding action "a holding action with an expiry date, not a fix". It does **not** say delete.

**Test that pins "boxes-only" as behaviour rather than as a comment:** using a fixture the shared-term planner would light up (reuse the Smith-PIP summaries from `tests/sleep/sleep-reviewer.test.ts:186-207`), assert `ProposalScheduler.runDue` returns `traceProposals: 0` while `boxProposals > 0`, and that `listProposals({ proposalType: "trace" })` is empty afterwards.

**Where the switch goes decides which existing test breaks** — see §7.

---

## 7. What the existing tests pin (and therefore constrain the design)

| Test | Line | What it pins | Consequence |
|------|------|--------------|-------------|
| `tests/traces/trace-proposal-planner.test.ts` | `:72-76` | Exact id `proposal_trace_trace_smith_pip_provider_bill` and `payload.traceId: trace_smith_pip_provider_bill`. Called **without** `idNamespace`, so no namespace suffix. | Any change to the shared-term identity rule breaks it. Since the phase *replaces* rather than tunes that planner, the honest question is whether the old planner is deleted (test goes with it) or retained-but-unwired (test stays green). CONTEXT does not decide this. |
| `tests/traces/trace-proposal-planner.test.ts` | `:79-105` | The `"Only broad shared terms"` skip reason. | Same disposition question. |
| `tests/sleep/sleep-reviewer.test.ts` | `:186-207` | `SleepReviewer.proposeTraces` **with the default planner** produces that id and writes it to the store. | **This is the test GAP-12-E will collide with.** It calls `proposeTraces` directly on the reviewer, not through the scheduler. A switch in `ProposalScheduler`/daemon wiring leaves it green; a switch inside `SleepReviewer.proposeTraces` breaks it. Choose the switch location deliberately. |
| `tests/sleep/sleep-reviewer.test.ts` | `:228-245` | An **injected** `tracePlanner` is used and its proposals are persisted. | **The good news for SC3.** This is the sanctioned seam a vector planner enters through with zero reviewer changes. |
| `tests/sleep/sleep-reviewer.test.ts` | `:246`, `:271`, `:298` | Decay behaviour, including the `lastAccessedAt` field-selection rule. | Constrains GAP-12-D — see R8. |
| `tests/sleep/sleep-reviewer.test.ts` | `:321`, `:351`, `:381` | Box state refresh/revival. | Untouched, but shares `refreshBoxStates`' unfiltered `listSummaries()` (`sleep-reviewer.ts:226-229`) — an existing full-table load nobody has narrowed. Out of scope; note it exists. |
| `tests/daemon/proposal-scheduler.test.ts` | `:161-186` | `stagingSummaryCount === 0` — the anti-restage guard from `15b0430`. | A new design must not put the corpus back into the staging store, by any route. |
| `tests/daemon/proposal-scheduler.test.ts` | `:192-215` | Nothing the reviewer produces reaches the durable store before `commitProposalRun`. | Publication atomicity is non-negotiable, including for bootstrap-produced proposals. |
| `tests/daemon/proposal-scheduler.test.ts` | `:216+` | Staged output citing a summary that is not live/person-owned is rejected. | A vector-derived proposal must cite summaries with non-empty `personId`, `scopeIds`, `sourceCanonicalEventIds`, `sourceTurnRanges` (`proposal-scheduler.ts:159-165`). Filter at selection time, not at publication time. |
| `tests/daemon/proposal-scheduler.test.ts` | `:17-54`, `:55-84`, `:85-160` | Authority, token turnover, expired-authority and provenance-mismatch rejection. | The bootstrap needs a legitimate `WriteAuthority`. `ContractionRunner` requires foreground authority to be exactly `historical-bootstrap` for the person (`contraction-runner.ts:153-156`) and `commitProposalRun` asserts the same operation (`sqlite-store.ts:827`). An offline Phase-13 bootstrap must use an authority shape the store already accepts, or a new one must be introduced deliberately. |
| `tests/storage/summary-vectors.test.ts` | `:235-360` | `findNearestSummaries` boundary: cross-person, out-of-scope, non-retrievable, `topK`, `minimumScore`, deterministic id tiebreak. | Constrains Option C in §4. |
| `tests/storage/summary-vectors.test.ts` | `:514-670` | **SqliteStore ↔ InMemoryStore parity**, including the GAP-11-A sweep and `minimumScore`. | The template any new bulk method must extend (R6). |
| `tests/integrations/hermes-sleep-command.test.ts` | `:177`, `:208` | `proposedTraceIds: ["trace_smith_pip_provider_bill"]` end-to-end through `memory hermes:sleep`. | The shared-term trace id is pinned in **four** places across three suites. |
| `tests/integrations/hermes-smoke-harness.test.ts` | `:52` | Same id, through the smoke harness (`npm run hermes:smoke`). | The Hermes path calls `reviewer.proposeTraces` directly (`integrations/hermes/sleep-command.ts:76-81`) with an `include_proposals: false` escape hatch. A boxes-only switch placed inside the reviewer breaks the smoke harness too. |
| `tests/bootstrap/historical-bootstrapper.test.ts` | `:40-50` | `traceProposalsCreated` flowing out of a review into the bootstrap result. | `historical-bootstrapper.ts:163-202` surfaces trace counts; a zeroed trace path changes this reported number. |

**Summary of the constraint:** the string `trace_smith_pip_provider_bill` appears as a pinned expectation in four tests across `tests/traces/`, `tests/sleep/`, and `tests/integrations/`. Whatever the plan does with the shared-term planner, it must decide the fate of all four in one pass — leaving two green and two red is how a wave stalls.

---

## Runtime State Inventory

Phase 13 is not a rename, but it does write derived state, so the equivalent question is *"what runtime state exists that a second run could collide with?"*

| Category | Items found | Action required |
|----------|-------------|-----------------|
| Stored data | **None to migrate.** traces 0, boxes 0, proposals 0 on the live corpus (`13-CONTEXT.md:18-26`), verified as owner-measured today. 56,706 `summary_vectors` rows exist and are complete. | None — greenfield. Explicitly do **not** plan a migration or backfill of trace assignments. |
| Live service config | None — no external service holds trace state. The daemon is stopped; `daemon_lease` is empty (`12-CLOSING.md:116`). | None. |
| OS-registered state | macOS LaunchAgent for the daemon exists and is currently **unloaded** (`12-CLOSING.md:116`; `daemon/macos`). It stays unloaded until GAP-12-E lands (locked). | Do not reload the LaunchAgent during this phase's wave 1. |
| Secrets / env vars | `MEMORY_DB`, `OPENROUTER_API_KEY`/`OPENROUTER_MODEL` (optional planner path), `MEMORY_MODEL_PATH`. Embedder config lives in the sidecar `${dbPath}.embeddings.json`. None are renamed by this phase. | None. |
| Build artifacts | No build step (CLAUDE.md). `graphify-out/` is stale by ~250 commits (AGENTS.md) — do not trust it for this phase; use direct file search. | None, but do not cite the graph as evidence. |
| Checkpoints (Phase-13-specific) | Any checkpoint this phase writes becomes runtime state a second run must reconcile. `daemon_contraction_checkpoint` rows exist and participate in `commitProposalRun`'s CAS. | See §3.2 — do not write Phase-13 fields into the contraction checkpoint. |

---

## Environment Availability

| Dependency | Required by | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js 22+ (`node:sqlite` `DatabaseSync`) | everything | ✓ (repo requires it; unchanged from Phase 12 which ran the daemon) | ≥22 | none — hard requirement |
| Vitest | all tests | ✓ | `^2.0.5` (`package.json:53`) | none |
| ONNX embedder + vendored model | not needed by this phase | ✓ (49,314→56,706 vectors already written) | bge-small | Phase 13 **reads** vectors; it does not embed. No embedder resolution is required for the bootstrap if vectors are read from the store. |
| APFS `cp -c` clones | measurement fences | ✓ (used throughout Phase 12) | — | none — locked operational fence |
| Live DB `~/.memory/aaron.db` | threshold selection on a clone | ✓ read-only | — | Threshold must be chosen on a clone; the live DB is read-only except behind a verified backup |
| OpenRouter | optional planner only | ✗/optional | — | Deterministic path must work offline (CLAUDE.md); no test may require it |
| New npm packages | **none** | — | — | ANN libraries explicitly out of scope |

**Missing dependencies with no fallback:** none identified.

---

## Validation Architecture

### Test framework

| Property | Value |
|----------|-------|
| Framework | Vitest `^2.0.5` (`package.json:53`) |
| Config file | `vitest.config.ts` |
| Quick run | `npx vitest run tests/traces/ tests/sleep/ tests/daemon/proposal-scheduler.test.ts` |
| Full suite | `npm test` (`vitest run`, 96 test files) + `npm run typecheck` |
| Adjacent gates | `npm run hermes:smoke` — pins `trace_smith_pip_provider_bill` end-to-end; will be affected by GAP-12-E |

### Phase requirements → test map

| Req | Behavior | Test type | Command | Exists? |
|-----|----------|-----------|---------|---------|
| REQ-046 | Candidates come from vector similarity above a threshold | unit | `npx vitest run tests/traces/` | ❌ new file |
| REQ-046 | Vector planner produces `TraceCandidate`-shaped output | unit | `npx vitest run tests/traces/` | ❌ new |
| REQ-047 | Call/query counts are equal at two corpus sizes (R1) | unit + counting store decorator | `npx vitest run tests/traces/` | ❌ new — **wave 1 artifact** |
| REQ-047 | New/modified store queries use the intended index; existing plans unchanged (R7) | query-plan | `npx vitest run tests/storage/` | ⚠️ pattern exists at `tests/storage/canonical-event-spine.test.ts:162-217`; new assertions needed |
| REQ-047 | Bootstrap resumes after a kill without duplicating (R2) | integration | `npx vitest run tests/operations/` or `tests/traces/` | ❌ new |
| REQ-048 | Vector proposal passes `validateStagedReview` + `commitProposalRun` unchanged | integration | `npx vitest run tests/daemon/proposal-scheduler.test.ts` | ⚠️ suite exists; new case needed |
| REQ-048 | Vector proposal accepts through `approveTraceProposal` unchanged | integration | `npx vitest run tests/proposals/proposal-reviewer.test.ts` | ⚠️ suite exists; new case needed |
| REQ-048 | Rationale is human-readable and non-empty | unit | `npx vitest run tests/traces/` | ❌ new |
| SC4 | Second run + one new summary leaves every pre-existing assignment deep-equal (R3) | integration | `npx vitest run tests/traces/` | ❌ new — **the SC4 test** |
| SC5 | Per-cycle cost flat as corpus grows | covered by R1's equality assertion | — | ❌ new |
| GAP-12-D | Decay is idempotent; halves per half-life of elapsed time, not per invocation (R8) | unit | `npx vitest run tests/sleep/sleep-reviewer.test.ts` | ⚠️ suite exists; 3 tests constrain the fix |
| GAP-12-E | `runDue` returns `traceProposals: 0` and `boxProposals > 0` on a Smith-PIP fixture (R10) | integration | `npx vitest run tests/daemon/proposal-scheduler.test.ts` | ❌ new |
| Cap | `proposals + suppressed === candidates`; deterministic order (R4) | unit | `npx vitest run tests/traces/` | ❌ new |
| Cap | Suppressed candidates reachable next cycle (R5) | integration | `npx vitest run tests/traces/` | ❌ new |
| Boundary | Cross-store parity for any new bulk read (R6) | unit | `npx vitest run tests/storage/summary-vectors.test.ts` | ⚠️ parity block exists at `:514-670`; extend it |

### Sampling rate

- **Per task commit:** `npx vitest run tests/traces/ tests/sleep/ tests/daemon/ tests/storage/summary-vectors.test.ts` + `npm run typecheck`
- **Per wave merge:** `npm test`
- **Phase gate:** `npm test` green **and** `npm run hermes:smoke` reconciled (it currently pins a shared-term trace id) before `/gsd:verify-work`

### Wave 0 / wave 1 gaps

- [ ] A counting `MemoryStore` decorator for R1 — no such helper exists in `tests/`; `tests/daemon/fixtures.ts` is the natural home.
- [ ] A two-corpus-size fixture builder (N summaries + N vectors, parameterised).
- [ ] A kill/restart hook on the bootstrap job (pattern: `contraction-runner.ts:448` `faults?.reach(...)`, `backfill-embeddings-command.ts:35-37` `onBatchComplete`).
- [ ] `tests/traces/` currently has exactly **one** file, 106 lines, covering the algorithm being replaced. Effectively greenfield test coverage for this phase.

---

## Security Domain

Personal, local-first, single-user system. No network surface is added by this phase.

| ASVS category | Applies | Standard control in this repo |
|---------------|---------|-------------------------------|
| V2 Authentication | no | No user auth; local file DB |
| V3 Session Management | no | — |
| **V4 Access Control** | **yes** | Person/scope isolation is the hard invariant. Every vector query takes explicit `personId` + `allowedScopeIds` (`memory-store.ts:97-107`); the GAP-11-A retrievable sweep is fail-closed (`retrieval/retrievable-state.ts:7-15`). **Any new bulk read is a new access-control surface** and must carry the identical boundary — see R6. |
| **V5 Input Validation** | **yes** | Zod at the edge. New checkpoint/candidate shapes need schemas; `.strict()` back-compat is a real hazard (§3.2). |
| V6 Cryptography | no (not added) | Vector identity uses `sha256` for id derivation only, not for security. Sync crypto is untouched. |
| V7 Logging | yes | Precedent: counts, provider, model **only** — never a summary id, never summary text (`embedding-repair.ts:162-172`). Any progress/receipt output from the bootstrap must follow this. |

| Threat pattern | STRIDE | Mitigation |
|----------------|--------|------------|
| Cross-person trace linkage via an unbounded bulk vector read | Information disclosure | `personId` + `allowedScopeIds` mandatory on the new read; cross-store parity test with a second-person fixture |
| Non-retrievable (superseded/stale/rejected) summary resurfacing through a new path | Information disclosure | Single `isRetrievableState` predicate; no re-derived allow-list |
| Auto-approval of a trace | Elevation of privilege | `CommitProposalRunInputSchema` rejects any non-`proposed` state (`daemon/types.ts:229-236`); do not add a bypass |
| Summary text leaking into logs from a bootstrap progress line | Information disclosure | Counts-only logging, per `embedding-repair.ts:162-172` |

---

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|-------|---------|---------------|
| A1 | Migration 3's `idx_summaries_person_state` **could** cover an id-only, state-predicated retrievable-id query, making Option D cheap and index-free | §4 Option D | If the expression strings do not match character-for-character, SQLite silently declines the index and the query degrades to the same full payload scan — the exact ADR 0054 §2 failure. **Verify with `explain query plan` before planning on it.** Not measured in this session. |
| A2 | The parallel trace backfill path (`parallel-trace-backfill.ts`, `trace-backfill-worker.mjs`) has no production caller | §1 | If a caller exists that I missed, deleting or bypassing it breaks something. My grep across `src/` found only the planner's own conditional. Low risk, easily re-checked. |
| A3 | Summary ids being sha256 hex makes "new member becomes the new lexicographic minimum" ≈ 1/(k+1) | §5.3 design 2 | Only true for the `historical_summary_<hash>` form; the `summary_<hostSessionId>_<start>_<end>` form (`pre-compactor.ts:79-86`) is *not* uniformly distributed. The conclusion (min-id is unstable) holds under both, but the probability figure is only valid for the hash form. |
| A4 | Adding an index to `summary_vectors` or `summaries` risks stealing the plans named in §3.3 | §3.3 | Reasoned by analogy from ADR 0054's `canonical_events` case, not measured on these tables. The mitigation (query-plan tests) is cheap and correct regardless, so acting on it costs little even if the risk is lower than stated. |
| A5 | A per-cycle bulk vector read may or may not violate SC2's "does not reload the entire person corpus" | §4 closing note | This is a reading of the success criterion, not a fact. If the planner reads it the other way, the daemon design changes materially. Needs an explicit owner/planner decision. |
| A6 | `TraceProposalPayloadSchema.keywords.min(1)` blocks a keyword-free vector payload | §2.6 | Verified from the schema (`domain/types.ts:233`); the *consequence* (that a workaround is needed) assumes the planner will not change the schema. Changing it is possible but ripples. |

---

## Open Questions (RESOLVED — see the plans and ADR 0055)

All six were answered during planning on 2026-08-04. The resolution is recorded inline below so
`/gsd:verify-work 13` does not read them as open. The deciding plan is named in each case.

1. **Is the shared-term planner deleted or retained-but-unwired?**
   → **RESOLVED (D-13-5, Plan 13-12):** retained and unreachable, with deprecation headers and an
   `src/`-wide fence test; `parallel-trace-backfill.ts` and `trace-backfill-worker.mjs` are deleted subject
   to an A2 re-verification grep. The four pinned `trace_smith_pip_provider_bill` expectations are handled
   in one pass in Plan 13-01: three stay green unedited, the two Hermes ones change there.
   - Known: CONTEXT forbids *tuning* it; it does not say delete. Four tests across three suites pin its output.
   - Unclear: whether `trace-candidate-core.ts`, `parallel-trace-backfill.ts`, and `trace-backfill-worker.mjs` (~370 lines plus a worker) leave the tree in this phase.
   - Recommendation: decide in wave 1, because the GAP-12-E switch location depends on it, and so does whether four tests are edited or deleted.

2. **Where does the GAP-12-E off-switch live?**
   → **RESOLVED (Plan 13-01):** `ProposalScheduler` wiring, as an injected `NullTraceProposalPlanner`
   default — and the same one-line remedy in the Hermes path, replacing an earlier corpus-size refusal
   guard that needed the very `listSummaries` load it was protecting against.
   - `ProposalScheduler`/daemon wiring → `tests/sleep/sleep-reviewer.test.ts:186-207` and the Hermes tests stay green.
   - Inside `SleepReviewer.proposeTraces` → those tests break, and `hermes:sleep` behaviour changes for a non-daemon caller.
   - Recommendation: the daemon wiring, because GAP-12-E is explicitly about "the daemon's proposal review", and the Hermes path is human-invoked.

3. **Does the cursor advance over suppressed candidates?** (R5)
   → **RESOLVED (D-13-2, Plan 13-06):** yes, unconditionally. Suppression goes to a bounded, deterministic,
   reported backlog (`backlogCap` 1,000) that competes on score with fresh work. The alternative — advance
   only over fully-emitted work — is rejected for head-of-line blocking.

4. **What authority does the offline bootstrap write under?**
   → **DISSOLVED (D-13-4, Plan 13-11):** the bootstrap publishes nothing. It writes only the Phase-13
   checkpoint, and `saveBootstrapCheckpoint` (`sqlite-store.ts:1145-1158`) takes no `WriteAuthority`, so the
   Phase-13 checkpoint trio needs none either. Original text: `commitProposalRun` asserts `historical-bootstrap` operation authority (`sqlite-store.ts:827`; `contraction-runner.ts:153-156`). Reusing it is plausible; introducing a new operation kind is a `WriteAuthority` change with sync implications. Not resolved here.

5. **Does the bootstrap emit proposals at all, or traces-in-`proposed`-state?**
   → **RESOLVED (D-13-4, Plan 13-11):** neither. It fills a ranked backlog the daemon drains through the
   unchanged `commitProposalRun` path, which makes idempotence structural. Original text: `commitProposalRun` accepts `traces` (all in `state: "proposed"`, `daemon/types.ts:229-232`), and `stageProposals` currently always returns `traces: []` (`sleep-reviewer.ts:140`). Emitting proposed traces directly is a path the storage layer already supports and that nothing currently uses. Worth a deliberate decision, not an accident.

6. **Rejection memory** (§5.4)
   → **RESOLVED (Plan 13-07, extended by D-13-6 in Plan 13-08):** a rejected member set suppresses any
   equal-or-subset candidate permanently; a strict superset is allowed one offer. Separately, a candidate
   overlapping a live *proposed* trace proposal is suppressed until that proposal is decided.

---

## Sources

### Primary (HIGH confidence — read directly in this session)

- `.planning/phases/13-forward-only-vector-trace-discovery/13-CONTEXT.md` — locked decisions, measured live-corpus figures (quoted, not re-measured)
- `.planning/phases/12-daemon-incremental-embedding/12-CLOSING.md` — GAP-12-D/E, threshold-sweep table
- `.planning/ROADMAP.md` Phase 13 · `.planning/REQUIREMENTS.md:77-79,118-120`
- `CLAUDE.md`, `AGENTS.md`
- `docs/adr/0054-contraction-slice-spine-and-window.md` (full) · `docs/adr/0052-daemon-incremental-embedding-seam.md` §6-§9 · `docs/adr/0049-retrievable-memory-states.md` (outline)
- `src/traces/trace-candidate-core.ts`, `trace-proposal-planner.ts`, `parallel-trace-backfill.ts`
- `src/sleep/sleep-reviewer.ts`, `src/proposals/{proposal-utils,proposal-reviewer,scoped-proposal-reviewer,openrouter-proposal-planner}.ts`
- `src/daemon/{proposal-scheduler,contraction-runner,embedding-repair,daemon,daemon-command,types}.ts`
- `src/storage/{memory-store,sqlite-store,in-memory-store,schema-migrations}.ts`
- `src/domain/types.ts`, `src/retrieval/retrievable-state.ts`, `src/bootstrap/types.ts`, `src/service/derivation-invalidator.ts`, `src/imports/cooperative-yield.ts`, `src/cli/command-registry.ts`, `src/operations/backfill-embeddings-command.ts`, `src/integrations/hermes/sleep-command.ts`, `src/compaction/pre-compactor.ts`
- `tests/traces/trace-proposal-planner.test.ts`, `tests/sleep/sleep-reviewer.test.ts`, `tests/daemon/proposal-scheduler.test.ts`, `tests/storage/canonical-event-spine.test.ts`, `tests/storage/summary-vectors.test.ts` (test-name index + key excerpts)

### Secondary (MEDIUM)

- Live-corpus timings and row counts are quoted from `13-CONTEXT.md` and `12-CLOSING.md`, both owner-measured. **HIGH as provenance, MEDIUM as a basis for projection** — ADR 0054 documents a 1.9× optimistic extrapolation on this exact corpus.

### Tertiary (LOW / not used)

- No web search performed. No Context7 lookup performed. Neither would have added signal to an internal-architecture question with no new dependency.
- `graphify-out/` is ~250 commits stale (AGENTS.md) and was **not** used.

---

## Metadata

**Confidence breakdown:**

- Current trace path (§2): **HIGH** — every step read and cited by line.
- What tests pin (§7): **HIGH** — read directly.
- Checkpoint precedents and the no-DDL finding (§3): **HIGH** — verified from `saveContractionCheckpoint` (`sqlite-store.ts:478-493`) and the table DDL.
- Corpus-load options (§4): **HIGH** on the shape of each option and its constraints; **MEDIUM** on Option D's index hypothesis (A1) and on the memory figures for Option A, neither measured here.
- Trace identity (§5): **HIGH** on why the current scheme fails (derived from the code plus the owner's threshold-sweep data); **MEDIUM** on the relative merits of the candidate designs, which are reasoned rather than tried.
- Risks and their tests (§6): **HIGH** on the mechanism of each test; the ADR 0054 index-steal generalization (A4) is reasoned by analogy.

**Research date:** 2026-08-04
**Valid until:** ~2026-09-03 for the codebase findings (they invalidate on any commit touching `src/traces/`, `src/sleep/`, `src/daemon/proposal-scheduler.ts`, or the vector methods in either store). The live-corpus figures were measured 2026-08-04 and drift as the daemon runs — but the daemon is stopped, so they are stable until it is started.
