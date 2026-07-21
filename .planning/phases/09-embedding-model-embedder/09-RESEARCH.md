# Phase 9: Embedding Model + Embedder - Research

**Researched:** 2026-07-21
**Domain:** Local ONNX sentence-transformer embedding (transformers.js + bge-small-en-v1.5), deterministic pinning, opt-in vendoring, golden-vector regression testing
**Confidence:** HIGH (package versions/API surface verified live via `npm view` + npm-packed `.d.ts` source; model pooling/dimension verified via official BAAI model card; transformers.js `env`/pipeline option surface verified via official docs + source-adjacent skill reference)

## Summary

This phase adds a second `Embedder` implementation — `TransformerEmbedder` — that wraps `@huggingface/transformers`' `feature-extraction` pipeline over the pinned `Xenova/bge-small-en-v1.5` ONNX model (fp32, 384-dim), sitting alongside the existing `DeterministicEmbedder` without replacing it as the default. All locked decisions (D-01..D-08) are directly implementable with the verified API surface below: `env.allowRemoteModels`/`env.localModelPath` for zero-implicit-network vendoring, `dtype: "fp32"` for the unquantized weight file, `session_options.executionProviders: ["cpu"]` + `intraOpNumThreads: 1` + `graphOptimizationLevel: "disabled"` for airtight same-machine determinism, and `pooling: "cls"` + `normalize: true` for bge's actual pooling contract (the Xenova model card's copy-pasted usage snippet says `mean` — this is a known generic-template error across many Xenova model cards; BAAI's own `1_Pooling/config.json` for `bge-small-en-v1.5` sets `pooling_mode_cls_token: true` and every other pooling mode `false` — do not trust the snippet).

**Primary recommendation:** Implement `TransformerEmbedder` as a thin, single-pipeline-instance wrapper with two embed methods (`embedPassage(text)` bare, `embedQuery(text)` with the bge instruction prefix), backed by one resident `pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "fp32", device: "cpu", session_options: {...pinned...} })` initialized once at daemon/CLI-command startup and reused for every call — never re-instantiated per embed. Vendor the model via an explicit `memory embeddings enable` command that downloads once with `env.allowRemoteModels = true` (only during that command), verifies file hashes, and writes them under `env.localModelPath`; all other code paths run with `env.allowRemoteModels = false`.

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Model is `Xenova/bge-small-en-v1.5` (ONNX, 384-dim) — chosen over MiniLM-L6-v2 for its better retrieval quality at the same dimensionality. Pin the exact Hugging Face revision/commit hash.
- **D-02:** fp32 weights (~130MB), not int8-quantized — keeps same-machine determinism airtight and best quality; disk cost is acceptable for a personal tool.
- **D-03:** Asymmetric embedding per bge's training recipe: queries prefixed with bge's instruction string ("Represent this sentence for searching relevant passages: "), stored summaries/passages embedded bare. Both modes must be pinned, deterministic, and covered by the golden set. The embed API must make the mode explicit (separate query-vs-passage embed entry points).
- **D-04:** Opt-in is a persisted config key set via an explicit CLI command (e.g., `memory embeddings enable`) which also performs the one-time, explicit vendored model install (no implicit runtime downloads — daemon and MCP server never touch the network). Hash embedder remains default when no action is taken.
- **D-05:** Hard error when enabled-but-broken: if the ONNX embedder is enabled in config but model files are missing or fail to load, embed operations refuse to run (no silent fallback to the hash embedder).
- **D-06:** Daemon semantics for D-05: unattended daemon tick skips embedding work and marks the embedder unhealthy in `memory health`/`memory status`; all other pipeline work keeps running. CLI paths that embed still hard-error loudly.
- **D-07:** Golden verification uses a quantized hash: round each vector component (e.g., to 1e-4) before hashing, one committed golden hash stable across CPU architectures, plus an exact byte-hash repeat-run test asserting bit-identical output on the same machine.
- **D-08:** Golden set is a small committed set of real summary-like texts (~10–20, including unicode, long-input truncation, near-empty edge cases), covering BOTH embed modes. CI runs the real model with the model artifact cached between runs.

### Claude's Discretion

- Model acquisition mechanics beyond D-04 (storage path, e.g. under `~/.memory/models/`; download/verification details; checksum pinning) — follow research recommendation pattern 2 (explicit vendoring, `env.allowRemoteModels = false`, `env.localModelPath`).
- ONNX session pinning specifics: CPU execution provider, fixed `intraOpNumThreads` (1 unless benchmarks justify a fixed higher value), fixed graph-optimization level.
- Provider/model/version provenance string format recorded per vector (must be sufficient for Phase 14 stale-model detection).
- Exact config key naming, CLI command naming, and `memory health` surface details (align with Phase 7 CLI conventions).
- Truncation/max-sequence-length handling (bge-small is 512 tokens) — deterministic and documented.

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-044 | A real semantic embedding model shall be available as an explicit, opt-in local adapter that runs fully offline with no runtime network dependency. The deterministic keyword embedder shall remain the always-on default and fallback. | `env.allowRemoteModels=false` + `env.localModelPath` vendoring pattern (verified below); explicit `memory embeddings enable` CLI command design; hard-error-on-broken wiring in `TransformerEmbedder` construction path; `DeterministicEmbedder` untouched as default `Embedder` binding. |
| REQ-051 | For a fixed embedder configuration, embedding output shall be deterministic and verified by a golden-vector regression test, and vector search results shall be stable for identical inputs. | Pinned `session_options` (CPU-only EP, `intraOpNumThreads: 1`, `graphOptimizationLevel: "disabled"`), pinned fp32 dtype, pinned HF revision; golden-test recipe (quantized-hash + exact byte-hash) below. |

## Project Constraints (from CLAUDE.md)

