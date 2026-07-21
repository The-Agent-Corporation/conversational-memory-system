# Architecture Research: Vector Embeddings + ANN Integration

**Domain:** Local vector search integration into an existing SQLite-backed, event-sourced personal memory system
**Researched:** 2026-07-21
**Confidence:** HIGH (all findings grounded in the actual codebase, not general ANN-library research)

This research is scoped exactly as requested: **integration design**, not library internals. It answers where
embeddings live, how they flow through `MemoryStore`, how 135k summaries get backfilled, how the daemon's
trace step goes from all-pairs to forward-only, how `MemoryRetriever` becomes ANN-backed, and how this interacts
with Phase 6 sync — all against the actual shapes in `src/storage/memory-store.ts`, `sqlite-store.ts`,
`in-memory-store.ts`, `src/traces/*`, `src/daemon/*`, and `src/domain/types.ts`.

## Ground Truth From the Codebase (load-bearing facts)

- `Summary.embedding: EmbeddingSchema.nullable()` already exists in `src/domain/types.ts` — it is `{ provider,
  model, dimensions, vector: number[], createdAt }`. `Anchor.embedding` has the identical shape. Every new
  `Summary` written by `ContractionRunner.summaryForSpan` sets `embedding: null` — nothing currently populates it.
- The `summaries` SQLite table (`sqlite-store.ts` ~line 1868) is `(id text primary key, payload text not null)` —
  a single JSON blob per row, like every other domain table (`boxes`, `anchors`, `proposals`, `traces`). There is
  **no dedicated `embedding` column and no vector index table today.**
- Storage is `node:sqlite`'s built-in `DatabaseSync` (`createRequire(...)("node:sqlite")`), **not**
  `better-sqlite3`. There is no `sqlite-vec` or other extension loaded. `node:sqlite` does expose
  `enableLoadExtension`, but pulling in a native extension binary is an added packaging/portability risk this
  project has avoided so far (zero non-JS native deps beyond the Node built-in).
- `MemoryStore` (the interface) is large and explicit — every capability is its own named method
  (`getSyncOutboxOperation`, `commitContractionSlice`, etc.), and **every method is implemented in both
  `SqliteStore` and `InMemoryStore`**. Any new embeddings/ANN capability must follow this exact pattern: add
  method(s) to the interface, implement in both.
- `DeterministicEmbedder` (`src/embeddings/embedder.ts`) is a real, working, fully local, deterministic
  keyword-hash embedder (SHA-256 token hashing into a fixed-dimension vector, L2-normalized) plus a working
  `cosineSimilarity`. `MemoryRetriever.rankSummary`/`rankAnchor`/`embeddingScore` already prefer vector
  cosine-similarity over keyword overlap **when an embedder + `Summary.embedding`/`Anchor.embedding` are
  present and provider/model/dimensions match** — this fallback logic already exists and does not need
  redesigning, only exercising (i.e., today `MemoryRetriever` is ANN-ready in its scoring logic, just not in
  its data-access pattern — it always calls `listSummaries()`/`listAnchors()` and does brute-force cosine over
  everything in JS).
