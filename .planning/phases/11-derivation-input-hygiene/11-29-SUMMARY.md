---
phase: 11-derivation-input-hygiene
plan: 29
subsystem: corpus-operations
tags: [rebuild, anchor-prune, gap-closure, live-corpus, owner-authorized, GAP-11-H]

requires:
  - phase: 11-derivation-input-hygiene
    provides: "Plan 11-28's hygiene-rules/v4 silent-sentinel narrowing, whose 123 flipped events this rebuild restores to the derived corpus"
  - phase: 11-derivation-input-hygiene
    provides: "Plan 11-27's anchor-gate fix, which keeps rebuild-driven anchor resurrection at 0"
provides:
  - "The live corpus at continuous-contraction/v1+hygiene-rules/v4, generation 4, sliceCount 4,680"
  - "330 scaffolding anchors deleted (329 task-notification + 1 harness-system); anchors 19,268 -> 18,938, unhygienic 330 -> 0"
  - "The 20 silent-sentinel anchors preserved, named by id in 11-REBUILD-V4.md"
  - "A fourth backup at ~/.memory/aaron.db.pre-v4 (inode 181531855)"
  - "The post-v4 recall-probe column, fifth arm on the frozen 12-query harness"
affects: [11-14 SC7 sign-off, any future rebuild or prune of the live corpus]

tech-stack:
  added: []
  patterns:
    - "Rehearse the FULL sequence on a cp -c clone at the same commit the live run will use, then compare id sets, not counts"

key-files:
  created:
    - .planning/phases/11-derivation-input-hygiene/11-REBUILD-V4.md
    - .planning/phases/11-derivation-input-hygiene/probe-v2/post-v4.json
    - .planning/phases/11-derivation-input-hygiene/probe-v2/post-v4.md
  modified:
    - .planning/phases/11-derivation-input-hygiene/11-RECALL-PROBE-V2.md

key-decisions:
  - "The prune's candidate set was the full 19,268-anchor page walk; no anchor id was hand-selected, so the 330 is the store's own recomputed classification (T-11-100)"
  - "The 20 silent-sentinel anchors were identified and written down by id BEFORE any write, so 'the 20 survived' is checkable against a written set rather than a count"
  - "Rebuild first, prune second, so the prune's eligibility is recomputed against the final corpus state"

requirements-completed: [REQ-052, REQ-053, REQ-054]

duration: 45min
completed: 2026-07-28
---

# Phase 11 Plan 29: Apply `hygiene-rules/v4` and prune the 330 Summary

**The live corpus now runs at `hygiene-rules/v4` with the 123 trailing-sentinel events' reasoning back in the derived corpus and 330 unambiguous scaffolding anchors deleted — while all 20 anchors that carry real reasoning behind a `[SILENT]` sentinel survive, verified by id.**

## Performance

- **Duration:** ~45 min wall clock (14:20Z → 15:05Z), of which ~20 min is two full rebuilds and ~11 min the recall probe
- **Tasks:** 3/3
- **Files created:** 3 · **modified:** 1 · **source files changed: 0**

## Accomplishments

### The authorized split was confirmed against the live corpus before anything ran

An independent read-only census (driving the shipped `classifyEvent`, enriched with each anchor's
resolved canonical event `role`/`eventKind` — the same inputs `commitUnhygienicAnchorPrune` uses)
reproduced the plan's expectation exactly, with no drift from the state the plan documented:

```json
{ "totalCount": 19268,
  "countsByClass": { "conversational": 18938, "tool_activity": 0, "synthetic_injected": 330 },
  "byRule": { "task-notification": 329, "harness-system": 1 } }
```

The **20 silent-sentinel anchors were written down by id** at that point (they are tabulated in
`11-REBUILD-V4.md` with type, `createdAt`, and content opening), so the survival claim is checkable
against a written set instead of a count. Their shape matches `11-GAP-11-H.md`: 12 near-duplicate
`PID 89914` decisions plus 8 items of genuine operational memory.

### Task 1 — the full sequence rehearsed on a clone

Rebuild → dry-run prune → `--apply` prune, all against one `cp -c` clone at commit `c7d46ea`, with
before/after counts for every table, the checkpoint, `user_version`, and file size. All four stop
conditions cleared:

| condition | result |
|---|---|
| prune names exactly 330 | 330 — receipt, dry-run, and id-level diff all agree |
| the 20 survive | **20 / 20** present by id after `--apply`; 0 intersect the deleted set |
| resurrection vs. 11-18's set | **0** (11-18's set reconstructed at 26,643 ids, matching its receipt) |
| `--force` required | no — the v4 bump marked the checkpoint stale on its own |

### Task 2 — a fourth backup, from the current state

`~/.memory/aaron.db.pre-v4`, inode **181531855**, 5,031,448,576 bytes, mtime 2026-07-27T21:55:36 EDT
= 2026-07-28T01:55:36Z — identical to `aaron.db`'s mtime at clone time, which is what makes it an
image of the state Task 3 then operated on. Local and UTC are rendered from separate `stat` calls and
labelled; Plan 11-25's mislabeling is not repeated. The three earlier backups are untouched.

### Task 3 — applied live, and the rehearsal predicted it exactly

| | rehearsal | live |
|---|---|---|
| rebuild receipt | `slices 1170, processedEvents 292407, summariesWritten 50483, supersededSummaries 49137` | **byte-identical** |
| rebuild elapsed | 9 m 41 s | 9 m 40 s |
| prune deleted | 330, 39 batches | 330, 39 batches |
| deleted anchor id set | 330 ids | **set-equal, id for id** |
| every count | — | exact match |

