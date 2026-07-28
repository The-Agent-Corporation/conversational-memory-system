# Phase 11 — `hygiene-rules/v4` Rebuild + 330-Anchor Prune (Plan 11-29)

**Status:** Task 1 (rehearsal) complete. Tasks 2–3 recorded below as they happen.

Owner decision, 2026-07-28, verbatim: **"Prune 330 AND fix the silent-sentinel rule."** Plan 11-28
shipped the rule (`hygiene-rules/v4`). This plan does the corpus.

**Git commit at rehearsal:** `91bb4a0dacc90573863c16d3473059fc62c86952`

> **Timezone convention, stated once.** `stat -f %Sm` on this machine renders **local time (EDT,
> UTC−4)**. Every `mtime` in this document is labelled explicitly. Wall-clock run timings come from
> `date -u` and are true UTC.

---

## Live state entering this plan (measured, read-only, before anything ran)

Measured at 2026-07-28T14:20Z with a from-scratch read-only script
(`scratchpad/1129-measure.ts`, opened `readOnly: true`, never writes) that drives the **shipped**
`classifyEvent` and enriches each anchor with its resolved canonical event's `role`/`eventKind` —
the same inputs `commitUnhygienicAnchorPrune` uses.

| metric | value |
|---|---:|
| canonical events | 292,407 |
| turns | 584,814 |
| summaries — active (`compacted`) | 49,253 |
| summaries — superseded | 89,120 |
| summaries — total rows | 138,373 |
| anchors | 19,268 |
| summary vectors | 0 |
| boxes / traces / proposals | 0 / 0 / 0 |
| injections | 30 |
| file size (bytes) | 5,031,448,576 |
| `pragma user_version` | 3 |
| checkpoint `processorVersion` | `continuous-contraction/v1+hygiene-rules/v3` |
| checkpoint `generation` | 3 |
| checkpoint `sliceCount` | 3,510 |
| checkpoint `immediateStage` | complete |

Every figure matches the state the plan's `<interfaces>` block recorded. No drift.

### Anchor classification census at `hygiene-rules/v4`, before any write

```json
{
  "totalCount": 19268,
  "countsByClass": { "conversational": 18938, "tool_activity": 0, "synthetic_injected": 330 },
  "unhygienicCount": 330,
  "unhygienicPayloadBytes": 4104307,
  "unattributedCount": 0,
  "byRule": { "task-notification": 329, "harness-system": 1 }
}
```

**The store's own recomputation already yields exactly the authorized 330.** The plan's expectation
(`conversational 18,938 · synthetic_injected 330`, split 329 task-notification + 1 harness-system) is
confirmed to the row, independently, before any command ran.

### The 20 silent-sentinel anchors, named by id

These are the anchors whose canonical event is `role: assistant` and carries a `[SILENT]`-led line,
and which classify **`conversational`** under v4 — i.e. exactly the population Plan 11-28's
`isSentinelOnly` flipped back, and exactly what the owner's decision protects. They are listed here
so "the 20 survived" is checkable against a written set rather than a count.

