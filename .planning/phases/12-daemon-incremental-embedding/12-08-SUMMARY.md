---
phase: 12-daemon-incremental-embedding
plan: 8
subsystem: embeddings
tags: [REQ-044, GAP-12-C, vendoring, coverage]
gap_closure: true
closes_gaps: ["GAP-12-C"]
requires:
  - "BGE_SMALL_EN_V1_5_MANIFEST (unchanged, Phase 9 plan 05)"
  - "tests/fixtures/models/Xenova/bge-small-en-v1.5 (gitignored, all five files at pinned hashes)"
provides:
  - "vendorModel that writes exactly what verifyManifest reads, atomically"
  - "a baseUrl injection seam for offline vendoring coverage"
  - "exported verifyManifest"
  - "tests/embeddings/model-vendor.offline.test.ts — runs in a plain npm test"
affects:
  - "src/operations/embeddings-command.ts (unchanged; its enable path can now succeed)"
tech-stack:
  added: []
  patterns:
    - "inject a baseUrl rather than mock fetch, so the real request/response/write path is exercised"
    - "stage + hash-verify + rename: no partial vendor survives"
key-files:
  created:
    - tests/embeddings/model-vendor.offline.test.ts
  modified:
    - src/embeddings/model-vendor.ts
    - tests/embeddings/model-vendor.test.ts
    - docs/adr/0052-daemon-incremental-embedding-seam.md
decisions:
  - "Fetch the five pinned files directly from {baseUrl}/{repo}/resolve/{revision}/{file} rather than through pipeline() — the library's cache indirection is what produced the defect, and five explicit pinned URLs are the most auditable shape for the one network path in the product"
  - "The post-vendor load proof runs against an ISOLATED env.cacheDir — measured, a stale node_modules transformers cache makes loading a model root that does not exist succeed, which is the same cache-hit mechanism that hid GAP-12-C"
  - "env.allowRemoteModels is irrelevant to the direct fetch but is NOT deleted: it is asserted false so D-04/T-09-02's invariant still covers the load proof and everything after"
metrics:
  duration: "~35 min"
  completed: 2026-07-29
  tasks: 3
  suite_before: "1106 passed / 4 skipped"
  suite_after: "1112 passed / 4 skipped"
---

# Phase 12 Plan 8: Vendor the Pinned Model Into the Layout It Verifies — Summary

`vendorModel` now fetches each of the five pinned files directly from the Hub at the pinned revision
and stages, hash-verifies, and moves them into the flat layout `verifyManifest` reads — and the path
is covered by six loopback-served tests that run in every `npm test`, not by four that are skipped.

## What was wrong, and the pre-fix output

Both defects were already verified by the orchestrator; they were fixed, not re-derived. The RED run
is the record that the new test actually pins them. **The fixture was present** — the tests ran, they
did not skip:

```
 ❯ tests/embeddings/model-vendor.offline.test.ts (5 tests | 5 failed) 881ms
   × … > writes every pinned file into the flat layout verifyManifest reads 446ms
     → ENOENT: no such file or directory, open '/var/folders/…/model-vendor-offline-CDw5Af/Xenova/bge-small-en-v1.5/onnx/model.onnx'
   × … > requests all five manifest files, special_tokens_map.json included (defect 2) 120ms
     → ENOENT: no such file or directory, open '/var/folders/…/model-vendor-offline-915NDP/Xenova/bge-small-en-v1.5/onnx/model.onnx'
   × … > rejects when special_tokens_map.json is unavailable, leaving nothing verifiable 109ms
     → expected [Function] to throw error matching /special_tokens_map\.json/ but got 'ENOENT: no such file or directory, op…'
   × … > rejects a corrupted body with the integrity message and leaves no usable model dir (T-12-30) 97ms
     → expected [Function] to throw error matching /integrity|sha256|mismatch/i but got 'ENOENT: no such file or directory, op…'
   × … > does NOT write quantized variant files (D-02 fp32-only) 108ms
     → ENOENT: no such file or directory, open '/var/folders/…/model-vendor-offline-D8eGH3/Xenova/bge-small-en-v1.5/onnx/model.onnx'

 Test Files  1 failed (1)
      Tests  5 failed (5)
```

with the failure originating inside the reader, three frames down from `vendorModel`:

```
Error: ENOENT: no such file or directory, open '/var/folders/…/Xenova/bge-small-en-v1.5/onnx/model.onnx'
 ❯ verifyManifest src/embeddings/model-vendor.ts:76:19
 ❯ Module.vendorModel src/embeddings/model-vendor.ts:64:3
```

