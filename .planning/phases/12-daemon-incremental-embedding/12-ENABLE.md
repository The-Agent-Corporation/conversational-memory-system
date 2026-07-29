# Phase 12 — Enabling the ONNX embedder on the live corpus

Execution record for Plan 12-05. Every figure below is a measurement taken during this plan, not a
carried-forward assumption. Timezone labels are explicit throughout: `stat -f %Sm` renders **LOCAL**
time (EDT here), so every mtime is recorded twice, once in each zone.

Live corpus: `~/.memory/aaron.db`, person `aaron`.

---

## Task 1 — the daemon, stopped at the process level, with the database never opened

**No `memory` subcommand was run against the live database in this task.** Every one of them constructs
a non-`readOnly` `SqliteStore`, whose constructor runs pending migrations (`sqlite-store.ts:195-198`) —
and Plan 12-02 added a v4 index migration. The first open belongs to Task 3, after the backup is
verified. Every measurement below is either a filesystem call or a `readOnly: true` probe.

### There was nothing to stop

The plan is written to stop an actively-cycling daemon (`attempts: 4680`, `nextDueAt` within minutes as
of 2026-07-28). Measured now, nothing is running and no LaunchAgent is installed:

```
$ ps aux | grep -i -E "daemon-command|memory daemon|conversational-memory" | grep -v grep
(no matching process)

$ launchctl print "gui/501/com.conversational-memory.daemon"
Bad request.
Could not find service "com.conversational-memory.daemon" in domain for user gui: 501

$ launchctl list | grep -i conversational
(no conversational-memory job registered)

$ ls -l ~/Library/LaunchAgents/com.conversational-memory.daemon.plist
ls: /Users/aaronwhaley/Library/LaunchAgents/com.conversational-memory.daemon.plist: No such file or directory
```

The plist path and `gui/$(id -u)` domain were read from `daemon-command.ts:265-274` rather than guessed;
the label above is the one that build would install. **No LaunchAgent was installed** — the absence is
the expected state, not a fault to repair. `daemon_lease` holds **0 rows** (read-only probe, below), so
no writer lease is outstanding. Task 1's acceptance criteria pass trivially.

### The WAL is checkpointed (F7)

```
$ ls -l ~/.memory/aaron.db*
-rw-r--r--  1 aaronwhaley  staff  5031448576 Jul 28 10:56 aaron.db
-rw-r--r--  1 aaronwhaley  staff       32768 Jul 28 16:40 aaron.db-shm
-rw-r--r--  1 aaronwhaley  staff           0 Jul 28 10:57 aaron.db-wal
```

`aaron.db-wal` is **0 bytes** and `aaron.db-shm` is **32,768 bytes** — matching the 2026-07-28 reading,
verified rather than assumed. A `cp -c` of the main file alone is therefore internally consistent.

### `stat` on the live database

| field | value |
|---|---|
| inode | **171672602** |
| size | **5,031,448,576** bytes |
| mtime (LOCAL) | 2026-07-28 10:56:36 EDT |
| mtime (UTC) | 2026-07-28 14:56:36 UTC |

`pragma user_version` was **not** read in this task — that requires an open, and it belongs to Task 2's
read-only verification and Task 3's first real open.

---

## Task 2 — the backup, verified rather than re-taken

Per the orchestrator's 2026-07-28 update at the top of the plan: `~/.memory/aaron.db.pre-phase12` already
exists, taken immediately after Plan 12-02 landed schema v4 to close the window where the live corpus was
one non-read-only open away from a migration with no restore point. This task therefore **verifies** that
clone; taking a second one would be redundant and would put a second 5.0 GB file on disk for nothing.

### All five backups present, with the expected inodes

