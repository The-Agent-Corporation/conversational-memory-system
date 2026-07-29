# Plan 12-06 — Backfill Rehearsal on Clones

**Run:** 2026-07-29 by the Plan 12-06 executor. **Assembled by the orchestrator** after that executor died
mid-plan on a server-side `API Error: 529 Overloaded` — a transport failure, not a task failure. Its
background jobs survived the agent and ran to completion; the orchestrator polled them to exit and read the
receipts directly. Every number below comes from a log or a database, not from the dead agent's report.

**The live corpus was never written.** `~/.memory/aaron.db` verified at `user_version` 4, `summary_vectors`
**0**, inode 171672602, 5,031,448,576 bytes, before and after. All five backups intact.

## Corpus rehearsed against

`user_version` 4 with `idx_summaries_state_id`; 138,373 summaries (49,314 `compacted` + 89,059
`superseded`); `summary_vectors` 0; embeddings ENABLED under the composed ONNX identity
`onnx-transformers` / `Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3`.

## 1. Cost — measured, not estimated

| | value |
|---|---|
| wall clock | **1,263.52 s = 21 m 04 s** (`19:31:24Z → 19:52:27Z`, exit 0) |
| summaries | 49,314 |
| throughput | **25.6 ms/summary** |

The pre-phase estimate was 24.2 ms/summary ≈ 20 min, taken before the ONNX embedder was actually enabled.
The measured figure lands within noise of it, so the estimate is confirmed rather than merely reused.

Receipt, verbatim:

```json
{ "ok": true, "provider": "onnx-transformers",
  "model": "Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3",
  "processed": 49314, "totalMissingAtStart": 49314 }
```

## 2. Peak RSS — the open risk, now closed

**Peak 1,628,000 kB = 1.55 GiB** across the process tree (including the ONNX session); the launcher process
itself peaked at 89,216 kB.

This was the genuine unknown: `backfill-embeddings-command.ts` loads every summary into one in-memory map
before batching, 12-01 narrowed it to retrievable states (a 64 % cut), but 49,314 summaries — one of them
~818 KB — had never been held at once. 1.55 GiB is unremarkable on this machine. **No mitigation needed.**

## 3. Resume — the property GAP-12-A broke

Killed partway, restarted, and it **resumed rather than restarting**:

| run | processed | reported `total` |
|---|---:|---:|
| A (killed) | ~4,000 | 49,314 |
| B (resumed) | **45,314** | **45,314** |

Run B's `total` is 45,314, **not** 49,314 — the missing set had correctly shrunk by the completed work.
Final vector count on the clone: **49,314**. Arithmetic: 4,000 + 45,314 = 49,314 exactly, so nothing was
double-embedded and nothing was skipped.

This is GAP-12-A's fix holding at real scale under the real ONNX identity, not only in unit tests. Before
that fix the query key and the write key differed, so a killed backfill restarted from zero and this table
would read 49,314 / 49,314.

## 4. Idempotence

A second full run after completion:

```json
{ "ok": true, "provider": "onnx-transformers",
  "model": "Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3",
  "processed": 0, "totalMissingAtStart": 0 }
```

**Zero additional writes.** Phase 10's SC3 satisfied for this embedder for the first time.

## 5. Query time under and after load

| state | rows | cold | warm |
|---|---:|---:|---:|
| pre-backfill (live, measured 12-05) | 49,314 | 93 ms | ~25 ms |
| fully backfilled (clone) | 0 | 180 ms | **14.5 ms** |

No drift toward the 4,000 ms pre-index behavior. The index holds with the vector table populated.

## 6. Disk — a finding worth carrying into 12-07

| | bytes |
|---|---:|
| clone before backfill | 5,031,448,576 |
| clone after 49,314 vectors | **5,031,448,576** |
| vector payload added | 75,746,304 (**72.2 MiB**; 1,536 B/vector = 384 × float32) |

**The file did not grow at all.** SQLite reused free pages left by Phase 11's prunes (26,643 anchors and
the superseded-summary churn). So the live backfill should be expected to add ~72 MiB of *logical* payload
at ~zero file growth — the same distinction Phase 11 had to make about its own "64.6 MB" figure. Do not
promise a size increase, and do not treat an unchanged file size as evidence the backfill did nothing.

## NOT COMPLETED — F11's daemon-once repair check

`once.log` is **0 lines**; `daemon-once-probe.mjs` was written but the check never ran — the executor died
first. So plan 12-06's verification that the repair pass actually executes under `memory daemon once` is
**unverified**.

What that does and does not mean: 12-04 wired `runEmbeddingRepair` into both `drainOne` (`daemon.ts:198`)
and `runOnce` (`daemon.ts:292`) — orchestrator-verified in source, and covered by unit tests including the
zero-query no-op assertion. What is missing is the end-to-end confirmation on a real corpus clone. This is
**not** a blocker for 12-07 (the backfill does not involve the daemon, which stays stopped throughout), but
it must be closed before the daemon is started for real. Recorded rather than quietly dropped.

## Cleanup

Rehearsal clones deleted after measurement; paths and freed space recorded in the commit.
