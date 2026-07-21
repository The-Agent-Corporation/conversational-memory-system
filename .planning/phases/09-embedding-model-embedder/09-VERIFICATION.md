---
phase: 09-embedding-model-embedder
verified: 2026-07-21T20:40:18Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
---

# Phase 9: Embedding Model + Embedder Verification Report

**Phase Goal:** The milestone's open embedding-model decision is resolved and recorded, with a pinned-deterministic local embedder available while the keyword-hash embedder remains the always-on default and fallback.
**Verified:** 2026-07-21T20:40:18Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Hash `DeterministicEmbedder` remains default/fallback with zero behavior change for users who take no action | VERIFIED | `src/embeddings/embedder.ts` `DeterministicEmbedder` byte-for-byte unchanged from Phase 8 (same provider/model/dimensions/algorithm). `src/embeddings/embeddings-config.ts:13` schema defaults `enabled: false`. `src/embeddings/embedder-resolver.ts:27-32` `resolveEmbedder` returns `new DeterministicEmbedder()` whenever `!config.enabled` (including no sidecar file at all — `readEmbeddingsConfig` returns schema defaults when the file doesn't exist). Test: `tests/embeddings/embedder-resolver.test.ts:28-31` asserts this, passing. |
| 2 | Operator can explicitly opt in to a local ONNX sentence-transformer embedder, fully offline at runtime | VERIFIED | `memory embeddings enable` (`src/operations/embeddings-command.ts`) is the sole opt-in path; registered in `src/cli/command-registry.ts:42`. `vendorModel` (`src/embeddings/model-vendor.ts`) is the only code path that sets `env.allowRemoteModels = true`, restored to `false` in a `finally`. `TransformerEmbedder.init()`/`resolveEmbedder`/`probeEmbedderHealth` never touch `allowRemoteModels`. Runtime model loading is fully local (`env.localModelPath` set to the vendored dir). |
| 3 | Golden set under pinned ONNX config reproduces committed golden-vector hash via `npm run test:golden` | VERIFIED | Ran `npm run test:golden` in this environment (vendored model present at `tests/fixtures/models`): **16 passed, 1 skipped** (the "golden gate requires model" guard test correctly skips because the model IS present). Quantized-hash-per-id (`tests/fixtures/embedding-golden-hashes.json`, real hashes captured in plan 05) and the exact-byte-hash repeat-run assertion both pass. |
| 4 | Deterministic re-embedding + stable vector search for fixed config | VERIFIED | ONNX session pinned in `transformer-embedder.ts:57-64`: `executionProviders: ["cpu"]`, `intraOpNumThreads: 1`, `interOpNumThreads: 1`, `graphOptimizationLevel: "disabled"`, `executionMode: "sequential"`; single resident pipeline reused across calls (`init()` awaited once, never re-created per-embed). CLS pooling + L2 normalize pinned and documented against the model's own pooling config. Exact byte-hash repeat-run test (golden suite) confirms bit-identical output same-machine. Vector search stability inherited from Phase 8's cosine-similarity store, unaffected by this phase. |
| 5 | Every vector records embedder provider, model, and version for stale-model detection | VERIFIED | `TransformerEmbedder.runPipeline` (`transformer-embedder.ts:101-107`) returns `model: \`${this.model}@${this.revision}\`` (e.g. `Xenova/bge-small-en-v1.5@ea104dac...`) alongside `provider: "onnx-transformers"` and `dimensions: 384` on every `Embedding`. These flow into Phase 8's `summary_vectors` store (provider/model/dimensions columns), which already write-time-validates dimension/finite-float invariants — satisfied by this embedder's fp32 CLS-pooled, L2-normalized output. |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/embeddings/embedder.ts` | `AsymmetricEmbedder` + `isAsymmetricEmbedder`, base `Embedder`/`DeterministicEmbedder` untouched | VERIFIED | Extension-only; interface + type guard present, exported. |
| `src/embeddings/transformer-embedder.ts` | Pinned deterministic ONNX `AsymmetricEmbedder` | VERIFIED | `embed()` bare-passage, `embedQuery()` bge-instruction-prefixed, CLS pooling, L2 normalize, eager `init()` (D-05 hard error at startup, not lazy). |
| `src/embeddings/model-vendor.ts` | One-time hash-verified vendoring, real manifest | VERIFIED | Real pinned revision `ea104dac...` + 5 real sha256 hashes (plan-05 captured); `verifyManifest` runs unconditionally after `pipeline()`; fp32-only (quantized variants excluded, test-verified). |
| `src/embeddings/embeddings-config.ts` | Sidecar config, zod-strict, disabled by default | VERIFIED | `.strict()` schema, `enabled: false` default, atomic-enough read/write via `existsSync` gate. |
| `src/embeddings/embedder-resolver.ts` | `resolveEmbedder` + non-throwing `probeEmbedderHealth` | VERIFIED | Default/enabled/broken resolution correct; `probeEmbedderHealth` catches `readEmbeddingsConfig` throws (CR-01 fix applied — see Review Findings below) and never rejects. |
| `src/operations/embeddings-command.ts` | `memory embeddings enable/disable/show` | VERIFIED | `main` export present; vendor-then-persist ordering correct (failed vendor never writes `enabled:true`). |
| `src/cli/command-registry.ts` | `embeddings` subcommand registered | VERIFIED | `embeddings: () => import("../operations/embeddings-command.js")` present. |
| `tests/fixtures/embedding-golden-set.json` | 10-20 golden texts, both modes, edge cases | VERIFIED | 15 entries, `passage`/`query` modes present, includes unicode/truncation/near-empty per plan-01 SUMMARY. |
| `src/bootstrap/status-command.ts` | Embedder health block | VERIFIED | `embedder: EmbedderHealth` field wired into `Promise.all` via `probeEmbedderHealth`; non-throwing per CR-01 fix, confirmed by `tests/bootstrap/status-embedder-health.test.ts` (both disabled-default and enabled-but-broken cases pass, health surfaced without crashing). |
| `package.json` | `@huggingface/transformers@4.2.0` pinned + `test:golden` script | VERIFIED | Dependency pinned; `onnxruntime-node@1.24.3` resolved transitively (recorded in package-lock.json for provenance); `test:golden` script present and green. |
| `docs/embeddings.md` | Operator + CI documentation | VERIFIED | 187 lines; covers enable/disable/show, offline guarantee, determinism/golden gate. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `transformer-embedder.ts` | `embedder.ts` | `implements AsymmetricEmbedder` | WIRED | `export class TransformerEmbedder implements AsymmetricEmbedder`. |
| `transformer-embedder.golden.test.ts` | `embedding-golden-set.json` / `embedding-golden-hashes.json` | golden fixture imports | WIRED | Both imported and consumed in `it.each`. |
| `embedder-resolver.ts` | `embeddings-config.ts` | `readEmbeddingsConfig` gate | WIRED | Called in both `resolveEmbedder` and `probeEmbedderHealth`. |
| `command-registry.ts` | `embeddings-command.ts` | `REGISTRY['embeddings']` import | WIRED | Confirmed present, and end-to-end dispatcher test passes (`tests/...bin-dispatcher...`). |
| `embeddings-command.ts` | `model-vendor.ts` | `enable` runs `vendorModel` | WIRED | `await vendorModel(modelPath)` before config write. |
| `status-command.ts` | `embedder-resolver.ts` | `probeEmbedderHealth` (non-throwing) | WIRED | Included in `Promise.all`; behavioral test proves it doesn't crash `memory status` on broken/corrupt state. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full test suite green | `npm test` | 765 passed, 4 skipped (94/95 files, network + model-presence gated tests correctly skip) | PASS |
| Golden determinism gate | `npm run test:golden` | 16 passed, 1 skipped (guard test) | PASS |
| Typecheck | `npm run typecheck` | clean, no errors | PASS |
| No default-`npm test` model dependency | grep `describe.skipIf`/`runIf` gating in golden + network suites | Present and correctly gated (CR-02 fix confirmed) | PASS |

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|--------------|-------------|--------|----------|
| REQ-044 | 01, 02, 03, 04, 05, 06 | Local embedding adapter, opt-in, offline, hash embedder remains default | SATISFIED | Truths 1, 2, 5 above; CLI + resolver + vendoring all implemented and wired. |
| REQ-051 | 01, 03, 05 | Embedding determinism, golden-vector regression, stable vector search | SATISFIED | Truths 3, 4 above; `npm run test:golden` reproducibly green in this environment. |

No orphaned requirements — REQUIREMENTS.md maps only REQ-044/REQ-051 to Phase 9, both claimed and satisfied.

### Review Findings Cross-Check (09-REVIEW.md)

| Finding | Claimed Fix | Verified |
|---------|-------------|----------|
| CR-01 (`probeEmbedderHealth` throws on corrupt config) | Fixed in `aaccce2` | CONFIRMED — `embedder-resolver.ts:47-62` now catches `readEmbeddingsConfig` and returns `{healthy:false, reason}` instead of throwing. |
| CR-02 (golden suite breaks default `npm test` without vendored model) | Fixed in `aaccce2` | CONFIRMED — `describe.skipIf(!MODEL_PRESENT)` gate present; `npm test` passes on a clone without triggering golden failures (and passes here where the model IS vendored). |
| WR-01 (sha-mismatch test asserts wrong thing) | Fixed in `aaccce2` | CONFIRMED — `model-vendor.test.ts:65-70` now vendors, tampers a file, and asserts rejection with an integrity-related message. |
| WR-02 (parse-before-verify ordering) | Open, documented follow-up | Confirmed still open in `model-vendor.ts:56-64` (`pipeline()` called before `verifyManifest`) — acceptable per phase scope, not a goal-blocking gap since post-vendor verification still gates `enabled:true`. |
| WR-03 (empty modelPath/revision on hand-edited config) | Open, documented follow-up | Confirmed still open — `embeddings-config.ts` schema has no `superRefine` guard. |
| WR-04 (`--model-path` persisted unresolved/relative) | Open, documented follow-up | Confirmed still open — `embeddings-command.ts:59` uses `parsed.modelPath ?? defaultModelPath(...)` without `resolve()`. |
| WR-05 (process-global `env` mutation coordination) | Open, documented follow-up | Confirmed still open — no mutex/assertion added. |
| IN-01..IN-03 | Open, documented follow-up | Confirmed still open (dead `PLACEHOLDER_SHA256`/`bytes` fields, duplicated `parseArgs`, health echoes config-declared not instantiated identity). |

These open WR/IN items are pre-existing, explicitly-documented follow-ups per the task instructions (WR-02..WR-05 + infos "remain open as documented follow-ups"), not silently dropped. None of them block the phase's observable truths — they are hardening/robustness gaps on paths already covered by hard-error/never-throw contracts for the common case.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK` markers found in any phase-modified source file. One pre-existing named constant `PLACEHOLDER_SHA256` in `model-vendor.ts` is dead code (IN-01, open follow-up) but is not a debt-marker comment and does not gate real hashes (real hashes are already pinned).

### Human Verification Required

None. All must-haves are verifiable via code + automated tests. The two blocking human checkpoints required by the plans (package-legitimacy audit in plan 02, real-model vendoring in plan 05) were already operator-approved during execution per the task brief, and their artifacts (pinned `@huggingface/transformers@4.2.0`/`onnxruntime-node@1.24.3`, real manifest hashes, real golden hashes) are present and verified in the codebase.

### Gaps Summary

None. All 5 roadmap success criteria are observably true in the codebase and independently re-verified by running the actual test suite and golden gate in this environment (not merely trusting SUMMARY.md claims). Both REQ-044 and REQ-051 are satisfied with no orphaned requirements. All three review-flagged critical/warning items claimed as fixed (CR-01, CR-02, WR-01) are confirmed fixed by direct code inspection and passing tests. The remaining open review items (WR-02..WR-05, IN-01..IN-03) are documented hardening follow-ups on paths that already fail safe (hard-error/never-throw), not blockers to phase goal achievement.

Note: `09-VALIDATION.md` frontmatter still reads `status: draft` / `nyquist_compliant: false` with an unchecked sign-off checklist — this is a planning-artifact staleness issue, not a code gap. Given the phase's actual delivered evidence (all waves executed, reviewed, and independently re-verified here), this sign-off could reasonably be flipped to `approved`/`nyquist_compliant: true`, but that is a documentation housekeeping item for the phase owner, not a reason to withhold `passed` status on this verification.

---

_Verified: 2026-07-21T20:40:18Z_
_Verifier: Claude (gsd-verifier)_
