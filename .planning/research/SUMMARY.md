# Research Summary — v1.1 Vector-Native Traces + Semantic Recall

**Milestone:** v1.1 Vector-Native Traces + Semantic Recall
**Date:** 2026-07-21
**Overall confidence:** MEDIUM-HIGH (Stack MEDIUM-HIGH, Features MEDIUM, Architecture HIGH, Pitfalls MEDIUM-HIGH)
**Sources:** `.planning/research/{STACK,FEATURES,ARCHITECTURE,PITFALLS}.md`

## Executive Summary

This milestone replaces the shared-term all-pairs trace algorithm — combinatorially pathological at 135,366 summaries (~526k candidates from just 8k) — with local vector embeddings + nearest-neighbor-above-threshold discovery, and reuses those embeddings for semantic recall. Hard constraint REQ-040: deterministic, fully local, no external services at runtime.

Converged recommendation: keep the keyword-hash `DeterministicEmbedder` as the always-on default/fallback; add a local ONNX sentence-transformer (`@huggingface/transformers`, 384-dim MiniLM/bge-small/gte-small via `onnxruntime-node`) as an explicit **opt-in adapter** — vendored/one-time-fetched (no implicit daemon network call), CPU-only with pinned thread count + graph-opt level for reproducibility. This mirrors the product's existing boundary: "external models are optional adapters, never a local correctness dependency."

Exact brute-force vector search (not true ANN) is the right choice at this scale: it takes trace discovery from O(n²) to O(n) per query while staying fully deterministic. True ANN (hnswlib/usearch) is deferred until ~500k–1M summaries with measured latency pain, because it would introduce the codebase's only determinism regression (HNSW insertion-order/seed sensitivity).

## Key Findings

1. **Vector-index approach — a genuine open decision (needs your call).**
   - **STACK.md:** `sqlite-vec` native extension — exact brute-force at C speed, but a native binding, and `node:sqlite`'s `DatabaseSync` must be constructed with `{ allowExtension: true }` (cannot be enabled post-construction in Node 24).
   - **ARCHITECTURE.md:** pure-JS brute-force cosine over a dedicated narrow `summary_vectors` Float32-BLOB table — no native-binary risk, exact, deterministic, fast enough at 135k over the narrow table (not the JSON payloads).
   - Both are exact + deterministic at current scale. True ANN deferred.

2. **Embedding model — converged.** Hash embedder stays the default; ONNX sentence-transformer is an opt-in adapter. Determinism: bit-identical for the hash embedder; per-device-stable-but-not-cross-arch-identical for ONNX (IEEE-754/SIMD reduction order) — acceptable because embeddings are recomputed per device, never synced.

3. **Sync — settled (HIGH confidence).** `SyncOperationKind` is a closed enum with no summary/embedding kind; all derived memory is recomputed per device from replicated canonical events. Embeddings MUST follow the same rule — never synced. (ADR 0047 already treats embeddings as a per-device cache.)

4. **Staging/delta — a distinct concern.** The trace pathology is not only the all-pairs join: `proposal-scheduler.ts`'s `createStagingStore` restages the ENTIRE person corpus every due cycle, so a vector swap alone still leaves O(corpus)-per-tick. Delta/dirty-tracking is a separate roadmap item, or "no all-pairs post-bootstrap" is only half-achieved. (Flagged independently by FEATURES + PITFALLS.)

5. **Correctness gap — source deletion.** `commitSourceDeletion` supersedes summaries but has NO embedding-invalidation hook. Source deletion is a shipped feature, so leftover embeddings are a correctness gap (privacy + stale recall), not a nicety. Should be pulled forward (Phase 1 or 3), not left to last.

6. **Determinism guards.** Golden-vector cross-arch hash test; pinned ONNX execution provider (CPU) + fixed thread count + fixed graph-opt level. If any true-ANN ever lands: pinned seed + rebuild-vs-incremental parity test.

7. **Scope-boundary partitioning.** The vector index/search must respect person/workspace/case/sensitivity boundaries at **selection** time. `applyRetrievalBoundary` already runs pre-ranking for recall; a flat global index must NOT filter only post-query (leak risk).

## Roadmap Implications (dependency-ordered, ~8 phases)

1. **Vector Storage Foundation** — `summary_vectors` table + migration; `MemoryStore` methods (`saveSummaryVector`, `getSummaryVector`, `listSummaryIdsMissingVector`, `findNearestSummaries`) in BOTH `SqliteStore` and `InMemoryStore` as exact brute-force (test parity); scope-partitioning + deletion-tombstoning designed in from the start. *(Resolves the sqlite-vec-vs-pure-JS decision — needs research/discuss.)*
2. **Embedding Model Decision + Embedder Implementation** — resolve hash-only vs. ONNX-adapter (record as ADR); pin determinism config; golden-vector cross-arch test; vendoring/one-time-fetch mechanism aligned with Phase-7 guided-init.
3. **Backfill of 135,366 summaries** — reuse `parallel-trace-backfill.ts` worker pattern; checkpointed/resumable `memory backfill-embeddings` CLI; idempotent via `listSummaryIdsMissingVector` set-difference.
4. **Daemon incremental embedding** — new `EmbeddingScheduler`, mirroring `ProposalScheduler`/`ContractionRunner` separation; embeds new summaries per cycle (<10/night typical).
5. **Delta/dirty tracking for the daemon trace step** — closes the `createStagingStore`-restages-everything gap; forward/rewind cost-model split mirroring `contraction-runner`.
6. **Forward-only vector trace discovery** — `buildTraceCandidatesFromNeighbors` + `VectorTraceProposalPlanner` emitting the SAME `TraceCandidate[]` shape (zero change to review/accept flow); star/centroid clustering (not transitive closure → avoids mega-trace collapse); drop the shared-term `continuityTerms.length >= 2` gate; add vector-based rationale replacing keyword explainability; threshold/topK calibrated against the real corpus.
7. **Semantic recall** — swap `MemoryRetriever` candidate selection from `listSummaries()` brute force to top-K pre-filter, before unchanged `applyRetrievalBoundary`; lowest-risk, ships late.
8. **Operator surface + deletion-invalidation closure** — extend `commitSourceDeletion` to tombstone embeddings (correctness gate — candidate to pull earlier); `memory health`/`memory tune` for backfill completeness + model-version skew.

## Research Flags

- **Needs research/discuss:** Phase 1 (sqlite-vec vs. pure-JS BLOB), Phase 2 (exact model pin, quantized-vs-FP32, vendoring), Phase 5/6 (delta cursor design, centroid-update rule, threshold/topK calibration against real 135k corpus).
- **Standard patterns (research likely skippable):** Phase 3 (existing worker/checkpoint patterns), Phase 4 (existing scheduler separation), Phase 7 (`MemoryRetriever` vector scoring already implemented).

## Open Questions for Requirements / Discuss-Phase

- Vector index: `sqlite-vec` (native, faster) vs. pure-JS `summary_vectors` BLOB table (no native risk).
- Embedder default confirmation + exact model pin (MiniLM / bge-small / gte-small) + quantized vs. FP32.
- Similarity threshold + topK calibration against the real corpus.
- Keep the shared-term planner as a transition fallback, or retire it outright?
- Anchor embeddings — likely the same treatment; not yet designed; near-term follow-up, not a v1.1 blocker.
- Where to place the deletion→embedding-invalidation fix (pull forward vs. last).

## Gaps / Caveats

Vector-index storage decision unresolved (by design — a discuss-phase call). Threshold/topK need empirical validation against real data. Cross-arch ONNX bit-identity not guaranteed (mitigated by recompute-per-device). Anchor embeddings deferred.