| file | inode | size (bytes) | mtime LOCAL | mtime UTC |
|---|---:|---:|---|---|
| `aaron.db` (live) | 171672602 | 5,031,448,576 | 2026-07-28 10:56:36 EDT | 2026-07-28 14:56:36 UTC |
| `aaron.db.pre-phase12` | **182055297** | **5,031,448,576** | **2026-07-28 10:56:36 EDT** | **2026-07-28 14:56:36 UTC** |
| `aaron.db.pre-v4` | 181531855 | 5,031,448,576 | 2026-07-27 21:55:36 EDT | 2026-07-28 01:55:36 UTC |
| `aaron.db.pre-rebuild-v3` | 181199709 | 5,031,448,576 | 2026-07-27 19:30:48 EDT | 2026-07-27 23:30:48 UTC |
| `aaron.db.pre-anchor-prune` | 180214168 | 5,031,448,576 | 2026-07-27 11:23:59 EDT | 2026-07-27 15:23:59 UTC |
| `aaron.db.pre-phase11` | 179000198 | 4,962,574,336 | 2026-07-26 19:26:45 EDT | 2026-07-26 23:26:45 UTC |

`pre-phase12`'s inode (182055297) matches the orchestrator's record exactly, its size matches the live
database exactly, and it **differs** from the live inode (171672602) — a clone, not a hardlink alias.
The four Phase 11 backups are present with unchanged inodes. Nothing in `~/.memory/` was deleted, moved,
or overwritten by this plan.

### The clone's contents, and proof the live corpus was not opened in the interim

Both probed with `new DatabaseSync(path, { readOnly: true })` — a read-only handle cannot run a
migration, so the probe itself cannot be what advances the schema.

```json
LIVE   { "user_version": 3, "summaries": 138373,
         "state_counts": [ { "superseded": 89059 }, { "compacted": 49314 } ],
         "summary_vectors": 0, "daemon_lease_rows": 0 }

BACKUP { "user_version": 3, "summaries": 138373,
         "state_counts": [ { "superseded": 89059 }, { "compacted": 49314 } ],
         "summary_vectors": 0, "daemon_lease_rows": 0 }
```

The live database still reads `user_version` **3**. Since any non-read-only open by this build would have
applied the pending v4 migration, this is direct evidence that **no such open happened between the clone
and now** — the backup captures the corpus exactly as it stands. The clone is byte-for-byte equivalent on
every count checked.

`aaron.db.pre-phase12-shm` (32,768) and `-wal` (0) exist alongside the clone from the verification reads;
the clone's main-file mtime is unchanged at 10:56:36 EDT, so nothing wrote to it.

### Baseline: the missing-set query BEFORE the v4 index

Taken read-only, replicating `sqlite-store.ts:1702-1720` verbatim against the composed ONNX identity, so
the post-migration figure has something to be compared against on the same hardware and the same file:

```json
{ "user_version": 3,
  "runs": [ { "run": 1, "ms": 3388.8, "rows": 49314 },
            { "run": 2, "ms": 462.0,  "rows": 49314 },
            { "run": 3, "ms": 461.0,  "rows": 49314 } ],
  "indexes": [ "sqlite_autoindex_summaries_1", "idx_summaries_person_state" ] }
```

Two things this pins down before anything is changed:

- **49,314 rows, already.** The state predicate from Plan 12-02 is in this build and is doing its job on
  live data: 138,373 summaries in the table, 49,314 candidates out of the query, 89,059 superseded rows
  correctly excluded. That measurement is what proves GAP-12-B is closed on the real corpus — see
  `12-GAP-12-B.md`.
- **`idx_summaries_state_id` is absent**, as expected at `user_version` 3. Cold 3,389 ms / warm 461 ms is
  the "without the covering index" cost the v4 migration exists to remove.

Disk free before the vendor fetch: **408 Gi** available on `/System/Volumes/Data` (1.8 Ti, 78% used).

### Owner authorization for the network fetch

**Granted 2026-07-29.** The owner was shown exactly what this plan does — the `memory embeddings enable`
network model download, and the first non-read-only open triggering the schema v4 migration on the 5.0 GB
live corpus — and replied **"keep going"**.

Recorded per the checkpoint's requirement; the checkpoint is not re-opened. The facts as put to the owner:

- `memory embeddings --action enable` is the only CLI path in this codebase that touches the network. It
  fetches five fp32 files (~134 MB) from the Hugging Face Hub at pinned revision
  `ea104dacec62c0de699686887e3f920caeb4f3e3` and sha256-verifies every one against
  `BGE_SMALL_EN_V1_5_MANIFEST` before returning.