- Trace discovery today: `DeterministicTraceProposalPlanner.proposeTraces` builds `TraceCandidate[]` via either
  `buildTraceCandidates` (single-threaded, shared-term inverted index, O(n·avg-postings)) or
  `buildTraceCandidatesParallel` (worker-sharded) when `summaries.length >= PARALLEL_TRACE_BACKFILL_THRESHOLD`
  (20,000) **and** the planner was constructed with `parallelWorkers > 0`. The parallel path uses a real
  worker-thread harness: `parallel-trace-backfill.ts` writes a compact per-summary terms JSON to a tmp file,
  spawns N `trace-backfill-worker.mjs` workers (loaded via `tsx`'s `tsImport`, no special `execArgv`), each
  processes a `[leftStart, leftEnd)` shard of left-indices over the **shared inverted-term index** that was
  precomputed once, and results merge via a `traceId`-keyed union of summary indices. This is the reusable
  worker-thread *pattern* — file-shared inputs, index-keyed shard outputs, deterministic merge — but it is
  currently coupled to term-postings, not vectors; ANN backfill will need its own version of this pattern (see
  Backfill Strategy).
- Every `TraceCandidate` gets validated against fixed rules in the planner (`continuityTerms.length >= 2`,
  `minimumTraceSummaries`, `hasNonContiguousRanges`, confidence formula, dedupe against existing
  proposals/traces) before becoming a `MemoryProposal` with `proposalType: "trace"` and a
  `TraceProposalPayload`. **Nothing downstream of `TraceCandidate` needs to change** if the ANN path produces
  the same `TraceCandidate` shape (`{ title, traceId, summaries, keywords, continuityTerms, boxIds }`).
- Daemon orchestration (`daemon.ts`): `ContractionRunner.drainSlice` (canonical events → turns/summaries/anchors,
  no boxes/traces) runs on every tick; `ProposalScheduler.runDue` (summaries/boxes/anchors/proposals/traces →
  new box/trace proposals, via `SleepReviewer` → `DeterministicTraceProposalPlanner`) runs only when a
  contraction job is `proposalDirty` and quiet/forced intervals elapse. **Trace proposal generation is already
  decoupled in time from summary creation** — it is not literally inline in `drainSlice`, it is its own gated
  step. This is the natural seam for forward-only ANN trace discovery.
- `ProposalScheduler.createStagingStore` currently loads **every** person-scoped summary, box, anchor,
  proposal, and trace into a fresh in-memory staging `InMemoryStore` on every run, then hands that whole
  in-memory snapshot to the planner, which (for <20k summaries) rebuilds the whole-corpus inverted index every
  time. This "reload everything, recompute from scratch" pattern is exactly what must change for forward-only
  discovery — it is currently masked by the shared-term index being cheap enough at current scale, but it is
  the same all-pairs problem the milestone is about.
- Sync (`src/storage/sync-contracts.ts`, `src/sync/materialization/sync-materializer.ts`): `SyncOperationKind`
  is a closed enum — `canonical_append | host_event_ingest | proposal_decision | reviewed_box_decision |
  source_revocation | source_deletion | quarantine_resolution`. **There is no sync operation kind for
  summaries, boxes, anchors, or traces.** Only canonical events and a few authoritative decisions replicate
  across devices; all derived memory (summaries, boxes, anchors, traces — and therefore embeddings) is
  **recomputed locally on each device** from the replicated canonical timeline via `ContractionRunner` +
  `ProposalScheduler`, deterministically. This is a pre-existing, load-bearing architectural decision, not
  something this milestone introduces — it settles the sync question in this research with HIGH confidence:
  embeddings must follow the same rule.

## Integration Points

| Existing component | Integration point |
|---|---|
| `MemoryStore` interface | New methods for saving/looking up vectors and querying nearest neighbors (see Storage Design) |
| `SqliteStore` | New `summary_vectors` table + JS-side or extension-backed ANN query; migration for existing rows |
| `InMemoryStore` | New in-memory vector map + brute-force `cosineSimilarity` neighbor query (already have `cosineSimilarity` in `src/embeddings/embedder.ts`) |
| `ContractionRunner.summaryForSpan` | Where a new summary's embedding gets computed **before** commit, or as an async immediate follow-up after commit (see Incremental Discovery) |
| `DeterministicTraceProposalPlanner` / `trace-candidate-core.ts` | New `buildTraceCandidatesFromNeighbors` sibling to `buildTraceCandidates`, emitting the same `TraceCandidate[]` shape |
| `parallel-trace-backfill.ts` + `trace-backfill-worker.mjs` | Pattern reused for a new `parallel-embedding-backfill.ts` (embed) and, if brute-force ANN is used, `parallel-ann-backfill.ts` (build index) |
| `ProposalScheduler.createStagingStore` | Needs a forward-only variant that stages only new-since-last-run summaries against the persisted index, not the whole corpus, for the trace step specifically |
| `MemoryRetriever.prepareInjection` | Replace `listSummaries()` + brute-force `rankMemories` scoring with an ANN top-K pre-filter, still followed by existing scope/boundary filtering and the existing `rankMemories`/`selectMemories` shaping |
| `Embedder` interface | Gets a second implementation (local ONNX sentence-transformer) alongside `DeterministicEmbedder`; both remain valid per REQ-040 as long as local+deterministic |
| Sync (`sync-contracts.ts`) | No new sync operation kind — embeddings are derived state, recomputed per device, never transmitted |
| `memory` CLI (Phase 7) | New backfill/reindex subcommand |
| Daemon lease/checkpoint machinery | Backfill and index maintenance need their own checkpoint row (parallels `ContractionCheckpoint`), not reuse contraction's |

## Storage Design

### Recommendation: dedicated `summary_vectors` table, keep `Summary.embedding` as-is (for now), no sqlite-vec extension.

**Why not just fill in `Summary.embedding`:**
`Summary` is a JSON blob column (`payload text`). Storing the vector there works for `MemoryRetriever`'s
existing per-row cosine scoring (it already reads `summary.embedding`), but it is **useless for ANN
lookups** — SQLite cannot index into a JSON blob's array field, so any "find nearest neighbors" query still
means deserializing every summary payload and computing cosine in JS: that is exactly the same brute-force cost
this milestone exists to eliminate at the *retrieval* layer, even if it's fixed at the *trace-discovery* layer.

**Why not sqlite-vec / a native virtual table:**
The store deliberately uses `node:sqlite`'s bundled `DatabaseSync` — no native npm dependency for the DB layer
at all today. Adding `sqlite-vec` means bundling a native binary artifact per platform (arm64/x64 macOS,
potentially Linux for CI) and either using `node:sqlite`'s `enableLoadExtension` (undocumented stability
guarantees against `node:sqlite` version drift) or switching the whole store to `better-sqlite3` just to get
extension loading. That is a much bigger footprint change than this milestone needs and works against
REQ-040's "no external services" spirit by adding platform-specific native surface. **Not recommended for v1.1.**
A brute-force-but-well-indexed JS ANN (see below) is sufficient at 135k summaries and consistent with the
project's "small, deterministic, pure-JS where possible" bias (see `trace-candidate-core.ts`'s comment style —
performance work here has consistently meant smarter indexing in JS, not native acceleration).

**Recommended shape:**

```sql
create table if not exists summary_vectors (
  summary_id text primary key,
  provider text not null,
  model text not null,
  dimensions integer not null,
  vector blob not null,        -- Float32Array bytes, dimensions * 4 bytes
  created_at text not null
);

create index if not exists idx_summary_vectors_model
  on summary_vectors (provider, model);
```

