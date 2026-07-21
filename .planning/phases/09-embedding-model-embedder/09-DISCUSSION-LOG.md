# Phase 9: Embedding Model + Embedder - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-21
**Phase:** 09-embedding-model-embedder
**Areas discussed:** Model choice, Opt-in & fallback, Golden-set CI strategy

---

## Model choice

| Option | Description | Selected |
|--------|-------------|----------|
| MiniLM-L6-v2 | 384-dim, ~90MB fp32 / ~23MB quantized, research's recommended pick | |
| bge-small-en-v1.5 | 384-dim, ~130MB fp32 / ~35MB quantized, slightly better MTEB retrieval | ✓ |
| You decide | Leave final call to research/planning within 384-dim family | |

**User's choice:** bge-small-en-v1.5 (chose quality over the recommended smaller default)

| Option | Description | Selected |
|--------|-------------|----------|
| fp32 | ~130MB, airtight same-machine determinism, best quality (recommended) | ✓ |
| int8 quantized (q8) | ~35MB, faster, small quality cost, less-trodden golden-pinning path | |

**User's choice:** fp32

| Option | Description | Selected |
|--------|-------------|----------|
| Symmetric — no prefix | Embed summaries and queries bare; one code path, one golden set (recommended) | |
| Asymmetric — prefix queries | Prefix recall queries per bge's training recipe; two pinned embed modes | ✓ |
| You decide | Benchmark or pick during planning | |

**User's choice:** Asymmetric — prefix queries. Accepted the two-mode pinning/testing cost for retrieval quality.

---

## Opt-in & fallback

| Option | Description | Selected |
|--------|-------------|----------|
| Config + CLI command | Persisted config key set via explicit CLI enable command that also vendors the model (recommended) | ✓ |
| Config file only | Hand-edit config; separate model install step | |
| Guided-init prompt | Offer during `memory init` | |

**User's choice:** Config + CLI command

| Option | Description | Selected |
|--------|-------------|----------|
| Loud fallback | Fall back to hash embedder + health warning (recommended) | |
| Hard error | Refuse to embed until model installed or config reverted | ✓ |
| Silent fallback | Just use hash embedder | |

**User's choice:** Hard error — went stricter than the recommendation; driving principle: never silently write a mixed-provider vector store.

| Option | Description | Selected |
|--------|-------------|----------|
| Skip + unhealthy | Daemon skips embedding that tick, marks embedder unhealthy in `memory health`, rest of pipeline runs (recommended) | ✓ |
| Daemon refuses to start | Fatal at startup | |
| You decide | Planning picks exact semantics | |

**User's choice:** Skip + unhealthy

---

## Golden-set CI strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Quantized hash | Round components (e.g. 1e-4) before hashing — arch-stable single golden hash + exact same-machine byte-hash test (recommended) | ✓ |
| Per-arch golden hashes | One exact hash per CI architecture | |
| Pin CI to one arch | Single exact hash on one pinned runner | |

**User's choice:** Quantized hash

| Option | Description | Selected |
|--------|-------------|----------|
| Small real-text set, cached model | ~10–20 committed texts incl. edge cases; CI caches model artifact (recommended) | ✓ |
| Local-only golden job | Golden runs locally/pre-release only; CI covers hash embedder only | |
| You decide | Planning sizes it | |

**User's choice:** Small real-text set, cached model

## Claude's Discretion

- Model storage path and vendoring mechanics (pattern 2: `env.allowRemoteModels=false`, `env.localModelPath`)
- ONNX session pinning specifics (CPU EP, fixed threads, fixed graph-opt level)
- Provenance string format per vector (Phase 14 stale-model detection)
- Config key / CLI command naming, `memory health` surface details
- Truncation/max-length handling (512-token limit)

## Deferred Ideas

None — discussion stayed within phase scope.