- It writes to `~/.memory/aaron.db.models/` and `~/.memory/aaron.db.embeddings.json`. It does not write
  to the database file.
- Until the backfill (Plan 12-07) the corpus has zero vectors under the ONNX identity — which is also
  true today under the hash identity, so nothing regresses.
- Locked decision 1 already authorizes ONNX as the target; this is authorization for the fetch itself.

---

## Task 3 — first open, schema v4, and a vendor that does not work

### The first non-read-only open, and the migration

`memory daemon status --db ~/.memory/aaron.db --person aaron`. Arg surface confirmed against
`parseDaemonCommandArgs` (`daemon-command.ts:74-97`) before running — `--db` and `--person` only, after
the subcommand — rather than trusted from the docs.

| | value |
|---|---|
| `pragma user_version` before (read-only probe) | **3** |
| `pragma user_version` after | **4** |
| first-open wall clock | **6,102 ms** |
| re-open #1 / #2 (idempotence) | **639 ms** / **486 ms** |
| implied migration cost | **≈5.5 s** |

Exit 0. Output:

```json
{ "ok": true, "subcommand": "status",
  "status": { "state": "stopped", "ownerToken": null, "pid": null, "acquiredAt": null,
              "heartbeatAt": null, "expiresAt": null, "stopRequestedAt": null,
              "lastSuccessfulScanAt": null, "degradedSources": [],
              "queues": { "contractions": 0, "proposals": 1 },
              "service": { "capable": true, "loaded": false, "pid": null } } }
```

State `stopped`, no owner token, no pid, service not loaded — the daemon is confirmed stopped from
inside the database as well as from the OS.

**Divergence worth recording: 5.5 s, not the 1.16 s Plan 12-02 measured.** Same DDL, same row count.
12-02's figure came from a clone measured in isolation; this is a cold first touch of a 5.0 GB file whose
pages are not in the page cache, on a volume at 78% capacity. The migration is a one-time cost and it
succeeded, so this is a note rather than a fault — but 12-02's 1.16 s should be read as a floor, not an
estimate. Re-opens settle at ~490-640 ms, of which most is `tsx` startup.

Migration ledger and indexes after:

```json
{ "user_version": 4,
  "summary_indexes": [ "sqlite_autoindex_summaries_1", "idx_summaries_person_state",
                       "idx_summaries_state_id" ],
  "migrations": [ { "version": 1, "description": "baseline: tables created by SqliteStore.migrate() base block are version 1" },
                  { "version": 2, "description": "REQ-041: add summary_vectors table for local vector-native summary embeddings" },
                  { "version": 3, "description": "GAP-11-A: index summaries by person and state for filtered retrieval" },
                  { "version": 4, "description": "REQ-043: covering index for the state-predicated missing-vector query" } ] }
```

### The gate that matters: the missing-set query on live data

Same read-only probe as the pre-migration baseline, same file, same hardware, same composed identity —
only `idx_summaries_state_id` differs:

| | rows | run 1 | run 2 | run 3 |
|---|---:|---:|---:|---:|
| **before** (`user_version` 3, no covering index) | 49,314 | 3,388.8 ms | 462.0 ms | 461.0 ms |
| **after** (`user_version` 4) | 49,314 | **26.1 ms** | **26.0 ms** | **24.6 ms** |

**~25 ms, against a 29-45 ms expectation and a 4,000 ms failure mode.** The index took. Plan 12-04's
repair pass will run a 25 ms query every 15 minutes, not a 4-second scan. An 18× improvement on the warm
figure and 130× on the cold one.

And the count is **49,314** on both sides of the migration — 138,373 rows in `summaries`, 89,059
superseded rows correctly excluded by Plan 12-02's state predicate, on the live corpus. Not 138,373.
This is GAP-12-B closed on real data (`12-GAP-12-B.md`), and it was already true at `user_version` 3,
which isolates the two changes cleanly: the **predicate** fixes the count, the **index** fixes the cost.

