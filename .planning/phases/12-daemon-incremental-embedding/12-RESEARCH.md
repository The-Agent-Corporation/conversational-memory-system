# Phase 12: Daemon Incremental Embedding — Research

> **⚠ SUPERSEDED IN PART — read this before acting on anything below.**
>
> This research was written BEFORE the owner closed Locked decision 3 (2026-07-28). Its Summary and its
> sequencing table recommend running `memory prune-superseded --apply` to delete the 89,059 superseded
> rows. **The owner decided NOT to prune.** The chosen fix is a state predicate on
> `listSummaryIdsMissingVector` so superseded rows are never backfill candidates — see `12-CONTEXT.md`'s
> 2026-07-28 addendum and `12-GAP-12-B.md`.
>
> **Do not run `memory prune-superseded` in this phase.** Every other finding here stands; only the
> prune recommendation is overridden.

**Researched:** 2026-07-28
**Domain:** Daemon derivation pipeline + local vector cache (no new external technology)
**Confidence:** HIGH for the seam analysis and the two blocking defects (both reproduced by running code in this session); MEDIUM for backfill wall-clock projections (measured on a 300-summary random sample, not a full run).

<user_constraints>
## User Constraints (from 12-CONTEXT.md)

### Locked Decisions

**Locked decision 1 — target the ONNX bge-small embedder, not the hash embedder.**
Owner decision 2026-07-28. Enable `bge-small-en-v1.5` for the live corpus.

Rationale, as put to the owner: the deterministic hash embedder is keyword-shaped, and it is the direct
cause of the two recall defects recorded at Phase 11 sign-off — Q6's relevance shift and Q12's
expected-nothing false positive (`11-SC7-SIGNOFF.md`). Real semantic similarity is the point of the v1.1
milestone.

Consequences the planner must handle rather than discover:
- `memory embeddings enable` is the **only CLI path that touches the network**. It vendors the model to
  `${databasePath}.models` (i.e. `~/.memory/aaron.db.models`), hash-verified against
  `BGE_SMALL_EN_V1_5_MANIFEST`, and flips `enabled: true` ONLY after the vendor call resolves. A failed or
  partial vendor must leave the config disabled.
- The vendored copy under `tests/fixtures/models` is gitignored TEST fixture. Production resolution is the
  sidecar path above; do not couple the daemon to the fixture path.
- **Mixed-provider vector stores are hard-errored by design** (D-05, `embedder-resolver.ts`). Once enabled,
  every vector — backfilled and incremental — must come from the same (provider, model, revision).
  Enabled-but-broken must hard-error, never silently fall back to the hash embedder.
- Phase 9's locked embedder decisions still bind: **cls-pooling** (the Xenova model card's mean-pooling
  example is wrong; BAAI config says cls), **asymmetric** bge prefixing (queries prefixed, passages bare),
  pinned HF revision `ea104dacec62c0de699686887e3f920caeb4f3e3`.

**Locked decision 2 — backfill the live corpus as part of this phase.**
Owner decision 2026-07-28. Run `memory backfill-embeddings` against the live corpus so incremental
embedding has a populated baseline to extend.

- 49,314 summaries. Phase 10's success criteria already require the command to be resume-safe (SC2) and
  idempotent on a second full run (SC3) — this phase should USE those properties, and verify them at real
  scale rather than re-implement them.
- The live corpus is 5,031,448,576 bytes. Adding ~49k × 384-dim float32 vectors is a material write.
  **A fresh backup is mandatory before the backfill run**, following the discipline Phase 11 used
  throughout (`cp -c` APFS clone, verified by inode/size/mtime with correctly labelled timezones).
- Four Phase 11 backups exist in `~/.memory/` (`pre-v4`, `pre-rebuild-v3`, `pre-anchor-prune`,
  `pre-phase11`). None may be deleted, moved, or overwritten.

### Claude's Discretion

CONTEXT.md declares no explicit discretion section. By elimination, discretion covers: the choice of
embedding seam inside the daemon, checkpointing mechanism, repair-pass shape, and test design — all
constrained by the locked decisions and success criteria above.

### Deferred Ideas (OUT OF SCOPE)

- **Semantic recall / retrieval changes.** Q6 and Q12 are recorded as inputs but fixing ranking is a later
  phase. This phase populates vectors and keeps them current; it does not change how retrieval uses them.
- **Syncing embeddings.** ADR 0047 treats vectors as a per-device cache and `SyncOperationKind` is a closed
  enum. SC3 requires embeddings never appear in any sync payload or outbox operation.
- **GAP-11-F's remaining halves** — the 151 contaminated corpus rows (owner declined redaction) and
  `~/cms-pre-rewrite-backup/`, which still holds the credential by design.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description (REQUIREMENTS.md:74,76) | Research Support |
|----|-------------|------------------|
| REQ-043 | "The daemon shall embed newly contracted summaries incrementally, without recomputing embeddings for the existing corpus." | Seam analysis below: post-commit embed stage driven by `ContractionSliceResult`, cost = O(summaries written by this slice). |
| REQ-045 | "Embeddings shall be recomputed per device from local summaries and shall never be synchronized. The embedder provider, model, and version shall be recorded so stale-model vectors can be detected and recomputed." | SC3 verified structurally (`commitContractionSlice` emits no outbox row; `SyncOperationKind` closed enum). SC4: provider/model/revision ARE recorded — but only accidentally, via a string concatenation that is the root of GAP-12-A. |

**Success criteria mapping (ROADMAP Phase 12):**

| SC | Statement | Where addressed |
|----|-----------|-----------------|
| SC1 | New summary has a persisted vector within one subsequent daemon tick, without recomputing the rest | Recommended Seam (Option B) |
| SC2 | Per-tick cost bounded by NEW summaries, not corpus size | Recommended Seam + Repair Pass Budget |
| SC3 | Embeddings never in any sync payload or outbox operation | SC3 Verification |
| SC4 | Vectors record provider/model/version so stale-model devices are detectable | SC4 Surface + GAP-12-A |
</phase_requirements>

## Summary

The daemon has no embedding path at all today: `saveSummaryVectors` has exactly one caller,
`src/operations/backfill-embeddings-command.ts:111`. The natural seam is not a new scheduler and not the
contraction transaction — it is a **post-commit stage inside the existing contraction work item**, driven
by the summaries the slice just wrote. That exact shape already exists in this repo:
`src/operations/rebuild-derivations-command.ts:167-175` post-commit tombstones vectors from
`slice.supersessions`. Phase 12 adds the symmetric write. Cost is O(summaries written this slice) with no
query at all, which satisfies SC2 by construction rather than by a scan budget.

Two findings block the locked decisions and were **reproduced by running the real code in this session**,
not inferred:

