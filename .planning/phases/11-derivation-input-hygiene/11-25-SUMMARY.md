---
phase: 11-derivation-input-hygiene
plan: 25
subsystem: derivation-hygiene
tags: [rebuild-derivations, anchors, hygiene, sqlite, rehearsal, owner-gate, live-corpus]

# Dependency graph
requires:
  - phase: 11-derivation-input-hygiene (Plan 11-24)
    provides: hygiene-rules/v3 (H-i embedded matching + H-0 SC1 reversal), marking every checkpoint stale
  - phase: 11-derivation-input-hygiene (Plan 11-23)
    provides: owner remediation decision authorizing the rebuild class (11-REMEDIATION-DECISION.md)
provides:
  - Measured (not estimated) blast radius of `memory rebuild-derivations` on the 4.6 GB live corpus, from two independent full rehearsals on APFS clones
  - REQ-054/SC5 resumability + idempotence confirmed empirically: interrupt-and-resume converges to a byte-identical anchor set and identical counts
  - Blocking finding raised and handed to Plan 11-27 (GAP-11-G) — the pre-fix rebuild resurrected 1,330 anchors Plan 11-18 pruned, all containing raw `[Tool call: ]` text; root-caused to `survivingDerivationIndices` (contraction-runner.ts:469) still implementing the SC1 rule Plan 11-24 reversed
  - LIVE CORPUS REBUILT under hygiene-rules/v3 — `~/.memory/aaron.db` active summaries 50,551 -> 49,253, checkpoint advanced to `continuous-contraction/v1+hygiene-rules/v3` gen 3, anchors unchanged at 19,268 with zero resurrection
  - Separate finding — 350 anchors already in the live corpus classify `synthetic_injected` under v3 but were `conversational` under v1; pre-existing, not rebuild damage, left in place as an open owner decision
affects: [11-derivation-input-hygiene (Plan 11-26 final probe, Plan 11-14 SC7 sign-off), 12-incremental-embedding]

tech-stack:
  added: []
  patterns:
    - "Id-level resurrection check: reconstruct a prior prune's deleted-id set by differencing a backup against the live db, then intersect with the post-operation set — count-level before/after would have shown only '+1,330 anchors' and missed that they are the same rows a prior gap closure deleted"
    - "Two-clone rehearsal (clean run vs. interrupt+resume run) as the substitute for a dry-run mode the command does not have"

key-files:
  created:
    - .planning/phases/11-derivation-input-hygiene/11-REBUILD.md
  modified: []

key-decisions:
  - "STOPPED at Task 2 on the first pass rather than proceeding: the owner's advance authorization was conditioned on the rehearsal broadly matching the projection with no anchor resurrection, and resurrection tripped. Resumed to Task 3 only after Plan 11-27 fixed the defect and the orchestrator re-verified the stop rule against a fresh clone rehearsal."
  - "The anchor resurrection was reported as a blocking defect requiring its own code-fix plan, not worked around by re-running the 11-18 prune afterwards — a prune would be undone by the next rebuild, since the defect was in the anchor gate, not the anchor rows. Plan 11-27 fixed the gate."
  - "The live run's -1,330 anchor divergence from the rehearsal is reported as a changed code path, not a rehearsal that failed to predict the tooling — every figure produced by code Plan 11-27 did not touch is identical between the two runs, receipt included, which is itself the evidence that the fix was surgical."

requirements-completed: [REQ-054]

duration: ~75min
completed: 2026-07-28
---

# Phase 11 Plan 25: Live derivation rebuild under hygiene-rules/v3 Summary

**Rehearsed the rebuild twice on APFS clones, stopped the plan when the rehearsal resurrected 1,330 raw `[Tool call: ]` anchors that Plan 11-18 had permanently deleted, then — after Plan 11-27 fixed the anchor gate — applied the rebuild to the live 4.6 GB corpus in 9 m 51 s with a receipt byte-identical to the rehearsal and zero anchor resurrection.**

## Performance

- **Duration:** ~75 min across two sittings (rehearsal Run A 9 m 40 s; Run B1 3 m 2 s to interrupt; Run B2 resume 6 m 40 s; live run 9 m 51 s; the rest census/analysis)
- **Tasks:** 3 of 3 complete — Task 1 rehearsal, Task 2 checkpoint (stopped, then released), Task 3 live run
- **Files modified:** 1 created (`11-REBUILD.md`), 0 source files

## Outcome against the decision rule

| # | condition | first rehearsal (`455ba7d`) | after Plan 11-27 (`cb97c82`) |
|---|---|---|---|
| (a) | any anchor Plan 11-18 pruned is resurrected | **TRIPPED — 1,330** | **cleared — 0** |
| (b) | interrupt-and-resume does not converge | not tripped — converged exactly, anchor id sets byte-identical | unchanged |
| (c) | `--force` required | not tripped — never used, never needed | unchanged |