**Reading the two defect cases.** Every case fails at the same flat-path `ENOENT`, which is defect 1
stated exactly: the pre-fix code ignored the injected `baseUrl` entirely, went through `pipeline()`,
and was served from the stale `node_modules/@huggingface/transformers/.cache` — so the loopback
server recorded **zero** requests. That is also why the two *rejection* cases fail on the wrong
error rather than on no error: the vendor never reached the point of noticing an omitted or corrupted
file, because it never asked the server for anything. Defect 2 (`special_tokens_map.json` never
requested) is therefore pinned positively by the *second* case, "requests all five manifest files",
which asserts the server's recorded request list equals the manifest's five keys — post-fix it passes,
and against the pre-fix code the list was empty.

## The fix

`vendorModel(localModelPath, { baseUrl?, verifyLoad? })`:

- fetches each manifest file from `{baseUrl}/{repo}/resolve/{revision}/{file}`, **revision pinned in
  the URL**, streaming (never buffering) the 133 MB `onnx/model.onnx`;
- hashes while streaming and checks the sha256 and, where the manifest pins one, the byte length;
- stages the whole set into a `.vendor-*` temp dir **inside** `localModelPath` (so the final move is
  a same-filesystem rename), runs `verifyManifest` against the staging root, and only then moves it
  into place — so a failed or partial vendor leaves nothing a later run could pass verification on
  (T-12-30);
- re-verifies at the real path and then proves the model loads.

No `pipeline()` call remains in `model-vendor.ts`. `grep -n "pipeline"` returns 4 hits: the
`node:stream/promises` import aliased to `streamPipeline`, and three comment references explaining the
defect. `@huggingface/transformers` is now imported for `env` only.

**`BGE_SMALL_EN_V1_5_MANIFEST` is byte-unchanged.** Verified by extracting the declaration from
`2ae2624` (the pre-plan commit) and from the working tree and diffing: identical, 784 bytes each.

**`env.allowRemoteModels` disposition — stated, not silently dropped.** The direct fetch does not
route through transformers.js, so the flag no longer has anything to do with the download. It was not
deleted: it is deliberately never switched on, and is asserted `false` at the top of `vendorModel`,
so D-04/T-09-02's invariant ("transformers.js never loads from the network in this process") still
covers the post-vendor load proof and everything that runs after. This is a strictly stronger
position than before, where the flag was switched **on** for the duration of the download.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The post-vendor load proof was satisfiable by a stale transformers cache**