- `vector` as a `BLOB` of packed `Float32` (not JSON text) — 4 bytes/dim instead of ~20+ bytes/dim as JSON
  text, meaningful at 135k rows × e.g. 384 dims (sentence-transformer) = ~207MB as Float32 vs ~1GB+ as JSON.
  `DeterministicEmbedder`'s default 64-dim vectors are trivially small either way, but the schema should not
  assume the small model.
- Keyed by `summary_id` (1:1 with `summaries.id`), not a separate autoincrement id — a summary has at most one
  live embedding per (provider, model) generation.
- `provider`/`model`/`dimensions` duplicated from `Embedding` so a **model migration** (switching
  `DeterministicEmbedder` → an ONNX model, or upgrading model version) can be detected and handled without
  deserializing every row: `select count(*) from summary_vectors where model != ?` tells you exactly how many
  rows are stale.
- `Summary.embedding` (the JSON field) is **kept** for backward/API compatibility and because
  `MemoryRetriever`'s existing scoring path already reads it directly — but the *authoritative* copy for ANN
  purposes lives in `summary_vectors`. Simplest approach: `saveSummary` continues to persist whatever
  `embedding` is passed on the `Summary` object (unchanged), and a **new** `saveSummaryVector` /
  `getSummaryVector` / `listSummaryVectors` / `findNearestSummaries` set of `MemoryStore` methods manage the
  index table independently. This avoids touching the `SummarySchema`/`upsertPayload` path for vectors at all.

  Alternative considered: drop `Summary.embedding` entirely and have `MemoryRetriever` always resolve embeddings
  via the new store methods. Rejected for v1.1 — it would require also touching `Anchor.embedding` and every
  test/fixture that constructs a `Summary`/`Anchor` inline (this codebase's tests construct domain objects by
  hand extensively; a required schema change ripples wide for no functional gain since the JSON field costs
  little at this row count and vector blob dedup is the thing that actually matters).

### `MemoryStore` interface additions

```ts
export interface NearestSummaryMatch {
  summaryId: string;
  score: number; // cosine similarity, higher is better
}

export interface MemoryStore {
  // ...existing methods unchanged...

  saveSummaryVector(vector: {
    summaryId: string;
    provider: string;
    model: string;
    dimensions: number;
    vector: number[];
    createdAt: string;
  }): Promise<void>;
  getSummaryVector(summaryId: string): Promise<{ provider: string; model: string; dimensions: number; vector: number[]; createdAt: string } | null>;
  /** Summary ids that have no vector row for the given (provider, model), in a stable id order — the backfill/reindex driving query. */
  listSummaryIdsMissingVector(provider: string, model: string): Promise<string[]>;
  /**
   * Top-K nearest neighbors by cosine similarity above `minimumScore`, excluding `excludeSummaryId`
   * when provided. SqliteStore may implement this as an in-process brute-force scan today (still a
   * single indexed table read instead of N JSON deserializations) with room to swap in a real ANN
   * structure later without changing the interface. InMemoryStore MUST implement the identical
   * brute-force cosine scan so results match SqliteStore within floating-point tolerance for tests.
   */
  findNearestSummaries(
    queryVector: number[],
    options: { provider: string; model: string; dimensions: number; topK: number; minimumScore?: number; excludeSummaryId?: string }
  ): Promise<NearestSummaryMatch[]>;
}
```

This mirrors the existing style exactly (see `getSyncOutboxOperation`'s doc comment explaining *why* an indexed
lookup exists instead of list+scan — the same justification applies here).

### InMemoryStore parity

`InMemoryStore` should hold vectors in a `Map<string, { provider, model, dimensions, vector, createdAt }>` and
implement `findNearestSummaries` as a straightforward loop using the existing `cosineSimilarity` from
`src/embeddings/embedder.ts` (already imported nowhere in storage, only in `memory-retriever.ts` and
`embedder.ts` itself — fine to import it into `in-memory-store.ts` too, or duplicate the tiny function to avoid
a storage→embeddings dependency; given `trace-candidate-core.ts` already imports from
`../proposals/proposal-utils.js`, cross-module imports inside `src/` are an accepted pattern here). Because
`SqliteStore`'s recommended v1.1 implementation is *also* brute-force cosine (see below), the two
implementations can share near-identical logic and will produce **exactly** matching top-K results (same
floating point ops, same ordering tie-break rule needed — sort by score desc, then `summaryId` asc, mirroring
`rankMemories`'s existing `right.score - left.score || left.id.localeCompare(right.id)` tie-break) — this
removes the "closely enough" fuzziness the question anticipates and makes it an exact-match test assertion
instead.

### SQLite-side ANN implementation for v1.1: brute-force-in-JS-over-BLOB, not a real ANN structure

At 135k summaries with e.g. 384-dim vectors, a full brute-force cosine scan is ~135k × 384 multiply-adds ≈ 52M
FLOPs per query — sub-10ms in JS, sub-1ms with a typed-array loop. This is **fast enough that a real ANN
structure (HNSW, IVF) is not required for v1.1** at this corpus size, and skipping it avoids a large new
dependency (sidecar `hnswlib-node` file, index build/maintenance, index staleness on delete/update). The
recommendation is:

1. `SqliteStore.findNearestSummaries` loads all `summary_vectors` rows matching `(provider, model)` via one
   `select summary_id, vector from summary_vectors where provider = ? and model = ?` (bytes stay packed;
   decode once per row into a reused `Float32Array`), scores each in a tight loop, keeps a bounded top-K via a
   small max-heap or simple partial sort.
2. This is still a **huge** win over today's approach (deserializing full `Summary` JSON payloads for trace
   candidate generation, or listing all summaries for `MemoryRetriever`) because it reads one narrow indexed
   table instead of full JSON blobs, and because it is the only place doing the scan (not every retrieval path
   re-deserializing `Summary.embedding` from JSON).