| # | anchor id | type | createdAt | content opening |
|---:|---|---|---|---|
| 1 | `anchor_personal_turn_event_00b094f86cd8ae7f29b1e677dd50bd8fa6550493b38a09ef7488532a55d4c9ba_decision` | decision | 2026-05-06T23:31:50.796Z | PID 89914 is not alive. Per decision logic A → `[SILENT]`. |
| 2 | `anchor_personal_turn_event_1c54fa3f76a26dd54d5d67451e081cbb83416608b3153068a21824504a1cddb1_key_fact` | key_fact | 2026-05-06T17:13:00.038Z | Confirmed — the McCay email was already processed fully (including strong summary…) |
| 3 | `anchor_personal_turn_event_365129924f1b4c100db747e2380c3b8a12653c791b72214c1e7cbd048c724465_decision` | decision | 2026-05-07T10:24:21.751Z | Everything workable is already `awaiting_owner` (assigned to Hermes but awaiting…) |
| 4 | `anchor_personal_turn_event_38c0728153ca6a01ff78640a5770f4df28d3c7a3b7f46fedc37bebe2ec8b9a7b_decision` | decision | 2026-05-07T00:04:20.421Z | PID 89914 is not alive. Per decision rule A → SILENT. |
| 5 | `anchor_personal_turn_event_5c455351d2d3e87723fd04040940c0c24dffffa7ac4aa480a70523c3f98d620b_decision` | decision | 2026-05-06T23:19:04.003Z | PID 89914 is not alive. Per decision logic A, exit notification handling is separate… |
| 6 | `anchor_personal_turn_event_5e7c015d2248e92792836a600cde208a1973b19ddec932b0bfc4328b5bcbde30_decision` | decision | 2026-05-06T23:48:09.656Z | PID 89914 is not alive. Per decision logic A: if PID not alive and exit notification… |
| 7 | `anchor_personal_turn_event_60de76f3f061899403a5cfabf231ae72fcb930627a18710b344caaadb08ece14_key_fact` | key_fact | 2026-05-06T17:26:07.255Z | Confirmed: 0 eligible tasks. **Run log:** - Preflight: MC_URL/MC_API_KEY resolve… |
| 8 | `anchor_personal_turn_event_674b18b825634a6fc7bebd10da377e066d6624f20ae7bbaac8d2f680d75b64d1_decision` | decision | 2026-05-06T23:42:54.954Z | PID 89914 is not alive. Per decision logic A, respond [SILENT] since Hermes handles… |
| 9 | `anchor_personal_turn_event_7ef74441e1441efa11f292c95f210f33ac2b2662a54b843eb05cebbd3aefb2cd_decision` | decision | 2026-05-06T22:19:19.581Z | All 12 Roscoe verification tasks are currently `awaiting_owner` under Hermes — waiting… |
| 10 | `anchor_personal_turn_event_991ba233ce5761b1b2dd05787891c9573b694317989575f0b8821cbfedfd62dd_decision` | decision | 2026-05-06T23:37:07.267Z | Process not alive, minimal log. Per decision A → SILENT. |
| 11 | `anchor_personal_turn_event_c17d112f000d73da565fdb21a4c35e4b0e24fa9ac34a6d23cefd346e7e4bc440_decision` | decision | 2026-05-06T23:26:14.080Z | PID 89914 is not alive. Per decision rule A, exit notification should have fired… |
| 12 | `anchor_personal_turn_event_c72d90475e02e8656ca8a7bc6aa34a0d76f2bb071608922e21c0e53433611b64_decision` | decision | 2026-05-06T23:59:07.155Z | PID 89914 is not alive. Per decision logic A, exit notification is handled separately… |
| 13 | `anchor_personal_turn_event_c92bb96c03b448165e5c707ca3a70ce87febe1c5a70c5230a921f75ea284a795_key_fact` | key_fact | 2026-05-06T12:26:43.834Z | Confirmed. The prior run at 23:01 (27 minutes ago) already delivered a detailed… |
| 14 | `anchor_personal_turn_event_ca79ac06e1c231ee0c1e214244359b928182b2bf5a3d4222ea5427a51740bdd1_decision` | decision | 2026-05-07T00:26:33.463Z | PID 89914 is not alive. Per decision rule A, suppress. |
| 15 | `anchor_personal_turn_event_db928376e37f4d9ba565c9d37fe2ad780a0f5bc3e839c814e261d5f4fd9713c1_key_fact` | key_fact | 2026-05-06T12:23:34.438Z | Confirmed. The prior run at 23:01 (27 minutes ago) already delivered a detailed… |
| 16 | `anchor_personal_turn_event_e70535d4f17a22d69c25cb5b4a7c511deacc8bf329eb0995976dc082b02611f9_decision` | decision | 2026-05-07T00:31:45.153Z | PID 89914 is not alive. Per decision rule A, respond silent. |
| 17 | `anchor_personal_turn_event_eb2ae8974660f002d27ff3f1019a25ba8d1e2149c11a53adb0a1448a2c5e4707_key_fact` | key_fact | 2026-05-06T10:40:04.961Z | Confirmed: the only `assigned` task is Aaron's (excluded by rule), all Hermes-owned… |
| 18 | `anchor_personal_turn_event_fa8554ac70bf842228be87f7bea854a4c141bca90e7cb2ac2428713408f11f3b_key_fact` | key_fact | 2026-05-06T03:20:33.548Z | Confirmed. The prior run at 23:01 (27 minutes ago) already delivered a detailed… |
| 19 | `anchor_personal_turn_event_fc65c36e90fd628ed0c9b05883adbfc96c7631c16fe06cdd2f8d086ddaef2c2b_decision` | decision | 2026-05-07T00:15:32.266Z | PID 89914 is not alive. Per decision rule A, respond silently. |
| 20 | `anchor_personal_turn_event_fe20b675cff4ae197d2b7704097b35934ebc9f6e0663788b4b9a13885d2c5192_decision` | decision | 2026-05-06T23:53:52.908Z | PID 89914 is not alive. Per decision rule A, respond silently so Hermes can handle… |

