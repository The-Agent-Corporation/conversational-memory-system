# Plan 12-07 — The live backfill of `~/.memory/aaron.db`

**Run:** 2026-07-29 by the Plan 12-07 executor. Every figure below is a measurement taken during this plan.
Timezone labels are explicit throughout: `stat -f %Sm` renders **LOCAL** time (EDT here), so every timestamp
is recorded in both zones.

Live corpus: `~/.memory/aaron.db`, person `aaron`. **49,314 vectors written. Zero file growth. Exit 0.**

The daemon was **not** started — see [Task 3 — the daemon was deliberately not restarted](#task-3--the-daemon-was-deliberately-not-restarted).

---

## Owner authorization (Task 1) — granted 2026-07-29

The owner was shown the measured rehearsal evidence from `12-REHEARSAL.md` — **21 m 04 s** wall clock,
**25.6 ms/summary**, **1.55 GiB** peak RSS, exact resume convergence (4,000 + 45,314 = 49,314),
zero-write idempotence, and **zero file growth** — and replied **"go"**.

Recorded per the checkpoint's requirement; the checkpoint is **not** re-opened. Locked decision 2
(`12-CONTEXT.md`) authorizes the live backfill in principle; this authorization confirms the measured cost
matched what that decision assumed. It did: nothing in the rehearsal diverged from the ≈20-minute / ~76 MB
scope the decision was made about, so the "STOP instead of applying" branch was not taken.

## Preconditions, verified immediately before the write

Every one of these was checked and had to pass before `backfill-embeddings` was launched.

| gate | measured | required |
|---|---|---|
| daemon process | none (`ps` for `daemon-command`/`memory daemon`/`conversational-memory`) | stopped |
| LaunchAgent | no plist, `launchctl list` shows no job | absent |
| `daemon_lease` | **0 rows** (read-only probe) | empty |
| `pragma user_version` | **4** | 4 |
| `idx_summaries_state_id` | present | present |
| `summary_vectors` | **0** | 0 |
| `summaries` | **138,373** (49,314 `compacted` + 89,059 `superseded`) | unchanged |
| missing set | **49,314** rows, 25.0 / 25.3 / 24.1 ms | 49,314 |
| `aaron.db-wal` | **0 bytes** (F7) | 0 |
| `embedder.healthy` | **true** | true |
| all five backups | present at expected inodes | intact |
| disk free | **402 Gi** | ample |

The live file before the run: inode **171672602**, **5,031,448,576** bytes, mtime 2026-07-29 **10:07:55 EDT**
/ **14:07:55 UTC**.

Backups, inode-verified (none deleted, moved, or overwritten at any point in this plan):

| file | inode | size (bytes) |
|---|---:|---:|
| `aaron.db.pre-phase12` | 182055297 | 5,031,448,576 |
| `aaron.db.pre-v4` | 181531855 | 5,031,448,576 |
| `aaron.db.pre-rebuild-v3` | 181199709 | 5,031,448,576 |
| `aaron.db.pre-anchor-prune` | 180214168 | 5,031,448,576 |
| `aaron.db.pre-phase11` | 179000198 | 4,962,574,336 |

### `memory status` before the run, verbatim

```json
"embedder": {
  "enabled": true,
  "provider": "onnx-transformers",
  "model": "Xenova/bge-small-en-v1.5",
  "revision": "ea104dacec62c0de699686887e3f920caeb4f3e3",
  "healthy": true,
  "reason": null
},
"embeddingBackfill": {
  "provider": "onnx-transformers",
  "model": "Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3",
  "totalSummaries": 49314,
  "missingVectors": 49314,
  "completedFraction": 0
}
```

`schemaVersion: 4`, `daemon.state: "stopped"`. This call cost **55.64 s** — D-12-3, the known
`memory status` cost, which is why progress was read from the backfill's own JSON lines and never by
polling `status`.

---

## The run

`memory backfill-embeddings --db ~/.memory/aaron.db`. Arg surface confirmed against `parseArgs`
(`backfill-embeddings-command.ts:151-171`) before running: `--db` and an optional `--batch-size`. No
`--batch-size` was passed, so the default 500-row batch applies — which is what the rehearsal measured.

**Backgrounded to a log file and polled to exit**, with a 5-second RSS sampler over the whole process tree.
244 samples. The CONTEXT hazard names this exact failure — the run was never left unattended.

| | value |
|---|---|
| start | 2026-07-29 **17:09:36 EDT** / **21:09:36 UTC** |
| end | 2026-07-29 **17:30:14 EDT** / **21:30:14 UTC** |
| wall clock (`/usr/bin/time -p real`) | **1,238.76 s = 20 m 38.8 s** |
| user / sys | 1,219.71 s / 11.48 s |
| exit code | **0** |
| progress lines | **99** (49,314 ÷ 500, last one `49314/49314`) |
| throughput | **25.12 ms/summary** |
| peak RSS, process tree | **1,497,328 kB = 1.428 GiB** |
| peak RSS, `time -l` single process | 1,381,449,728 B = 1.287 GiB |

### Receipt, verbatim

```json
{
  "ok": true,
  "provider": "onnx-transformers",
  "model": "Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3",
  "processed": 49314,
  "totalMissingAtStart": 49314
}
```

`totalMissingAtStart` **49,314**, not 138,373 — GAP-12-B's state predicate on live data. `model` is the
**composed** identity carrying the pinned revision, not the bare repo id — GAP-12-A on live data.

The final progress line, verbatim:

```json
{"event":"progress","processed":49314,"total":49314,"provider":"onnx-transformers","model":"Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3"}
```

### Where the memory goes — the peak is the load, not the embedding

The peak RSS sample is **20 seconds into a 1,239-second run**:

```
2026-07-29T21:09:56Z total_rss_kb=1497328 82125:1280 82128:89104 82169:71440 82170:1335504
```

and RSS then declines for the rest of the run (833,216 kB at the last sample). This confirms the
rehearsal's diagnosis mechanically rather than by inference: the cost is
`listSummaries({ states: RETRIEVABLE_MEMORY_STATES })` materializing and Zod-parsing all 49,314 summaries
into one `Map` before the first batch (`backfill-embeddings-command.ts:79-83`) — not the ONNX session, and
not any accumulation across batches. The launcher process peaked at **89,104 kB**, within 112 kB of the
rehearsal's 89,216 kB.

---

## `memory status` after the run — the SC4 evidence, verbatim

```json
"embedder": {
  "enabled": true,
  "provider": "onnx-transformers",
  "model": "Xenova/bge-small-en-v1.5",
  "revision": "ea104dacec62c0de699686887e3f920caeb4f3e3",
  "healthy": true,
  "reason": null
},
"embeddingBackfill": {
  "provider": "onnx-transformers",
  "model": "Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3",
  "totalSummaries": 49314,
  "missingVectors": 0,
  "completedFraction": 1
}
```

| assertion | result |
|---|---|
| `embeddingBackfill.missingVectors === 0` | ✅ **0** |
| `embeddingBackfill.completedFraction === 1` | ✅ **1** |
| `embeddingBackfill.model` is the composed `Xenova/bge-small-en-v1.5@ea104dac…` identity | ✅ |
| `model` **contains** `ea104dacec62c0de699686887e3f920caeb4f3e3` (F1 / REQ-045) | ✅ substring present |
| `embedder.healthy === true` | ✅ |

**`completedFraction: 1` is the assertion GAP-12-A made impossible.** Before Plan 12-01 the missing-set
query key and the written vector key differed, so this figure was pinned at 0 no matter how many vectors
were written. It reads 1 on the live corpus.

`schemaVersion: 4`, `daemon.state: "stopped"`. Cost **56.49 s** — D-12-3 again, unchanged by the backfill.

---

## Row-level verification (read-only probe)

Taken with `new DatabaseSync(path, { readOnly: true })`, which cannot migrate, so the probe itself cannot
change what it measures.

| | before | after |
|---|---:|---:|
| `summaries` | 138,373 | **138,373** |
| ├ `compacted` | 49,314 | **49,314** |
| └ `superseded` | **89,059** | **89,059** |
| `summary_vectors` | 0 | **49,314** |
| `daemon_lease` | 0 | 0 |
| `pragma user_version` | 4 | **4** |
| indexes on `summaries` | 3 | 3 (unchanged) |
| `pragma integrity_check` | — | **ok** |

Every vector row is one identity, one dimensionality:

```json
"vectors_by_identity": [
  { "provider": "onnx-transformers",
    "model": "Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3",
    "c": 49314 }
],
"vector_dimensions_distinct": [ { "dimensions": 384, "bytes": 1536, "c": 49314 } ]
```

**All 49,314 rows carry provider `onnx-transformers` and a model containing the pinned revision
`ea104dacec62c0de699686887e3f920caeb4f3e3` (F1 / REQ-045).** Not a sample — a `group by` over the whole
table, so there is no room for a stray row under another identity. `dimensions` is 384 on every row and the
blob is 1,536 bytes on every row, which is 384 × float32 with no short or long writes.

### The superseded assertion — GAP-12-B's whole point, stated explicitly

```json
"superseded_with_vector": 0,
"vector_rows_by_summary_state": [ { "s": "compacted", "c": 49314 } ],
"orphan_vectors": 0,
"person_id_mismatches": 0
```

**Not one of the 89,059 `superseded` summaries received a vector.** Asserted two independent ways: a direct
count of superseded summaries holding *any* vector row (**0**), and a `group by` of vector rows joined back
to their summary's state, which returns **`compacted` 49,314 and nothing else**. Had the pre-12-02 query
shipped, this table would read 138,373 rows across two states and the run would have taken ~56 minutes.

`orphan_vectors: 0` — no vector points at a summary that does not exist. `person_id_mismatches: 0` — no
vector row's `person_id` disagrees with its own summary's `personId` (T-10-05: never a caller override).

### The missing-set query after the write

| state | rows | run 1 | run 2 | run 3 |
|---|---:|---:|---:|---:|
| before (49,314 missing) | 49,314 | 25.0 ms | 25.3 ms | 24.1 ms |
| **after (fully backfilled)** | **0** | **14.8 ms** | **15.5 ms** | **15.8 ms** |

**~15 ms, not ~4,000 ms.** The v4 covering index holds with the vector table populated — the query got
*faster*, because the correlated subquery now finds a row and stops instead of scanning to exhaustion. The
repair pass Plan 12-04 wired will run a 15 ms query per tick, not a 4-second scan.

### Three spot-checked rows, across the id range

Picked as first / median / last of the ascending backfill-eligible id list.

| summary id | state | summary `personId` | vector `person_id` | match | `dimensions` | blob bytes | `model` | `created_at` |
|---|---|---|---|---|---:|---:|---|---|
| `historical_summary_0004f7dd…381f4e` | compacted | `aaron` | `aaron` | ✅ | **384** | 1,536 | `Xenova/bge-small-en-v1.5@ea104dac…` | 2026-07-29T21:09:38.631Z |
| `historical_summary_800ddc5c…999e31` | compacted | `aaron` | `aaron` | ✅ | **384** | 1,536 | `Xenova/bge-small-en-v1.5@ea104dac…` | 2026-07-29T21:19:50.503Z |
| `historical_summary_ffff8e5e…b78fe6` | compacted | `aaron` | `aaron` | ✅ | **384** | 1,536 | `Xenova/bge-small-en-v1.5@ea104dac…` | 2026-07-29T21:30:14.807Z |

The three `created_at` values fall at the start, the middle, and the very end of the run's wall clock —
consistent with an ascending-id single pass, and useful in its own right: the id ordering the resume key
depends on is the order the rows were actually written in.

### Arithmetic consistency (in the style of `11-18-SUMMARY.md`)

| identity | check |
|---|---|
| 49,314 `compacted` + 89,059 `superseded` = **138,373** `summaries` | ✅ |
| `totalMissingAtStart` 49,314 = the `compacted` count | ✅ |
| `processed` 49,314 = `summary_vectors` after − before = 49,314 − 0 | ✅ |
| `missingVectors` after = 49,314 − 49,314 = **0** | ✅ |
| vector rows by summary state: 49,314 `compacted` + **0** `superseded` = 49,314 | ✅ |
| 99 progress lines × 500 = 49,500 ≥ 49,314; last line 49,314 (98×500 + 314) | ✅ |
| payload 49,314 × 1,536 B = **75,746,304 B = 72.24 MiB** | ✅ identical to the rehearsal |
| `completedFraction` = 49,314 ÷ 49,314 = **1** | ✅ |

Nothing was double-embedded and nothing was skipped: the primary key is
`(summary_id, provider, model)`, `processed` equals the row-count delta exactly, and the missing set is
empty.

---

## Disk — the file size is EQUAL before and after, and that is the expected result

| | bytes |
|---|---:|
| **before** the backfill | **5,031,448,576** |
| **after** the backfill | **5,031,448,576** |
| **file growth** | **ZERO** |
| `pragma page_count` before / after | 1,228,381 / **1,228,381** (identical) |
| logical vector payload added | **75,746,304 B = 72.24 MiB** |

**This is the rehearsal's prediction confirmed exactly, not a failure and not a size reduction.** SQLite
reused free pages left by Phase 11's prunes; the file never had to be extended. The same distinction Phase
11 had to make about its own "64.6 MB" figure applies here: 72.24 MiB is *logical payload*, and disk is
unchanged.

The free-page accounting makes it concrete — a measurement the rehearsal did not report:

| | pages | bytes |
|---|---:|---:|
| `freelist_count` before | 53,006 | 217.13 MiB |
| `freelist_count` after | **23,350** | **91.21 MiB** |
| **consumed** | **29,656** | **121,470,976 B = 115.84 MiB** |

29,656 free pages absorbed the write, and **23,350 pages (91.21 MiB) of headroom remain**. The 115.84 MiB
consumed exceeds the 72.24 MiB of raw vector payload by ~43.6 MiB, which is the b-tree and
`idx_summary_vectors_provider_model_person` overhead for 49,314 new rows plus partial-page waste — not lost
data. Whether a *future* backfill of this size still lands at zero growth depends on that remaining 91 MiB;
this one did.

`aaron.db` inode **171672602 unchanged** (written in place, not replaced), mtime moved to 2026-07-29
**17:30:14 EDT** / **21:30:14 UTC** — the moment the run exited. Disk free 402 Gi → **400 Gi**.

The vendored model (5 files) and the 215-byte sidecar are untouched.

---

## Idempotence, on the live corpus

A second full `memory backfill-embeddings --db ~/.memory/aaron.db`, backgrounded and polled:

```json
{
  "ok": true,
  "provider": "onnx-transformers",
  "model": "Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3",
  "processed": 0,
  "totalMissingAtStart": 0
}
```

**`processed: 0`, exit 0, `3 s` wall clock, zero progress lines.** Phase 10's SC3 satisfied for this
embedder on the real corpus, not only on a clone.

Proven at row level rather than taken from the receipt:

- `summary_vectors` still **49,314**; `summaries` still 138,373 / 49,314 / 89,059; `user_version` still 4.
- File size **5,031,448,576** before and after the rerun; `page_count` 1,228,381; `freelist_count` 23,350
  — **unmoved**, so not a single page was touched.
- `min(created_at)` **2026-07-29T21:09:38.631Z** and `max(created_at)` **2026-07-29T21:30:14.807Z** — both
  inside run 1's window (21:09:36Z → 21:30:14Z). The rerun started at **21:34:21Z**. **No vector row bears
  a rerun timestamp**, which is a stronger statement than `processed: 0`: even an upsert that rewrote a row
  with identical bytes would have moved `max(created_at)`.

---

## Divergences from the rehearsal

Every live figure against `12-REHEARSAL.md`. Four of the five headline numbers match to within noise or
exactly; the two that moved both moved favorably.

| metric | rehearsed | live | divergence | cause |
|---|---|---|---|---|
| wall clock | 1,263.52 s | **1,238.76 s** | **−24.76 s (−1.96 %)** | noise; a clone read via a cold page cache vs the live file whose pages were partly warm from the pre-run `memory status`. Both land on the pre-phase 24.2 ms/summary estimate. |
| throughput | 25.6 ms/summary | **25.12 ms/summary** | −1.9 % | same |
| peak RSS (tree) | 1,628,000 kB = 1.553 GiB | **1,497,328 kB = 1.428 GiB** | **−130,672 kB (−8.0 %)** | see below |
| launcher peak RSS | 89,216 kB | **89,104 kB** | −112 kB (−0.1 %) | none — effectively identical |
| vectors written | 49,314 | **49,314** | **exact** | — |
| vector payload | 75,746,304 B | **75,746,304 B** | **exact** | — |
| file growth | ZERO | **ZERO** | **exact** | free pages, as predicted |
| query after | 0 rows, 14.5 ms warm | 0 rows, **14.8–15.8 ms** | +0.3–1.3 ms | noise |
| idempotent rerun | `processed: 0` | **`processed: 0`** | **exact** | — |

**On the RSS divergence (−8.0 %).** It is the only figure that moved by more than noise, and it moved in
the safe direction. Two candidate causes, and I cannot separate them from one run: (a) the 5-second
sampling interval can miss a transient peak, and the true peak sits in a ~20-second window during the
`listSummaries` load, so a sample landing a few seconds off the apex under-reads it; (b) the rehearsal ran
two clones' worth of activity on the same machine over the same afternoon, so its process tree may have
included page-cache and allocator state this run did not have. **The rehearsal did not fail to predict this
one** — it predicted 1.55 GiB as an upper bound and 1.43 GiB was observed. Read the rehearsed 1.55 GiB as
a ceiling, not a target.

**Two things the rehearsal did not report, now measured:**

1. **The idempotent rerun costs 3 s, not ~60 s.** The command loads all retrievable summaries into a map
   unconditionally (`:79`), so I expected the no-op path to still pay for 49,314 Zod parses. It does, and
   that costs ~3 s total including `tsx` startup — meaning the whole no-op path is cheap enough to re-run
   freely. Worth knowing before anyone budgets for a verification rerun.
2. **Free-page consumption: 29,656 pages, 91.21 MiB of headroom left.** The rehearsal established *that*
   growth was zero; this quantifies *why* and how much slack remains. Zero growth is not a permanent
   property of this file.

### One surprise, and it is benign

**`aaron.db-wal` and `aaron.db-shm` no longer exist after the run.** Before it they were 0 bytes and 32,768
bytes respectively, and `12-ENABLE.md` records them present throughout Plan 12-05. Their disappearance is
normal SQLite behavior — the last connection to close a WAL-mode database checkpoints and **deletes** both
sidecar files — and it is positive evidence that the backfill process closed the store cleanly
(`store.close()` in the command's `finally`) rather than being killed. It is **not** data loss: the WAL was
already checkpointed into the main file, `integrity_check` returns `ok`, and all 49,314 rows read back. Both
files will reappear on the next open. Recorded because a reader comparing the two documents' `ls` output
would otherwise see two files vanish from a 5 GB database and reasonably worry.

---

## Rollback — recorded although it was NOT needed (F8)

Not exercised. The run exited 0, `integrity_check` is `ok`, every identity assertion passed, and no vector
was written under a wrong identity, so there is nothing to roll back. Restore-from-backup is the only
recovery path (ADR 0051), and the sequence, had it been needed:

1. `memory daemon stop --db ~/.memory/aaron.db` (it was already stopped throughout).
2. **MOVE, never delete**, the live file:
   `mv ~/.memory/aaron.db ~/.memory/aaron.db.failed-<UTC-stamp>` — and move `-wal`/`-shm` alongside it.
3. `cp -c ~/.memory/aaron.db.pre-phase12 ~/.memory/aaron.db` (APFS clone).
4. `memory status --db ~/.memory/aaron.db --person aaron` and confirm `summary_vectors` back to **0**,
   `user_version` **3**, and the corpus counts matching `12-ENABLE.md`'s pre-run figures
   (138,373 / 49,314 / 89,059).
5. Leave the vendored model in place; delete the sidecar `~/.memory/aaron.db.embeddings.json`, since a
   corpus with no vectors under the ONNX identity should not advertise that identity.

**A partial backfill is NOT a rollback trigger** — it is resumable by design, and Plan 12-06 measured that
resume converging exactly (4,000 + 45,314 = 49,314). Roll back only for corruption or a wrong-identity
write. Neither occurred.

## What was NOT run

- **`memory prune-superseded` was not run.** Locked decision 3 declines it; the **89,059** superseded rows
  are still present, asserted unchanged above. No prune of any kind was run.
- **No synthetic events were written** to the live corpus.
- **No daemon was started** — next section.

---

## Task 3 — the daemon was deliberately NOT restarted

The plan's Task 3 calls for `memory daemon start` and a live SC1/SC2 observation window. **That half was
not executed, on the orchestrator's explicit instruction, and the reason is a real open gap rather than a
convenience.**

`12-REHEARSAL.md`'s **NOT COMPLETED** section records that **F11's `memory daemon once` repair check never
ran** — `once.log` is 0 lines and the Plan 12-06 executor died (server-side `API Error: 529 Overloaded`)
before the check executed. What *is* verified: Plan 12-04 wired `runEmbeddingRepair` into **both**
`drainOne` (`daemon.ts:198`) and `runOnce` (`daemon.ts:292`), orchestrator-verified in source and covered
by unit tests including the zero-query no-op assertion. What is **missing** is the end-to-end confirmation
on a real corpus that the repair pass actually fires under `once` mode. The rehearsal's own words: *"this is
not a blocker for 12-07 (the backfill does not involve the daemon, which stays stopped throughout), but it
must be closed before the daemon is started for real."*

Starting a resident daemon on the live corpus with that confirmation outstanding would be starting the
scheduler whose one unverified property is *whether its repair pass runs at all*. So:

- **The daemon remains stopped.** No process, no LaunchAgent, `daemon_lease` **0 rows** — verified after the
  backfill, exactly as before it.
- **SC1 live corroboration was not captured**, and no attempt was made to manufacture it. The definitive
  SC1 evidence remains Plan 12-03's unit tests (the post-commit embed stage driven by the committed summary
  set). This document adds none.
- **SC2 live corroboration was not captured either.** The strong structural argument stands unchanged from
  Plan 12-03 — the embed stage is O(committed summaries) with **zero queries** — but the "row count does not
  jump by 49,314" observation this plan was to make against a running daemon **was not made**.

**Follow-up, owned by no plan yet:** run the F11 `memory daemon once` repair check on a clone
(`daemon-once-probe.mjs` already exists from Plan 12-06 and was never executed), then start the daemon and
capture the SC1/SC2 observation window. Until then, incremental embedding is verified by unit test and by
source inspection, **not** on live data. The corpus's vectors are complete as of 2026-07-29 21:30 UTC and
nothing is keeping them current.

This is a deliberate, reported omission — **not** a claim that Task 3 passed.

## No phase sign-off claim

This plan makes **no** Phase 12 sign-off claim. Verification is `/gsd:verify-work 12`, not this document.
Two of Phase 12's four success criteria have live evidence here (SC4's completeness half in full; SC2's
structural argument unchanged); SC1's and SC2's live corroboration are outstanding per the section above.

## Suite

`npx vitest run` — **1,112 passed / 4 skipped**, exactly the baseline; exit 0. `npm run typecheck` clean,
exit 0. The corpus changed and the code did not, so a green suite is the expected result and a regression
would have meant something unexpected happened to the tree. Neither the tests nor `typecheck` read the live
corpus.

## Artifact hygiene

This document was scanned for secrets before staging: no Mission Control credential, no 64-hex API key, no
`Bearer`/`token=`/`password=` assignment. The only corpus-derived strings reproduced here are three summary
ids (opaque SHA-256 hex) and aggregate counts — no `summaryText` is quoted anywhere. Staged with explicit
paths only; no `git add -A`, no `git add .`, no `git stash`.
