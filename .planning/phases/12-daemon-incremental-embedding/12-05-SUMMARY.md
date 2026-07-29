---
phase: 12-daemon-incremental-embedding
plan: 05
subsystem: embeddings
tags: [onnx, vendoring, live-corpus, schema-v4, req-045]
requires: ["12-01", "12-02", "12-08"]
provides: ["live corpus on the ONNX embedder", "pre-backfill measurement for 12-07"]
affects: ["12-06", "12-07"]
tech-stack:
  added: []
  patterns: ["direct pinned-URL model vendoring (via 12-08)", "hash-verified staged-then-moved writes"]
key-files:
  created: []
  modified:
    - .planning/phases/12-daemon-incremental-embedding/12-ENABLE.md
    - .planning/phases/12-daemon-incremental-embedding/12-DEFERRED.md
decisions:
  - "Live corpus left at user_version 4 rather than reverted — the migration is additive and verified"
  - "memory status's 50 s cost logged as D-12-3 rather than fixed — pre-existing and out of scope"
metrics:
  duration: "~25 min (re-run of Task 3 only)"
  completed: 2026-07-29
requirements: [REQ-045]
---

# Phase 12 Plan 05: Enable the ONNX Embedder on the Live Corpus — Summary

The live 5.0 GB corpus now resolves the hash-verified ONNX `bge-small-en-v1.5` embedder at pinned
revision `ea104dac…`, with the pre-backfill measurement — 49,314 missing vectors in 22 ms — proving
Plans 12-01 and 12-02 on real data rather than fixtures.

## What happened

Tasks 1 and 2 completed on 2026-07-28/29 (commit `e38d54b`) and were only re-confirmed here, not redone:
daemon absent, `daemon_lease` empty, all five `~/.memory/` backups intact, `pre-phase12` still the
pristine `user_version` 3 restore point. Task 3 completed the migration and the missing-set gate on the
first attempt but **stopped at the vendor**, which was broken in shipped code (GAP-12-C: the download
landed in transformers.js's revision-nested `cacheDir` while `verifyManifest` read a flat path nothing
wrote, and `special_tokens_map.json` was never fetched at all).

Plan 12-08 fixed both defects. This run re-executed Task 3's vendor step and its post-enable assertions.

## Measurements

| | value |
|---|---|
| vendor wall clock | **15.06 s** (2026-07-29 15:22:20→15:22:35 EDT / 19:22:20→19:22:35 UTC) |
| bytes fetched | **133,806,060** across five files; `onnx/model.onnx` exactly 133,093,490 |
| sha256 vs manifest | **5/5 match**, including `special_tokens_map.json` |
| sidecar | `enabled: true`, `onnx-transformers`, `Xenova/bge-small-en-v1.5`, `ea104dacec62c0de699686887e3f920caeb4f3e3`, `~/.memory/aaron.db.models` |
| `embedder.healthy` | **true** |
| `embeddingBackfill.model` | `Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3` — composed, contains the pinned revision (F1/SC4) |
| `missingVectors` / `totalSummaries` | **49,314 / 49,314** (not 138,373) |
| `listSummaryIdsMissingVector` | **22 ms** via `idx_summaries_state_id`, vs a 4,000 ms failure mode |
| `summary_vectors` | **0** — nothing backfilled |

This was the **first genuine network exercise** of the vendor path; the earlier attempt transferred
nothing (every cached file dated to the 2026-07-21 Phase 9 capture). For 12-06/12-07: budget ~15-20 s
for a cold vendor, not minutes.

## Deviations from Plan

**None affecting the plan's actions.** Two structural notes:

1. Tasks 1 and 2 were verified rather than re-executed, per the orchestrator's instruction and the
   plan's own 2026-07-28 update. All their acceptance criteria were re-confirmed by measurement.
2. **[Scope boundary — logged, not fixed]** `memory status` costs 50 s on the live corpus
   (`performance.queryLatencyMs: 49047`). This is **not** the vector query (22 ms) — it is the
   `Promise.all` at `status-command.ts:179-195` materializing 292,407 canonical events, 138,373
   summaries and 301,132 outbox rows into arrays to take their `.length`. Pre-existing and unrelated to
   Phase 12; recorded as **D-12-3** in `12-DEFERRED.md`. It constrains 12-07: a progress display must
   not poll `memory status` in a loop.

## Threat dispositions

| Threat | Outcome |
|---|---|
| T-12-24 model substitution | Held — all five files sha256-verified against the pinned manifest, staged then moved |
| T-12-25 partial vendor with `enabled: true` | Held both ways — the failed run left no sidecar and zero partial files; the successful run wrote `enabled: true` only after `vendorModel` resolved |
| T-12-26 two writers | Held — no daemon process, no LaunchAgent, `daemon_lease` 0 rows throughout |
| T-12-27 / 27a / 27b backup discipline | Held — `pre-phase12` verified at `user_version` 3 before the first open; `-wal` 0 bytes |
| T-12-28 backup destruction | Held — all five backups at unchanged inodes |
| T-12-29 fixture coupling | Held — `MEMORY_MODEL_PATH` unset; default `${db}.models` used |
| T-12-30 credential disclosure | Held — artifacts grepped before staging; only tokenizer filenames and a null `ownerToken` matched |

## Known Stubs

None.

## State left for Plan 12-07

ONNX live and healthy, **zero** vectors under that identity, daemon stopped and staying stopped, all
five backups intact, live corpus at `user_version` 4 with `idx_summaries_state_id`. The backfill is a
separate owner gate and was not run.

## Self-Check: PASSED

- `.planning/phases/12-daemon-incremental-embedding/12-ENABLE.md` — FOUND
- `.planning/phases/12-daemon-incremental-embedding/12-DEFERRED.md` — FOUND
- `~/.memory/aaron.db.embeddings.json` — FOUND (215 bytes)
- `~/.memory/aaron.db.models/Xenova/bge-small-en-v1.5/` — FOUND, 5 files
- commit `e2f15a3` — FOUND
