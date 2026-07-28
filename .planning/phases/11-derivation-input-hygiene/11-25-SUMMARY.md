---
phase: 11-derivation-input-hygiene
plan: 25
subsystem: derivation-hygiene
tags: [rebuild-derivations, anchors, hygiene, sqlite, rehearsal, owner-gate, blocked]

# Dependency graph
requires:
  - phase: 11-derivation-input-hygiene (Plan 11-24)
    provides: hygiene-rules/v3 (H-i embedded matching + H-0 SC1 reversal), marking every checkpoint stale
  - phase: 11-derivation-input-hygiene (Plan 11-23)
    provides: owner remediation decision authorizing the rebuild class (11-REMEDIATION-DECISION.md)
provides:
  - Measured (not estimated) blast radius of `memory rebuild-derivations` on the 4.6 GB live corpus, from two independent full rehearsals on APFS clones
  - REQ-054/SC5 resumability + idempotence confirmed empirically: interrupt-and-resume converges to a byte-identical anchor set and identical counts
  - BLOCKING FINDING — the rebuild resurrects 1,330 anchors Plan 11-18 permanently pruned, all containing raw `[Tool call: ]` text; root-caused to `survivingDerivationIndices` (contraction-runner.ts:469) still implementing the SC1 rule Plan 11-24 reversed
  - Separate finding — 350 anchors already in the live corpus classify `synthetic_injected` under v3 but were `conversational` under v1; pre-existing, not rebuild damage
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
  - "STOPPED at Task 2 without running Task 3. The owner's advance authorization was conditioned on the rehearsal broadly matching the projection, with anchor resurrection named as an explicit stop condition; it tripped, so the authorization does not extend to this operation."
  - "The anchor resurrection is reported as a blocking defect requiring its own code-fix plan, not worked around by re-running the 11-18 prune afterwards — a prune would be undone by the next rebuild, since the defect is in the anchor gate, not the anchor rows."
  - "No live database write of any kind occurred; `stat` on ~/.memory/aaron.db is identical before and after the plan."

requirements-completed: []

duration: ~40min
completed: 2026-07-28
---

# Phase 11 Plan 25: Live derivation rebuild — rehearsed, blocked, not applied Summary

**Two full rehearsals on APFS clones measured the rebuild's real blast radius and confirmed its resumability exactly, then surfaced a blocking defect the projection could not have shown: the rebuild re-creates 1,330 raw `[Tool call: ]` anchors that Plan 11-18 permanently deleted, because Plan 11-24 reversed SC1 in `derivationContents` but not in `survivingDerivationIndices`, the anchor-side twin of the same rule.**

## Performance

- **Duration:** ~40 min (Run A 9 m 40 s; Run B1 3 m 2 s to interrupt; Run B2 resume 6 m 40 s; the rest census/analysis)
- **Tasks:** 1 of 3 complete (Task 1 rehearsal), Task 2 checkpoint reached and resolved as "authorization does not stand", Task 3 not run
- **Files modified:** 1 created (`11-REBUILD.md`), 0 source files

## Outcome against the decision rule

The orchestrator's stop rule, evaluated:

| # | condition | result |
|---|---|---|
| (a) | any anchor Plan 11-18 pruned is resurrected | **TRIPPED — 1,330** |
| (b) | interrupt-and-resume does not converge | not tripped — converged exactly, anchor id sets byte-identical |
| (c) | `--force` required | not tripped — never used, never needed |

Condition (a) tripping means the live operation is not the one the owner authorized. Task 3 did not run.

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

## Blocking finding

`src/daemon/contraction-runner.ts:469` (`survivingDerivationIndices`) still adds an isolated single tool call to the survivor set, and survivors produce anchors from their **raw** text via `anchorsForTurn` (line 258). Plan 11-24 removed the equivalent `segment.entries.length === 1` short-circuit from `derivationContents` but not from this second, independent implementation of the same rule. The comment at lines 247-254 still asserts the pre-reversal contract verbatim and is now wrong.

All 1,330 resurrected anchors were verified to contain `[Tool call:` (1,330/1,330), and the product's own classifier independently reports `tool_activity: 1330` on the post-rebuild clone against `tool_activity: 0` on the live corpus.

Recommended fix (a separate plan, not done here): drop isolated singles in `flushRun`, correct the comment, add a regression test pinning "an isolated tool call produces no anchor", re-rehearse.

## Second finding (not rebuild damage)

350 anchors already in the live corpus classify `synthetic_injected` under `hygiene-rules/v3` while they were `conversational` under v1 — Plan 11-24's H-i fix detecting scaffolding v1 could not see. Confirmed by a read-only control run against an unrebuilt clone. Disjoint from the resurrected set.

## Corpus safety

- `~/.memory/aaron.db`: 5,031,448,576 bytes / mtime `2026-07-27T19:30:48Z`, identical before Task 1 and after Task 2. Never opened for writing.
- All three backups intact and `stat`-recorded: `pre-rebuild-v3` (fresh, 5,031,448,576), `pre-anchor-prune` (5,031,448,576), `pre-phase11` (4,962,574,336). None deleted, overwritten, or moved.
- All work done against three `cp -c` clones in the session scratchpad.

## Deviations from Plan

**1. [Rule 3 - blocking issue, reported not fixed] Task 3 not executed — stop condition (a) tripped**
- **Found during:** Task 1 rehearsal, anchor resurrection check
- **Issue:** The rebuild resurrects 1,330 pruned raw tool-call anchors, undoing GAP-11-D's closure.
- **Action:** Stopped and reported rather than proceeding or working around it. This is the plan's own threat T-11-90 firing and being caught by its mandated mitigation.
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

**Total deviations:** 3. No scope creep; no code changed.

## Issues Encountered

`11-25-PLAN.md`'s `<interfaces>` block documents `--database <path>`; the command actually parses `--db` (`rebuild-derivations-command.ts:225`). A documented interface that does not match the code — noted, not fixed.

## Verification

- `npm run typecheck` — clean at `455ba7d`.
- `npx vitest run` deliberately not run: the plan requires it *after* the live run as a perturbation guard, and no live run occurred. No source file was modified.
- Plan's automated check: `test -f 11-REBUILD.md && grep -q "rehearsal"` → `REHEARSAL_RECORDED`.

## No claim about SC7 / GAP-11-E / recall quality

The corpus is unchanged, so this plan makes no such claim. Plan 11-26 measures.

## Next Phase Readiness

**Blocked.** A code-fix plan for `survivingDerivationIndices` must land and be re-rehearsed before the live rebuild can be re-authorized. Plan 11-26 currently has an unrebuilt corpus as its input.