Live corpus after: canonical events 292,407 · active summaries **49,314** · superseded **89,059** ·
anchors **18,938** · unhygienic anchors **0** · checkpoint
`continuous-contraction/v1+hygiene-rules/v4` generation 4 sliceCount 4,680 · `user_version` 3 · file
size unchanged at 5,031,448,576 bytes.

**On the live corpus: 20/20 of the silent-sentinel anchors present, 0 of them in the deleted set,
resurrection 0, and the post-rebuild anchor id set identical to the pre-rebuild one.**

### The recall probe, three predicates reported separately

| predicate | items | queries |
|---|---:|---:|
| **tool-call** (`containsToolCallText`) | **0 / 33** | **0 / 12** |
| **product-unhygienic** (`synthetic_injected`) | **0 / 33** | **0 / 12** |
| *probe-suspicious (advisory)* (`markersFound.length > 0`) | *2 / 33* | *1 / 12* (Q2) |

The two advisory hits are the same two summaries `final-v2` flagged, re-inspected individually rather
than carried over on trust: 6 `[SILENT]` occurrences across them, **0 at a line start**, all
backtick-quoted design prose about noise suppression. Correctly `conversational`.

The `<task-notification>` anchor that held rank 0 for Q1 and Q3 in `final-v2` is **gone** — it is one
of the 330 (present in the deleted id list, absent from the live anchor table) and appears nowhere in
the `post-v4` packets. No query regressed.

## Verification

| Check | Result |
|---|---|
| Both receipts transcribed verbatim (clone and live) | Yes — `11-REBUILD-V4.md` |
| Prune deleted exactly 330 | Yes, on clone and live, id-level |
| All 20 silent-sentinel anchors present after the live prune | **20 / 20**, by id |
| Resurrection count on the live corpus | **0** |
| Dry-run / apply parity | preview 330 === receipt 330 === id diff 330 |
| `post-v4` column with three labelled predicates | Yes — `11-RECALL-PROBE-V2.md` |
| Frozen query set and harness byte-unchanged | `git diff --exit-code` clean before AND after |
| All four backups present afterwards | Yes, distinct inodes, none deleted/moved/overwritten |
| Secret scan before every `git add` | Yes — 1 occurrence redacted, see below |
| `npx vitest run` | **110 passed / 1 skipped files; 1,024 passed / 4 skipped tests; 0 failed**, 20.55 s |
| `npm run typecheck` | Clean |

The known `tests/mcp/mutation-tools.test.ts` / `tests/mcp/stdio-server.test.ts` parallel-load flake did
not reproduce.

## Deviations from Plan

**None.** The plan executed as written: rebuild first, prune second, no `--force`, no hand-selected
anchor ids, no stop condition tripped. Two things are worth recording that are not deviations:

**1. [Observation] The rebuild's packet-visible effect is nil on this query set.** The v4 rebuild
produced 61 net new active summaries (49,253 → 49,314; superseded 89,120 → 89,059, total rows
unchanged), but **ten of twelve probe packets are identical id-for-id to `final-v2`** — every
packet-visible change came from the anchor prune. The case for restoring the 123 events rests on
`11-GAP-11-H.md`'s argument (it stops the system deleting genuine memory), not on evidence from these
12 queries, which do not exercise it. Stated here so the restoration is not later credited with the
probe improvement, which the prune produced.

**2. [Process] Secret found and redacted before staging.** `probe-v2/post-v4.json` contained the
GAP-11-F plaintext Mission Control login in a summary preview — reproduced faithfully into the
rebuilt summaries from the untouched canonical events, exactly as `11-REBUILD.md` warned and exactly
as happened for `final-v2`. Replaced with `[REDACTED]` (1 occurrence; the file still parses as JSON).
`post-v4.md` had 0 occurrences. Sweeps for vendor key prefixes, `key|token|secret|password`
assignments, and bare 32/40/64-hex runs are otherwise clean on both artifacts and on both markdown
documents — the one bare 64-hex string is the public Bun 1.3.10 installer SHA-256. The underlying
corpus is unremediated, per the owner's decision to decline rotation as stale.

## Known Stubs

None.

## Threat Flags

None. This plan added no network, auth, file-access, or schema surface; it changed the corpus and no
source file.

## Notes for the next plan

- The corpus is at `hygiene-rules/v4` / generation 4 / sliceCount 4,680. The next rebuild will need a
  further version bump or `--force`.
- `~/.memory/aaron.db.pre-v4` is the restore point for this operation (ADR 0051 — restore-from-backup
  is the only recovery path for a deleted anchor; no `rebuild-anchors` command exists).
- **No SC7 claim is made anywhere in this plan's output.** The `post-v4` column is a measurement, not
  an acceptance; sign-off is Plan 11-14 and the owner's call.
- GAP-11-F remains open and untouched.

## Self-Check: PASSED

- Files verified present: `.planning/phases/11-derivation-input-hygiene/11-REBUILD-V4.md`,
  `probe-v2/post-v4.json`, `probe-v2/post-v4.md`, this summary.
- Commits verified in `git log`: `be54c89` (Task 1 rehearsal), `4e1cfe9` (Tasks 2–3 live run + probe).
- Live corpus verified at the claimed state by an independent read-only census after the run:
  anchors 18,938, `synthetic_injected` 0, checkpoint `…+hygiene-rules/v4` generation 4.
