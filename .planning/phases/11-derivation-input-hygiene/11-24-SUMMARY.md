---
phase: 11-derivation-input-hygiene
plan: 24
subsystem: derivation-hygiene
tags: [derivation, hygiene, sqlite, tool-call-collapse, synthetic-classification, roadmap-amendment, adr]

# Dependency graph
requires:
  - phase: 11-derivation-input-hygiene (Plan 11-23)
    provides: owner remediation decision authorizing rebuild + rule-matching fix + SC1 revision (11-REMEDIATION-DECISION.md)
provides:
  - Line-anchored embedded-marker matching in SYNTHETIC_RULES (closes GAP-11-E H-i)
  - Isolated tool calls now collapse via collapseText instead of surviving verbatim (closes GAP-11-E H-0; reverses ROADMAP SC1)
  - HYGIENE_RULE_VERSION bumped to hygiene-rules/v3, marking every existing checkpoint stale for the next rebuild-derivations run (readies H-iii's fix, which needed no code change)
  - ROADMAP SC1/SC3 amended in place (original text preserved), ADR 0048 addendum, 11-CONTEXT.md decision marked superseded
  - Retired 11-hygiene-sim.ts's stale 135,366->55,930 / 228.9MB->77.6MB targets; republished under hygiene-rules/v3
  - Corpus-wide H-0 blast-radius count: 15,996 isolated tool-call events (read-only, no live db write)
affects: [11-derivation-input-hygiene (Plan 11-25 live rebuild, Plan 11-26 final probe), 12-incremental-embedding, 13-vector-trace-discovery]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Line-anchored embedded-marker matching (matchesEmbedded): detect a scaffolding marker at the start of ANY line within an event, not just the event's own start, without degenerating to an unanchored substring scan that would flag prose merely mentioning the marker"

key-files:
  created: []
  modified:
    - src/topic/derivation-hygiene.ts
    - tests/topic/derivation-hygiene.test.ts
    - tests/daemon/contraction-runner.test.ts
    - tests/compaction/pre-compactor.test.ts
    - tests/topic/hygiene-corpus-ratio.test.ts
    - .planning/ROADMAP.md
    - docs/adr/0048-derivation-input-hygiene.md
    - .planning/phases/11-derivation-input-hygiene/11-CONTEXT.md
    - .planning/phases/11-derivation-input-hygiene/11-hygiene-sim.ts

key-decisions:
  - "H-i fixed with line-start-anchored matching (marker begins some line in the event), not a bare content.includes() scan — avoids misclassifying conversational prose that merely mentions a marker (the false positive GAP-11-E traced for Q2's silent-sentinel offender) as scaffolding"
  - "H-0 fixed by removing derivationContents' segment.entries.length===1 verbatim short-circuit — an isolated tool call now collapses exactly like a run of >=2, reversing ROADMAP SC1's locked carve-out per the owner's 2026-07-27 override"
  - "H-iii required no code change — PROCESSOR_VERSION already embeds HYGIENE_RULE_VERSION, so this plan's v2->v3 bump alone marks every existing checkpoint stale; the next rebuild-derivations run (Plan 11-25, owner-gated) will close H-i, H-0, and H-iii together in one full rebuild"
  - "11-hygiene-sim.ts (a throwaway measurement prototype, not production code) was updated so its own hardcoded isolated-single branch matches the new derivationContents behavior, then re-run read-only against a cp -c clone, rather than left silently diverged from the module it exists to measure"

requirements-completed: [REQ-052, REQ-053]

# Metrics
duration: ~65min
completed: 2026-07-27
---

# Phase 11 Plan 24: GAP-11-E remediation (H-i embedded-marker matching + H-0/SC1 reversal) Summary

**Fixed two of GAP-11-E's three causes in code (H-i's anchoring defect, H-0's SC1 carve-out), confirmed the third (H-iii's staleness) needs no code change, and amended every document the H-0 reversal touches — ROADMAP SC1/SC3, ADR 0048, 11-CONTEXT.md, and the phase's own measurement targets — rather than let a locked decision change silently.**

## Performance

- **Duration:** ~65 min
- **Tasks:** 2 plan tasks (Task 1 scope confirmation, Task 2 fix) plus the full remediation-decision scope expansion (documentation, sim re-run, blast-radius census)
- **Files modified:** 9 (2 src/test pairs in `src/`, 4 test files, 3 planning/doc files, 1 throwaway sim script)

## Scope note (required by 11-24-PLAN.md Task 1)