1. **GAP-12-A (blocking).** `TransformerEmbedder` advertises `model = "Xenova/bge-small-en-v1.5"`
   (`src/embeddings/transformer-embedder.ts:32`) but stamps every `Embedding` it produces with
   `model = "Xenova/bge-small-en-v1.5@<revision>"` (`transformer-embedder.ts:103`). The backfill queries
   the missing set with the former (`backfill-embeddings-command.ts:64`) and writes rows keyed by the
   latter (`backfill-embeddings-command.ts:102`). **The missing set therefore never shrinks.** Measured:
   after a complete run over 3 summaries, `listSummaryIdsMissingVector` still returns all 3, and a second
   full run re-embeds all 3. On the live corpus that means a kill+restart of a 20–56 minute backfill
   resumes from zero, `memory status` reports `missingVectors == totalSummaries` forever, and any
   missing-set-driven daemon repair pass would re-embed the entire corpus every tick. Phase 10's SC2/SC3
   tests never caught this because every one of them pins `PROVIDER = "deterministic"`,
   `MODEL = "keyword-hash-v1"` (`tests/operations/backfill-embeddings-command.test.ts:9-10`), the one
   embedder whose class `model` and emitted `model` happen to be identical.

2. **GAP-12-B (blocking for cost/scope).** `listSummaryIdsMissingVector` selects `from summaries` with
   **no state predicate** (`src/storage/sqlite-store.ts:1692-1704`). The live corpus holds 138,373 summary
   rows — 49,314 `compacted` plus 89,059 `superseded` (measured read-only, 2026-07-28). CONTEXT's "49,314
   summaries" is the retrievable count, not what backfill would process. As written, the backfill embeds
   all 138,373, including superseded rows that `findNearestSummaries` deliberately filters out
   (`sqlite-store.ts:1712-1725`) and that `rebuild-derivations` tombstones. Measured throughput 24.2
   ms/summary → **≈56 min for 138,373 vs ≈20 min for 49,314**, and ~2.8× the vector bytes.

**Primary recommendation:** Fix GAP-12-A first (one identity, used for both the query and the write, in
the config, the resolver, and `memory status`), prune superseded rows before backfilling (the
purpose-built `memory prune-superseded` already exists with a dry-run default and a fail-closed backup
gate), then land the post-commit embed stage in `ContractionRunner`/the daemon's contraction work item,
with a bounded missing-set repair pass as the crash-recovery second line.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Embedding newly contracted summaries | Daemon derivation runner (`src/daemon/`) | — | The daemon is the single-writer; the contraction slice is the only place that knows which summaries are new. |
| Vector persistence | Storage (`SqliteStore` / `InMemoryStore`) | — | `saveSummaryVectors` already exists; no new write path. |
| Embedder resolution + model identity | `src/embeddings/embedder-resolver.ts` | Sidecar config `${db}.embeddings.json` | Single resolution point exists (D-04/D-05); the daemon must resolve once per process, not per tick. |
| Corpus backfill baseline | Operations CLI (`backfill-embeddings-command.ts`) | — | Already shipped in Phase 10; this phase runs it, it does not reimplement it. |
| Staleness / completeness reporting | `memory status` (`src/bootstrap/status-command.ts:251`) | — | `embeddingBackfill` snapshot already exists and is the SC4 hook. |
| Never syncing vectors | Sync (`src/sync/`) | — | Enforced by omission: derived artifacts have no `SyncOperationKind`. Phase 12 adds the proving test, not a mechanism. |

## Standard Stack

**No new packages.** Every dependency this phase needs is already installed and already exercised by
Phases 8–10.

### Core (already present)
| Module | Purpose | Why standard |
|--------|---------|--------------|
| `@huggingface/transformers` 4.2.0 | ONNX runtime for `TransformerEmbedder` | Pinned in Phase 9; golden-vector test gates it (`npm run test:golden`, 16 passed / 1 skipped 2026-07-28 per CONTEXT). |
| `node:sqlite` `DatabaseSync` | `summary_vectors` storage | Built-in, no native addon (CLAUDE.md); schema v2 created the table (`schema-migrations.ts:33-51`). |
| `zod` | Contract validation at every store seam | Repo-wide convention. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Pure-JS cosine over BLOB | `sqlite-vec` extension | Explicitly deferred in REQUIREMENTS.md:97 as a Phase 8 design decision; already settled as BLOB + JS cosine. Out of scope here. |
| Per-summary `embed()` | Batched tensor inference | `TransformerEmbedder` exposes only single-text `embed`/`embedQuery` (`transformer-embedder.ts:70-76`), and the ONNX session is pinned to `intraOpNumThreads: 1`, `executionMode: "sequential"`, `graphOptimizationLevel: "disabled"` (`transformer-embedder.ts:57-63`) — deliberate determinism settings backing REQ-051. Batching would change those settings and risk the golden test. Do not batch in this phase. |

**Installation:** none.

## Package Legitimacy Audit

**Not applicable — this phase installs no external packages.** No `slopcheck` run was needed. Every
module referenced already exists in `package.json` and is exercised by the passing test suite.

## Architecture Patterns

### System Architecture Diagram

```
                        ┌─────────────────────────────────────────┐
  host history files    │  DaemonLoop.drainOne()                  │
        │               │  (daemon.ts:94 — one writer turn)       │
        ▼               │                                         │
  ApprovedSourceRunner ─┼─► item.kind === "source_scan"           │
        │               │                                         │
        ▼               │                                         │
  canonical_events      │                                         │
        │               │                                         │
        ▼               │                                         │
  ContractionRunner ────┼─► item.kind === "contraction"           │
   .drainSlice()        │   daemon.ts:136-149                     │
        │               │                                         │
        │  turns,       │                                         │
        │  summaries,   │                                         │
        │  anchors      │                                         │
        ▼               │                                         │
  commitContractionSlice│  ◄── ONE transaction (sqlite-store.ts:681)
   (atomic)             │      writes summaries + checkpoint + job │
        │               │      emits NO sync outbox row            │
        │               │                                         │
        ▼               │                                         │
  ┌──────────────────┐  │                                         │
  │ ►► NEW STAGE ◄◄  │  │  post-commit, same work item            │
  │ embed(slice      │  │  cost = O(slice.summaries.length)       │
  │   .summaries)    │  │  failure isolated: leaves               │
  │ saveSummaryVectors  │  summary-without-vector (recoverable)   │
  └──────────────────┘  │                                         │
        │               │                                         │
        ▼               │                                         │
  summary_vectors       │  ProposalScheduler.runDue()  (rotating) │
  (per-device cache,    │  syncReplication.runCycle()  (optional) │
   never synced)        └─────────────────────────────────────────┘
                                       │
                                       ▼
                        sync_outbox — carries ONLY
                        {operationKind ∈ 7 closed kinds, targetId,
                         effectFingerprint, digests}. No summary
                         payload, no vector, ever.
```

### The Seam — three options compared honestly

**Option A — inside the contraction transaction.** Extend `CommitContractionSliceInputSchema`
(`src/daemon/types.ts:175-189`) with a `summaryVectors` array and write rows inside the same
`begin immediate` block as the summaries.

