---
phase: 11-derivation-input-hygiene
plan: 13
subsystem: retrieval
tags: [recall, probe, benchmark, anchors, injection]

# Dependency graph
requires:
  - phase: 11-derivation-input-hygiene
    provides: "GAP-11-A state filter (Plans 11-08..11-12), GAP-11-B dedup performance fix (Plan 11-15)"
provides:
  - "a reusable frozen 12-query recall probe (11-recall-probe.ts + 11-RECALL-QUERIES.md) proving SC7's before/after comparison is falsifiable, not impressionistic"
  - "measured before/after-filter evidence that Phase 11's summary-hygiene rebuild did NOT reduce tool-call text in injection packets (9/12 -> 10/12)"
  - "a code-confirmed root cause (AnchorDetector bypasses the hygiene classifier) recorded as GAP-11-D"
affects: [11-14, gap-closure]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Reusable frozen-query recall probe: query set frozen and committed before any measurement run, harness re-runnable against any database copy with --label"

key-files:
  created:
    - .planning/phases/11-derivation-input-hygiene/11-RECALL-PROBE.md
    - .planning/phases/11-derivation-input-hygiene/11-GAP-11-D.md
  modified: []

key-decisions:
  - "Task 2 (owner authorization checkpoint) not run: the evidence gathered in Task 1 shows the live prune cannot satisfy the plan's must_have (tool-call text comes from anchors, which the prune never touches), so presenting Task 2's authorization request as written would be asking the owner to approve a destructive step that does not achieve its stated purpose."
  - "Task 3 (execute the prune) not run, per the owner's out-of-band authorization scope for this execution: only the read-only/evidence-gathering portion of the plan was authorized. The live prune requires explicit owner authorization this session did not have, and is separately not indicated by the evidence."

requirements-completed: []  # REQ-052/053/054 NOT completed by this plan - see below

# Metrics
duration: 45min
completed: 2026-07-27
---

# Phase 11 Plan 13: Recall probe built and run; SC7 evidence is negative, GAP-11-D raised Summary

**Built and ran the frozen 12-query recall probe against a scratch copy of the pre-phase11 backup and
the live corpus; the before/after-filter comparison shows Phase 11's derivation-hygiene rebuild did NOT
reduce tool-call text in injection packets (9/12 -> 10/12 queries), traced the cause to `AnchorDetector`
bypassing the hygiene classifier entirely, and raised GAP-11-D. The live prune was not run — it is not
authorized in this execution, and the evidence shows it would not fix the problem regardless.**

## Performance

- **Duration:** 45 min
- **Started:** 2026-07-27T10:45:00Z
- **Completed:** 2026-07-27T11:30:00Z
- **Tasks:** 1 of 3 completed (Task 1 fully; Task 2 and Task 3 explicitly not run — see below)
- **Files modified:** 2 (both new)

## Plan status: PARTIALLY COMPLETE

This plan is **not** complete. Task 1 (freeze the query set, build the probe, capture before/after-filter
runs) is done. Task 2 (owner authorization checkpoint for the live prune) and Task 3 (execute the prune)
were **not run**, for two independent reasons:

1. **Scope of authorization for this execution.** The owner authorized only the read-only /
   evidence-gathering portion of this plan for this run — building and running the probe harness,
   probing a copy of the pre-phase11 backup, probing the live corpus read-only, and writing
   `11-RECALL-PROBE.md`. The destructive `--apply` step against `~/.memory/aaron.db` was explicitly
   withheld from authorization.
2. **The evidence itself.** Even setting aside authorization, Task 1's results show the live prune
   cannot satisfy the plan's own must_have ("After the prune, no injection packet for any probe query
   contains tool-call or harness-injected text"). The tool-call text traces to `AnchorDetector`, which
   operates on raw `Turn` content with no hygiene gate — a code path entirely separate from the
   superseded-summary prune. Presenting Task 2's authorization checkpoint as originally scoped ("decide
   whether to authorize the destructive apply step") would be asking the owner to approve a step that
   does not achieve its stated purpose. This is itself recorded as new evidence (`11-GAP-11-D.md`), not
   a decision made unilaterally to skip the checkpoint — the checkpoint is simply moot until GAP-11-D is
   scoped and addressed, or the owner decides otherwise with this evidence in hand.

