# Feature Research: Vector-Native Trace Discovery + Semantic Recall

**Domain:** Personal memory system — recurring-thread (trace) discovery and meaning-based recall over a growing summary corpus
**Researched:** 2026-07-21
**Confidence:** MEDIUM (thresholds and clustering patterns verified against multiple sources; exact numbers need calibration against this corpus's actual embedding model)

## Context From the Existing Codebase

Read directly (not assumed) to ground this research:

- `src/traces/trace-candidate-core.ts` — today's trace discovery is a full inverted-index all-pairs join over **every summary the person owns**, gated only by a document-frequency floor (`maxDocumentFrequencyFor`, 200 or 0.4% of corpus) to prune non-discriminating terms. `buildTraceCandidates` takes `summaries: Summary[]` — the *whole* person corpus, not a delta.
- `src/traces/trace-proposal-planner.ts` — wraps candidates in confidence scoring (`0.45 + continuityTerms*0.1 + summaries*0.05`, capped 0.9), requires `continuityTerms.length >= 2`, `summaries.length >= minimumTraceSummaries` (default 2), and non-contiguous turn ranges (`hasNonContiguousRanges`) before proposing. Existing traces/proposals are deduped by `traceId`.
- `src/boxes/box-proposal-planner.ts` — sibling planner, same whole-corpus-per-run shape, greedy single-link grouping by first-two-significant-terms + running intersection (this is itself effectively single-pass streaming/leader-style already — a useful existing pattern to mirror for vector clustering).
- `src/daemon/proposal-scheduler.ts` — `runDue()` re-stages the **entire person's summaries** (`listSummaries()` filtered to `personId`) into a fresh `InMemoryStore` on every due cycle (quiet period or forced interval) and calls `SleepReviewer.stageProposals`, which invokes both planners. This is the root of the O(n²)/combinatorial blowup at 135k+ summaries: even though the daemon runs "incrementally" in wall-clock terms, the planner itself is re-fed the whole corpus every time it's due, not just new-since-last-run.
- `src/embeddings/embedder.ts` — `Embedder` interface (`provider`, `model`, `dimensions`, `embed(text): Promise<Embedding>`) and `cosineSimilarity` already exist. `DeterministicEmbedder` is a keyword-hash pseudo-embedding (REQ-040-safe, no real semantics — bag-of-hashed-tokens with sign flips, not a trained sentence embedding).
- `src/retrieval/memory-retriever.ts` — `MemoryRetriever.prepareInjection` already has a vector path: if `embedder` is configured and both query and memory have embeddings from the *same* provider/model/dimensions, it scores via `cosineSimilarity` instead of keyword overlap (`embeddingScore`). Falls back to keyword automatically when embeddings are absent or mismatched. Scope/boundary filtering (`applyRetrievalBoundary`) already runs **before** ranking — person + scope allow-list — so vector scoring only ever sees already-boundary-filtered candidates. Trace and box ranking currently stay keyword-only even when summaries have embeddings (`rankTrace` does not call `embeddingScore`) — a gap the new milestone should close.

This means the new work is not "bolt vector search onto nothing" — it is (a) replace the trace *candidate-generation* algorithm while keeping the existing proposal/confidence/dedup/scope machinery, (b) populate real embeddings so the retriever's already-built vector path activates, and (c) make the daemon step operate on a delta instead of restaging the whole corpus every due cycle.

---

## Table Stakes

Features users/operators will assume exist once "vector-native traces + semantic recall" is the stated capability. Missing these makes the milestone feel unfinished or regressive relative to the shared-term system it replaces.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Every summary gets a real embedding (backfill + incremental) | The milestone's stated goal; semantic recall and vector traces both depend on it | MEDIUM | Backfill 135k+ existing summaries once; embed new summaries as they're created by contraction, not lazily at query time |
| Local ANN/vector index for neighbor search | Without it, "find nearest neighbors" degenerates back into an O(n²) or O(n·log n at best) linear scan every run — the exact regression this milestone exists to fix | MEDIUM-HIGH | Approx: HNSW-style or brute-force-with-cutoff acceptable at this corpus size (100k-1M) if paired with per-summary top-K caps; must stay local/dependency-light per REQ-040 |
| Trace candidates found by similarity-above-threshold, not shared terms | Direct replacement of the pathological algorithm; if it still explodes combinatorially the milestone fails its own premise | MEDIUM | See Incremental Discovery Pattern below |
| Non-contiguity requirement preserved | A trace is defined as *recurring, non-contiguous* — a cluster of temporally-adjacent similar summaries is not a trace, it's a box. Vectors alone will over-merge temporally adjacent chatter unless this existing structural gate (`hasNonContiguousRanges`) is kept | LOW | Reuse existing check unchanged; apply it after vector clustering, same as today |
| Traces still surface as review proposals (proposed → accepted/rejected) | Existing UX contract; vectors change *how* candidates are found, not the review lifecycle | LOW | No change needed in `trace-proposal-planner.ts`'s proposal/confidence/dedup logic — only the candidate-generation call swaps out |
| Deterministic output for the same input | Existing system promises this implicitly (proposal IDs derived from content, dedup checks); users expect re-running the daemon on unchanged data not to spawn new/different trace proposals | MEDIUM | Nearest-neighbor search order, float precision, and tie-breaking must be made explicit and stable (sort by summary ID on ties, fixed iteration order) — see below |
| Semantic recall — query summaries by meaning | Explicit milestone goal; users expect "find memories about X" without exact keyword match | MEDIUM | `MemoryRetriever` vector path already exists; this is mostly "make embeddings real" plus applying it to trace ranking too |
| Every recalled fact traceable to its source | Existing product invariant, not new — "every recalled fact traceable to its source" is in `PROJECT.md`'s Vision | LOW-MEDIUM | Already enforced structurally via `sourceSummaryIds`/`sourceTurnRanges` on every `RankedMemory`; vector-based results must populate these identically to keyword results — do not let embeddings become a second, less-traceable code path |
| Scope/boundary filtering applies identically to vector results | Person/workspace/case/sensitivity boundaries "override universal recall" per PROJECT.md | LOW | Already structurally guaranteed since `applyRetrievalBoundary` runs before `rankMemories`/embedding scoring in `memory-retriever.ts` — must not regress when adding vector trace clustering, which needs the same pre-filter |
| Confidence score on recalled/clustered items | Existing proposals and injection packets already carry `confidence`; vector similarity score is a natural, better-calibrated substitute | LOW | Cosine similarity in [0,1] after `Math.max(0, ...)` clamp maps naturally to confidence; keep the same 0.5 minimum-confidence gate semantics for trace proposals |
| Threshold tuned to avoid one giant blob AND avoid missing real recurrences | Both the shared-term algorithm's failure modes (526k candidates) and a naive low threshold on vectors ("bridge everything") must not recur | MEDIUM | See threshold discussion below; needs empirical tuning against this corpus's actual embedding model, not just literature defaults |

## Differentiators

Features that go beyond "vectors instead of term-overlap" and would meaningfully improve the product beyond parity with the old algorithm.

| Feature | Value Proposition | Complexity | Notes |
|---------|--------------------|------------|-------|
| Hybrid keyword+vector recall (RRF) for semantic recall | Pure vector search misses exact identifiers (case numbers, proper nouns, IDs) that keyword search catches; pure keyword misses paraphrase. RRF (rank-based fusion, k≈60) is the current production-RAG standard and is scale-invariant across BM25-like and cosine scores, avoiding fragile score normalization | MEDIUM | Not strictly required for v1.1 (existing keyword fallback already coexists with vector scoring per-item), but real hybrid *fusion* of a combined result list — rather than "vector if available else keyword" — is a genuine improvement over today's either/or scoring in `rankSummary`/`rankAnchor` |
| Vector-based trace ranking (not just discovery) | `rankTrace` in `memory-retriever.ts` is currently keyword-only even though traces are backed by summaries that will soon have embeddings; scoring recalled traces by centroid/max-similarity to the query embedding would make trace recall as good as summary recall | LOW-MEDIUM | Natural follow-on once summary embeddings exist; mirror the `embeddingScore` fallback pattern already used for summaries/anchors |
| Trace continuity term extraction stays, augmented not replaced | Users reviewing a trace proposal want a human-readable reason ("continues because of X, Y, Z"), which shared-term extraction already provides. Vectors find *that* two summaries are related; term extraction still explains *why* in the proposal UI | LOW | Keep `significantTerms`/shared vocabulary as an explanation layer computed over the (now much smaller) vector-matched candidate set, not as the discovery mechanism |
| Query-time semantic recall with score threshold + top-K, exposed via existing MCP tools | Table-stakes RAG behavior — return the best K above a minimum similarity, never force-return K weak matches | LOW | `selectMemories` already caps to 3 items and packs by token budget; adding a minimum-similarity floor (reject weak vector matches rather than always filling to 3) is a small, valuable addition |
| Per-embedding-model versioning/migration path | Swapping the embedding model later (e.g., DeterministicEmbedder → ONNX sentence-transformer) is likely, given the milestone's own "Key open decision" section flags this. A vector store that records provider/model/dimensions per embedding (already true of the `Embedding` type) and supports re-embedding in place is a differentiator that avoids a future data-migration crisis | MEDIUM | `embeddingScore` already refuses to compare mismatched provider/model/dimensions — extend this discipline to the backfill/reindex tooling so a model swap doesn't silently degrade to zero matches for old rows |

## Anti-Features

Things that look appealing but would recreate the exact problem this milestone fixes, or break existing invariants.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|------------------|-------------|
| Clustering / re-embedding the whole corpus every nightly run | "Just re-run clustering on everything to be safe/consistent" | This is precisely the shared-term algorithm's failure mode restated in vector form; at 135k+ summaries, re-clustering nightly means either re-running ANN index builds (expensive) or reopening the same all-pairs blowup the milestone exists to eliminate. `proposal-scheduler.ts` already restages the *whole* person corpus each due cycle even for the current keyword algorithm — carrying that pattern forward into vectors compounds rather than fixes it | Forward-only/incremental: embed once, index once (append-only ANN inserts), and on each daemon cycle only query neighbors for *newly created or newly dirty* summaries against the existing index — see Incremental Discovery Pattern |
| Unbounded/greedy trace merging (transitive closure of "similar to something similar") | Feels natural — "if A~B and B~C, merge into one trace" | Without a cap, a moderately dense topic area collapses into one mega-trace connecting unrelated matters transitively (A~B~C~D~...~Z even though A and Z share nothing), exactly mirroring the old "broad term = enormous posting list" failure. Also breaks determinism/stability if cluster membership depends on non-deterministic traversal order | Cap trace/cluster size, require a minimum pairwise similarity to the trace's centroid (not just to *any* member), and keep the existing continuity-term explanation as a sanity check that a human-reviewable proposal still makes semantic sense |
| Fuzzy/approximate recall that skips exact source attribution ("here's roughly what I remember") | Speed, or "good enough" answers | Directly violates the product's core invariant — "every recalled fact traceable to its source" — and the case-management domain this system serves (legal/professional records) cannot tolerate untraceable recall | Every vector-ranked result must carry the same `sourceSummaryIds`/`sourceTurnRanges` provenance fields as keyword results; if a candidate can't be traced to source turns, it is not eligible for recall regardless of similarity score |
| Per-query full-corpus vector rescans (compute-on-the-fly embeddings for every stored summary at query time) | Simpler to implement — "just embed everything fresh each time you search" | O(corpus) per query, defeats the purpose of persisting embeddings/an index, and reintroduces the exact latency-at-scale problem dogfooding already exposed for other O(n²) hotspots | Persist embeddings at write time (contraction produces the summary → embed then); query time only embeds the *query text* and does an ANN/index lookup, not a corpus scan |
| Global similarity threshold with no lower bound / no minimum cluster size | "Lower the threshold so we don't miss anything" | Low threshold + large corpus reliably produces one dominant cluster absorbing everything (documented failure mode of leader/threshold clustering — cluster count and size are highly threshold-sensitive) | Empirically tune threshold per corpus statistics (e.g. validate against known/reviewed trace pairs), keep the existing `minimumTraceSummaries` and `continuityTerms.length >= 2` gates as independent sanity checks that survive the swap to vectors |
| Cross-person or cross-scope nearest-neighbor search for efficiency ("search across everyone's vectors, filter after") | Tempting for a shared ANN index — one index is operationally simpler than one per person/scope | Filtering *after* the ANN query means the top-K returned by the index may already exclude the correct in-scope results (a scope-restricted true match ranked 50th globally never surfaces if only top-10 raw neighbors are fetched) — this would silently weaken the person/scope/sensitivity boundary that PROJECT.md says "overrides universal recall" | Partition the index (or pre-filter candidate IDs) by person/scope *before* the ANN query, matching the existing `applyRetrievalBoundary`-before-ranking pattern already used in `memory-retriever.ts` |

---

## Incremental Discovery Pattern (Forward-Only Trace Discovery)

The core requirement: **all-pairs must never recur, even at bootstrap-plus-N-years scale.** The pattern below generalizes the "leader clustering" / "streaming agglomerative with threshold" approach that the literature confirms is standard for exactly this problem (see Sources), adapted to this codebase's existing shapes.

### Steady-state (post-bootstrap) daemon cycle

1. **Identify delta, not corpus.** The daemon/scheduler must track "summaries created or materially changed since the trace index was last updated" — a `lastTraceIndexedAt`/dirty-marker per summary or per contraction job, analogous to the existing `proposalDirty`/`lastActivityAt` fields already on `ContractionJob` in `proposal-scheduler.ts`. This is the single biggest change needed: today `createStagingStore` in `proposal-scheduler.ts` restages *all* of a person's summaries every due cycle; that must become "all persisted vectors/index state, plus only the new summaries since last trace-index update."
2. **Embed the new summary** using the configured `Embedder` at summary-creation time (ideally as part of contraction, so it's never a backlog) — one embed call per new summary, O(1) per summary, never O(corpus).
3. **Query top-K nearest neighbors** of the new summary's vector against the *existing* persisted ANN index (not against all other summaries pairwise) — O(log n) to O(√n) depending on index structure, never O(n²) and never all-pairs.
4. **Insert the new vector into the index** (append-only), so the next cycle's queries see it too — never rebuild the whole index from scratch on every cycle.
5. **Link if similarity ≥ threshold.** For each neighbor above the similarity cutoff:
   - If the neighbor already belongs to an existing (proposed or approved) trace, and the new summary meets the *centroid* threshold (not just point-to-point) for that trace, attach it — this becomes a new revision to an existing trace-proposal or a fresh addition to an approved trace, not a brand-new trace.
   - If no neighbor belongs to an existing trace, and the neighbor pair is itself non-contiguous (existing `hasNonContiguousRanges` check) and clears the existing structural gates (`continuityTerms.length >= 2` analog, `minimumTraceSummaries`), propose a *new* trace exactly as today, but discovered via nearest-neighbor lookup instead of shared-term join.
   - If similarity is below threshold for all neighbors, no trace action — the summary just sits in the index for future queries to find.
6. **No re-scan of existing trace pairs.** Existing accepted/rejected traces are not re-evaluated; only the new summary's neighbor set is queried. This mirrors how `hasExistingProposal`/dedup-by-`traceId` already prevents duplicate proposals today, just applied earlier (at candidate-generation time, not just at proposal-emission time).

### Bootstrap (one-time backfill of the existing 135k+ summaries)

- This is the one place an O(n log n)-ish full pass is acceptable — it happens once, is explicitly scoped as backfill work (mirrors the existing `trace-backfill-worker.mjs` / `parallel-trace-backfill.ts` parallel-shard pattern already used for the shared-term algorithm above the `PARALLEL_TRACE_BACKFILL_THRESHOLD` of 20,000 summaries).
- Build the ANN index incrementally even during backfill (insert-then-query per summary in a fixed, deterministic order — e.g. summary ID or creation-timestamp order) rather than "collect all vectors, batch-cluster" — this both (a) reuses the exact same forward-only linking logic as steady-state, avoiding two discovery code paths, and (b) keeps the process resumable/checkpointable like the existing resumable historical bootstrap (PROJECT.md mentions this already exists for import).
- Determinism requirement: process summaries in the *same fixed order* every backfill run (e.g., strictly by summary ID, not by index-internal insertion order or async completion order) so that identical input always yields identical cluster membership and identical `traceId`s — mirrors the existing pattern where `traceId` in `trace-candidate-core.ts` is derived deterministically from shared/continuity terms, not from a random or run-order-dependent value.

### Threshold guidance (cosine similarity, sentence-embedding-style vectors)

- Multiple independent sources converge on **0.65–0.80** as the range where cosine similarity reliably indicates "same topic/story," with 0.70 cited repeatedly as a practical default balancing precision (not missing real matches) against oversegmentation (not over-merging). (MEDIUM confidence — WebSearch-sourced, not project-specific; needs empirical validation against this corpus's chosen embedder before being hardcoded.)
- Because `DeterministicEmbedder` (the current REQ-040-safe fallback) is a hashed bag-of-tokens, not a trained sentence embedding, its cosine similarity distribution will *not* match sentence-transformer literature numbers — if that embedder is kept as the REQ-040-safe default, the threshold must be recalibrated empirically against its own output distribution (e.g., known duplicate/near-duplicate summary pairs vs known-unrelated pairs), not borrowed from sentence-transformer literature. This directly affects the milestone's own "Key open decision" between `DeterministicEmbedder` and a local ONNX sentence-transformer — the choice changes what threshold value is even meaningful.
- To avoid the one-giant-cluster failure: (a) require **centroid** similarity for cluster membership (each candidate summary's similarity to the running centroid of the trace, not merely to one member — this is exactly the leader-clustering pattern and is already structurally close to how `box-proposal-planner.ts`'s greedy grouping maintains a running intersection of terms today), (b) cap maximum trace size or flag oversized proposals for extra review, (c) keep independent structural gates (non-contiguity, minimum distinct source ranges) as belt-and-suspenders checks vectors alone cannot guarantee.
- Determinism/stability: fix tie-breaking (sort candidate neighbors by summary ID on equal similarity, as `rankMemories` already does — `right.score - left.score || left.id.localeCompare(right.id)`), fix floating-point rounding in confidence derived from similarity, and avoid any dependency on hash-map iteration order or worker-thread completion order when merging partial results (the existing `collectTracePartials`/worker-sharding code already solves this for the term-based algorithm by keying partials deterministically — the vector version needs the equivalent discipline).

---

## Semantic Recall — Expected Behavior

Table-stakes shape (per RAG/hybrid-search literature, MEDIUM confidence, cross-checked against multiple sources):

- **Top-K retrieval** with a **minimum similarity floor** — return the best matches above a threshold, not always exactly K items. The existing `MemoryRetriever.selectMemories` caps at 3 and packs by token budget but does not yet reject weak matches below a floor; this should be added when true embeddings are populated.
- **Hybrid keyword+vector, fused by rank not score.** Reciprocal Rank Fusion (RRF), typically at k≈60, combines a keyword-search ranked list and a vector-search ranked list by summed reciprocal rank, sidestepping the fact that BM25-style scores and cosine similarity live on different, incompatible scales. This is described as the dominant production pattern for RAG systems in 2026 sources. The existing code already does something structurally similar per-item (prefer vector score if present, else keyword) — real RRF over two independently-retrieved candidate lists would be a step up (documented as a Differentiator above, not required for parity).
- **Snippet/source attribution is mandatory, not optional** — already a hard product invariant here (`sourceSummaryIds`, `sourceTurnRanges`, `boxIds` on every `InjectionPacket`/`RankedMemory`). Any new vector-recall code path must populate these fields identically to the keyword path; a "vector match" that cannot cite its source summary/turn range should never be returned.
- **Recall respects scope/boundary filtering identically to keyword recall.** This is structurally already true because `applyRetrievalBoundary` runs before `rankMemories` in `memory-retriever.ts` — person, scope, sensitivity boundaries filter the candidate pool *before* any similarity scoring happens. The main risk introduced by vectors is architectural, not logical: if a future ANN index implementation does global (cross-person) nearest-neighbor search for speed and filters results *after* retrieving the top-K, that ordering violates the existing boundary-first pattern and must be avoided (see Anti-Features).

---

## Feature Dependencies

```
Real embeddings populated (backfill + incremental)
    └──requires──> Embedder choice resolved (DeterministicEmbedder vs local ONNX sentence-transformer)
                       └──affects──> Threshold calibration (embedding distribution differs per model)

Local ANN/vector index
    └──requires──> Real embeddings populated
    └──enables──> Forward-only trace discovery (query top-K instead of all-pairs)
    └──enables──> Semantic recall (query-time nearest-neighbor lookup)

Forward-only trace discovery
    └──requires──> Local ANN/vector index
    └──requires──> Delta/dirty tracking per summary (extends existing ContractionJob.proposalDirty pattern)
    └──reuses──> Existing structural gates (non-contiguity check, minimumTraceSummaries, continuityTerms)
    └──reuses──> Existing proposal lifecycle (proposed/accepted/rejected, dedup-by-traceId)

Semantic recall
    └──requires──> Real embeddings populated
    └──reuses──> Existing scope/boundary filtering (applyRetrievalBoundary) — must run BEFORE any ANN query
    └──reuses──> Existing source-attribution fields (sourceSummaryIds, sourceTurnRanges)
    └──enhances──> Existing MemoryRetriever vector-scoring path (already implemented for summaries/anchors, not yet for traces)

Vector-based trace ranking (differentiator)
    └──requires──> Real embeddings populated
    └──enhances──> Semantic recall of traces specifically (rankTrace currently keyword-only)

Hybrid RRF recall (differentiator)
    └──requires──> Semantic recall
    └──enhances──> existing either/or keyword-vs-vector scoring in rankSummary/rankAnchor
```

### Dependency Notes

- **Forward-only trace discovery requires delta/dirty tracking**, which does not fully exist today at the trace-planning granularity — `ContractionJob.proposalDirty` marks whether a *job* is due for staging, but `createStagingStore` still pulls the *entire* person's summary set once staging runs. Adding true incrementality means either (a) persisting the ANN index itself as the source of "already indexed" truth (only summaries missing from the index are new), or (b) adding an explicit `lastTraceIndexedAt` cursor. This is very likely a required sub-task, not an afterthought — without it, "forward-only" is only partially achieved (embedding is O(1) per summary, but the daemon staging step around it may still be O(corpus)).
- **Embedder choice must be resolved early** because it gates threshold calibration for both trace discovery and recall — the milestone cannot ship a hardcoded threshold before this decision, or the threshold will need re-tuning (and possibly re-clustering/re-indexing) if the embedder changes later.
- **Vector-based trace ranking and hybrid RRF recall are explicitly deferrable** (Differentiators, not Table Stakes) — v1.1 can ship with vector-based *discovery* and keyword-scored *trace recall* coexisting, matching how `rankSummary`/`rankAnchor` already gracefully degrade to keyword scoring when embeddings/matching models are absent.

---

## Dependencies on Existing Systems

| Existing system | How the new work depends on / must preserve it |
|---|---|
| `DeterministicTraceProposalPlanner` (`trace-proposal-planner.ts`) | Candidate-generation call (`buildTraceCandidates`) is the swap point; confidence formula, `minimumTraceSummaries`, `continuityTerms.length >= 2` gate, dedup-by-`traceId`, and proposal payload shape should be preserved and fed by vector-discovered candidates instead of term-join candidates |
| `hasNonContiguousRanges` (`trace-proposal-planner.ts`) | Must remain a hard gate after vector clustering — a temporally contiguous cluster of similar summaries is a box, not a trace |
| `ProposalScheduler` / `proposal-scheduler.ts` | The due-cycle/quiet-period/forced-interval scheduling logic can stay, but `createStagingStore`'s "restage all person summaries every due cycle" must be replaced or supplemented with delta-aware staging for the trace step specifically, or the milestone's own goal (no all-pairs post-bootstrap) is undermined by the staging layer even if candidate generation itself is now incremental |
| `MemoryRetriever` / `memory-retriever.ts` | Vector scoring path (`embeddingScore`, provider/model/dimension match check) already exists and should be extended to `rankTrace`, not reimplemented; `applyRetrievalBoundary` must continue to run before any ANN/ranking step for both traces and semantic recall |
| `Embedder` interface / `embedder.ts` | New embedding backfill/incremental population must implement this interface; `cosineSimilarity` is reusable as-is; embedding provider/model/dimensions mismatch-guard logic (`embeddingScore`) is the existing pattern for safe embedder migration and should extend to trace vectors |
| `trace-backfill-worker.mjs` / `parallel-trace-backfill.ts` | The existing parallel-sharding pattern for one-time whole-corpus backfill (already built for the term algorithm, threshold 20,000 summaries) is directly reusable structure for one-time embedding backfill + initial ANN index build — same operational shape, different payload |
| Box proposal system (`box-proposal-planner.ts`) | Not in scope for this milestone per the stated goal, but its existing greedy/running-intersection grouping is architecturally the closest existing analog to leader-style streaming clustering already in this codebase — useful as an internal precedent when implementing vector trace clustering, and worth flagging as a candidate for the *same* vector treatment in a later milestone (explicitly noted as out of scope here) |
| Proposal review UI / accept-reject lifecycle | Fully reused unchanged — trace proposals discovered via vectors still flow through `proposed → accepted/rejected` exactly as today; no anti-feature here is to add an "auto-accept high-confidence vector traces" bypass, which would break the existing human-review invariant |

---

## Open Questions

- **Embedder decision (blocking for threshold work):** `DeterministicEmbedder` (keyword-hash, REQ-040-safe, weak semantics) vs a small local ONNX sentence-transformer (real semantics, REQ-040-safe if fully local/no network, new bundled dependency). This directly determines what similarity threshold is meaningful and whether literature-sourced 0.65–0.80 ranges apply at all. Flagged in PROJECT.md as the milestone's own open decision — this research does not resolve it, only notes its downstream effects.
- **ANN index technology choice**, not investigated in this pass — options range from a simple flat/brute-force scan with a per-summary top-K cap (viable at 100k-scale if queries are batched and the index is in-process) up to a proper HNSW-style structure. Needs its own feasibility/comparison research given REQ-040's "local, no external services" constraint — must confirm any candidate library is embeddable without a server process or network dependency.
- **Exact staging/delta mechanism for the daemon's trace step** — this research identifies the `createStagingStore`-restages-everything gap but does not design the specific cursor/dirty-tracking mechanism; needs a focused design pass against `ContractionJob`/`ContractionCheckpoint` types before implementation.
- **Threshold calibration methodology** — literature gives a starting range (0.65–0.80), but this corpus needs an empirical validation step (e.g., re-run against a sample of already-accepted traces from the old algorithm and confirm the new threshold reproduces similar clusters) before shipping a hardcoded default.
- **Centroid vs pairwise similarity semantics for cluster membership** — this research recommends centroid-based membership to avoid transitive over-merging, but the exact update rule (recompute centroid on every insert? windowed average? weighted by recency?) is an implementation decision requiring its own design, not resolved here.
- **Whether box discovery should eventually receive the same vector treatment** — flagged as an interesting adjacent problem but explicitly out of scope per the milestone framing; worth a note in the roadmap for a possible future milestone rather than folding into v1.1.

## Sources

- [Clustering — Sentence Transformers documentation](https://sbert.net/examples/applications/clustering/README.html) — MEDIUM confidence, official docs for threshold-based/leader-style clustering parameters
- [Text Clustering using Sentence Embeddings (Medium)](https://medium.com/@dingusagar/text-clustering-using-sentence-embeddings-abcb6048fc36) — LOW-MEDIUM confidence, practitioner writeup corroborating 0.6-0.8 range
- General WebSearch synthesis on cosine similarity thresholds for topic-level clustering (0.65-0.80 range, 0.70 as common default) — MEDIUM confidence, multiple independent sources converge
- General WebSearch synthesis on Leader/Hartigan clustering and incremental/streaming clustering algorithms (threshold-based, O(n), single-pass, order-dependent) — MEDIUM confidence, consistent across academic sources (IOSRJEN, ScienceDirect, ResearchGate)
- General WebSearch synthesis on Reciprocal Rank Fusion for hybrid keyword+vector RAG search (RRF at k≈60, rank-based fusion avoids score-scale incompatibility, described as dominant 2026 production pattern) — MEDIUM confidence
- Direct code reading (HIGH confidence, ground truth for this project): `src/traces/trace-candidate-core.ts`, `src/traces/trace-proposal-planner.ts`, `src/boxes/box-proposal-planner.ts`, `src/daemon/proposal-scheduler.ts`, `src/embeddings/embedder.ts`, `src/retrieval/memory-retriever.ts`, `.planning/PROJECT.md`

---
*Feature research for: vector-native trace discovery + semantic recall (v1.1 milestone)*
*Researched: 2026-07-21*