- *For:* strictly atomic. A summary-without-vector state can never exist; SC1 becomes trivially true.
- *Against:* the schema is `.strict()`, so this touches `types.ts`, `sqlite-store.ts`, and
  `in-memory-store.ts` (CLAUDE.md: any interface change means editing both stores). More seriously, it
  **couples memory formation to embedder health**. `resolveEmbedder` hard-errors on enabled-but-broken by
  design (`embedder-resolver.ts:27-40`), and `DaemonLoop` catches a contraction throw as
  `{ ok: false, category: "storage_failure" }` (`daemon.ts:145-148`). A corrupted ONNX file would stop the
  daemon forming summaries at all. That is a strictly worse failure mode than a missing vector.
- **Rejected.**

**Option B — post-commit stage in the same contraction work item. RECOMMENDED.** After
`commitContractionSlice` returns, embed the summaries the slice wrote and call `saveSummaryVectors`.

- *For:* exact precedent already in the repo — `rebuild-derivations-command.ts:167-175` does precisely
  this shape for the delete direction (`deleteSummaryVectors(supersededSummaryIds)` from
  `slice.supersessions`, post-commit, per slice). Cost is `slice.summaries.length` with **zero queries**,
  so SC2 holds by construction, not by budget. Failure is isolated and recoverable.
- *For (decisive):* it is the only option that keeps a **re-derived** summary's vector correct. A
  continuing topic's trailing active span is re-emitted every slice under the *same* deterministic id with
  *changed* text — an upsert, explicitly documented at `contraction-runner.ts:276-277` and produced at
  `contraction-runner.ts:230-236` + `429`. A missing-set-driven scheduler would never see it (the row
  exists) and its vector would go stale permanently. Option B upserts the vector alongside, for free.
- *Against:* a brief window where a summary exists without a vector (bounded by one embed, ~24 ms
  typical). Requires `ContractionSliceResult` to expose what was written — today it exposes only counts
  (`immediate: { summaries: number; anchors: number }`, `contraction-runner.ts:72`). Additive change.
- *Against:* the re-emitted active span is re-embedded once per slice. Bounded at 1 extra embed per slice;
  note it, do not over-engineer it away.

**Option C — a distinct scheduler alongside `proposal-scheduler.ts`.**

- *Against:* it needs a "what's new since last pass" query. The only available one is
  `listSummaryIdsMissingVector`, a full-`summaries` anti-join per tick (`sqlite-store.ts:1692-1704`), and
  it cannot see re-derived summaries at all. `ProposalScheduler.createStagingStore`
  (`proposal-scheduler.ts:83-103`) is the named-in-CONTEXT anti-pattern: it loads and re-parses every
  summary, box, anchor, proposal, and trace for the person, then copies them all into a fresh
  `InMemoryStore` — every cycle. At 138,373 summaries that is the known defect Phase 13 SC2 exists to
  close. **Do not copy it.**
- **Rejected as the primary seam**, but a *bounded* variant survives as the repair pass below.

### Pattern: bounded missing-set repair pass (crash recovery, second line only)

Option B's failure mode is a summary written with no vector — after a crash between the commit and the
embed, or after a transient embedder failure. This is recoverable and detectable, but the detector must
be budgeted or it reintroduces the SC2 violation.

```
IF embedder healthy AND (a repair budget is due):
    ids = listSummaryIdsMissingVector(provider, model)   // SQL anti-join, no JS parsing
    take at most K (e.g. 200) ids
    load those summaries, embed, saveSummaryVectors
```

Three constraints on this pass:

1. **It cannot run per tick until GAP-12-A is fixed** — today it would return the whole corpus every time.
2. **Never reuse `backfill-embeddings-command.ts:68`'s `store.listSummaries()`** — that full load Zod-parses
   every summary payload (138,373 today). It is correct for a one-shot CLI backfill; it is fatal per tick.
   There is **no `getSummary(id)` on `MemoryStore`** (verified: only `getSummaryVector` exists), so a
   bounded repair pass needs either `listSummaries({ personId, states })` (still a filtered full parse) or
   a new additive `listSummariesByIds(ids)` on both stores. Recommend the latter — it is small and it is
   what Phase 13/14 will want too.
3. **Add a state filter** — see GAP-12-B. Superseded summaries must not be repaired into existence.

### Restart and crash semantics

The daemon is lease-based (`daemon.ts:299-316`) and every mutation goes through a
compare-and-set `expectedCheckpoint` (`sqlite-store.ts:689-697`). Three crash points matter:

| Crash point | Resulting state | Detected by | Recovery |
|---|---|---|---|
| Before `commitContractionSlice` | Nothing written; checkpoint unchanged | Existing checkpoint resume (`contraction-runner.ts:145-148`) | Slice replays identically — summary ids are deterministic (`summaryId()`, `contraction-runner.ts:593`) |
| Between commit and the embed write | Summary persisted, vector missing | `listSummaryIdsMissingVector` (once GAP-12-A fixed) | Repair pass |
| Mid-`saveSummaryVectors` | Nothing — the whole batch rolls back (`sqlite-store.ts:1639-1677`) | Same | Same |

**Summary-without-vector is a recoverable state and must be treated as one.** It must never fail the
contraction work item, and it must never trigger `loseAuthority()`. Note that `DaemonLoop` currently
treats a `proposalScheduler.runDue` throw as lease loss (`daemon.ts:158-161`) — do not wire the embed
stage into that pattern.

### Embedder lifecycle inside the daemon

`resolveEmbedder` + `init()` costs 72–121 ms measured (ONNX session construction). It must be resolved
**once per daemon process**, at composition time in `daemon-command.ts`'s `createLoop`
(`daemon-command.ts:~305`, alongside `new ContractionRunner(...)`), not per tick.

The D-05 hard-error contract creates a real decision the planner must make explicitly:

- `resolveEmbedder` throws on enabled-but-broken (`embedder-resolver.ts:27-40`). Calling it at daemon
  startup means a corrupt model file prevents the daemon from starting.
- `probeEmbedderHealth` is the non-throwing twin (`embedder-resolver.ts:47-99`) built for exactly this
  consumer — its own docstring says "for daemon/`memory health` consumption (D-06)".

**Recommendation:** probe at startup. If `healthy: false`, run the daemon with the embed stage disabled
and surface the reason; if healthy, resolve once and embed every slice. This satisfies "never silently
fall back to the hash embedder" (nothing is written at all) while keeping memory formation alive. It does
*not* satisfy "enabled-but-broken must hard-error" in the literal sense — the hard error stays on the CLI
paths (`backfill-embeddings`, retrieval). Flag this to the owner: it is a genuine reading of two locked
constraints in tension, and the alternative (daemon refuses to start) is defensible too.

### Anti-Patterns to Avoid

- **Restaging the corpus per cycle** (`proposal-scheduler.ts:83-103`). Named in CONTEXT as a known defect.
- **Deriving "what's new" from a query when the producer already has the answer in hand.** The slice
  returns the summaries; use them.
- **Catching the embedder's D-05 error and continuing with `DeterministicEmbedder`.** That is exactly the
  mixed-provider store the resolver exists to prevent.
- **Populating `Summary.embedding`.** The field exists on the schema (`src/domain/types.ts:114`) and
  contraction deliberately sets it `null` (`contraction-runner.ts:438`). Vectors live only in
  `summary_vectors`. Keeping it null is load-bearing for SC3 — see below.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Batch vector persistence | A per-record insert loop | `store.saveSummaryVectors(records)` | Single `begin immediate` transaction, all-or-nothing, shares `saveSummaryVector`'s validation (`sqlite-store.ts:1639-1677`) |