`11-REMEDIATION-DECISION.md`'s Decision 1 verdict, quoted: **"Chosen: all three [rebuild + anchored-rule fix + revise SC1]. Plan 11-24 will: 1. Run/enable rebuild-derivations remediation for the H-iii offenders... 2. Change the rule-matching strategy so scaffolding markers embedded mid-event are detected... — closing H-i. 3. Revise SC1 so an isolated tool call is collapsed rather than kept verbatim... closing H-0."** This is broader than 11-24-PLAN.md's own frontmatter (which was written before Plan 11-22's finding, deliberately scoped to "whichever defect class the finding names"). Per the team lead's explicit authorization, this plan executed the full remediation-decision scope, not the narrower plan-file scope — every file touched beyond `11-24-PLAN.md`'s `files_modified` list is recorded below as a deviation, not silently added.

All three defect classes named in `11-GAP-11-E-FINDING.md` were in scope per the decision:
- **H-0** (5 of 11 traced offenders): fixed — see Task 2 below.
- **H-i** (2 of 11 traced offenders): fixed — see Task 2 below.
- **H-iii** (4 of 11 traced offenders): confirmed ready, no code change needed — see "H-iii readiness" below.

GAP-11-F (credential exposure) and the `[phase:X]`/Mission-Control/Slack-relay conversational carve-outs (owner decision 2) were explicitly out of scope and untouched.

## Accomplishments

- **H-i closed:** `SYNTHETIC_RULES`' literal-prefix rules now match a marker at the start of ANY line within an event (`matchesEmbedded`), not only the event's own start, while a marker quoted inline within running prose still classifies conversational — verified against both a false-positive control built from the real Q2 offender text and a constructed embedded-marker case.
- **H-0 closed (SC1 reversed):** `derivationContents` no longer special-cases a length-1 tool-activity segment; every tool run, isolated or not, collapses via `collapseText`. `openToolRunStart`/`derivationContents` still share `computeSegments`, so the "can never disagree about where a run begins" invariant (ADR 0048, locked Phase 11 decision) is untouched — only the post-`computeSegments` handling of a length-1 segment changed.
- **H-iii confirmed ready:** `rebuild-derivations-command.ts`'s staleness gate (`checkpoint.processorVersion !== PROCESSOR_VERSION`) already forces a full corpus rewind-and-reprocess on any `HYGIENE_RULE_VERSION` bump — no code change needed. This plan's v2->v3 bump means the next `memory rebuild-derivations` invocation (Plan 11-25, owner-gated) applies H-i, H-0, and H-iii's fixes together, in one rebuild.
- **HYGIENE_RULE_VERSION bumped v2 -> v3** (REQ-054): both code changes alter `classifyEvent`/`derivationContents` output for some inputs.
- **ROADMAP SC1 and SC3 amended in place**, original wording preserved verbatim alongside the amendment and its dated reason.
- **ADR 0048 addendum** (2026-07-27) recording both fixes, the false-positive reasoning behind H-i's design, and the SC1 reversal's rationale and accepted trade-off.
- **11-CONTEXT.md's isolated-call decision entry marked superseded**, not deleted, pointing forward to the amendment.
- **11-hygiene-sim.ts's stale 135,366->55,930/228.9MB->77.6MB targets retired**, not left standing as expectations; the sim's own hardcoded isolated-single branch was updated to match production behavior and re-run read-only against a `cp -c` corpus clone, publishing new figures under `hygiene-rules/v3` (see below).
- **Corpus-wide H-0 blast radius measured, read-only:** 15,996 isolated tool-call events across the full 292,407-event corpus — far larger than the 5 offenders the 12-query recall probe happened to surface. No live database was written.

## Task Commits

1. **Task 2: Reproduce the defect from the real span, then fix it (H-i + H-0)** - `6f17270` (fix) — `src/topic/derivation-hygiene.ts` plus the four fallout test files (`tests/topic/derivation-hygiene.test.ts`, `tests/daemon/contraction-runner.test.ts`, `tests/compaction/pre-compactor.test.ts`, `tests/topic/hygiene-corpus-ratio.test.ts`)
2. **Deviation-scope documentation (ROADMAP/ADR/CONTEXT/sim retirement)** - `de368c7` (docs) — `.planning/ROADMAP.md`, `docs/adr/0048-derivation-input-hygiene.md`, `.planning/phases/11-derivation-input-hygiene/11-CONTEXT.md`, `.planning/phases/11-derivation-input-hygiene/11-hygiene-sim.ts`

**Plan metadata:** (this commit, following this SUMMARY)

_Task 1 (scope confirmation) produced no separate commit — its output is this SUMMARY's "Scope note" section, per the plan's own instruction that Task 1's action is "restate... in the SUMMARY-in-progress," not a standalone artifact._

## Files Created/Modified

- `src/topic/derivation-hygiene.ts` — `matchesEmbedded` helper (H-i); `derivationContents`'s length-1 short-circuit removed (H-0); `HYGIENE_RULE_VERSION` bumped to `hygiene-rules/v3`
- `tests/topic/derivation-hygiene.test.ts` — new `describe("classify — embedded markers (GAP-11-E H-i, Plan 11-24)")` block (false-positive control from the real Q2 span, a constructed embedded-marker positive, and an inline-non-line-start negative); isolated-single `derivationContents` test rewritten for collapse behavior; version-bump assertion updated
- `tests/daemon/contraction-runner.test.ts` — two isolated-single-call tests rewritten to assert collapse instead of verbatim survival
- `tests/compaction/pre-compactor.test.ts` — isolated-single-turn test rewritten to assert collapse
- `tests/topic/hygiene-corpus-ratio.test.ts` — the "isolated singles survive verbatim" assertion replaced with "zero verbatim `[Tool call:` residue, some `[Activity]` residue"
- `.planning/ROADMAP.md` — SC1 and SC3 amended in place (original text preserved)
- `docs/adr/0048-derivation-input-hygiene.md` — 2026-07-27 addendum; Context section's stale target figures marked retired with new figures
- `.planning/phases/11-derivation-input-hygiene/11-CONTEXT.md` — isolated-call decision marked superseded; phase-boundary summary line annotated
- `.planning/phases/11-derivation-input-hygiene/11-hygiene-sim.ts` — `flushTools` collapses isolated singles like production; log line reworded

## Decisions Made

- **H-i's fix is line-start anchoring, not a bare substring scan.** `content.includes(marker)` was considered and rejected: the two real H-i offenders GAP-11-E traced are an assistant message discussing `[SILENT]` as a design concept inside a markdown table cell — mid-sentence, never at a line's start. A bare substring scan would flag that legitimate conversational prose as scaffolding, exactly the false positive this phase's conservative anchoring exists to prevent. Line-start anchoring generalizes the SAME discriminator the H-iii offenders already prove is real (a marker as the ENTIRE content of its own dedicated event) one level down, to a marker as the entire content of its own dedicated LINE inside a larger event. Both real H-i offenders remain classified `conversational` after the fix — consistent with the finding's own assessment that they read as probe-detector false positives, not genuine leaks; the fix's effect is on the general embedded-marker case, verified with a constructed illustrative fixture since (per the finding's own admission) the traced corpus evidence has no second, cleaner mid-body offender to extract verbatim.
- **H-0's SC1 reversal is unconditional**, not gated by any new heuristic: every tool_activity segment collapses now, matching the decision's exact wording ("collapsed rather than kept verbatim").
- **`collapseText` for a single tool call reads "ran 1 tool calls: 1 Bash"** — grammatically odd but unchanged from the existing `collapseText` implementation (never modified; only its caller changed). Out of scope: fixing `collapseText`'s pluralization was not part of any authorized defect class.
- **The sim script (`11-hygiene-sim.ts`) was edited, not just annotated**, because its `flushTools` reimplements the collapse decision inline rather than calling `derivationContents` — leaving it unedited would mean re-running it still measured the OLD H-0 behavior. This is outside `files_modified`'s candidate set and outside `src/`, but is the correct minimal action to "re-run the sim and publish new figures" as the remediation decision requires; recorded as a deviation below.