### Row-count invariance

| | before | after |
|---|---:|---:|
| `summaries` | 138,373 | 138,373 |
| ├ `compacted` | 49,314 | 49,314 |
| └ `superseded` | 89,059 | 89,059 |
| `summary_vectors` | 0 | 0 |
| `daemon_lease` | 0 | 0 |

Nothing was written to any row. The file's mtime, size, and `-wal`/`-shm` changed as the plan anticipated
(F4) — the v4 index, `pragma journal_mode = WAL`, and the recorded stop request all touch the file.

### The graceful stop

`memory daemon stop --db ~/.memory/aaron.db` → `{ "ok": true, "subcommand": "stop",
"service": { "capable": true, "loaded": false, "pid": null } }`. Idempotent, as expected against an
already-absent process. **The daemon remains stopped and no backfill was run.**

---

## STOP — `memory embeddings --action enable` is broken, and it is not a transient failure

```
$ memory embeddings --db ~/.memory/aaron.db --action enable
ENOENT: no such file or directory, open '/Users/aaronwhaley/.memory/aaron.db.models/Xenova/bge-small-en-v1.5/onnx/model.onnx'
```

Backgrounded to a log and polled; it exited within ~10 s.

### T-12-25 holds — the failure mode is safe

Verified explicitly rather than assumed, which is the property the plan asked for:

```
$ ls -l ~/.memory/aaron.db.embeddings.json
ls: ... No such file or directory

$ memory embeddings --db ~/.memory/aaron.db --action show
{ "ok": true, "action": "show",
  "config": { "enabled": false, "provider": "onnx-transformers",
              "model": "Xenova/bge-small-en-v1.5", "revision": "", "modelPath": "" } }

$ find ~/.memory/aaron.db.models -type f
(directory does not exist)
```

**No sidecar, `enabled: false`, and not one partial file.** `runEmbeddingsCommand` awaits `vendorModel`
before it builds `nextConfig` (`embeddings-command.ts:65-73`), so the throw skipped
`writeEmbeddingsConfig` entirely. `resolveEmbedder` keeps returning the hash embedder. The sidecar was
**not** hand-edited. The live corpus is exactly where it was, plus schema v4.

### Two defects in `vendorModel`, both deterministic

**D1 — the download never lands where verification reads.** `vendorModel`
(`model-vendor.ts:49-65`) sets `env.localModelPath = localModelPath` and then calls `pipeline()`. But in
transformers.js `localModelPath` is the path *local models are read from*; remote downloads are written to
`env.cacheDir`, which is untouched and therefore still the default
`node_modules/@huggingface/transformers/.cache`. `verifyManifest` then reads
`${localModelPath}/${repo}/${relPath}` — a path nothing ever writes. Proof, from the actual cache:

```
node_modules/@huggingface/transformers/.cache/Xenova/bge-small-en-v1.5/config.json
node_modules/@huggingface/transformers/.cache/Xenova/bge-small-en-v1.5/ea104dac…/config.json
node_modules/@huggingface/transformers/.cache/Xenova/bge-small-en-v1.5/ea104dac…/tokenizer.json
node_modules/@huggingface/transformers/.cache/Xenova/bge-small-en-v1.5/ea104dac…/tokenizer_config.json
node_modules/@huggingface/transformers/.cache/Xenova/bge-small-en-v1.5/ea104dac…/onnx/model.onnx
```

Note the layout is **revision-nested** (`<repo>/<revision>/<file>`), not the flat `<repo>/<file>` layout
that both `verifyManifest` and `TransformerEmbedder`'s `env.localModelPath` read. Setting `cacheDir` to
the target alone therefore does not fix it either — the layouts differ.

**D2 — the manifest demands a file the fetch never requests.** Four of the manifest's five files are in
the cache and all four hash **exactly** to the pinned values:

| file | cached sha256 | manifest | match |
|---|---|---|---|
| `onnx/model.onnx` | `828e1496…40cf35` | `828e1496…40cf35` | ✅ |
| `tokenizer.json` | `d241a60d…9e5c66` | `d241a60d…9e5c66` | ✅ |
| `tokenizer_config.json` | `9261e7d7…172ab3` | `9261e7d7…172ab3` | ✅ |
| `config.json` | `fa73f90b…a56350` | `fa73f90b…a56350` | ✅ |
| `special_tokens_map.json` | **absent from the cache entirely** | `b6d346be…37ee3` | ❌ |

`pipeline("feature-extraction", …)` does not request `special_tokens_map.json` for this model. So even
after D1 is fixed, `verifyManifest` fails on file five. **Both defects must be fixed together**; fixing
only the path converts one ENOENT into another.

The manifest itself is not wrong — the gitignored fixture at `tests/fixtures/models/Xenova/bge-small-en-v1.5`
holds all five files in the flat layout and every one matches its pinned hash, `special_tokens_map.json`
included (125 bytes, `b6d346be…37ee3`). That fixture was assembled by hand from the cache during the
Phase 9 plan-05 capture, which is why the manifest is correct while the code that is supposed to
reproduce it is not.

### Why this was never caught

`tests/embeddings/model-vendor.test.ts:36` is `describe.runIf(RUN_NETWORK_TESTS)`, gated on
`MEMORY_RUN_NETWORK_TESTS=1`. Its first case is literally *"writes the pinned fp32 file set under
localModelPath"* — the exact assertion that fails here. **These are the 4 skipped tests in the
1,106-passed / 4-skipped suite.** The golden tests pass because they read the hand-assembled fixture, not
because vendoring works.

### No network transfer happened today

Every cached file is dated **2026-07-21 16:18 EDT / 20:18 UTC** — the Phase 9 capture. Nothing was
written today. The run was served entirely from the transformers cache, so the network fetch the owner
authorized has *not* in fact been exercised, and its behavior on a cold cache remains unproven.

### Why this is a STOP rather than a Rule 1 auto-fix

The plan and the briefing both pre-authorize this stop ("If the vendor fails, STOP and report; do not
retry blindly"). Retrying is pointless — the failure is deterministic, not transient. And the fix is not
mechanical: it changes the only network path in the codebase and the mechanism behind T-12-24's integrity
guarantee, and there are at least three defensible designs:

1. **Fetch the five pinned files directly** over HTTPS from
   `https://huggingface.co/{repo}/resolve/{revision}/{file}`, write them straight into the flat layout,
   then verify. Most auditable — exactly five pinned URLs, exactly the manifest's files, no dependence on
   library cache semantics — and it fixes D1 and D2 in one move. Loses the incidental "`pipeline()` proved
   it loads" property, which a post-vendor `probeEmbedderHealth` covers better anyway.
2. **Keep `pipeline()`, then materialize** the four files it fetched from `cacheDir` into the flat layout
   and fetch `special_tokens_map.json` separately. Preserves the load proof; keeps a dependency on an
   undocumented cache layout that a transformers.js upgrade can change silently.
3. **Drop `special_tokens_map.json` from the manifest.** Fixes D2 by weakening the guarantee. Not
   recommended — the file is part of the tokenizer contract and the fixture proves it is fetchable.

**Recommendation: option 1**, plus flipping the network-gated vendor test into something that runs — even
a cold-cache CI-optional job — since a test that never executes is what let this ship. Whichever is
chosen, the fix belongs in its own plan with its own tests, not in a hand-edit here.

### State left behind, for whoever picks this up

- Live corpus at **`user_version` 4** with `idx_summaries_state_id` built. Not reverted: the migration is
  additive, verified, and is exactly what the next attempt needs. All row counts unchanged.
- **Hash embedder still active.** No sidecar, no `~/.memory/aaron.db.models` directory.
- Daemon stopped, `daemon_lease` empty, no LaunchAgent installed. **No backfill run.**
- All five backups intact at the inodes tabulated above.
- Disk free unchanged at **408 Gi** (nothing was downloaded).
- Rollback was **not** exercised and is not needed — nothing to roll back beyond the intended migration.

Tasks 1 and 2 are complete and their measurements stand. Task 3 is complete through the migration and the
missing-set gate; it stops at the vendor.