| Corpus baseline | A daemon bootstrap mode | `memory backfill-embeddings` | Phase 10 shipped it with resume + idempotence properties; CONTEXT locks "use, don't re-implement" |
| Removing the 89,059 superseded rows | Ad-hoc DELETE | `memory prune-superseded` | Dry-run default, fail-closed `--confirm-backup` gate, id-cursor resume, eligibility recomputed inside the store transaction (`prune-superseded-command.ts:8-28`) |
| Vector tombstoning on supersession | New code | `store.deleteSummaryVectors(ids)` from `slice.supersessions` | Already done at `rebuild-derivations-command.ts:167-175` |
| Embedder selection | A daemon-local config read | `resolveEmbedder` / `probeEmbedderHealth` | Single D-04/D-05 resolution point |
| Completeness reporting | A new command | `memory status`'s `embeddingBackfill` | Already computed from ground truth (`status-command.ts:196-199, 251-257`) |

**Key insight:** almost everything this phase needs already exists and has one owner. The phase's real
work is a ~30-line post-commit stage plus fixing two identity/scope defects that the deterministic-only
test coverage hid.

## Runtime State Inventory

This phase mutates live durable data (adds ~49k vector rows, optionally deletes 89k summary rows).

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `~/.memory/aaron.db`: 292,407 canonical events; `summaries` = 138,373 rows (49,314 compacted + 89,059 superseded); `summary_vectors` = **0 rows**; schema_version = 3. All measured read-only 2026-07-28. | Data migration: backfill vectors. Optional data migration: prune superseded. Mandatory `cp -c` backup first. |
| Live service config | `${db}.embeddings.json` — **absent**, so `readEmbeddingsConfig` returns `enabled:false` defaults and `DeterministicEmbedder` is active (`embeddings-config.ts:31-35`). Written by `memory embeddings enable`. Not in git. | Create via `memory embeddings enable` (network, gated). |
| OS-registered state | macOS LaunchAgent `com.conversational-memory.daemon.plist` (`daemon-command.ts:~272`). Its plist references the repo root and `--db` path only — no embedder identity. | None. But the daemon must be **stopped** during backfill (single-writer lease) and restarted after. |
| Secrets/env vars | `MEMORY_MODEL_PATH` is a *test fixture* env var (CLAUDE.md). `MEMORY_SYNC_*` unset for this device. No embedder secret exists — vendoring is anonymous HTTPS to HF. | None. |
| Build artifacts | Vendored model will be written to `~/.memory/aaron.db.models/Xenova/bge-small-en-v1.5/` by `vendorModel` (`embeddings-command.ts:65`). Test fixture copy at `tests/fixtures/models/Xenova/bge-small-en-v1.5` exists and is gitignored — **do not couple production to it**. | New directory created by the enable step. |
| Live daemon lease | `daemon_contraction_job` shows `attempts: 4680`, `state: complete`, `proposalDirty: true`, `generation: 4`, `nextDueAt` 2026-07-28T14:44Z — the daemon is actively cycling on this corpus. | Stop the daemon before any bulk operation; a running daemon holds the writer lease and the backfill opens its own `SqliteStore`. |

## Blocking Defects Found

### GAP-12-A — the vector model key does not match the query key (BLOCKING, reproduced)

**Evidence chain:**
- `transformer-embedder.ts:32` — `readonly model = "Xenova/bge-small-en-v1.5"`
- `transformer-embedder.ts:103` — emitted `Embedding.model = \`${this.model}@${this.revision}\``
- `backfill-embeddings-command.ts:64` — `listSummaryIdsMissingVector(embedder.provider, embedder.model)` ← bare
- `backfill-embeddings-command.ts:102` — `model: embedding.model` ← suffixed
- `status-command.ts:195-196` — `activeModel = embedder.model` from **config** (`embeddings-config.ts:15`,
  default `"Xenova/bge-small-en-v1.5"`, bare) → same mismatch in the reporting surface.

**Reproduction** (run this session, temp DB, fixture model, offline; script at
`<scratchpad>/probe.mts`):

```
run1: {"ok":true,"provider":"onnx-transformers","model":"Xenova/bge-small-en-v1.5",
       "processed":3,"totalMissingAtStart":3}
getSummaryVector(bare repo model)  -> NULL
getSummaryVector(repo@revision)    -> FOUND dims=384
missing after full run (bare key):  3  [ 's1', 's2', 's3' ]
run2 (processed:0 iff resume works): {"processed":3,"totalMissingAtStart":3}
```

**Impact:** Phase 10 SC2 (resume) and SC3 (idempotent rerun) are false for the ONNX embedder — the exact
embedder locked decision 1 selects. A killed 20-minute backfill restarts from zero. `memory status` reports
0% complete forever. Any missing-set-driven repair pass re-embeds the whole corpus every tick, directly
violating Phase 12 SC2.

**Why it survived review:** every Phase 10 test pins the deterministic embedder
(`tests/operations/backfill-embeddings-command.test.ts:9-10`), whose `embed()` returns `model: this.model`
(`embedder.ts:40`) with no suffix. Status tests likewise assert `model: "keyword-hash-v1"`
(`tests/bootstrap/status-command.test.ts:219`).

**Fix options** (planner picks; all are small, the choice is about where identity lives):
- **(a) One identity on the embedder.** Give `TransformerEmbedder` a private `repo` for the `pipeline()`
  call (`transformer-embedder.ts:55`) and set `readonly model = \`${repo}@${revision}\``. Every existing
  caller then agrees automatically. Requires the sidecar config's `model` to carry the revision too, or
  `status-command` to compose it.
- **(b) Key rows on `embedder.model` and store `revision` in its own column.** Cleaner data model, but a
  schema migration (v4) and a `SummaryVectorRecord` field — larger blast radius.
- **(c) Have every caller key on a probe embed's `embedding.model`.** Cheapest diff, worst design — the
  identity stays implicit.

**Recommendation: (a).** Add a regression test that runs the backfill twice under the ONNX embedder and
asserts `run2.processed === 0` and `run2.totalMissingAtStart === 0`. That test is the thing that was
missing.

### GAP-12-B — the missing-set query has no state filter (BLOCKING for scope/cost)

`sqlite-store.ts:1692-1704` selects `from summaries` unconditionally. Live corpus: 138,373 rows, of which
89,059 are `superseded`. `findNearestSummaries` already discards superseded rows at query time as a
"fail-closed second line" (`sqlite-store.ts:1712-1725`), and `rebuild-derivations` tombstones their vectors
(`rebuild-derivations-command.ts:167-175`) — so embedding them is pure waste that must then be undone.
`status-command.ts:197` computes `totalSummaries = summaries.length` from an unfiltered `listSummaries()`,
so the reported denominator is 138,373 as well.