## Deviations from Plan

### Auto-fixed / owner-authorized scope expansions

**1. [Owner-authorized scope expansion, per team-lead directive] Executed the full 11-REMEDIATION-DECISION.md scope, not 11-24-PLAN.md's narrower frontmatter**
- **Found during:** Task 1 (scope confirmation)
- **Issue:** `11-24-PLAN.md`'s `files_modified` and task text were written before Plan 11-22's finding existed, deliberately scoped to "whichever defect class the finding names" (singular framing). The finding named three classes and the owner authorized fixing all three plus a locked-decision reversal with its own documentation obligations.
- **Fix:** Followed the team lead's explicit authorization to execute the full decision scope. All extra work is enumerated in this Deviations section.
- **Files modified:** see below, item by item.
- **Verification:** each sub-item below has its own verification.

**2. [Rule 2 - missing critical functionality] ROADMAP SC1/SC3 amendment, ADR 0048 addendum, 11-CONTEXT.md supersession**
- **Found during:** Task 2, after the SC1 reversal landed in code
- **Issue:** A locked roadmap success criterion cannot silently stop matching implementation without becoming misleading documentation.
- **Fix:** Amended SC1/SC3 in place with original text preserved; added a dated ADR 0048 addendum; marked the 11-CONTEXT.md decision superseded in place.
- **Files modified:** `.planning/ROADMAP.md`, `docs/adr/0048-derivation-input-hygiene.md`, `.planning/phases/11-derivation-input-hygiene/11-CONTEXT.md`
- **Committed in:** `de368c7`