Condition (a) tripping meant the live operation was not the one the owner authorized, so Task 3 did not run at that point. Plan 11-27 (`ecbc1e2`, `cafc8e7`, `cb97c82`) removed the duplicated rule behind the resurrection and re-measured it at 0 on a fresh clone; the orchestrator released the gate on that basis and Task 3 then ran.

## Live receipt (verbatim) — byte-identical to the rehearsal

```json
{
  "ok": true,
  "rebuilt": true,
  "personId": "aaron",
  "hygieneRuleVersion": "hygiene-rules/v3",
  "processorVersion": "continuous-contraction/v1+hygiene-rules/v3",
  "slices": 1170,
  "processedEvents": 292407,
  "summariesWritten": 50422,
  "supersededSummaries": 50435
}
```

**Elapsed 9 m 51 s** (`01:26:48Z` → `01:36:39Z`). `--force` not passed, not needed.

Live before/after: active summaries 50,551 → **49,253**; superseded 87,727 → **89,120**; total rows 138,278 → 138,373; **anchors 19,268 → 19,268 (0 resurrected, 0 dropped, 0 new)**; canonical events, turns, vectors, `user_version`, and file size unchanged; checkpoint advanced `hygiene-rules/v1` gen 2 → `hygiene-rules/v3` gen 3.

Arithmetic: −1,298 + 1,393 = +95 ✓ (138,278 + 95 = 138,373 ✓); checkpoint `sliceCount` 2,340 + 1,170 = 3,510 ✓.

## Divergences from the rehearsal

1. **Anchors 19,268 live vs 20,598 rehearsed (−1,330).** Intended: the rehearsal ran pre-11-27, the live run post-11-27, and the delta is exactly the resurrected id set 11-27 suppresses. Unhygienic anchors accordingly went 350 → 350 live, against a rehearsed 350 → 1,680. Reported as a changed code path rather than a tooling miss, because every figure from code 11-27 did not touch — including the receipt byte-for-byte — is identical across the two runs.
2. **Elapsed 9 m 51 s vs 9 m 40 s (+11 s, +1.9 %).** Machine noise on an identical workload.

No other divergence of any magnitude.

**File size did not shrink** — 5,031,448,576 bytes before and after, no `VACUUM`. Plan 11-24's ~64.6 MB figure is logical payload, not disk, and is not a disk-space claim.

## Rehearsal receipt (Run A, verbatim)

```json
{
  "ok": true,
  "rebuilt": true,
  "personId": "aaron",
  "hygieneRuleVersion": "hygiene-rules/v3",
  "processorVersion": "continuous-contraction/v1+hygiene-rules/v3",
  "slices": 1170,
  "processedEvents": 292407,
  "summariesWritten": 50422,
  "supersededSummaries": 50435
}
```

Active summaries 50,551 → **49,253** — an exact match to Plan 11-24's recommended-pass projection of 49,253. Superseded 87,727 → 89,120. Total rows +95. Anchors 19,268 → **20,598**. File size unchanged at 5,031,448,576 bytes (no `VACUUM`; the ~64.6 MB projection is logical payload, not disk).

Full arithmetic reconciliation, per-run timings, and every before/after count are in `11-REBUILD.md`.

## Blocking finding (raised here, fixed by Plan 11-27)

`src/daemon/contraction-runner.ts:469` (`survivingDerivationIndices`) still added an isolated single tool call to the survivor set, and survivors produce anchors from their **raw** text via `anchorsForTurn` (line 258). Plan 11-24 removed the equivalent `segment.entries.length === 1` short-circuit from `derivationContents` but not from this second, independent implementation of the same rule; the comment at lines 247-254 still asserted the pre-reversal contract verbatim.

All 1,330 resurrected anchors were verified to contain `[Tool call:` (1,330/1,330), and the product's own classifier independently reported `tool_activity: 1330` on the pre-fix rebuild clone against `tool_activity: 0` on the live corpus.

Plan 11-27 (GAP-11-G) fixed it, finding the defect was twofold and removing the duplicated rule outright rather than patching the copy — `survivingDerivationIndices` now delegates to the same `drivesTopicLabel` predicate every other call site uses. Confirmed on the live corpus by this plan's Task 3: 0 resurrected, `tool_activity: 0`.

## Second finding (not rebuild damage, left in place)

350 anchors already in the live corpus classify `synthetic_injected` under `hygiene-rules/v3` while they were `conversational` under v1 — Plan 11-24's H-i fix detecting scaffolding v1 could not see. Confirmed by a read-only control run against an unrebuilt clone; disjoint from the resurrected set. Still 350, at identical payload bytes, after the live rebuild. **Not pruned** — an open owner decision.