**Measured cost difference** (300-summary random sample from the live corpus, fixture ONNX model, this
session): 24.2 ms/summary → **≈20 min for 49,314 vs ≈56 min for 138,373**, plus ~2.8× the vector bytes
(384 float32 = 1,536 B/row → ~76 MB vs ~213 MB before index overhead).

**Two independent remedies, and they compose:**
1. Run `memory prune-superseded` (with its `--confirm-backup` gate) before the backfill. This is what that
   command was built for — its docstring names "the live corpus's 87,727 superseded rows (~155 MB)"
   (`prune-superseded-command.ts:9`); the count has since grown to 89,059.
2. Add a state predicate to `listSummaryIdsMissingVector`. Needed regardless of pruning, because new
   supersessions accrue continuously and the daemon repair pass must not chase them.

**Note the interaction:** ADR 0049 defines retrievable states. The filter should reuse whatever
`isRetrievableState` uses (`sqlite-store.ts:1721`), not a hand-written `!= 'superseded'`.

## SC3 Verification — embeddings must never sync

**Verified structurally. There is no code path by which a vector can reach an outbox operation.** Four
independent reasons, each citable:

1. **`SyncOperationKind` is a closed 7-value Zod enum** (`src/storage/sync-contracts.ts:18-26`):
   `canonical_append`, `host_event_ingest`, `proposal_decision`, `reviewed_box_decision`,
   `source_revocation`, `source_deletion`, `quarantine_resolution`. No derived-artifact kind exists.
2. **`commitContractionSlice` writes no outbox row.** Read in full at `sqlite-store.ts:681-733`: turns,
   summaries, anchors, boxes, proposals, traces, supersessions, job, checkpoint — and nothing else.
   `emitLocalSyncOperation` is called only from `mcp/mutation-application.ts:119,200`,
   `imports/codex-importer.ts:416`, and `service/source-lifecycle-service.ts` — never from the daemon
   derivation path.
3. **Outbox rows carry no payload.** `SyncOutboxOperationSchema` (`sync-contracts.ts:63-92`) holds ids,
   sequences, digests, and an `effectFingerprint` — a SHA-256 hex string. No content field.
4. **ADR 0047 says so explicitly** (`docs/adr/0047-...md:211`): *"Recompute only affected summaries, topics,
   boxes, traces, and embeddings locally. Derived caches are never independent authority and do not emit a
   second sync operation."*

**The one latent risk worth a test.** `SummarySchema.embedding` is a nullable `EmbeddingSchema` carrying a
full `vector: number[]` (`src/domain/types.ts:81-89, 114`). Nothing syncs summaries today, but if a future
phase ever added a summary-bearing operation kind, a populated `Summary.embedding` would carry a vector
across the wire. Contraction sets it `null` (`contraction-runner.ts:438`) and Phase 12 must keep it that
way — the vector belongs in `summary_vectors` only.

**What the negative test should assert** (all four, in one test file, e.g.
`tests/sync/embeddings-never-sync.test.ts`):

1. Run a full daemon contraction slice that writes N summaries **and** N vectors, then assert
   `listSyncOutboxOperations(personId)` is byte-identical to its pre-slice value (length and every row).
2. Assert `SyncOperationKindSchema.options` equals the exact 7-element array — a **pin**, so adding an
   eighth kind fails this test loudly and forces the author to think about vectors.
3. Assert every summary written by the slice has `summary.embedding === null` while
   `getSummaryVector(id, provider, model)` returns a 384-dim row — i.e. the vector exists *only* in the
   sidecar table.
4. Serialize whatever a sync push would send for the person and assert the bytes contain neither the
   string `"summary_vectors"` nor any float from a known vector. (Weakest of the four; include it as
   defence-in-depth, not as the primary assertion.)

Assertion 2 is the one with real long-term value: it converts an architectural invariant into a
tripwire.

## SC4 Verification — stale-model detection

**What is recorded.** Every `summary_vectors` row carries `provider`, `model`, `dimensions`
(`schema-migrations.ts:36-47`), and for the ONNX embedder the `model` string embeds the pinned HF
revision (`transformer-embedder.ts:103`). So provider/model/version *are* all persisted — but the version
is only there as a side effect of the string concatenation that causes GAP-12-A. **Fixing GAP-12-A must
not drop the revision from the persisted identity.** If the planner picks fix option (b), the revision
moves to its own column, which is strictly better for SC4; if (a), it stays in the composed string.

**The existing surface.** `memory status` already returns `embeddingBackfill: { provider, model,
totalSummaries, missingVectors, completedFraction }` (`status-command.ts:251-257`) plus the full
`EmbedderHealth` object `{ enabled, provider, model, revision, healthy, reason }` (`status-command.ts:250`,
shape at `embedder-resolver.ts:13-20`). That is the SC4 hook and it needs no new command.

**Two corrections to assumptions in the brief:**
- There is **no `memory health` command.** The CLI registry (`src/cli/command-registry.ts:15-46`) has
  `status` and `tune` but no `health`. The health snapshot lives inside `memory status`. CLAUDE.md's
  "health/tune" phrasing and `embedder-resolver.ts:11`'s "`memory health`" comment both refer to a command
  that does not exist under that name.
- The `embeddingBackfill` snapshot is currently **wrong for the ONNX embedder** — it queries with the bare
  config `model` (GAP-12-A), so it will report `missingVectors == totalSummaries` regardless of reality.
  SC4 is not satisfiable until GAP-12-A is fixed.

**What SC4 additionally needs.** "Detectable relative to peers" implies comparison. Nothing in the store
records *peer* device embedder identity, and adding one would need a sync-carried field — which the closed
`SyncOperationKind` enum forbids. Practical reading: SC4 is satisfied when a device can report **its own**
(provider, model, revision) and its own completeness, so an operator comparing two `memory status`
outputs sees the divergence. Recommend stating that reading explicitly in the plan rather than building
peer exchange, which would contradict SC3. **Flag for owner confirmation.**

## Enable + Backfill Sequencing

The ordering matters because `embedder-resolver.ts` hard-errors on a mixed-provider store by design, and
because the daemon holds a single-writer lease.

**Recommended order:**

| # | Step | Why this position |
|---|------|-------------------|
| 0 | Fix GAP-12-A (+ regression test), add the state filter for GAP-12-B | Everything downstream depends on the missing-set being truthful. Doing the backfill first means doing it twice. |
| 1 | `memory daemon stop` | Single-writer lease. A running daemon and a backfill process both opening `SqliteStore` on the same file is the lease conflict `daemon-command.ts` classifies as `lease_conflict`. |
| 2 | `cp -c ~/.memory/aaron.db ~/.memory/aaron.db.pre-phase12` — verify inode/size/mtime | CONTEXT locks this. Four existing backups must not be touched. |
| 3 | `memory prune-superseded --apply --confirm-backup <path>` (dry-run first) | Optional but strongly recommended: 138,373 → 49,314 rows to embed; ~56 min → ~20 min; ~213 MB → ~76 MB of vectors. Must precede enable/backfill, not follow it. |
| 4 | `memory embeddings enable` | The only network step. Vendors to `~/.memory/aaron.db.models`, hash-verified, flips `enabled:true` only on success (`embeddings-command.ts:62-74`). |
| 5 | `memory status` — confirm `embedder.healthy === true`, `provider: "onnx-transformers"`, correct `revision` | Cheap gate before a 20-minute run. |
| 6 | `memory backfill-embeddings --db ~/.memory/aaron.db` — **backgrounded to a log file and POLLED** | CONTEXT hazard: Phase 11 executors stalled 8× on unpolled background jobs. Emits one JSON progress line per 500-record batch (`backfill-embeddings-command.ts:114-122`). |
| 7 | `memory status` — confirm `embeddingBackfill.completedFraction === 1` | This is the assertion that GAP-12-A's fix makes meaningful. |
| 8 | Land the daemon post-commit embed stage; restart the daemon | Incremental extends a populated baseline. |