The shape matches `11-GAP-11-H.md`'s characterization exactly: 12 near-duplicate `PID 89914` decisions
plus 8 items of genuine operational memory (McCay email, the 12 Roscoe `awaiting_owner` tasks, the
23:01 preflight-blocker report, the 0-eligible-task run logs).

---

# Task 1 — Rehearsal on a clone

The live database was never a target in this task. Full sequence — rebuild → dry-run prune →
`--apply` prune — run against one `cp -c` clone.

| artifact | path | inode |
|---|---|---:|
| clone | `…/scratchpad/rehearsal-v4.db` | 181516888 |
| clone's own backup (for the `--confirm-backup` gate) | `…/scratchpad/rehearsal-v4.db.bak` | 181531250 |

Scratchpad root:
`/private/tmp/claude-501/-Users-aaronwhaley-Agent-Corporation-conversational-memory-system/6ea0c5f7-ef88-4139-838b-47b0e29baa9d/scratchpad`

The clone was taken at 2026-07-28T14:21:01Z, `cp -c` (APFS clone), 5,031,448,576 bytes, mtime
identical to the source — a byte-for-byte image of the current live state at a distinct inode.

## Staleness / `--force`

**`--force` was not required and was never passed.** Plan 11-28's bump to `hygiene-rules/v4` marked
the checkpoint stale on its own, exactly as GAP-11-H predicted:

| | value |
|---|---|
| clone checkpoint `processorVersion` (before) | `continuous-contraction/v1+hygiene-rules/v3` |
| code `PROCESSOR_VERSION` | `continuous-contraction/v1+hygiene-rules/v4` |
| `HYGIENE_RULE_VERSION` | `hygiene-rules/v4` |
| `checkpoint.processorVersion !== PROCESSOR_VERSION` | true → `isStale` → full rewind |

Stop condition (d) — "`--force` turns out to be required" — **not tripped.**

Command, identical to the live invocation modulo `--db`:

```
NODE_OPTIONS=--max-old-space-size=8192 npx tsx src/cli/bin.ts \
  rebuild-derivations --db <clone> --person aaron
```

Note the flag is **`--db`**, not `--database`; `11-REBUILD.md` recorded that documentation defect and
this plan's `<interfaces>` block carries the correction.

## Rebuild receipt (verbatim)

**Elapsed: 9 min 41 s** (`2026-07-28T14:21:10Z` → `2026-07-28T14:30:51Z` UTC), 1,170 progress lines,
1,170 slices at 250 events per slice, ≈503 events/sec.

```json
{
  "ok": true,
  "rebuilt": true,
  "personId": "aaron",
  "hygieneRuleVersion": "hygiene-rules/v4",
  "processorVersion": "continuous-contraction/v1+hygiene-rules/v4",
  "slices": 1170,
  "processedEvents": 292407,
  "summariesWritten": 50483,
  "supersededSummaries": 49137
}
```

Final progress line, verbatim:

```json
{"event":"progress","slices":1170,"processedEvents":292407,"complete":true}
```

## Prune dry-run receipt (verbatim)

`2026-07-28T14:31:25Z` → `14:31:27Z`, ~2 s.

```json
{
  "ok": true,
  "applied": false,
  "personId": "aaron",
  "totalCount": 19268,
  "countsByClass": {
    "conversational": 18938,
    "tool_activity": 0,
    "synthetic_injected": 330
  },
  "unhygienicCount": 330,
  "unhygienicPayloadBytes": 4104307,
  "unattributedCount": 0,
  "prunedCount": 0,
  "prunedByClass": {
    "tool_activity": 0,
    "synthetic_injected": 0
  },
  "skippedByReason": {},
  "freedPayloadBytes": 0,
  "batches": 0
}
```

## Prune apply receipt (verbatim)

`2026-07-28T14:31:39Z` → `14:31:45Z`, ~6 s, 39 batches at batch size 500.

