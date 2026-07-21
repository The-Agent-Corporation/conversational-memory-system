# Phase 9: Embedding Model + Embedder - Context

**Gathered:** 2026-07-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Resolve and record the milestone's open embedding-model decision, and ship a pinned, deterministic, opt-in local ONNX sentence-transformer embedder — while the keyword-hash `DeterministicEmbedder` remains the always-on default and fallback with zero behavior change for users who take no action (REQ-044, REQ-051). No backfill (Phase 10), no daemon incremental embedding (Phase 11), no trace/recall changes (Phases 12–13).

</domain>

<decisions>
## Implementation Decisions

### Model choice
- **D-01:** Model is **`Xenova/bge-small-en-v1.5`** (ONNX, 384-dim) — chosen over MiniLM-L6-v2 for its better retrieval quality at the same dimensionality. Pin the exact Hugging Face revision/commit hash.
- **D-02:** **fp32 weights** (~130MB), not int8-quantized — keeps same-machine determinism airtight and best quality; disk cost is acceptable for a personal tool.
- **D-03:** **Asymmetric embedding per bge's training recipe:** recall/search *queries* are prefixed with bge's instruction string ("Represent this sentence for searching relevant passages: "); stored *summaries/passages* are embedded bare. Both modes must be pinned, deterministic, and covered by the golden set. The embed API must make the mode explicit (e.g., separate query-vs-passage embed entry points), so Phase 12 (summary-to-summary trace discovery) uses bare-passage mode on both sides, and Phase 13 (semantic recall) uses prefixed-query-vs-bare-passage.

### Opt-in & fallback
- **D-04:** Opt-in is a **persisted config key set via an explicit CLI command** (e.g., `memory embeddings enable`) which also performs the one-time, explicit vendored model install (no implicit runtime downloads — the daemon and MCP server never touch the network). Hash embedder remains the default when no action is taken.
- **D-05:** **Hard error when enabled-but-broken:** if the ONNX embedder is enabled in config but model files are missing or fail to load, embed operations refuse to run (no silent fallback to the hash embedder) — a mixed-provider vector store must never be written by surprise. Recovery is: install the model or revert the config.
- **D-06:** **Daemon semantics for D-05:** the unattended daemon tick *skips* embedding work and marks the embedder **unhealthy in `memory health`**; all other pipeline work (import, contraction, sync) keeps running. CLI paths that embed still hard-error loudly.

### Golden-set CI strategy
- **D-07:** Golden verification uses a **quantized hash**: round each vector component (e.g., to 1e-4) before hashing, producing one committed golden hash stable across CPU architectures (AVX2/AVX-512/Apple Silicon), still catching real model/tokenizer/config drift. Additionally an **exact byte-hash repeat-run test** asserts bit-identical output on the same machine (REQ-051's determinism claim).
- **D-08:** Golden set is a **small committed set of real summary-like texts** (~10–20, including unicode, long-input truncation, and near-empty edge cases), covering BOTH embed modes (bare passage + prefixed query). **CI runs the real model with the model artifact cached** between runs.

### Claude's Discretion
- Model acquisition mechanics beyond D-04 (storage path, e.g. under `~/.memory/models/`; download/verification details; checksum pinning) — follow research recommendation pattern 2 (explicit vendoring, `env.allowRemoteModels = false`, `env.localModelPath`).
- ONNX session pinning specifics: CPU execution provider, fixed `intraOpNumThreads` (1 unless benchmarks justify a fixed higher value), fixed graph-optimization level — per research PITFALLS/STACK guidance and roadmap SC3.
- Provider/model/version provenance string format recorded per vector (must be sufficient for Phase 14 stale-model detection; Phase 8's `summary_vectors` already stores provider/model/dimensions).
- Exact config key naming, CLI command naming, and `memory health` surface details (align with Phase 7 CLI conventions).
- Truncation/max-sequence-length handling (bge-small is 512 tokens) — deterministic and documented.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone research (settled trade-studies this phase implements)
- `.planning/research/STACK.md` — library/model comparison, determinism analysis, vendoring patterns, `@huggingface/transformers` recommendation. NOTE: its sqlite-vec recommendation is SUPERSEDED — Phase 8 landed pure-JS cosine over a `summary_vectors` BLOB table.
- `.planning/research/PITFALLS.md` — ONNX determinism pitfalls (thread count, precision, cross-arch drift).
- `.planning/research/ARCHITECTURE.md` — where the embedder sits in the v1.1 build order.

### Requirements & prior phase
- `.planning/REQUIREMENTS.md` — REQ-044 (local embedding adapter), REQ-051 (embedding determinism), REQ-040 (no external model dependency).
- `.planning/phases/08-vector-storage-foundation/08-VERIFICATION.md` — the shipped vector-store surface this phase's vectors will flow into (write-time validation invariants: dimensions must match vector length; all components finite in float32).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/embeddings/embedder.ts` — `Embedder` interface (`provider`, `model`, `dimensions`, `embed(text)`) and `DeterministicEmbedder` (provider "deterministic", model "keyword-hash-v1", 64-dim). The new `TransformerEmbedder` implements the same interface alongside it; note D-03 requires a query-vs-passage distinction the current single `embed(text)` doesn't express — extend deliberately.
- `src/embeddings/vector-codec.ts` — Float32 BLOB codec from Phase 8 (littleendian DataView, alignment-safe).
- Phase 8 `summary_vectors` store — write-time rejects `dimensions !== vector.length` and non-float32-finite components (`Number.isFinite(Math.fround(v))`); new embedder output must satisfy these invariants.

### Established Patterns
- Constructor injection of `Embedder` into `MemoryRetriever`/`memory-service.ts`; `embeddingScore()` already guards on provider/model/dimensions match before trusting stored vectors — swapping embedders is additive.
- Model loading should initialize the transformers.js pipeline once and reuse it, not per-call (research Integration Points).
- Phase 7 `memory` CLI + `memory health` conventions for the new enable command and health surface.

### Integration Points
- New `src/embeddings/` adapter + config plumbing + CLI command; vectors land in Phase 8's `summary_vectors` via the existing five-method `MemoryStore` vector surface. No sync surface — embeddings are per-device derived cache, never synced (ADR 0047).

</code_context>

<specifics>
## Specific Ideas

- bge instruction prefix (exact string per the bge-small-en-v1.5 model card) applied to queries only — the asymmetric recipe is a deliberate quality choice, accepted with the cost of two pinned embed modes.
- "Enabled-but-broken must never silently write hash vectors" was the driving principle behind D-05's hard-error choice.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 09-embedding-model-embedder*
*Context gathered: 2026-07-21*