**Orderings that produce a mixed-provider store — do NOT do these:**

- **Backfill before enable.** With no sidecar, `resolveEmbedder` returns `DeterministicEmbedder`
  (`embedder-resolver.ts:30-32`) and writes 49k rows keyed `("deterministic", "keyword-hash-v1")`. Enabling
  afterwards leaves those rows orphaned — invisible to the ONNX missing-set (so a second full 20-minute
  backfill runs) and invisible to `findNearestSummaries`, which filters on `provider = ? and model = ?`
  (`sqlite-store.ts:1707-1712`). Not corrupting, but ~76 MB of dead rows with no cleanup path.
- **Enabling the daemon embed stage before the backfill finishes.** New summaries get ONNX vectors while
  the bulk of the corpus has none; retrieval silently ranks over a ~0.1% sample. Sequence 8 after 7.
- **Enable, start backfill, then `memory embeddings disable` mid-run.** The embedder is resolved once at
  run start (`backfill-embeddings-command.ts:62`, and its comment says so), so the in-flight run keeps
  writing ONNX rows while `memory status` reports deterministic. Transient reporting confusion only, but
  worth knowing.

## Common Pitfalls

### Pitfall 1: assuming "new summaries" means "summaries whose id is new"
**What goes wrong:** A continuing topic's summary is re-emitted every slice under the same id with longer
text. An id-based or missing-set-based trigger never fires for it, so its vector reflects the topic's
first two turns forever.
**Why:** deterministic id from `(personId, firstEventId, topicLabel)` (`contraction-runner.ts:593-596`),
upsert semantics documented at `contraction-runner.ts:276-277`.
**Avoid:** embed exactly the set `commitContractionSlice` was handed. `saveSummaryVectors` is an upsert
(`sqlite-store.ts:1644-1653`), so re-embedding is free of duplicate risk.
**Warning sign:** a test that adds one new summary and asserts one embed call passes, while a test that
appends turns to an existing topic and asserts the vector changed fails.

### Pitfall 2: reusing the backfill's `listSummaries()` in the daemon
**What goes wrong:** `backfill-embeddings-command.ts:68` loads and Zod-parses every summary (138,373 rows,
~1.4 KB average text, one row 818 KB). Correct once for a CLI; per tick it is seconds of CPU and hundreds
of MB, violating SC2 in spirit even if the *embedding* count is small.
**Avoid:** the recommended seam needs no query at all. The repair pass needs ids only, then a bounded
by-id fetch.

### Pitfall 3: letting embedder failure fail the contraction
**What goes wrong:** `DaemonLoop` maps a contraction throw to `{ ok: false, category: "storage_failure" }`
(`daemon.ts:145-148`) and a proposal throw to `loseAuthority()` (`daemon.ts:158-161`). Wiring the embed
stage into either means a corrupt model file stops memory formation or drops the writer lease.
**Avoid:** the embed stage catches its own errors, records the condition, and leaves the (recoverable)
summary-without-vector state.

### Pitfall 4: the 818 KB summary
**What goes wrong:** the live corpus holds 30 summaries over 100 KB and 668 over 10 KB. Measured, a
521,320-char summary embeds in 167 ms vs 69 ms for its first 4,000 chars. No crash — the tokenizer always
truncates at `model_max_length` 512 tokens (`transformer-embedder.ts:93-98`) — but it is 7× the typical
per-summary cost.
**Avoid:** acceptable as-is. If pre-truncation is attempted for speed, it changes the *input* to a
tokenizer that was already truncating, so output should be identical — but that is an assumption, and
REQ-051's golden-vector determinism makes it a claim requiring a test, not a comment.

### Pitfall 5: running a bulk operation against a live daemon
**What goes wrong:** lease conflict, or two writers. The live `daemon_contraction_job` shows
`attempts: 4680` and a `nextDueAt` within minutes — this daemon is actively cycling.
**Avoid:** `memory daemon stop` and confirm release before steps 3/6 of the sequencing table.

## Code Examples

### The existing post-commit precedent this phase mirrors

```typescript
// src/operations/rebuild-derivations-command.ts:156-175 (existing, verified)
const slice: ContractionSliceResult = await runner.drainSlice(
  parsed.personId, jobId, {},
  { preloadedEvents: events, scopesAlreadyAsserted: scopesAsserted, eventIndexById }
);
const supersededSummaryIds = slice.supersessions
  .filter((supersession) => supersession.kind === "summary")
  .map((supersession) => supersession.id);
if (supersededSummaryIds.length > 0) {
  // Tombstone vectors for superseded summaries ... (T-11-18)
  await store.deleteSummaryVectors(supersededSummaryIds);
}
```

Phase 12 adds the write direction on the same post-commit boundary, in the daemon's contraction work item
(`src/daemon/daemon.ts:136-149`), fed by an additive field on `ContractionSliceResult`
(`src/daemon/contraction-runner.ts:65-74`, which today returns only `immediate: { summaries, anchors }`).

### The record shape (from the one existing writer)

```typescript
// src/operations/backfill-embeddings-command.ts:96-107 (existing, verified)
const embedding = await embedder.embed(summary.summaryText);   // passage mode — never embedQuery
records.push({
  summaryId: summary.id,
  provider: embedding.provider,
  model: embedding.model,          // ← GAP-12-A lives here vs. embedder.model at :64
  dimensions: embedding.dimensions,
  vector: embedding.vector,
  personId: summary.personId,      // the summary's OWN personId, never a caller override (T-10-05)
  scopeIds: summary.scopeIds ?? [],
  createdAt: embedding.createdAt
});
```

Note `embedder.embed(...)`, not `embedQuery(...)`: bge asymmetric prefixing means summaries are embedded
bare and only queries get `QUERY_INSTRUCTION` (`transformer-embedder.ts:11, 70-76`). Phase 9 locked this.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Summaries carried an inline `Summary.embedding` field | Vectors live in the `summary_vectors` table; `Summary.embedding` stays null | Phase 8, schema v2 (`schema-migrations.ts:33`) | Keep it null — it is load-bearing for SC3 |
| Hash embedder as the only embedder | Opt-in ONNX bge-small via sidecar config | Phase 9 | This phase flips the switch for the live corpus |
| No vectors anywhere | Backfill command exists (never run on live data) | Phase 10 | `summary_vectors` = 0 rows today |