**No anchor id was hand-selected.** The command pages `listAnchorIds` and hands each full page to
`commitUnhygienicAnchorPrune`, which recomputes eligibility authoritatively inside its own
transaction — `anchorIds` is a request, never an authorization (T-11-100). The 330 is the store's own
classification of a 19,268-anchor candidate set, not a list this executor supplied.

```json
{
  "ok": true,
  "applied": true,
  "personId": "aaron",
  "totalCount": 19268,
  "countsByClass": {
    "conversational": 18938,
    "tool_activity": 0,
    "synthetic_injected": 330
  },
  "unhygienicCount": 330,
  "unhygienicPayloadBytes": 4104307,
  "unattributedCount": 0,
  "prunedCount": 330,
  "prunedByClass": {
    "tool_activity": 0,
    "synthetic_injected": 330
  },
  "skippedByReason": {
    "retained_conversational": 18938
  },
  "freedPayloadBytes": 4104307,
  "batches": 39,
  "backupPath": ".../scratchpad/rehearsal-v4.db.bak",
  "backupBytes": 5031448576
}
```

`skippedByReason` has exactly one key. No `person_mismatch` / `person_unattributed` skips occurred.

## Before / after counts (clone)

| metric | before | after rebuild | after prune | net delta |
|---|---:|---:|---:|---:|
| canonical events | 292,407 | 292,407 | 292,407 | 0 |
| turns | 584,814 | 584,814 | 584,814 | 0 |
| summaries — **active** | 49,253 | **49,314** | 49,314 | **+61** |
| summaries — **superseded** | 89,120 | **89,059** | 89,059 | **−61** |
| summaries — total rows | 138,373 | 138,373 | 138,373 | 0 |
| **anchors** | 19,268 | 19,268 | **18,938** | **−330** |
| summary vectors | 0 | 0 | 0 | 0 |
| boxes / traces / proposals | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 |
| injections | 30 | 30 | 30 | 0 |
| file size (bytes) | 5,031,448,576 | 5,031,448,576 | 5,031,448,576 | 0 |
| `pragma user_version` | 3 | 3 | 3 | 0 |
| checkpoint `processorVersion` | `…+hygiene-rules/v3` | `…+hygiene-rules/v4` | `…+hygiene-rules/v4` | — |
| checkpoint `generation` | 3 | 4 | 4 | +1 |
| checkpoint `sliceCount` | 3,510 | 4,680 | 4,680 | +1,170 |
| checkpoint `immediateStage` | complete | complete | complete | — |

### Anchor classification census, clone

| | before | after rebuild | after prune |
|---|---:|---:|---:|
| conversational | 18,938 | 18,938 | **18,938** |
| tool_activity | 0 | 0 | **0** |
| synthetic_injected | 330 | 330 | **0** |
| unhygienic payload bytes | 4,104,307 | 4,104,307 | **0** |
| unattributed | 0 | 0 | 0 |

## Arithmetic checks

> active +61 + superseded −61 = total 0 ✓ (138,373 before and after)
> anchors 19,268 − 330 = 18,938 ✓, matching both the receipt's `prunedCount` and the id-level diff
> checkpoint `sliceCount` 3,510 + receipt `slices` 1,170 = 4,680 ✓

**Reconciling `summariesWritten: 50,483` against a total row count that did not move.** As
`11-REBUILD.md` established for the v3 run, the writes are overwhelmingly **upserts, not inserts**:
`rebuild-derivations` deliberately reuses `historicalContractionJobId` so it supersedes and rewrites
the existing summary set under the same deterministic ids (`summaryId(personId, firstEventId,
topicLabel)`) rather than deriving a parallel one. Likewise `supersededSummaries: 49,137` far exceeds
the net superseded movement because the invalidator supersedes a summary and the same run re-derives
and re-writes it active under the same id.

**The direction of the +61/−61 movement is the point of this plan.** The v3 rebuild left 1,393
summaries superseded and never re-derived — the ones v3's rules eliminated outright. At v4, 61 of
those come back: the 123 trailing-sentinel events are `conversational` again, so windows that v3
emptied now carry content and re-derive. Restoring the 123 events' text is what this rebuild is for,
and 61 net active summaries is the shape that restoration takes.

**File size did not shrink and was never going to.** 5,031,448,576 bytes at every measurement point.
SQLite does not release pages without a `VACUUM`, which neither command runs. `freedPayloadBytes`
(4,104,307 — ~3.9 MB) is logical payload freed inside existing pages, not disk reclaimed.