**Outstanding task:** Task 2 (owner authorization for the live prune) and Task 3 (execute the prune) are
still open. To resume this plan once GAP-11-D is scoped or the owner decides the prune should proceed
regardless (e.g., to free the ~155 MB even though it won't affect injection quality), the owner would
run:

```
npx tsx src/cli/bin.ts prune-superseded --db ~/.memory/aaron.db --person aaron
# review the dry-run output, then, if authorized:
npx tsx src/cli/bin.ts prune-superseded --db ~/.memory/aaron.db --person aaron --apply \
  --confirm-backup ~/.memory/aaron.db.pre-phase11
```

**REQUIREMENTS NOT COMPLETED:** REQ-052/REQ-053/REQ-054 remain open. This plan does not claim them.

## Accomplishments

- Confirmed `11-RECALL-QUERIES.md` (12 frozen queries, committed 2026-07-27 in `c0bfd3b`, before any
  probe run — `git log` ordering intact) and `11-recall-probe.ts` (WIP harness committed in `f2e89f2`,
  now verified to execute end-to-end, not just typecheck) were ready to run once GAP-11-B unblocked them.
- Ran `before`: scratch copy of `~/.memory/aaron.db.pre-phase11` made via `cp -c` (instant APFS clone).
  Original backup verified byte-identical (4,962,574,336 bytes, mtime 2026-07-26 19:26:45) both before
  and after the probe run — the original was never opened.
- Ran `after-filter`: live `~/.memory/aaron.db` as it stands (state filter applied, prune not yet run).
- Wrote `11-RECALL-PROBE.md`: full before/after-filter comparison table, real elapsed ms per query
  (before total 1,509,789.1 ms / ~25.2 min; after-filter total 523,680.4 ms / ~8.7 min — ~2.9x faster,
  itself the GAP-11-B performance win showing up on real data), and the `containsToolCallText` /
  `containsHarnessText` tallies stated without softening.
- Diagnosed the root cause by reading the actual code, not guessing: `AnchorDetector.detectForTurn` is
  invoked unconditionally on every turn in `src/integrations/hermes/adapter.ts:89`, with no
  `drivesTopicLabel`-style hygiene gate (unlike the topic-labeling call three lines above it). Anchors
  carry `content: turn.content` verbatim (`src/anchors/anchor-detector.ts:63`), so tool-call turns
  (`[Tool call: ${name}] ${argumentSummary}`, `src/imports/tool-call-record.ts:38-40`) generate anchors
  whose content is raw, unhygienic tool-call JSON — and those anchors' keyword-regex hits (planning-doc
  language in Write/Edit payloads) let them outrank real summary text in `rankMemories`.
- Refuted the standing hypothesis in STATE.md that `conversation-resumer.ts` was the leak path — that
  code is a separate resume flow never called by `prepareInjection`, the only path this probe exercises.
- Raised `11-GAP-11-D.md` with full evidence, the confirmed mechanism, why the live prune cannot close
  it, and a scoped recommendation for a follow-up plan.

## Task Commits

Only Task 1 executed:

1. **Task 1: Freeze the query set and build the probe harness; capture before and after-filter runs** -
   `2711489` (docs) — this commit covers the probe results and gap writeup; the query set and harness
   themselves were already committed in prior plan work (`c0bfd3b`, `f2e89f2`).

Task 2 (checkpoint) and Task 3 (auto): not executed, no commits.

**Plan metadata:** this SUMMARY commit (to follow).

## Files Created/Modified

- `.planning/phases/11-derivation-input-hygiene/11-RECALL-PROBE.md` - before/after-filter comparison,
  per-query elapsed times, tool-call/harness tallies, and the anchor-detection diagnostic
- `.planning/phases/11-derivation-input-hygiene/11-GAP-11-D.md` - new gap: anchor detection bypasses
  derivation-input hygiene, blocking SC7