**Deprecated/outdated in the planning docs:**
- **ROADMAP Phase 12 "Depends on: Phase 10 (existing corpus already has vectors)"** — false, already flagged
  in CONTEXT. Confirmed: `summary_vectors` has 0 rows.
- **ROADMAP Phase 13/14 dependency prose is internally inconsistent.** The v1.1 sequencing paragraph refers
  to "Phase 11 → 12", "Phase 12, 13", and "Phase 14" for what the headings call Phases 12, 13, 14 — the
  narrative is off by one against the phase headings. Cosmetic, but it will mislead a reader.
- **REQUIREMENTS.md traceability table maps REQ-050 to "Phase 15 — Deletion-Invalidation Closure +
  Operator Surface"** (REQUIREMENTS.md:122) while the ROADMAP's own Phase 14 section describes deletion-
  invalidation and there is no Phase 15 heading. One of the two is wrong.
- **CLAUDE.md says "Each subsystem has an ADR under `docs/adr/` (0001–0047)"** — the directory now runs to
  0051. Phases 8–10 (vector storage, embedder, backfill) added **no ADR**. Per the repo's own convention
  ("add a new ADR for a new decision"), Phase 12's seam choice warrants ADR 0052.
- **`embedder-resolver.ts:11` and CLAUDE.md reference `memory health`** — no such command is registered.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | everything | ✓ | v24.7.0 | — (repo requires 22+) |
| `@huggingface/transformers` | ONNX embedder | ✓ | 4.2.0 (pinned, cited in `transformer-embedder.ts:88-90`) | — |
| Vendored bge-small model (test fixture) | golden test, local benchmarking | ✓ | `tests/fixtures/models/Xenova/bge-small-en-v1.5` | — |
| Vendored bge-small model (**production**) | daemon + backfill | ✗ | — | **None — `memory embeddings enable` must run.** Requires network. |
| `${db}.embeddings.json` sidecar | enabling ONNX | ✗ (absent) | — | Written by the enable step |
| Live DB `~/.memory/aaron.db` | backfill target | ✓ | 138,373 summaries, 0 vectors, schema v3 | — |
| Free disk for ~76–213 MB of vectors + a 5.0 GB backup clone | step 2 and 6 | not measured | — | `cp -c` is an APFS clone (near-zero initial cost), but the backfill's new pages are real writes |

**Missing dependencies with no fallback:** the production vendored model. Step 4 of the sequencing table
is a hard gate and it is the phase's only network operation.

## Validation Architecture

`.planning/config.json` does not set `workflow.nyquist_validation`, so it is treated as enabled.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (`npm test` → `vitest run`, 96 test files per CLAUDE.md) |
| Config file | `vitest.config.*` at repo root (existing) |
| Quick run command | `npx vitest run tests/daemon/contraction-runner.test.ts tests/operations/backfill-embeddings-command.test.ts` |
| Full suite command | `npm test` |
| Type gate | `npm run typecheck` |
| Golden gate | `npm run test:golden` (needs vendored fixtures; passing 16/1-skipped as of 2026-07-28) |

### Phase Requirements → Test Map
| Req / SC | Behavior | Type | Command | File exists? |
|--------|----------|------|---------|--------------|
| SC1 | A slice that writes N summaries persists N vectors post-commit | unit | `npx vitest run tests/daemon/contraction-runner.test.ts -t "embeds"` | ⚠️ file exists, test does not — Wave 0 |
| SC1 | A re-emitted (upserted) active-span summary gets its vector refreshed | unit | same file | ❌ Wave 0 |
| SC2 | Embed calls per slice == summaries written, independent of corpus size (assert with a counting embedder double over a 1-summary vs 1000-summary store) | unit | same file | ❌ Wave 0 |
| SC2 | The repair pass processes at most K ids per invocation | unit | new `tests/daemon/embedding-repair.test.ts` | ❌ Wave 0 |
| SC3 | Outbox unchanged across a vector-writing slice; `SyncOperationKindSchema.options` pinned to 7; `Summary.embedding === null` while `getSummaryVector` returns 384 dims | unit | new `tests/sync/embeddings-never-sync.test.ts` | ❌ Wave 0 |
| SC4 | `memory status` reports `completedFraction === 1` after a complete ONNX backfill | integration | `npx vitest run tests/bootstrap/status-command.test.ts` | ⚠️ exists, deterministic-only — Wave 0 adds ONNX case |
| GAP-12-A | Backfill run twice under the **ONNX** embedder: `run2.processed === 0` | integration | `npx vitest run tests/operations/backfill-embeddings-command.test.ts` | ⚠️ exists, deterministic-only — Wave 0 adds ONNX case |
| GAP-12-B | Superseded summaries are excluded from the missing set | unit | `npx vitest run tests/storage/*vector*` | ❌ Wave 0 |
| Crash | Kill between commit and embed leaves a detectable summary-without-vector that the repair pass heals | unit | `tests/daemon/embedding-repair.test.ts`; use the existing `faults.reach("after_contraction_checkpoint")` hook (`contraction-runner.ts:351`) | ❌ Wave 0 |
| Live | Real backfill of 49,314 summaries completes and `memory status` shows 1.0 | manual UAT | operator-run, backgrounded + polled | ❌ — record in a `12-HUMAN-UAT.md` like Phase 10's |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/daemon/ tests/operations/backfill-embeddings-command.test.ts`
- **Per wave merge:** `npm test && npm run typecheck`
- **Phase gate:** full suite green + `npm run test:golden` green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] ONNX-embedder test fixtures/helper usable from unit tests (the golden test already loads the fixture
      model; extract or reuse its setup rather than writing a third copy)
- [ ] `tests/sync/embeddings-never-sync.test.ts` — SC3
- [ ] `tests/daemon/embedding-repair.test.ts` — SC2 budget + crash recovery
- [ ] ONNX cases added to `tests/operations/backfill-embeddings-command.test.ts` and
      `tests/bootstrap/status-command.test.ts` — these are the tests whose absence hid GAP-12-A
- [ ] Known flake to expect: `tests/mcp/mutation-tools.test.ts` and `tests/mcp/stdio-server.test.ts` can
      time out at 5000 ms under parallel load (CONTEXT hazard) — not caused by this phase

## Security Domain

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No user auth surface in this phase |
| V3 Session Management | no | — |
| V4 Access Control | **yes** | Person/scope isolation. Vector rows denormalize `personId` + `scopeIds` (`memory-store.ts:78-87`) precisely so `findNearestSummaries` can filter before scoring (`sqlite-store.ts:1727-1734`). Incremental writes must tag each row with **the summary's own** `personId`/`scopeIds`, never a caller-supplied value — the fail-loud guard at `backfill-embeddings-command.ts:86-92` (T-10-05) is the pattern to copy. |
| V5 Input Validation | **yes** | Zod at the store seam; `saveSummaryVector` rejects dimension mismatch and non-finite floats (`sqlite-store.ts:1601-1608`) |
| V6 Cryptography | **yes (by omission)** | Model vendoring is hash-verified against a pinned manifest (`model-vendor.ts:16-18, 68-77`) — do not add an unverified download path. Sync crypto is untouched by this phase. |
| V7 Error Handling / Logging | **yes** | Progress and error output must not echo summary text. `backfill-embeddings-command.ts:114-122` emits only counts and provider/model — keep that discipline in the daemon stage. Redaction rule: `[REDACTED]`, never raw secrets (CLAUDE.md). |