## The three stop conditions, checked explicitly

### 1. The prune names exactly 330, and the 20 survive — **PASS**

- Receipt `prunedCount`: **330**. Not 350, not any other number.
- `prunedByClass`: `{ tool_activity: 0, synthetic_injected: 330 }`.
- Id-level diff (post-rebuild anchor ids minus post-prune anchor ids): **330 ids**, and that set is
  **identical** to the 330 ids my independent pre-apply census classified as eligible.
- **All 20 silent-sentinel anchors are present after `--apply`: 20 / 20**, verified by matching the
  id list above against the post-prune anchor id dump.
- **Intersection of the 20 with the deleted set: 0.**

### 2. Zero resurrection — **PASS**

Plan 11-18's deleted set was reconstructed the way Plan 11-27 did: difference the anchor ids in
`~/.memory/aaron.db.pre-anchor-prune` against those in the live `~/.memory/aaron.db` immediately
before this plan.

| set | count |
|---|---:|
| anchors in `.pre-anchor-prune` | 45,911 |
| anchors in live corpus now | 19,268 |
| **reconstructed 11-18 deleted set** | **26,643** — matches 11-18's `prunedCount: 26643` exactly |
| deleted set ∩ clone anchors after rebuild | **0** |
| deleted set ∩ clone anchors after prune | **0** |
| pre-rebuild live anchors dropped by the rebuild | 0 |
| brand-new anchors never seen before | 0 |

The post-rebuild anchor id set is **identical** to the pre-rebuild live set (19,268 ids, no
difference either way). Plan 11-27's fix continues to hold at v4.

### 3. Dry-run / apply parity — **PASS**

| | value |
|---|---:|
| dry-run `unhygienicCount` (preview) | 330 |
| apply `prunedCount` (receipt) | 330 |
| id-level diff of the anchor tables | 330 |

Parity holds. Plan 11-18's 851-row under-report (fixed in `b7ae28b` by enriching the preview with the
resolved event's role/eventKind) does not recur.

### 4. `--force` not required — **PASS**, see "Staleness" above.

## Live database untouched by Task 1

`stat` on `~/.memory/aaron.db`, before Task 1 and after it, unchanged in every field:

| when | inode | size | mtime (local, EDT) | mtime (UTC) |
|---|---:|---:|---|---|
| before Task 1 (2026-07-28T14:20Z) | 171672602 | 5,031,448,576 | 2026-07-27T21:55:36 | 2026-07-28T01:55:36Z |
| after Task 1 (2026-07-28T14:33Z) | 171672602 | 5,031,448,576 | 2026-07-27T21:55:36 | 2026-07-28T01:55:36Z |

`~/.memory/aaron.db-wal` is 0 bytes, so there is no uncheckpointed content outside the file. All
three pre-existing backups are present at their original inodes, sizes, and mtimes — none was
deleted, moved, or overwritten:

| path | inode | size | mtime (local, EDT) | mtime (UTC) |
|---|---:|---:|---|---|
| `~/.memory/aaron.db.pre-rebuild-v3` | 181199709 | 5,031,448,576 | 2026-07-27T19:30:48 | 2026-07-27T23:30:48Z |
| `~/.memory/aaron.db.pre-anchor-prune` | 180214168 | 5,031,448,576 | 2026-07-27T11:23:59 | 2026-07-27T15:23:59Z |
| `~/.memory/aaron.db.pre-phase11` | 179000198 | 4,962,574,336 | 2026-07-26T19:26:45 | 2026-07-26T23:26:45Z |

## Prediction for the live run, recorded before it runs

Measured on a clone, not estimated:

- ~9 min 41 s of rebuild wall clock plus ~8 s of prune; the corpus is degraded for memory purposes
  during the rebuild and stays degraded if it is interrupted before it finishes.
- Active summaries 49,253 → 49,314; superseded 89,120 → 89,059; total rows unchanged at 138,373.
- Anchors 19,268 → 19,268 through the rebuild, then → **18,938** after the prune. Unhygienic anchors
  330 → 0.
- Canonical events, turns, `user_version`, boxes/traces/proposals, summary vectors, and **file size
  all unchanged**. No disk space is reclaimed.
- Checkpoint moves to `continuous-contraction/v1+hygiene-rules/v4`, generation 4, sliceCount 4,680.
- Resurrection 0; all 20 silent-sentinel anchors survive.