## Corpus safety

- `~/.memory/aaron.db` before Task 3: inode 171672602, 5,031,448,576 bytes, mtime 2026-07-27T19:30:48 EDT — identical to its state before Task 1, confirming the rehearsal never wrote to it. After Task 3: same inode, same size, mtime 2026-07-27T21:36:32 EDT (written, as intended). `-wal` is 0 bytes, so the file on disk is the complete state.
- All three backups intact at distinct inodes with unchanged mtimes: `pre-rebuild-v3` (181199709, 5,031,448,576), `pre-anchor-prune` (180214168, 5,031,448,576), `pre-phase11` (179000198, 4,962,574,336). None deleted, overwritten, or moved. ADR 0051's restore path is intact.
- All rehearsal and classification work done against four `cp -c` clones in the session scratchpad.
- GAP-11-F untouched: the rebuild re-derived summaries from the untouched canonical events and will have faithfully reproduced the mission-control credential into the new summary text. Known, accepted by the owner, not remediated here.

## Deviations from Plan

**1. [Rule 3 - blocking issue, reported not fixed here] Task 3 deferred on the first pass — stop condition (a) tripped**
- **Found during:** Task 1 rehearsal, anchor resurrection check
- **Issue:** The pre-fix rebuild resurrected 1,330 pruned raw tool-call anchors, undoing GAP-11-D's closure.
- **Action:** Stopped and reported rather than proceeding or working around it. This is the plan's own threat T-11-90 firing and being caught by its mandated mitigation. Handed to Plan 11-27; Task 3 ran after the fix landed and the orchestrator re-verified the stop rule.
- **Files modified:** none

**2. [Rule 2 - missing critical functionality] Added an id-level resurrection check, not just before/after counts**
- **Found during:** Task 1
- **Issue:** The plan's acceptance criteria ask for "anchor count before and after ... and whether any pruned anchor returned". A count comparison alone would have reported "+1,330 anchors" and could plausibly have been read as benign new derivation.
- **Fix:** Reconstructed 11-18's exact 26,643-id deleted set by differencing `pre-anchor-prune` against live (matching its receipt exactly), then intersected with the post-rebuild set, then inspected all 1,330 hits' payloads.
- **Files modified:** none (scratchpad scripts only)

**3. [Rule 2] Added a read-only v3-classification control run against an unrebuilt clone**
- **Found during:** analysis of the 350 `synthetic_injected` anchors
- **Issue:** Without a control, the 350 would have been reported as rebuild damage.
- **Fix:** Classified today's live anchors under v3 on a throwaway clone; 350 present already.
- **Files modified:** none

**4. [Rule 2] Corrected a timezone mislabel in this plan's own evidence record**
- **Found during:** Task 3, re-stat of the backups
- **Issue:** `stat -f %Sm` renders local time (EDT), but the Tasks 1-2 half of `11-REBUILD.md` quoted those mtimes with a `Z` suffix, asserting UTC. In a document whose purpose is backup evidence, a mislabelled timestamp is a real defect.
- **Fix:** Corrected the affected mtimes, added an explicit timezone note, and recorded both local and UTC for every backup, plus inodes (which prove the backups are distinct files from `aaron.db` and so cannot be reached by a write to it).
- **Files modified:** `.planning/phases/11-derivation-input-hygiene/11-REBUILD.md`

**Total deviations:** 4. No scope creep; no source code changed by this plan.

## Issues Encountered

`11-25-PLAN.md`'s `<interfaces>` block documents `--database <path>`; the command actually parses `--db` (`rebuild-derivations-command.ts:225`). A documented interface that does not match the code — noted, not fixed.

## Verification

- `npx vitest run` after the live rebuild — **110 files passed / 1 skipped; 1,017 tests passed / 4 skipped**, 22.63 s. Fully green; the pre-existing `tests/mcp/mutation-tools.test.ts` / `tests/mcp/stdio-server.test.ts` parallel-load flake did not reproduce.
- `npm run typecheck` after the live rebuild — clean.
- Plan's automated checks: `grep -q "rehearsal"` → `REHEARSAL_RECORDED`; `grep -q "receipt"` → `RECEIPT_RECORDED`.

## No claim about SC7 / GAP-11-E / recall quality

This plan produced a receipt, not an acceptance. Plan 11-26 measures whether the rebuild improved recall.

## Next Phase Readiness

**Unblocked.** The live corpus is rebuilt under `hygiene-rules/v3` with the checkpoint advanced to `continuous-contraction/v1+hygiene-rules/v3` generation 3, so Plan 11-26's probe now has the remediated corpus as its input. Two items remain open and are deliberately not touched here: the 350 pre-existing `synthetic_injected` anchors (owner decision) and GAP-11-F (owner declined rotation).