| Threat pattern | STRIDE | Mitigation |
|---|---|---|
| Vector leaks personal content to a peer device | Information disclosure | Closed `SyncOperationKind` enum + the SC3 pin test |
| Cross-person retrieval via a mis-tagged vector row | Elevation of privilege | Tag from `summary.personId`; fail loud on absent personId |
| Model substitution during vendoring | Tampering | Hash-verified manifest; enable is the only network path |
| Mixed-provider store yields meaningless cosine scores | Tampering / integrity | D-05 hard error; never catch-and-fall-back |

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|-------|---------|---------------|
| A1 | 24.2 ms/summary generalizes from a 300-row random sample to the full 49,314 | GAP-12-B, Sequencing | Wall-clock estimate off; the 30 summaries >100 KB and 668 >10 KB skew high, so ~20 min is a floor, not a ceiling. Plan for 20–40 min and poll. |
| A2 | Pre-truncating a long summary to ~4,000 chars would produce a byte-identical vector (the tokenizer already truncates at 512 tokens) | Pitfall 4 | If wrong, it silently changes vectors and breaks REQ-051 determinism. **Do not act on this without a test.** Recommendation is to not truncate. |
| A3 | SC4's "relative to peers" is satisfied by each device reporting its own identity, not by peer exchange | SC4 | If the owner meant real peer comparison, that needs a sync-carried field, which SC3 forbids. **Needs owner confirmation.** |
| A4 | Probing (not hard-erroring) at daemon startup is the right reading of "enabled-but-broken must hard-error" | Embedder lifecycle | If the owner meant the daemon must refuse to start, the design changes. **Needs owner confirmation.** |
| A5 | Pruning the 89,059 superseded rows is desirable before backfill | Sequencing step 3 | It is a 5 GB database's worth of irreversible-ish deletion (recoverable only via `rebuild-derivations` from canonical events). The command's own gates make it safe, but it is the owner's call. **Needs owner confirmation.** |
| A6 | Fix option (a) for GAP-12-A (compose revision into `TransformerEmbedder.model`) is preferred over (b) (new column + schema v4) | GAP-12-A | (b) is arguably the better data model and the migration is cheap while `summary_vectors` has 0 rows — this is the *only* moment where (b) costs nothing. Worth reconsidering at plan time. |

## Open Questions

1. **Does the owner want `memory prune-superseded` run as part of Phase 12?**
   - Known: 89,059 superseded rows; backfill currently embeds them; the command exists with a fail-closed
     backup gate; ~36 min and ~137 MB of waste avoided.
   - Unclear: whether the owner wants the deletion now or the state filter alone.
   - Recommendation: dry-run it, show the owner the numbers, then decide. The state filter should land
     regardless.

2. **GAP-12-A fix shape (a) vs (b).**
   - Known: both work; `summary_vectors` is empty *right now*, so a schema v4 adding a `revision` column
     is free today and expensive after 49k rows land.
   - Recommendation: raise it as an explicit plan decision rather than defaulting to the smaller diff.

3. **Daemon behavior when the embedder is unhealthy** — refuse to start, or run without embedding? (A4)

4. **Does SC4 require peer comparison?** (A3)

5. **Should the phase add ADR 0052?** The repo convention says a new decision gets an ADR, and Phases 8–10
   skipped it. The seam choice, the failure-isolation rule, and the model-identity fix are all ADR-shaped.

## Sources

### Primary (HIGH confidence) — this codebase, read directly
- `src/daemon/contraction-runner.ts` (full read) — the seam, upsert semantics, checkpointing
- `src/daemon/daemon.ts` (full read) — work-item loop, failure handling, lease
- `src/daemon/daemon-command.ts` — composition point for a process-lifetime embedder
- `src/daemon/proposal-scheduler.ts` (full read) — the anti-pattern
- `src/daemon/types.ts:100-200, 255-290` — checkpoint/commit schemas, work-item kinds
- `src/operations/backfill-embeddings-command.ts` (full read) — the only `saveSummaryVectors` caller
- `src/operations/rebuild-derivations-command.ts:150-190` — the post-commit precedent
- `src/operations/prune-superseded-command.ts:8-28` — the superseded-row tool
- `src/storage/sqlite-store.ts:681-733, 1145-1176, 1600-1770` — commit path, vector API
- `src/storage/memory-store.ts:78-105, 240-269` — the vector contract
- `src/storage/sync-contracts.ts:1-120` — closed `SyncOperationKind` enum, outbox shape
- `src/storage/schema-migrations.ts:25-60` — `summary_vectors` DDL
- `src/embeddings/*` (resolver, transformer, config, vendor) — model identity, D-05
- `src/bootstrap/status-command.ts:56-106, 177-260` — the SC4 surface
- `src/domain/types.ts:81-120, 150-165` — `EmbeddingSchema`, `Summary.embedding`
- `docs/adr/0047-...md:211` — "Derived caches ... do not emit a second sync operation"

### Primary (HIGH confidence) — measurements taken this session
- Read-only probe of `~/.memory/aaron.db` (`readOnly: true`, no writes): 292,407 canonical events;
  138,373 summaries (49,314 compacted / 89,059 superseded); 0 `summary_vectors`; schema v3; live
  contraction job `attempts: 4680`, `state: complete`, `proposalDirty: true`
- Backfill double-run probe under the real ONNX embedder on a temp DB → GAP-12-A reproduced
- Throughput benchmark, 300 random live summaries, fixture model → 24.2 ms/summary; init 72–121 ms;
  521,320-char summary 167 ms
- Scripts retained at `<scratchpad>/probe.mts`, `live*.mts`, `bench.mts`

### Secondary (MEDIUM confidence)
- `tests/operations/backfill-embeddings-command.test.ts`, `tests/bootstrap/status-command.test.ts` — read
  to establish *why* GAP-12-A survived review (deterministic-only coverage)

### Tertiary (LOW confidence)
- None. No web search was performed; this phase introduces no external technology.

## Metadata

**Confidence breakdown:**
- Seam recommendation: **HIGH** — three options traced through real call sites; the deciding argument
  (upserted active-span summaries) is documented in the source itself
- GAP-12-A: **HIGH** — reproduced by executing the shipping code
- GAP-12-B: **HIGH** — direct SQL read of the live corpus plus the unfiltered query text
- SC3: **HIGH** — four independent structural reasons, each citable
- SC4: **MEDIUM** — the mechanism is verified; the "relative to peers" reading needs owner confirmation
- Cost projections: **MEDIUM** — measured but extrapolated from a 300-row sample

**Research date:** 2026-07-28
**Valid until:** 2026-08-27 (internal codebase; invalidated earlier by any change to
`contraction-runner.ts`, `backfill-embeddings-command.ts`, `embedder-resolver.ts`, or the live corpus)