**3. [Rule 2 - missing critical functionality] Retired/republished 11-hygiene-sim.ts's measurement targets**
- **Found during:** post-Task-2, decision-mandated
- **Issue:** The 135,366->55,930 / 228.9MB->77.6MB figures cited across planning docs were computed under the now-reversed verbatim-isolated-single behavior and would mislead if left standing.
- **Fix:** Updated the sim's `flushTools` to collapse isolated singles like production, re-ran it read-only against a `cp -c` clone of the live corpus, and recorded the new figures in ADR 0048's retirement note (below and in the ADR addendum). Did not rewrite already-completed historical PLAN/SUMMARY/STATE.md log entries that cited the old figures as dated, append-only history — only the ADR's living "Context" target statement, which is the one place the figures are presented as a current expectation.
- **Files modified:** `.planning/phases/11-derivation-input-hygiene/11-hygiene-sim.ts`, `docs/adr/0048-derivation-input-hygiene.md`
- **Committed in:** `de368c7`

**4. [Rule 2 - missing critical functionality] Corpus-wide H-0 blast-radius census (read-only)**
- **Found during:** the same sim re-run as item 3
- **Issue:** The decision requires stating the true blast radius before Plan 11-25 applies anything live, not just the 5 offenders the 12-query probe surfaced.
- **Fix:** The sim's existing `isolatedSingles` counter, run against the full corpus, reports **15,996** isolated tool-call events corpus-wide.
- **Files modified:** none beyond item 3 (the count is a byproduct of the same run).
- **Committed in:** n/a (reported here and in the ADR addendum; not itself a code artifact)

---

**Total deviations:** 4, all Rule 2 / owner-authorized-scope-expansion. **Impact on plan:** all four are the explicit, named consequences the remediation decision itself lists as "must be handled by Plan 11-24, not discovered later." No unrelated scope creep.

## Issues Encountered

None. The four pre-existing full-suite fallout test failures (isolated-single collapse changing expected summary text in `contraction-runner.test.ts`, `pre-compactor.test.ts`, `hygiene-corpus-ratio.test.ts`) were anticipated by the SC1 reversal and fixed as part of Task 2, not treated as surprises.

The known `tests/mcp/mutation-tools.test.ts` full-suite-parallel-load timing flake (documented in `deferred-items.md`, pre-existing, not caused by this plan) reproduced once during a full `npx vitest run`; re-run in isolation, it passed in 609ms. Not fixed here — out of scope per the assignment brief.

## Corpus safety (H-iii readiness / blast-radius census)

- The live database (`~/.memory/aaron.db`) was `cp -c`'d once to a scratchpad clone. `stat` `size`/`mtime` were recorded identical before AND after both sim runs against the clone (`5031448576` bytes / `mtime 1785195048`, unchanged across both invocations).
- Neither `~/.memory/aaron.db` nor any `.pre-*` backup was opened directly by this plan's tooling at any point.
- No `memory rebuild-derivations` or any other write command was run against the live corpus. The live application of these fixes remains Plan 11-25, owner-gated, per the plan's explicit "This plan touches NO live database" constraint.

## Verification

- `npx vitest run` — 1,014 tests, 1,010 passed / 4 skipped in a clean isolated run of the affected suites; one pre-existing, documented full-suite-only timing flake in `tests/mcp/mutation-tools.test.ts` (passes in isolation, see above).
- `npm run typecheck` — clean, no errors.
- `openToolRunStart`/`derivationContents` agreement invariant verified unchanged: both still derive from the same `computeSegments` walk; only post-walk handling of a length-1 tool_run segment changed, and `openToolRunStart` never inspected segment length in the first place.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 11-25 (owner-authorized live remediation) can now proceed: `memory rebuild-derivations` against the live corpus will apply `hygiene-rules/v3` (H-i's embedded matching + H-0's SC1 reversal) together with H-iii's staleness fix in one full rebuild, per the existing `PROCESSOR_VERSION` staleness gate. Plan 11-25 should cite this plan's blast-radius figure (15,996 corpus-wide isolated tool-call events) and the retired/republished sim targets (`docs/adr/0048-derivation-input-hygiene.md`'s 2026-07-27 addendum) when scoping its own rehearsal and receipt. No blockers.

## Self-Check: PASSED

All files and commits cited above were verified to exist:
- Commits `6f17270`, `de368c7` — both `FOUND` in `git log --oneline --all`.
- All 10 files listed in "Files Created/Modified" plus this SUMMARY — all `FOUND` on disk.
