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