- **Found during:** Task 2, while checking that the load proof could actually fail.
- **Issue:** The plan asks for `probeEmbedderHealth` (or an equivalent load) as the post-vendor
  proof. `probeEmbedderHealth` reads the embeddings sidecar, which at vendor time is still absent /
  `enabled:false` — it would return `healthy:true` without loading anything — so an equivalent direct
  `TransformerEmbedder.init()` was used. Measured on 2026-07-29, that load is **not** a proof by
  itself: with the default `env.cacheDir` (`node_modules/@huggingface/transformers/.cache`) holding
  the stale Phase 9 copy, `init()` against `localModelPath: "/nonexistent-model-root"` **succeeds**;
  with `cacheDir` pointed at an empty directory the same call throws ``  `local_files_only=true` or
  `env.allowRemoteModels=false` and file was not found locally at
  "/nonexistent-model-root/Xenova/bge-small-en-v1.5/config.json" ``. A load proof served from that
  cache proves nothing about what was just vendored — and it is the *same* cache-hit mechanism that
  let GAP-12-C ship (12-05's run downloaded nothing; every cached file was still dated 2026-07-21).
- **Fix:** `proveModelLoads` repoints `env.cacheDir` at an empty temp directory for the duration of
  the load and restores the previous value in a `finally`, so only the files just vendored can
  satisfy it. A test pins both the restoration and the absence of scratch dirs afterwards.
- **Files modified:** `src/embeddings/model-vendor.ts`, `tests/embeddings/model-vendor.offline.test.ts`
- **Commit:** `986dc19`

**2. [Rule 3 - Blocking] `verifyManifest` was module-private**

- **Found during:** Task 1. The atomicity assertions ("after a rejection, nothing survives that a
  later run could verify") have to call the reader directly, and the network-gated tamper case can no
  longer re-invoke `vendorModel` to detect tampering because the new vendor would simply re-download
  and overwrite the tampered file. Exported `verifyManifest`; its body and its flat contract are
  unchanged. Committed as part of the RED commit `619bfa6` since the test cannot link without it.

### Scope note

The `TransformerEmbedder` cache-shadowing finding above is **not** confined to vendoring:
`resolveEmbedder` and `probeEmbedderHealth` construct `TransformerEmbedder` with the default
`cacheDir` too, so on a machine with a populated transformers cache an *enabled-but-missing* model
directory could load from the cache instead of failing (D-05's "refuse to run" intent). That is
outside this plan's files and was **not** changed. Logged here rather than fixed.

## Coverage

`tests/embeddings/model-vendor.offline.test.ts` — six cases, **no `runIf`/`skipIf` on any network
flag**. The only gate is fixture presence (`describe.skipIf(!FIXTURE_PRESENT)`), mirroring
`transformer-embedder.golden.test.ts`, because the fixture is gitignored and a fresh clone must stay
green. Verified both ways:

- fixture present (this machine): `6 passed`
- `MEMORY_MODEL_PATH=/nonexistent-fixture-root`: `Tests 6 skipped (6)` — no failure on a fresh clone.

A `node:http` server on `127.0.0.1:0` serves the five fixture files at the Hub's own URL shape,
streaming `onnx/model.onnx` from disk. Because the fixture's bytes hash exactly to the pinned
manifest, real verification passes — the test exercises genuine fetch, flatten, and verify logic, not
a mock of it. Cases: flat-layout write with per-file sha256; the five-file request set (defect 2);
404 on `special_tokens_map.json` rejects and leaves nothing verifiable; corrupted `tokenizer.json`
mid-vendor rejects with the integrity message and leaves an empty `Xenova/` (T-12-30); scratch
cleanup and `env.cacheDir` restoration; no quantized variants (D-02).

**Wall clock: 1.99 s for all six cases** (2.26 s including vitest startup) — four full 133 MB
loopback transfers plus three model loads. It does not materially slow the suite: the whole run is
23.5 s, and this file is not among the slow ones (`tests/sync/recovery.test.ts` alone is 15.4 s).

The network-gated real-Hub cases are **kept** — they remain the only thing exercising the actual Hub.
They are simply no longer the only coverage. The tamper case was reshaped to assert through
`verifyManifest` for the reason given above.

## Verification

| check | result |
|---|---|
| `npx vitest run tests/embeddings/model-vendor.offline.test.ts` | **6 passed**, 1.99 s |
| same, with the fixture absent | **6 skipped**, no failure |
| `npx vitest run` (full suite) | **1112 passed / 4 skipped** (114 files passed, 1 skipped) |
| baseline | 1106 passed / 4 skipped |
| `npm run typecheck` | clean, no output |

**The skipped count stays 4, and it is the same 4** — the network-gated real-Hub cases in
`model-vendor.test.ts` (3 cases) plus the golden-gate guard case, unchanged by this plan by design.
The delta is `+6 passed`: exactly the six new offline cases. Nothing that was passing became skipped.

## What was NOT done

- `~/.memory/aaron.db` was **never opened**, in any mode. No `memory` subcommand was run.
- `memory embeddings --action enable` was **not** run against the live database. Plan 12-05 owns that
  under its own owner gate; this plan makes it capable of succeeding, proven offline.
- **The real Hub was never contacted.** All fetching in the new tests is loopback. The RED run went
  through `pipeline()`, which was served entirely from the existing `node_modules` cache — consistent
  with 12-05's finding that no network transfer occurs when that cache is warm.
- `BGE_SMALL_EN_V1_5_MANIFEST` unedited; `verifyManifest`'s body and contract unedited.

## Commits

| # | hash | what |
|---|---|---|
| 1 | `619bfa6` | `test(12-08)` — the failing offline test + `verifyManifest` export |
| 2 | `986dc19` | `fix(12-08)` — direct pinned fetch, flat layout, atomic staging, isolated load proof |
| 3 | `aa99309` | `docs(12-08)` — ADR 0052 addendum |

## Threat Flags

None. No new network endpoint, auth path, or schema change: the one network path in the product got
narrower (five pinned URLs at a pinned revision) and its failure mode got safer (atomic staging).

## Self-Check: PASSED

- `tests/embeddings/model-vendor.offline.test.ts` — FOUND
- `src/embeddings/model-vendor.ts` — FOUND
- `docs/adr/0052-daemon-incremental-embedding-seam.md` contains `GAP-12-C` — FOUND
- commits `619bfa6`, `986dc19`, `aa99309` — FOUND in `git log`