The user's global `CLAUDE.md` contains only cross-repo tooling/workflow guidance (GSD plugin routing, `bd` issue tracking, session hierarchy) — no project-specific coding/security directives apply to this repo's `./CLAUDE.md`, which does not exist in this working directory (checked: `ls CLAUDE.md` → not found). No additional constraints beyond REQUIREMENTS.md, ADR 0047 (zero-knowledge sync — embeddings are per-device derived state, never synced), and REQ-040 (no external model/service as a runtime correctness dependency).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| ONNX model inference (embed text → vector) | Backend / local process (daemon + CLI, in-process Node) | — | No client/server split in this product; `TransformerEmbedder` runs in whichever Node process calls it (daemon tick, CLI command, MCP server) |
| Model artifact storage/vendoring | Local filesystem (`~/.memory/models/` or equivalent under the existing data dir) | — | REQ-040/D-04 forbid any implicit network tier; vendoring is a one-time explicit CLI-driven filesystem write |
| Config: embedder enabled/disabled | Local config file (sidecar to DB, per existing `tune-command.ts` pattern) | — | Matches Phase 7's `${databasePath}.tune.json` precedent — no new config subsystem needed |
| Vector persistence | Database / Storage (`summary_vectors` table, Phase 8) | — | Phase 8 already owns this; Phase 9 only produces vectors that satisfy Phase 8's write-time invariants (dimensions match, float32-finite) |
| Health/unhealthy signaling | Backend (daemon status snapshot / `memory status`) | — | Phase 7's `DaemonStatusSnapshot`/`MemoryStatusCommandResult` is the existing extensible health surface; D-06 adds an embedder-health field there, not a new subsystem |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@huggingface/transformers` | `4.2.0` [VERIFIED: npm registry, live `npm view` 2026-07-21] | Local ONNX tokenizer + inference pipeline (`feature-extraction`) | Actively maintained successor to `@xenova/transformers` (frozen at 2.17.2 [VERIFIED: npm registry]); bundles the exact tokenizer needed to match model training, avoiding hand-rolled WordPiece tokenization |
| `onnxruntime-node` | `1.27.0` [VERIFIED: npm registry, live `npm view` 2026-07-21] | ONNX Runtime Node native binding, pulled in transitively by `@huggingface/transformers` as its Node backend | Not installed directly — `@huggingface/transformers` selects it automatically in a Node environment (per official backends/onnx doc: "When running in node, we use `onnxruntime-node`"). Its `SessionOptions` type (verified via packed `onnxruntime-common@1.20.1` `.d.ts`) exposes `intraOpNumThreads`, `interOpNumThreads`, `graphOptimizationLevel`, `executionProviders`, `executionMode`, `logSeverityLevel` — this is the exact surface `session_options` passed to `pipeline()` maps onto |

### Model artifact (not an npm package — vendored files)

| Artifact | Repo | Revision | File | Size |
|----------|------|----------|------|------|
| bge-small-en-v1.5 ONNX fp32 | `Xenova/bge-small-en-v1.5` on Hugging Face Hub [ASSUMED: package/repo name from training knowledge + WebFetch, not independently confirmed against an official BAAI/Xenova cross-listing beyond the HF page itself] | Pin the exact commit SHA of `Xenova/bge-small-en-v1.5` main branch at vendoring time — record it in the provenance string (see Code Examples) | `onnx/model.onnx` | 133,093,490 bytes (~127MB) [CITED: huggingface.co/Xenova/bge-small-en-v1.5/tree/main/onnx, fetched 2026-07-21] |
| Tokenizer | same repo | same revision | `tokenizer.json` | 711 kB [CITED: same source] |
| Tokenizer config | same repo | same revision | `tokenizer_config.json` | 366 Bytes [CITED: same source] |
| Special tokens map | same repo | same revision | `special_tokens_map.json` | 125 Bytes [CITED: same source] |
| Model config | same repo | same revision | `config.json` | 683 Bytes [CITED: same source] |
| Vocab (redundant with tokenizer.json, kept for completeness) | same repo | same revision | `vocab.txt` | 232 kB [CITED: same source] |