3. Document this explicitly as a scaling limit: **when the corpus meaningfully exceeds ~500k–1M summaries**, or
   query latency in practice exceeds an agreed budget (e.g. dogfooding shows >50ms), swap in a real ANN
   structure behind the same `findNearestSummaries` interface — the interface is designed so this swap is
   invisible to every caller (planner, retriever). Candidate future backends: a sidecar `hnswlib-node` index
   file (rebuilt from `summary_vectors` on schema migration) or, if the native-dependency tradeoff becomes
   acceptable later, `sqlite-vec`. This is explicitly deferred, not designed now, per the question's own framing
   ("design the integration, not the library internals").

### Migration for the existing 135,366 summaries

- `schema-migrations.ts` already has the exact append-only pattern needed: add a new entry to `MIGRATIONS` with
  `version: 2` that runs `create table if not exists summary_vectors (...)` inside the existing
  `begin immediate` / `commit` transaction wrapper. This is pure DDL, fast, and safe to run against the live
  ~3.5GB DB — it does **not** populate any rows (population is the backfill job, a separate, resumable,
  potentially-hours-long process that must not block daemon startup or hold a single long transaction).
- After migration, `summary_vectors` is empty; `listSummaryIdsMissingVector(provider, model)` returns all
  135,366 ids until the backfill runs. Nothing reads `summary_vectors` as authoritative until backfill
  completes for the active `(provider, model)` pair, so there is no window where queries silently return wrong
  results — `findNearestSummaries` against an empty/partial table just returns fewer/no candidates, which is
  a safe degraded mode (falls back to keyword scoring in `MemoryRetriever`, see Semantic Recall Path).

## Backfill Strategy

### Reuse the worker-thread *pattern*, not the literal trace-backfill code

`parallel-trace-backfill.ts` establishes three things worth reusing verbatim in shape:
1. A `.mjs` worker entry loaded via `tsx`'s `tsImport` so TypeScript core logic runs unmodified in the worker
   (`trace-backfill-worker.mjs` → imports `.ts` core functions directly).
2. Inputs shared via a **compact serialized file on disk** (a JSON dump, here of per-summary significant
   terms) rather than passing full `Summary[]` through `workerData` — keeps worker startup cheap and avoids
   serializing large objects repeatedly.
3. Deterministic sharding by contiguous index ranges + a **merge function that is associative and
   order-independent** so results are identical regardless of worker count.

For embedding backfill, the natural worker-thread split is **simpler than trace candidate generation** because
embedding one summary is independent of every other summary (no cross-summary index to build first) — no need
to replicate the inverted-index-then-shard structure, a plain "chunk of summary ids → chunk of computed
vectors" split suffices:

```
parallel-embedding-backfill.ts
  - reads summary text for a batch of summaryIds missing a vector (via listSummaryIdsMissingVector)
  - shards ids across N embedding-backfill-worker.mjs workers
  - each worker: loads the DeterministicEmbedder (or ONNX embedder) fresh, embeds its shard, returns {summaryId, vector}[]
  - main thread: saveSummaryVector for each result, in checkpointed batches
```