- `.planning/phases/11-derivation-input-hygiene/11-recall-probe.ts` - unchanged this session (already
  committed as WIP in `f2e89f2`); now verified to run end-to-end against both a scratch backup copy and
  the live corpus
- `.planning/phases/11-derivation-input-hygiene/11-RECALL-QUERIES.md` - unchanged this session (frozen
  and committed prior to this plan's Task 1 execution, `c0bfd3b`)

## Decisions Made

- Did not present Task 2's owner-authorization checkpoint in the form the plan wrote it ("decide whether
  to authorize the destructive apply step") because the evidence gathered in Task 1 shows authorizing it
  would not achieve the must_have it exists to serve. Recorded that reasoning as GAP-11-D rather than
  silently skipping the checkpoint or asking the owner to approve something the evidence says won't work.
- Did not run the live prune under any framing — this execution's authorization was explicitly scoped to
  the read-only/evidence-gathering portion of the plan, and the destructive `--apply` step was named as
  a hard stop regardless of what the evidence showed.

## Deviations from Plan

### Auto-fixed Issues

None applicable — no code was written or fixed; this plan is entirely evidence-gathering and analysis.

### Scope deviation (not a Rule 1-3 auto-fix — documented, not silently applied)

**1. Task 2/Task 3 not executed as written**
- **Found during:** Task 1 (the probe results themselves)
- **Issue:** Task 2 asks the executor to present the `after-filter` results and a dry-run report, then
  pause for the owner's decision on `--apply`. The results show the prune targets summaries while the
  actual leak (tool-call text in injection packets) comes from anchors — a store entity the prune never
  touches. Presenting the checkpoint as "decide whether to authorize the destructive apply step" without
  surfacing that the step doesn't fix the stated problem would be an incomplete framing of the decision.
- **Resolution:** Did not attempt Task 2 or Task 3 in any form. Recorded the finding as GAP-11-D with
  full evidence and a recommendation. This is a Rule 4 (architectural/judgment) situation — deciding
  whether to prune anyway despite it not fixing SC7, and how to scope an anchor-hygiene fix, are calls
  for the owner, not something to auto-resolve.
- **Files modified:** `11-GAP-11-D.md` (new), `11-RECALL-PROBE.md` (documents this in the "Why the
  prune doesn't fix this" section)
- **Committed in:** `2711489`

---

**Total deviations:** 0 auto-fixed; 1 documented scope deviation (Task 2/3 withheld, evidence-driven and
authorization-driven both).
**Impact on plan:** The plan's stated goal — produce SC7 evidence and run the live prune under
authorization — is half-delivered. The evidence is delivered and is more valuable *because* it caught
this before the prune ran, not after: had the prune been authorized and run on the original framing, it
would have consumed the owner's authorization on a step that doesn't move the actual metric.

## Issues Encountered

None beyond the negative result itself, which is not a probe malfunction — see the diagnostic in
`11-RECALL-PROBE.md` and the full writeup in `11-GAP-11-D.md`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `11-RECALL-QUERIES.md` and `11-recall-probe.ts` are reusable as-is for re-measurement once GAP-11-D is
  addressed — no changes needed to either.
- `11-GAP-11-D.md` needs a scoping decision (owner) before a follow-up plan can be written: gate
  `AnchorDetector` behind the hygiene classifier going forward, and decide whether historical anchors
  need a rebuild pass.
- Plan 11-14 (the SC7 judgment plan) should read `11-RECALL-PROBE.md` as-is: the judgment is that SC7 is
  **not yet met**, with the mechanism identified. This is itself a valid, actionable outcome for 11-14
  to record.
- The live prune (Task 2/3 of this plan) remains available to resume once the owner has this evidence
  and either scopes GAP-11-D or decides to prune anyway for storage-reclamation reasons independent of
  SC7.
- ROADMAP.md and STATE.md are being updated to reflect 11-13 as partially complete, not done — do not
  advance the plan counter past 11-13 as if it were finished.

---
*Phase: 11-derivation-input-hygiene*
*Completed: 2026-07-27 (partially — see Plan status above)*