**Do NOT vendor:** `model_fp16.onnx`, `model_int8.onnx`, `model_uint8.onnx`, `model_quantized.onnx`, `model_q4.onnx`, `model_q4f16.onnx`, `model_bnb4.onnx` — D-02 locks fp32; these quantized variants exist in the same `onnx/` directory and must be excluded from the vendoring step to avoid an operator accidentally shipping the wrong dtype file.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@huggingface/transformers` | `@xenova/transformers` (legacy) | Frozen/unmaintained package name; superseded — do not use for new code |
| bge-small-en-v1.5 fp32 | bge-small-en-v1.5 quantized (`model_quantized.onnx`, ~34MB) | D-02 explicitly rejects this — quantization introduces additional numerical deviation beyond CPU-reduction-order noise, which is unacceptable given the determinism goal |
| Direct `onnxruntime-node` usage | — | Would require hand-rolling WordPiece tokenization to exactly match bge's training-time tokenizer; transformers.js is the correct layer specifically to avoid this risk |

**Installation:**
```bash
npm install @huggingface/transformers@4.2.0
```
`onnxruntime-node` is a transitive dependency (do not add it to `package.json` directly — pinning happens implicitly via `@huggingface/transformers`'s own dependency pin; verify the resolved version with `npm ls onnxruntime-node` after install and record it in provenance for reproducibility).

**Version verification:** Confirmed live against the npm registry 2026-07-21:
```
$ npm view @huggingface/transformers version
4.2.0
$ npm view onnxruntime-node version
1.27.0
$ npm view onnxruntime-node os
[ 'win32', 'darwin', 'linux' ]
```
No `cpu` architecture restriction returned by `npm view onnxruntime-node cpu` (empty — meaning no arch allowlist filter is applied at the npm package level; prebuilt binaries are resolved via a postinstall/platform-package mechanism, not blocked by `os`/`cpu` fields alone). This project's target platforms (macOS arm64 per repo's dev environment; Linux x64 for CI) are both listed. [VERIFIED: npm registry]

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `@huggingface/transformers` | npm | Actively published line since 2024, current 4.2.0 published within the last month per registry metadata pattern observed for sibling `onnxruntime-node` publish cadence | High (widely used successor to `@xenova/transformers`, official Hugging Face org package) | `github.com/huggingface/transformers.js` | not run (see below) | Approved [ASSUMED — slopcheck not run this session, see gate note] |
| `onnxruntime-node` | npm | Long-running Microsoft-maintained package, current 1.27.0 published ~1 month ago per registry metadata | Very high (official Microsoft ONNX Runtime Node binding) | `github.com/microsoft/onnxruntime` | not run (see below) | Approved [ASSUMED — slopcheck not run this session] |

**slopcheck gate status:** `pip install slopcheck` was not attempted in this research session — this phase's only new runtime dependency is `@huggingface/transformers` (transitively `onnxruntime-node`), both of which are unambiguously legitimate, long-established, officially-maintained packages (Hugging Face org and Microsoft org respectively) verifiable by direct `npm view` registry inspection and cross-referenced against their canonical GitHub source repos. Per the graceful-degradation rule, both packages are marked `[ASSUMED]` rather than `[VERIFIED]` pending an actual slopcheck run, and **the planner must gate the `npm install @huggingface/transformers` step behind a `checkpoint:human-verify` task** even though the practical hallucination/slopsquat risk is near-zero for these two specific, well-known packages.

**Packages removed due to slopcheck [SLOP] verdict:** none (slopcheck not run).
**Packages flagged as suspicious [SUS]:** none identified from manual inspection, but formally unverified — see gate status above.

**Postinstall check (Node.js phases, Step 4 of gate):**
```
$ npm view onnxruntime-node scripts.postinstall
install
```
`onnxruntime-node` does declare an `install` script (standard for downloading/selecting the correct prebuilt native binary per platform — this is expected and well-documented behavior for native-binding npm packages, not a red flag on its own). No `postinstall` script was returned for `@huggingface/transformers`. The `onnxruntime-node` install step is itself a **network operation at `npm install` time**, not at model-embed runtime — it fetches the native binding for the current platform from npm's own registry/CDN infrastructure (standard npm package installation, not a "call home" pattern distinct from any other native npm dependency). This is a one-time, developer/CI-time network dependency (already implicitly true of every `npm install` in this project) and is distinct from — and does not violate — REQ-040's "no runtime network dependency" (REQ-040 concerns the running product's behavior, not `npm install`).

## Architecture Patterns

### System Architecture Diagram

```
                     ┌─────────────────────────────┐
                     │  memory embeddings enable    │   (explicit CLI, one-time)
                     │  (CLI command, network ON)   │
                     └──────────────┬───────────────┘
                                    │ 1. env.allowRemoteModels = true (scoped to this command only)
                                    │ 2. pipeline() triggers HF Hub fetch of pinned revision
                                    │ 3. verify file hashes against pinned manifest
                                    ▼
                     ┌─────────────────────────────┐
                     │ ~/.memory/models/            │  <- vendored model files land here
                     │   bge-small-en-v1.5/          │     (localModelPath root)
                     │     onnx/model.onnx            │
                     │     tokenizer.json, config.json│
                     └──────────────┬───────────────┘
                                    │ 4. write config key: embeddings.enabled = true,
                                    │    embeddings.provider/model/revision
                                    ▼
                     ┌─────────────────────────────┐
                     │ Sidecar config file           │  (e.g. ${databasePath}.embeddings.json,
                     │ (Phase 7 tune-command pattern)│   mirrors tune-command's own sidecar)
                     └──────────────┬───────────────┘
                                    │ read at every embedder-consuming process startup
                                    ▼
        ┌───────────────────────────────────────────────────────────┐
        │ Embedder resolution (daemon tick / CLI embed path / MCP)    │
        │                                                               │
        │  config.embeddings.enabled == false  ──► DeterministicEmbedder│
        │                                             (always-on default)│
        │  config.embeddings.enabled == true                            │
        │     │                                                          │
        │     ├─ model files present + hash-valid ──► TransformerEmbedder│
        │     │      (env.allowRemoteModels=false, env.localModelPath=…, │
        │     │       dtype:"fp32", session_options pinned)              │
        │     │                                                          │
        │     └─ model files missing/broken                              │
        │            ├─ CLI embed path  ──► hard error, exit non-zero (D-05)
        │            └─ daemon tick     ──► skip embed step, mark          │
        │                                    embedder unhealthy in         │
        │                                    memory status (D-06)          │
        └───────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                     embed(text) → Embedding{provider, model, dimensions, vector, createdAt}
                                    │
                                    ▼
                     Phase 8 summary_vectors write path
                     (write-time invariants: dimensions === vector.length,
                      every component float32-finite)
```

### Recommended Project Structure

```
src/embeddings/
├── embedder.ts                 # existing: Embedder interface, DeterministicEmbedder, cosineSimilarity (UNCHANGED)
├── transformer-embedder.ts     # NEW: TransformerEmbedder implements Embedder + QueryEmbedder-like extension
├── embedder-resolver.ts        # NEW: reads embeddings config, returns DeterministicEmbedder or TransformerEmbedder, or throws (D-05)
├── model-vendor.ts             # NEW: one-time fetch + hash-verify + write-to-localModelPath logic used by the CLI command
└── vector-codec.ts             # existing, unchanged (Phase 8)

src/operations/ or src/cli-adjacent location matching Phase 7 conventions
└── embeddings-enable-command.ts   # NEW: `memory embeddings enable` subcommand, registered in src/cli/command-registry.ts
```

### Pattern 1: Explicit query-vs-passage embed interface (D-03)

**What:** Extend (not replace) the existing single-method `Embedder` interface with an explicit two-mode surface. The safest approach that keeps `DeterministicEmbedder` conformant with zero behavior change is a new, wider interface that `DeterministicEmbedder` also implements trivially (its passage and query embed are identical, since the hash embedder has no asymmetric recipe).

**When to use:** Any embed call site must decide up front whether it is embedding a stored passage (summary) or a search query, per D-03 and per Phase 12/13's stated consumption pattern (Phase 12: bare-passage both sides; Phase 13: prefixed-query vs. bare-passage).

**Example:**
```typescript
// src/embeddings/embedder.ts — proposed additive interface (extends, does not replace, Embedder)
export interface Embedder {
  provider: string;
  model: string;
  dimensions: number;
  /** Embeds text as a stored passage/summary (bare, no instruction prefix). */
  embed(text: string): Promise<Embedding>;
}

// NEW in transformer-embedder.ts (or embedder.ts if kept together) — opt-in extension surface.
// Embedders that support asymmetric query/passage embedding implement this; callers
// that need query-mode embedding check for it explicitly (avoids widening every existing
// call site's contract for embedders — like DeterministicEmbedder — that have no asymmetry).
export interface AsymmetricEmbedder extends Embedder {
  /** Embeds text as a search query (bge instruction-prefixed). */
  embedQuery(text: string): Promise<Embedding>;
}

export function isAsymmetricEmbedder(embedder: Embedder): embedder is AsymmetricEmbedder {
  return typeof (embedder as Partial<AsymmetricEmbedder>).embedQuery === "function";
}
```
This mirrors the codebase's existing preference for explicit, closed contracts (`MemoryStore`'s one-named-method-per-capability style) rather than a boolean flag threaded through `embed(text, { mode: "query" | "passage" })`, and keeps `DeterministicEmbedder`'s existing signature and every existing call site untouched — `DeterministicEmbedder` simply never implements `AsymmetricEmbedder`, and `embed()` alone remains its passage-equivalent (both modes are identical for it, so no behavior is lost by not exposing `embedQuery`).

**Alternative considered and rejected:** widening `embed(text: string, mode?: "query" | "passage")` on the base interface — rejected because it forces `DeterministicEmbedder` and every mock/test embedder to accept a parameter that means nothing for lexical hashing, and makes it silently possible to call `embed(text, "query")` on `DeterministicEmbedder` and get an unprefixed (i.e., subtly wrong-shaped for the *intent*, if a caller assumes query mode changes something) result rather than a type-level guarantee that only asymmetric embedders expose query mode at all.

### Pattern 2: Explicit, single-pipeline-instance initialization

**What:** `TransformerEmbedder` constructs its `pipeline()` once (async factory, not constructor — pipeline init is async) and holds the resolved pipeline for the lifetime of the embedder instance; every `embed()`/`embedQuery()` call reuses it.

**When to use:** Every process that embeds (daemon tick, CLI embed-invoking command, MCP server if it ever embeds directly) must construct `TransformerEmbedder` once at startup, not per-call — repeated `pipeline()` calls reload the ONNX session from disk every time, which is both slow and does not change the determinism story but wastes I/O and memory churn.

**Example:**
```typescript
// src/embeddings/transformer-embedder.ts
import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { Embedder, AsymmetricEmbedder } from "./embedder.js";
import type { Embedding } from "../domain/types.js";

const QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: ";
// [CITED: huggingface.co/Xenova/bge-small-en-v1.5 model card usage example, fetched 2026-07-21;
//  matches BAAI/bge-small-en-v1.5's documented asymmetric retrieval instruction]

export interface TransformerEmbedderOptions {
  localModelPath: string; // e.g. `${dataDir}/models`
  /** HF revision pinned at vendoring time; recorded in provenance, NOT used to re-resolve remotely (allowRemoteModels stays false here). */
  revision: string;
  createdAt?: () => string;
}

export class TransformerEmbedder implements AsymmetricEmbedder {
  readonly provider = "onnx-transformers";
  readonly model = "Xenova/bge-small-en-v1.5";
  readonly dimensions = 384;

  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
  private readonly revision: string;
  private readonly createdAt: () => string;

  constructor(private readonly options: TransformerEmbedderOptions) {
    this.revision = options.revision;
    this.createdAt = options.createdAt ?? (() => new Date().toISOString());
  }

  /** Call once at process startup; throws (D-05 hard error) if model files are missing/broken. */
  async init(): Promise<void> {
    env.allowRemoteModels = false;
    env.localModelPath = this.options.localModelPath;
    // pipeline() resolves + loads immediately; awaiting here surfaces load failures at
    // startup (init()) rather than at the first embed() call, per D-05's "refuse to run" intent.
    this.pipelinePromise = pipeline("feature-extraction", this.model, {
      revision: this.revision,
      dtype: "fp32",
      device: "cpu",
      session_options: {
        executionProviders: ["cpu"],
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        graphOptimizationLevel: "disabled",
        executionMode: "sequential"
      }
    });
    await this.pipelinePromise; // force eager failure, not lazy-on-first-embed
  }

  async embed(text: string): Promise<Embedding> {
    return this.runPipeline(text);
  }

  async embedQuery(text: string): Promise<Embedding> {
    return this.runPipeline(QUERY_INSTRUCTION + text);
  }

  private async runPipeline(text: string): Promise<Embedding> {
    if (!this.pipelinePromise) {
      throw new Error("TransformerEmbedder.init() must be called and awaited before embed()");
    }
    const extractor = await this.pipelinePromise;
    const output = await extractor(text, { pooling: "cls", normalize: true });
    // bge-small-en-v1.5 uses CLS-token pooling (BAAI's own 1_Pooling/config.json:
    // pooling_mode_cls_token=true, all other modes false) — NOT the "mean" pooling shown
    // in some copy-pasted Xenova usage snippets. Verified against BAAI/bge-small-en-v1.5's
    // official SentenceTransformers config, not the (generic-template, incorrect-for-this-
    // model) Xenova model card example. [CITED, cross-verified against 2 sources]
    return {
      provider: this.provider,
      model: `${this.model}@${this.revision}`, // provenance: model+revision joined (see Provenance section)
      dimensions: this.dimensions,
      vector: Array.from(output.data as Float32Array),
      createdAt: this.createdAt()
    };
  }
}
```

### Pattern 3: Vendoring (explicit, one-time, hash-verified)

**What:** `memory embeddings enable` is the *only* code path that ever sets `env.allowRemoteModels = true`. It runs once, resolves the pinned revision, downloads the exact fp32 file set (not the quantized variants), verifies each file's content hash against a manifest pinned in source, writes them to `localModelPath`, then writes the config key that flips `TransformerEmbedder` on for all future process starts (which always run with `allowRemoteModels = false`).

**Example:**
```typescript
// src/embeddings/model-vendor.ts
import { env, pipeline } from "@huggingface/transformers";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// Pin revision + expected file hashes at implementation time (planner/implementer records
// the actual resolved commit SHA + sha256 of each downloaded file here after a real fetch —
// placeholder values below, MUST be filled from a live vendoring run, not guessed).
export const BGE_SMALL_EN_V1_5_MANIFEST = {
  repo: "Xenova/bge-small-en-v1.5",
  revision: "<PIN AT IMPLEMENTATION TIME — exact commit SHA>",
  files: {
    "onnx/model.onnx": { sha256: "<PIN>", bytes: 133_093_490 },
    "tokenizer.json": { sha256: "<PIN>", bytes: 711_000 },
    "tokenizer_config.json": { sha256: "<PIN>" },
    "special_tokens_map.json": { sha256: "<PIN>" },
    "config.json": { sha256: "<PIN>" }
  }
} as const;

export async function vendorModel(localModelPath: string): Promise<void> {
  env.allowRemoteModels = true; // scoped to this function only — never set globally elsewhere
  env.localModelPath = localModelPath;
  try {
    // Triggers download + local cache write via transformers.js's own resolution/cache logic.
    await pipeline("feature-extraction", BGE_SMALL_EN_V1_5_MANIFEST.repo, {
      revision: BGE_SMALL_EN_V1_5_MANIFEST.revision,
      dtype: "fp32"
    });
  } finally {
    env.allowRemoteModels = false; // restore the safe default immediately after this one-time op
  }
  await verifyManifest(localModelPath);
}

async function verifyManifest(localModelPath: string): Promise<void> {
  for (const [relPath, expected] of Object.entries(BGE_SMALL_EN_V1_5_MANIFEST.files)) {
    const bytes = await readFile(`${localModelPath}/${BGE_SMALL_EN_V1_5_MANIFEST.repo}/${relPath}`);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== expected.sha256) {
      throw new Error(`Model file integrity check failed for ${relPath}: expected ${expected.sha256}, got ${actualHash}`);
    }
  }
}
```

**Note on manifest hashes:** This research cannot produce real sha256 hashes without performing the actual multi-hundred-MB download in this session (out of scope for research; the planner/implementer must run the real vendoring flow once, capture the resulting file hashes, and commit them into the manifest — this is a concrete, mechanical implementation step, not an open design question).

### Anti-Patterns to Avoid

- **Re-instantiating `pipeline()` per embed call:** reloads the ~130MB ONNX session from disk every call — extremely slow and unnecessary; always hold one resident pipeline instance for the process lifetime.
- **Leaving `session_options` unset:** the transformers.js/ONNX Runtime default is `executionProviders: ["wasm"]` with unset/auto thread count and `graphOptimizationLevel: "all"` — none of these are safe defaults for this phase's determinism requirement; every field in Pattern 2's `session_options` block must be explicit.
- **Trusting the Xenova model-card usage snippet's `pooling: "mean"` verbatim:** confirmed wrong for this specific model (see Pattern 2 code comment) — always cross-check pooling mode against the base model's own `1_Pooling/config.json`, not the transformers.js wrapper repo's generic example.
- **Setting `env.allowRemoteModels = true` anywhere outside the vendoring command:** any embed-time code path that can reach the network violates D-04/REQ-040 even if it never actually triggers a fetch in practice (e.g., because the model is already cached) — the flag itself must be `false` for every process except the one-shot enable command.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| WordPiece/BPE tokenization matching bge's training-time tokenizer | Custom tokenizer | `@huggingface/transformers`'s bundled tokenizer, loaded from the vendored `tokenizer.json` | Off-by-one truncation or special-token handling silently degrades embedding quality without erroring — the exact Pitfall 12 mitigation this research inherited from PITFALLS.md |
| ONNX model file download/caching/resolution logic | Custom HTTP fetch + cache-dir management | `@huggingface/transformers`'s `env`/`pipeline()` resolution machinery (`localModelPath`, `cacheDir`, `allowRemoteModels`) | Already handles revision pinning, local-vs-remote resolution, and file layout conventions matching the HF Hub's model repo structure |
| Vector normalization / pooling math | Custom mean/cls pooling + L2 normalize implementation | `extractor(text, { pooling: "cls", normalize: true })` pipeline option | transformers.js's pipeline already implements both pooling strategies and normalization correctly and matches the reference PyTorch/sentence-transformers behavior the model was validated against |

**Key insight:** Every hand-rolled alternative in this table risks a subtle numerical or tokenization mismatch versus the model's training-time reference implementation — exactly the kind of drift that would silently break the golden-vector determinism test (D-07/REQ-051) without an obvious symptom, since a "close but wrong" tokenization still produces *some* vector, just not the correct or golden one.

## Common Pitfalls

### Pitfall 1: Trusting the Xenova model-card pooling snippet

**What goes wrong:** The example usage code on `Xenova/bge-small-en-v1.5`'s Hugging Face page shows `{ pooling: 'mean', normalize: true }`. This is generic boilerplate reused across many Xenova model cards and is **incorrect** for bge-small-en-v1.5 specifically — BAAI's own `1_Pooling/config.json` for this model sets `pooling_mode_cls_token: true` with every other pooling mode `false`.
**Why it happens:** Xenova's model-card generation appears templated across many converted models; the pooling field in the example snippet is not always updated per-model.
**How to avoid:** Use `pooling: "cls"` explicitly (as pinned in this research and in D-03's context), and add this exact fact as an inline code comment (Pattern 2 above already does this) so a future maintainer doesn't "fix" it back to `mean` by copying the model card.
**Warning signs:** Golden-vector hash mismatch after any refactor that touches the `extractor()` call options; retrieval quality noticeably worse than expected for a model marketed as strong on MTEB.

### Pitfall 2: ONNX Runtime determinism is same-machine only, not cross-arch — but D-07's golden test design already accounts for this

**What goes wrong:** Floating-point reduction order in matmul/softmax is not guaranteed identical across CPU microarchitectures (AVX2 vs AVX-512 vs Apple Silicon NEON) even with `intraOpNumThreads` pinned to 1 on both machines, because the *compiler-generated kernel* for a given ONNX Runtime build can differ by CPU feature detection, not just thread count.
**Why it happens:** ONNX Runtime auto-detects available CPU instruction sets (AVX2/AVX-512/NEON) at runtime and may dispatch to different optimized kernels per machine, independent of the `session_options` fields this research pins.
**How to avoid:** This is exactly why D-07 locks a two-tier test: (1) an exact byte-hash test asserting bit-identical repeat-runs *on the same machine* (this bound is airtight given the pinned `session_options`), and (2) a *quantized*-hash golden test (round to 1e-4) that tolerates legitimate cross-arch float noise while still catching real model/tokenizer/config drift. Do not attempt to make the quantized-hash test bit-exact across architectures — that is not achievable with fp32 CPU inference and D-07 already designed around this constraint.
**Warning signs:** CI green on one runner architecture, red on another for the *quantized*-hash test specifically (would indicate the rounding precision, currently 1e-4, is too tight for real cross-arch noise and needs loosening, or — more likely — a genuine determinism regression such as a `session_options` field silently reverting to a default).

### Pitfall 3: Lazy pipeline initialization defers D-05's hard-error to first embed instead of process startup

**What goes wrong:** If `pipeline()` is only invoked lazily on the first `embed()` call rather than eagerly in an `init()` awaited at process/command startup, a broken/missing model installation surfaces as a failure deep inside whatever workflow happened to call embed first (e.g., mid-daemon-tick or mid-MCP-response) rather than at a clean, diagnosable startup boundary.
**Why it happens:** `pipeline()` is async and it's tempting to store the promise and only `await` it inside `embed()`.
**How to avoid:** Pattern 2 above awaits pipeline construction inside an explicit `init()` method called once at startup; every consuming process (daemon, CLI embed command, MCP server) must call and await `init()` before doing any other embedder-dependent work, and must handle the thrown error per D-05 (CLI hard-errors) / D-06 (daemon marks unhealthy + skips, does not crash the whole tick).
**Warning signs:** A daemon crash-loop instead of a clean "unhealthy" status when the model is missing; a CLI command that appears to hang or fail with a confusing stack trace deep in embedding logic rather than a clear "model not installed, run `memory embeddings enable`" message at the top.

### Pitfall 4: 512-token truncation silently changes vector determinism if truncation strategy isn't pinned

**What goes wrong:** bge-small-en-v1.5 has a 512-token max sequence length (confirmed via BAAI's model card metadata — max sequence length 512). transformers.js's tokenizer applies truncation automatically for inputs exceeding this, but *how* it truncates (tail-truncate vs. error vs. a configurable `truncation`/`max_length` pipeline option) affects the resulting vector for any long summary — if this isn't pinned/documented, a summary near the boundary could embed differently after a transformers.js version bump changes default truncation behavior.
**Why it happens:** Truncation defaults are a tokenizer-library-version-dependent detail, not something visible from the pipeline() call site unless explicitly set.
**How to avoid:** Explicitly pass truncation options to the `extractor()` call (verify exact option name against the installed `@huggingface/transformers@4.2.0`'s `FeatureExtractionPipeline`/tokenizer call signature during implementation — the general pattern is `{ truncation: true, max_length: 512 }` or equivalent per the underlying `AutoTokenizer` call options) rather than relying on whatever the library's current default is, and include at least one golden-set text (D-08 already requires "long-input truncation" coverage) specifically near/over the 512-token boundary so any truncation-behavior drift is caught by the golden test.
**Warning signs:** Golden-vector mismatch isolated to only the long-input golden text after a dependency bump, while short texts remain stable.

### Pitfall 5: Daemon process memory footprint of a resident pipeline

**What goes wrong:** Holding one resident `TransformerEmbedder` pipeline in the daemon process adds the ONNX session's resident memory (model weights + ORT session buffers) to the daemon's baseline RSS for the daemon's entire lifetime, even during ticks that embed zero or few new summaries — at fp32 130MB model size, this is a non-trivial but bounded (not scale-dependent) fixed cost, distinct from and much smaller than the "loading all vectors into memory" scale trap flagged in PITFALLS.md Pitfall 3 (that pitfall is about corpus-size-scaling memory, not this phase's fixed per-model cost).
**Why it happens:** Easy to conflate "small per-call cost" with "no memory cost" — a resident ONNX session for a ~130MB fp32 model plus ORT's own working buffers is a real, constant memory floor for any process that keeps `TransformerEmbedder` initialized.
**How to avoid:** Document the expected fixed memory floor (order of magnitude: 150-300MB resident, actual number should be measured during implementation, not assumed) as an accepted cost of enabling the feature (opt-in per D-04, so this cost is only paid by users who explicitly enable it); do not initialize `TransformerEmbedder` in the daemon process at all when `embeddings.enabled` is false — daemon startup must only construct/hold the pipeline when the feature is on, never unconditionally probe/preload it "just in case."
**Warning signs:** Daemon RSS jumps by a fixed amount immediately after enabling embeddings, independent of corpus size or tick activity — expected and acceptable; flag only if it grows further over the daemon's lifetime (a leak, not the expected fixed floor).

## Code Examples

### Golden-test recipe (D-07, D-08)

```typescript
// tests/embeddings/transformer-embedder.golden.test.ts
// Pattern: mirrors this repo's existing vitest conventions (see tests/storage/summary-vectors.test.ts
// for the parity-test style: toEqual for exact assertions, explicit reject/accept tables).
import { describe, expect, it, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { TransformerEmbedder } from "../../src/embeddings/transformer-embedder.js";

// D-08: 10-20 committed real summary-like texts, covering both embed modes, including
// unicode, long-input truncation (near/over 512 tokens), and near-empty edge cases.
// Store as a committed fixture file, not inlined — e.g. tests/fixtures/embedding-golden-set.json
import goldenTexts from "../fixtures/embedding-golden-set.json" with { type: "json" };
// shape: Array<{ id: string; text: string; mode: "passage" | "query" }>

// D-07: committed golden hash(es), one per (mode) or per-text — implementer decides
// granularity; the manifest below assumes one committed hash per golden text.
import goldenHashes from "../fixtures/embedding-golden-hashes.json" with { type: "json" };
// shape: Record<string /* goldenText.id */, string /* quantized-vector sha256 hex */>

function quantizedHash(vector: number[], precision = 4): string {
  // D-07: round each component to a fixed decimal precision before hashing, absorbing
  // legitimate cross-arch float noise while still catching real drift.
  const rounded = vector.map((v) => v.toFixed(precision)).join(",");
  return createHash("sha256").update(rounded).digest("hex");
}

function exactByteHash(vector: number[]): string {
  // Bit-identical repeat-run assertion — same machine, same process run.
  const buffer = new Float32Array(vector).buffer;
  return createHash("sha256").update(Buffer.from(buffer)).digest("hex");
}

describe("TransformerEmbedder golden-vector regression (REQ-051)", () => {
  let embedder: TransformerEmbedder;

  beforeAll(async () => {
    embedder = new TransformerEmbedder({
      localModelPath: process.env.MEMORY_MODEL_PATH ?? "tests/fixtures/models",
      revision: "<pinned revision — matches BGE_SMALL_EN_V1_5_MANIFEST.revision>"
    });
    await embedder.init();
  });

  it.each(goldenTexts)("quantized-hash golden match: $id ($mode)", async ({ id, text, mode }) => {
    const embedding = mode === "query" ? await embedder.embedQuery(text) : await embedder.embed(text);
    const hash = quantizedHash(embedding.vector);
    expect(hash).toBe(goldenHashes[id]); // stable across CPU architectures per D-07
  });

  it("exact byte-hash is identical across repeated runs on this machine (REQ-051 determinism claim)", async () => {
    const [first, second] = await Promise.all([
      embedder.embed(goldenTexts[0].text),
      embedder.embed(goldenTexts[0].text)
    ]);
    expect(exactByteHash(second.vector)).toBe(exactByteHash(first.vector));
  });
});
```

**CI model caching:** cache the vendored model directory (`~/.memory/models/Xenova/bge-small-en-v1.5/` or the test-scoped equivalent under `tests/fixtures/models/`) between CI runs keyed by the pinned revision string (e.g. GitHub Actions `actions/cache` with key `embedding-model-${{ hashFiles-equivalent-of-pinned-revision }}`), so CI does not re-download ~130MB on every run — D-08 explicitly requires "CI runs the real model with the model artifact cached." The cache key must include the pinned revision so a future model-version bump invalidates the cache automatically rather than silently testing against a stale cached artifact.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `@xenova/transformers` (v2.x) | `@huggingface/transformers` (v3+/4.x) | Package renamed/moved under the official Hugging Face npm org; `@xenova/transformers` is now the frozen legacy line | Use `@huggingface/transformers@4.2.0` for all new code; do not add `@xenova/transformers` as a dependency |

**Deprecated/outdated:** None directly relevant beyond the package rename above — no other API surface used in this phase (env config, pipeline options, session_options) has a documented deprecation as of the versions verified in this research.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `Xenova/bge-small-en-v1.5` is the correct, canonical package/repo name matching D-01's pinned model choice (as opposed to a differently-cased or differently-orgized repo name) | Standard Stack, Code Examples | If the repo name is subtly wrong, `pipeline()` resolution fails cleanly at vendoring time (a loud, immediately-diagnosable error, not a silent wrong-model substitution) — low practical risk despite the [ASSUMED] tag, but formally unverified beyond a single WebFetch of the HF page in this session |
| A2 | slopcheck was not run against `@huggingface/transformers` / `onnxruntime-node` in this research session | Package Legitimacy Audit | Per the package legitimacy protocol, both packages are marked [ASSUMED] rather than [VERIFIED] and the planner must add a `checkpoint:human-verify` before the `npm install` step, even though both are extremely well-established, officially-org-maintained packages verified live against the npm registry |
| A3 | Exact sha256 file hashes for the vendored model files are placeholders (`<PIN>`) in the Pattern 3 code example, not real values | Architecture Patterns (Pattern 3) | The planner/implementer must run the actual vendoring flow once and capture real hashes before this manifest is usable — this is flagged explicitly in-line in the code example, not left implicit |
| A4 | The exact bge query instruction string ("Represent this sentence for searching relevant passages: ") is correctly transcribed from the model card fetch in this session and matches the string already locked in D-03's CONTEXT.md verbatim | Code Examples (Pattern 2) | If subtly mistyped, would cause the golden-vector query-mode hash to mismatch immediately upon first test run — a loud, immediately-diagnosable failure, not silent drift |
| A5 | The precise TypeScript option name(s) for pinning truncation/max_length on `@huggingface/transformers@4.2.0`'s `FeatureExtractionPipeline` tokenizer call were not independently confirmed against the exact 4.2.0 source in this session (Pitfall 4) | Common Pitfalls (Pitfall 4) | Implementer must verify the exact option name/shape directly against the installed package's types (`node_modules/@huggingface/transformers/types/...`) or Context7 during implementation, not assume the sketched `{ truncation: true, max_length: 512 }` shape is exact |

**If this table is empty:** N/A — see entries above; none of these assumptions touch the phase's locked decisions (D-01..D-08), only implementation-mechanical details (exact repo-name casing, real file hashes, exact tokenizer option name) that resolve deterministically and loudly (via install/test failure) if wrong, rather than silently.

## Open Questions

None blocking planning. The two smallest open items are implementation-mechanical, not design decisions, and are already captured in the Assumptions Log:

1. **Exact real sha256 hashes for the vendored model file manifest (A3)** — resolved automatically the first time the vendoring flow is actually run against the live Hugging Face Hub; the planner should include a task to run the real fetch once, capture the hashes, and commit them, rather than treating this as an open design question.
2. **Exact truncation/max_length option name on the installed `@huggingface/transformers@4.2.0` tokenizer call (A5)** — resolved by reading the installed package's own `.d.ts` during implementation (the same technique used successfully in this research to confirm `onnxruntime-common`'s `SessionOptions` fields); not a design ambiguity, a five-minute implementation-time lookup.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | `@huggingface/transformers` / `onnxruntime-node` Node backend | ✓ | v24.7.0 [VERIFIED: `node --version`, this session] | — |
| npm registry access (install-time only) | `npm install @huggingface/transformers` | ✓ (assumed — standard dev/CI environment; not independently re-probed this session since `npm view` calls above already succeeded against the live registry) | — | — |
| `onnxruntime-node` prebuilt binary for macOS arm64 (dev machine) | Native ONNX inference at runtime | ✓ (macOS listed in package's `os` field: `['win32','darwin','linux']` [VERIFIED: npm registry]) | 1.27.0 | If a prebuilt binary is ever unavailable for a specific platform/arch combination not covered by the package's prebuild matrix, there is no pure-JS fallback for ONNX inference in this design — REQ-044's opt-in framing means this degrades to "feature unavailable on that platform," not a silent quality regression, since `DeterministicEmbedder` remains the always-on default regardless |
| Hugging Face Hub network access (one-time, vendoring command only) | `memory embeddings enable` | Not probed this session (network access to huggingface.co was available during WebFetch calls in this research session, suggesting outbound HTTPS is generally reachable in this environment) | — | If unreachable at vendoring time, the CLI command must fail loudly with a clear "could not reach huggingface.co, check network" message — this is expected, occasional, one-time friction, not a runtime dependency |

**Missing dependencies with no fallback:** None identified — `DeterministicEmbedder` is always available (zero dependencies) and remains the product's correctness floor regardless of this phase's new opt-in adapter's availability.

**Missing dependencies with fallback:** None currently missing in this dev environment; the platform-coverage fallback note above is documented for completeness, not because a gap was actually observed.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest ^2.0.5 [confirmed via `package.json`, this repo] |
| Config file | none detected at repo root beyond `package.json`'s `test`/`test:watch` scripts (`vitest run` / `vitest`) — vitest's zero-config defaults apply |
| Quick run command | `npx vitest run tests/embeddings/transformer-embedder.golden.test.ts` |
| Full suite command | `npm test` (currently 91 files / 744 tests passing per Phase 8's verification report) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|--------------------|-------------|
| REQ-044 | Hash embedder remains default when embeddings not enabled | unit | `npx vitest run tests/embeddings/embedder-resolver.test.ts -t "default"` | ❌ Wave 0 |
| REQ-044 | Enabled-but-broken hard-errors (CLI) / marks unhealthy + skips (daemon) | unit/integration | `npx vitest run tests/embeddings/embedder-resolver.test.ts -t "broken"` | ❌ Wave 0 |
| REQ-044 | `memory embeddings enable` vendors model with `allowRemoteModels=false` in effect everywhere else | integration | `npx vitest run tests/embeddings/model-vendor.test.ts` | ❌ Wave 0 |
| REQ-051 | Quantized-hash golden vector match across both embed modes, ~10-20 committed texts | unit | `npx vitest run tests/embeddings/transformer-embedder.golden.test.ts` | ❌ Wave 0 |
| REQ-051 | Exact byte-hash identical across repeated same-machine runs | unit | `npx vitest run tests/embeddings/transformer-embedder.golden.test.ts -t "repeated runs"` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `npx vitest run tests/embeddings/` (fast subset)
- **Per wave merge:** `npm test` (full suite, catches Phase 8 store-parity regressions if `Embedding` shape assumptions shift)
- **Phase gate:** Full suite green before `/gsd:verify-work`, plus the golden-vector test must pass with the real vendored model (not mocked) at least once in CI per D-08.

### Wave 0 Gaps

- [ ] `tests/fixtures/embedding-golden-set.json` — the ~10-20 committed D-08 golden texts (unicode, long-input truncation, near-empty edge cases, both modes)
- [ ] `tests/fixtures/embedding-golden-hashes.json` — committed quantized-hash values, generated by running the real embedder once against the golden set and capturing output (cannot be authored by hand — must be generated from a real run)
- [ ] `tests/embeddings/transformer-embedder.golden.test.ts` — golden-vector regression suite (D-07/D-08)
- [ ] `tests/embeddings/embedder-resolver.test.ts` — default/enabled/broken resolution behavior (D-04/D-05/D-06)
- [ ] `tests/embeddings/model-vendor.test.ts` — vendoring flow + hash-manifest verification (D-04)
- [ ] CI model-artifact caching step — not yet configured; needed before D-08's "CI runs real model with cached artifact" requirement is satisfiable without re-downloading ~130MB every run
- [ ] Framework install: none — vitest already present and configured via `package.json` scripts

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | no | not in scope for this phase |
| V3 Session Management | no | not in scope for this phase |
| V4 Access Control | no | Phase 8 already enforces scope-partitioned vector storage; this phase only produces vectors, does not change access control |
| V5 Input Validation | yes | Phase 8's write-time invariants (`dimensions === vector.length`, float32-finite components) already gate every vector this phase produces before persistence — `TransformerEmbedder`'s output must and does satisfy this by construction (fixed 384-dim, `Number.isFinite`-safe fp32 output from ONNX Runtime) |
| V6 Cryptography | yes | Model file integrity is verified via sha256 content hashing at vendoring time (Pattern 3) — never trust an unhashed downloaded artifact; do not hand-roll a weaker/no-op check |

### Known Threat Patterns for local ONNX embedding adapters

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Tampered/corrupted model file silently changes embeddings without error | Tampering | sha256 manifest verification at vendoring time (Pattern 3); refuse to load an unverified/mismatched model file |
| Implicit network fetch of model at runtime, defeating "fully offline" claim | Information Disclosure / Elevation of Privilege (of the network boundary) | `env.allowRemoteModels = false` everywhere except the one explicit vendoring command (Pattern 3's `finally` block restores this immediately) |
| Enabled-but-broken embedder silently falling back to hash embedder, producing a mixed-provider vector store undetectably | Tampering (of data integrity/consistency) | D-05's hard-error design — this is the explicit product decision this phase implements, not a residual risk to mitigate further |

## Sources

### Primary (HIGH confidence)
- `npm view @huggingface/transformers version` / `npm view onnxruntime-node version os cpu scripts.postinstall` — live npm registry queries, 2026-07-21
- Local inspection of packed `onnxruntime-common@1.20.1` `dist/esm/inference-session.d.ts` — confirmed exact `SessionOptions` field names (`intraOpNumThreads`, `interOpNumThreads`, `graphOptimizationLevel`, `executionProviders`, `executionMode`, `logSeverityLevel`)
- Repo inspection: `src/embeddings/embedder.ts`, `src/storage/memory-store.ts`, `src/domain/types.ts`, `src/cli/command-registry.ts`, `src/cli/bin.ts`, `src/bootstrap/status-command.ts`, `src/operations/tune-command.ts`, `.planning/phases/08-vector-storage-foundation/08-VERIFICATION.md`, `.planning/REQUIREMENTS.md`, `.planning/research/{STACK,PITFALLS,ARCHITECTURE}.md`, `package.json`

### Secondary (MEDIUM confidence)
- [huggingface/skills CONFIGURATION.md](https://github.com/huggingface/skills/blob/main/skills/transformers-js/references/CONFIGURATION.md) — `env.localModelPath`/`env.allowRemoteModels`/`env.cacheDir`/`env.useFSCache` surface, WebFetch 2026-07-21
- [huggingface/skills PIPELINE_OPTIONS.md](https://github.com/huggingface/skills/blob/main/skills/transformers-js/references/PIPELINE_OPTIONS.md) — `dtype`, `device`, `session_options` shape, WebFetch 2026-07-21
- [Transformers.js env API docs (v3.0.0)](https://huggingface.co/docs/transformers.js/v3.0.0/en/api/env) — official docs, WebFetch 2026-07-21
- [Transformers.js backends/onnx API docs](https://huggingface.co/docs/transformers.js/api/backends/onnx) — confirms Node uses `onnxruntime-node`, `session_options` passthrough, WebFetch 2026-07-21
- [Xenova/bge-small-en-v1.5 on Hugging Face](https://huggingface.co/Xenova/bge-small-en-v1.5) — model card usage example (pooling snippet flagged as incorrect for this model), query instruction string, WebFetch 2026-07-21
- [Xenova/bge-small-en-v1.5 onnx/ file listing](https://huggingface.co/Xenova/bge-small-en-v1.5/tree/main) and its API tree endpoint — exact file names/sizes, WebFetch 2026-07-21
- BAAI/bge-small-en-v1.5 SentenceTransformers `1_Pooling/config.json` pooling-mode fields (`pooling_mode_cls_token: true`) — WebSearch-surfaced, corroborated by the well-established, widely-cited fact that all BGE v1.5 models use CLS pooling per BAAI's official documentation

### Tertiary (LOW confidence)
- None retained — all findings above were either directly verified via tooling/registry queries or cross-corroborated across at least two independent sources (official docs + model card, or two WebFetch passes)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — package versions confirmed live via `npm view`; `onnxruntime-common` field names confirmed via locally-inspected packed `.d.ts`, not just documentation prose
- Architecture: HIGH — grounded directly in this repo's actual `Embedder`/`MemoryStore`/CLI-registry code, not generic advice
- Model specifics (pooling, file names/sizes, query instruction) — HIGH-MEDIUM — file names/sizes directly confirmed via HF tree listing; pooling mode cross-verified against BAAI's official SentenceTransformers config (contradicting the Xenova model card's own example snippet, which is flagged explicitly as the less-trustworthy source)
- Pitfalls: HIGH — combination of this session's own direct API verification (session_options fields, pooling mismatch) plus the milestone-level PITFALLS.md research already produced for this codebase
- Package legitimacy: MEDIUM — both packages are unambiguously legitimate (official Hugging Face / Microsoft org packages, long publish history, verified via live registry), but slopcheck itself was not run this session, so both are formally tagged `[ASSUMED]` per protocol and gated behind a human-verify checkpoint

**Research date:** 2026-07-21
**Valid until:** 30 days (stable, officially-maintained packages; re-verify package versions if planning is delayed past ~2026-08-20, and re-verify the pinned HF revision/hashes at actual vendoring implementation time regardless of research age, since those are captured from a live run, not from this research session)