If the chosen embedding model is an ONNX sentence-transformer (the milestone's "key open decision"), a
worker-thread split is **more** valuable than for the deterministic hash embedder, since ONNX inference is the
actual CPU cost — this argues for building the worker harness now even if v1.1 ships with
`DeterministicEmbedder` initially, since swapping the embedder later is then just swapping what runs inside the
worker.

### One-shot `memory` CLI backfill command, checkpointed like `contraction-runner`

Recommend `memory backfill-embeddings` (parallel to Phase 7's other `memory` subcommands — `health`, `tune`,
`migrate`) with:
- **Idempotency**: driven entirely by `listSummaryIdsMissingVector(provider, model)` — reruns after a partial
  failure or Ctrl-C simply pick up wherever the table currently is; no separate checkpoint row is strictly
  required for correctness (unlike `ContractionCheckpoint`, which must resume mid-canonical-timeline-scan with
  topic-monitor state). A lightweight checkpoint row is still worth adding for **operational visibility and
  batch-size sanity** (progress reporting across a run that may take minutes at 135k summaries), following the
  existing daemon checkpoint style (`daemon_contraction_checkpoint`-style row: `{id, provider, model, processedCount, totalCount, updatedAt}`), but functionally this job is a **pure set-difference retry loop**, simpler than contraction's ordered-canonical-timeline resume logic.
- **Determinism**: `DeterministicEmbedder.embed` is already a pure function of `text` (SHA-256 token hashing) —
  re-running backfill (or the daemon's incremental embed step) on the same `summaryText` always yields the
  bit-identical vector, so `createdAt` is the only field that legitimately differs between runs, and even that
  should be pinned to a caller-supplied clock in tests (the embedder already supports `createdAt` injection via
  `DeterministicEmbedderOptions`). If the ONNX path is chosen instead, it must be verified to also be
  bit-reproducible across runs/platforms (fixed random seed at model init is irrelevant for inference-only
  sentence-transformers, but float non-determinism across CPU architectures/thread counts is a real risk to
  test explicitly — flag as LOW confidence until the specific model + runtime is chosen and verified).
- **Batching**: process in batches of e.g. 500–2,000 ids per `saveSummaryVector` flush so a crash loses at most
  one batch of work, matching the spirit of `ContractionRunner`'s `maxEvents`/`maxMonotonicMs` slice limits.

### Threshold reuse

`PARALLEL_TRACE_BACKFILL_THRESHOLD = 20_000` in `trace-proposal-planner.ts` is the existing precedent for "use
workers above N, single-thread below." The embedding backfill CLI command should default to using workers
unconditionally (it's a one-shot operator-triggered job, not a per-tick daemon path, so there's no reason to
avoid worker overhead the way the daemon's tiny incremental runs do) — but the **daemon's own incremental
embed-one-new-summary step** should stay single-threaded/inline, exactly mirroring how `drainSlice`'s few
summaries per tick never go through `buildTraceCandidatesParallel`.

## Incremental / Forward-Only Discovery

### Where it slots into the daemon

Two candidate seams; recommend the second:

1. **Inline in `ContractionRunner.summaryForSpan`** — compute the embedding synchronously as part of summary
   creation, before `commitContractionSlice`. Simple, but couples contraction's already-carefully-tuned
   performance path (this is the exact code that was O(n²) and got fixed) to embedding latency, and mixes two
   concerns (`ContractionRunner` currently only knows about turns/anchors/summaries — introducing embedding
   compute here changes its performance contract).
2. **Recommended: a new, small scheduled step alongside `ProposalScheduler`, e.g. `EmbeddingScheduler`,
   consulted by the daemon right after (or interleaved with) `drainSlice` on each tick.** This mirrors how trace
   proposal generation is *already* decoupled from contraction (`ProposalScheduler.runDue`, gated on
   `proposalDirty` + quiet/forced intervals) rather than inline in `drainSlice`. An `EmbeddingScheduler.runDue`
   would:
   - call `store.listSummaryIdsMissingVector(provider, model)` scoped to the person (or globally, since
     summaries embed independent of person-boundary rules — embedding is a pure text→vector function, no
     scope leakage risk as long as the *retrieval* layer still enforces scope filtering, which it does)
   - embed just the missing ones (typically a handful per tick, matching contraction's own `maxEvents: 250`
     scale) inline, no worker thread needed at this size
   - `saveSummaryVector` for each

This keeps `ContractionRunner` unchanged (still just canonical events → turns/summaries/anchors) and adds a new
narrow-purpose scheduler class following the existing `ProposalScheduler`/`ContractionRunner` separation-of-
concerns convention.

### Where forward-only trace discovery replaces all-pairs

The actual seam for the milestone's core ask — "daemon trace step becomes forward-only, never all-pairs
post-bootstrap" — is inside `ProposalScheduler`'s use of `DeterministicTraceProposalPlanner`, **not**
`ContractionRunner`. Concretely:

- Add a new candidate-generation function, e.g. `buildTraceCandidatesFromNeighbors`, living alongside
  `buildTraceCandidates` in `trace-candidate-core.ts` (or a sibling `vector-trace-candidate-core.ts`, given how
  clean the existing split between "pure candidate algorithm" and "planner orchestration" already is), with
  this shape:

  ```ts
  async function buildTraceCandidatesFromNeighbors(
    newSummaries: Summary[],       // only summaries created/changed since the trace step last ran
    boxes: Box[],
    store: MemoryStore,            // for findNearestSummaries
    options: { provider: string; model: string; topK: number; minimumScore: number; idNamespace?: string }
  ): Promise<TraceCandidate[]>
  ```

  For each new summary, query `store.findNearestSummaries(newSummary.embedding.vector, { topK, minimumScore,
  excludeSummaryId: newSummary.id, provider, model })`, and for every match above threshold, form a candidate
  pair exactly the way `collectTracePartials` forms a pair today (shared traceId derivation, keyword/evidence
  fields populated from e.g. the pair's shared significant terms or just the similarity score + both
  summaries' text), then run through **the same downstream validation** already in
  `DeterministicTraceProposalPlanner.proposeTraces` (`continuityTerms.length >= 2` needs adapting — see Open
  Questions — `minimumTraceSummaries`, `hasNonContiguousRanges`, confidence formula, dedupe against existing
  proposals/traces). Because the output type is the same `TraceCandidate[]`, **the planner's loop body,
  confidence formula, proposal-shape building (`buildTraceProposal`), and everything downstream (review/accept
  flow, `MemoryProposal`/`MemoryTrace` schemas, MCP tools) needs zero changes.**

- `DeterministicTraceProposalPlanner` gains a mode switch (or a second implementation of the
  `TraceProposalPlanner` interface, e.g. `VectorTraceProposalPlanner`) that calls
  `buildTraceCandidatesFromNeighbors` instead of `buildTraceCandidates`/`buildTraceCandidatesParallel`. Given
  `TraceProposalPlanner` is already an interface with one implementation, adding a second implementation
  (rather than branching inside the existing class) is the more idiomatic fit and lets `SleepReviewer` (or
  whatever constructs the planner) pick the strategy via constructor injection — consistent with how
  `ProposalSchedulerOptions.reviewerFactory` already allows swapping the reviewer.

- **What makes it forward-only rather than all-pairs**: the *input* to candidate generation becomes "summaries
  new since the last successful trace-discovery pass" instead of "every summary in the corpus." This requires a
  small new piece of state — a high-water mark, e.g. `lastTraceDiscoveryAt` or a processed-summary-id
  checkpoint — that `ProposalScheduler` (or a new sibling) tracks per person, analogous to
  `ContractionCheckpoint.processedThroughOrderKey`. `ProposalScheduler.createStagingStore` today loads *all*
  person summaries into an `InMemoryStore` regardless — that whole-corpus load can stay (summaries are needed
  for box proposals too, which are out of scope for this milestone and keep their existing all-pairs-ish
  behavior for now per the question's framing), but the **trace candidate step specifically** should filter to
  `newSummaries` before calling the neighbor-based candidate builder. This means `ProposalScheduler` needs to
  know the trace-discovery high-water mark and pass only new summaries to `DeterministicTraceProposalPlanner`/
  its vector sibling, while still passing the full summary/box/anchor set for box-proposal generation which
  remains unchanged in this milestone.

## Semantic Recall Path

### Current state
`MemoryRetriever.prepareInjection` calls `store.listSummaries()`/`listAnchors()`/`listTraces()`/`listBoxes()`
unconditionally (full table scan of derived memory), applies `applyRetrievalBoundary` (person/scope filtering —
**must be preserved exactly**), then `rankMemories` scores every remaining summary/anchor/trace via
`rankSummary`/`rankAnchor`/`rankTrace`. `rankSummary`/`rankAnchor` **already** prefer vector cosine similarity
over keyword overlap when `options.embedder` is supplied and `summary.embedding`/`anchor.embedding` is present
and provider/model/dimensions-compatible with the topic embedding (`embeddingScore` function, already written).
So the *scoring* logic is ANN-ready; what's missing is **candidate selection before scoring** — right now
"everything" is scored, brute-force, in JS, every call.

### Recommended change

1. `MemoryRetriever` gains access to `MemoryStore.findNearestSummaries` (already has `store: MemoryStore` in its
   constructor — no new dependency needed).
2. `prepareInjection` computes `topicEmbedding` (already does this, line ~43-45) and, **when an embedder is
   configured**, calls `store.findNearestSummaries(topicEmbedding.vector, { provider, model, dimensions, topK:
   N, minimumScore })` to get a bounded candidate summary-id set **before** loading full `Summary` objects,
   instead of `listSummaries()` returning everything.
3. `applyRetrievalBoundary`'s person/scope filtering then runs on this **smaller** candidate set (plus, still,
   the full anchor/trace/box lists — those remain brute-force for now since traces/anchors are typically much
   smaller in count than summaries; only the summary path, the dominant volume, needs ANN pre-filtering for
   v1.1). This preserves the boundary contract exactly (`applyRetrievalBoundary` doesn't care whether its input
   list was pre-filtered by relevance, only that person/scope conditions still gate what's included) and
   preserves `sourceSummaryIds`/`sourceTurnRanges`/`boxIds` attribution because the retrieved objects are still
   full `Summary` records fetched normally, not synthesized from the vector index.
4. `rankMemories`/`rankSummary` continue to work unmodified: they already handle "embedding present → vector
   score, else → keyword score" per-item, so **this is a strict narrowing of the candidate set, not a change to
   scoring logic**.
5. **Fallback when ANN candidates are empty/insufficient** (e.g. no embedder configured, embeddings not yet
   backfilled, or `findNearestSummaries` returns fewer than desired): fall back to the existing
   `listSummaries()` + keyword-overlap path unchanged. This is a safe default already implicit in
   `rankSummary`'s `vectorScore !== null` branch — the recommendation is simply to apply the same "degrade to
   keyword" policy one layer up, at candidate selection, not just at per-item scoring.

### Query-time flow (end state)

```
prepareInjection(request)
  -> embed request.currentTopicSummary (existing)
  -> if embedder configured:
       candidateSummaryIds = store.findNearestSummaries(topicEmbedding, {provider, model, dimensions, topK, minimumScore})
       candidateSummaries = load those Summary rows (existing per-id fetch or a small listByIds addition)
     else:
       candidateSummaries = store.listSummaries()   // existing full scan, unchanged
  -> applyRetrievalBoundary(request, candidateSummaries, allAnchors, allTraces, allBoxes, ...)   // unchanged
  -> rankMemories(...)                                                                            // unchanged
  -> selectMemories / addParentBoxContext / build InjectionPacket                                 // unchanged
```

## Sync Interaction

**Decision: embeddings are recomputed locally per device, never synced.** This is not really an open design
choice for this codebase — it follows directly from the existing Phase 6 architecture, with HIGH confidence
from reading `sync-contracts.ts`/`sync-materializer.ts`:

- `SyncOperationKind` is a closed enum of exactly seven kinds, none of which is "summary" or "derived memory."
  Only canonical events (`canonical_append`, `host_event_ingest`) and a small set of authoritative decisions
  (`proposal_decision`, `reviewed_box_decision`, `source_revocation`, `source_deletion`,
  `quarantine_resolution`) replicate across devices.
- Summaries, boxes, anchors, and traces are **derived, not synced** — every device runs its own
  `ContractionRunner` + `ProposalScheduler` against its own locally-replicated canonical timeline and arrives
  at the same derived state because contraction/summarization/trace-discovery are deterministic pure functions
  of the canonical event sequence. Embeddings are just one more deterministic derivation in that same chain
  (`summaryText -> vector`, given a fixed model), so they belong in exactly the same "recompute locally" bucket.
- **Trade-offs, stated for completeness even though the decision is effectively forced by existing design:**
  - *Bandwidth*: Not syncing saves meaningful bytes — 135k summaries × (e.g.) 384 dims × 4 bytes ≈ 207MB of
    vector data that would otherwise need to cross the zero-knowledge sync channel (encrypted, so also
    incompressible) on every new device pairing. Recomputing locally avoids this entirely.
  - *Determinism*: Only safe if the embedder is provably deterministic (`DeterministicEmbedder` is, by
    construction — pure hash function). An ONNX sentence-transformer must be verified deterministic
    across the specific runtime/hardware this system runs on (LOW confidence until verified — flag as an open
    question below) before this "recompute don't sync" decision can extend to that model without device-skew
    risk.
  - *Model-version skew*: If device A has embedded with model version X and device B (freshly paired, or
    mid-upgrade) is still on version Y, their `summary_vectors` tables will genuinely differ until B's backfill
    catches up — this is expected and self-healing (each device's own backfill/incremental-embed job converges
    it), not a sync bug. The `provider`/`model` columns on `summary_vectors` make this skew detectable and the
    `listSummaryIdsMissingVector`/reindex path is exactly the recovery mechanism. This should be called out
    explicitly in the daemon's health/status output (Phase 7's `memory health` command is the natural home) so
    a stale-model device is visible to the operator, not silent.
  - *No new sync operation kind needed* — the sync surface stays exactly as sized as Phase 6 left it, which is
    also lower risk given ADR 0047's threat-model work was already reviewed and closed for that surface.

## New vs Modified Components

**New:**
- `summary_vectors` SQLite table + schema migration (version 2)
- `MemoryStore` methods: `saveSummaryVector`, `getSummaryVector`, `listSummaryIdsMissingVector`, `findNearestSummaries` (interface + both implementations)
- `parallel-embedding-backfill.ts` + `embedding-backfill-worker.mjs` (new worker-thread harness, pattern-matched to `parallel-trace-backfill.ts`)
- `memory backfill-embeddings` CLI subcommand
- `EmbeddingScheduler` (daemon, incremental embed-new-summaries step)
- `buildTraceCandidatesFromNeighbors` in (or alongside) `trace-candidate-core.ts`
- `VectorTraceProposalPlanner` (second `TraceProposalPlanner` implementation) or a mode flag on the existing planner
- A trace-discovery high-water-mark/checkpoint (new small piece of daemon state, parallel to `ContractionCheckpoint`)
- Possibly a second `Embedder` implementation (local ONNX sentence-transformer) — pending the milestone's open model decision

**Modified:**
- `MemoryStore` interface (new methods appended, existing methods untouched)
- `SqliteStore`, `InMemoryStore` (new methods implemented; existing methods untouched)
- `MemoryRetriever.prepareInjection` (candidate selection narrowed to ANN top-K before `applyRetrievalBoundary`; `rankMemories`/`rankSummary`/`rankAnchor`/`embeddingScore` unchanged — they already support this)
- `ProposalScheduler` (trace-candidate input narrowed to new-since-last-run summaries; box-proposal input unchanged)
- `schema-migrations.ts` (new version-2 entry)
- `memory health`/`memory tune` (Phase 7 CLI) — surface embedding backfill completeness and model-version skew

**Explicitly unchanged:**
- `Summary`/`Anchor` schemas (embedding field already present, shape unchanged)
- `ContractionRunner` (no embedding compute inline; stays focused on canonical events → turns/summaries/anchors)
- `MemoryProposal`/`MemoryTrace` schemas and the entire review/accept flow (trace proposals keep the exact same shape regardless of which candidate-generation strategy produced them)
- `TraceProposalPayloadSchema`, `buildTraceProposal`, dedupe-against-existing-proposal logic
- Sync operation kinds / `sync-contracts.ts` / `sync-materializer.ts` (no new kind; embeddings never cross the wire)
- Box-proposal generation path (out of scope for this milestone per PROJECT.md's target features)

## Suggested Build Order

1. **Storage foundation.** `summary_vectors` table + migration, `MemoryStore` interface additions, both
   implementations (`SqliteStore` brute-force-over-blob, `InMemoryStore` map + `cosineSimilarity`), with tests
   asserting **exact** result parity between the two implementations (same top-K, same order, same scores)
   given identical input vectors — this is now achievable exactly, not just "closely enough," per the Storage
   Design section. No behavior change yet; nothing calls these methods.
2. **Embedding model decision + `Embedder` finalization.** Resolve the milestone's open question
   (`DeterministicEmbedder` vs. ONNX sentence-transformer) before backfill, since backfill work (and its
   worker-thread shape, and its determinism verification) depends on which embedder runs. If ONNX is chosen,
   verify cross-platform/cross-run determinism explicitly before proceeding — this is a hard prerequisite for
   Sync Interaction's "recompute don't sync" decision to hold safely.
3. **Backfill.** `parallel-embedding-backfill.ts` + worker + `memory backfill-embeddings` CLI, run once against
   the existing 135,366 summaries. Verify idempotency (rerun produces zero new writes) and determinism (rerun
   from scratch produces bit-identical vectors) before moving on.
4. **Daemon incremental embedding.** `EmbeddingScheduler`, wired into `daemon.ts` alongside `ContractionRunner`/
   `ProposalScheduler`, so every newly contracted summary gets embedded within one daemon tick going forward —
   this must land before forward-only trace discovery (step 5) since that step assumes new summaries already
   have vectors by the time trace discovery runs.
5. **Forward-only vector trace discovery.** `buildTraceCandidatesFromNeighbors`, the trace-discovery high-water
   mark, `VectorTraceProposalPlanner` wiring into `ProposalScheduler`. Validate against the existing shared-term
   planner on a real (or dogfooded) dataset — same downstream proposal shape, ideally comparable or better
   trace quality, before flipping the daemon's default from shared-term to vector-based (or running both in
   parallel for a transition period, since `hasExistingProposal`/dedupe logic already guards against duplicate
   proposals from two strategies targeting the same summary pair).
6. **Semantic recall.** `MemoryRetriever` candidate-selection change (ANN pre-filter before
   `applyRetrievalBoundary`). This is the lowest-risk step to do last: scoring logic already supports vectors,
   this step is purely a performance/relevance improvement to candidate selection, easily feature-flagged via
   "is an embedder configured," and has no schema or proposal-shape implications.
7. **Operator surface.** `memory health`/`memory tune` updates: embedding backfill completeness, model-version
   skew detection across devices, ANN query latency reporting — lands after the above are functionally
   complete, since it's observability on top of them.

This order respects every real dependency found in the code: storage before anything reads/writes it, the model
decision before backfill (backfill's worker shape depends on it), backfill before daemon incremental embedding
assumes-complete-history behavior isn't required but is the natural order, daemon incremental embedding before
forward-only trace discovery (which assumes fresh summaries are already embedded), trace discovery before
touching retrieval (independent features, but trace discovery is the milestone's stated primary motivation per
PROJECT.md — "the shared-term trace algorithm is combinatorially pathological at scale" — so it should land
first among the two consumer features), and operator surface last since it only reports on the others.

## Open Questions

- **Embedding model choice** (explicitly flagged as open in PROJECT.md): `DeterministicEmbedder` (weak
  semantics, zero new risk) vs. a local ONNX sentence-transformer (real semantics, new bundled model file +
  inference runtime dependency, determinism-across-platforms needs explicit verification). This research does
  not resolve it — it is upstream of backfill design (worker harness shape, checkpoint granularity, and the
  Sync Interaction section's "recompute is safe" claim all assume a verified-deterministic model).
- **`continuityTerms`/keyword fields on vector-derived `TraceCandidate`s.** The existing planner rejects
  candidates with `continuityTerms.length < 2` and uses `continuityTerms`/`keywords` to build
  `continuityReason` text shown to the human reviewer. A cosine-similarity-derived pair has no natural
  "shared terms" unless one is computed separately (e.g. still run `significantTerms` overlap on the pair as a
  secondary signal purely for the human-readable rationale, independent of the score used for ranking). Needs a
  decision: keep a term-overlap-derived rationale for explainability even when the *selection* is vector-based,
  or introduce a new rationale template keyed on similarity score instead. This affects whether
  `buildTraceCandidatesFromNeighbors` needs the term-index machinery at all or can be pure-vector.
  - Recommendation leaning: keep computing `significantTerms` per summary (cheap, already exists) purely for
    the human-facing rationale text on vector-derived candidates, but do NOT require `continuityTerms.length >=
    2` as a hard gate for vector-based candidates — that gate exists specifically to compensate for shared-term
    matching's combinatorial noise, which doesn't apply to a cosine-threshold-gated candidate.
- **Similarity threshold and `topK` defaults** for both trace discovery and semantic recall — these are tuning
  parameters that likely need dogfooding against the real 135k-summary corpus (referenced in PROJECT.md as the
  existing dogfooding dataset) rather than being chosen from first principles here.
- **Anchors.** `Anchor.embedding` exists and `MemoryRetriever` already scores it via vectors, but this research
  focused on `Summary` per the question's scope. Anchor backfill/incremental-embed likely wants the identical
  treatment (arguably folded into the same `EmbeddingScheduler`/backfill job) but was not separately designed
  here — flag as a likely near-term follow-up, not a v1.1 gap, since anchors are a smaller, secondary corpus.
- **When to retire the shared-term trace planner entirely** vs. keep it as a fallback (e.g. for
  people/devices where an embedder isn't configured, or as a sanity cross-check during the transition period
  named in Build Order step 5). Not resolved here — a product/roadmap decision more than an architecture one.
