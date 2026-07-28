# Plan 11-22 Summary — GAP-11-E root-cause investigation

**Plan:** 11-22 (wave 20, gap-closure investigation for GAP-11-E)
**Status:** COMPLETE
**Date:** 2026-07-27

## What was done

Built a read-only, clone-only discriminator script (`11-leak-attribution.ts`) that resolves every
unhygienic packet item from the Plan 11-21 probe artifacts to its stored summary record, re-derives
its source canonical events under the shipped `derivationContents`, and assigns exactly one
hypothesis label (H-0 by-design / H-i rule-matching defect / H-ii input-path bypass / H-iii stale
derivation / H-iv non-summary path) by a reproducible first-match test. Ran it against a `cp -c`
clone of the live corpus (never opened `~/.memory/aaron.db` or a backup directly), traced 11
distinct offenders end-to-end to their raw canonical events, and wrote the finding
(`11-GAP-11-E-FINDING.md`) answering all three of GAP-11-E's open questions.

## Result: three distinct root causes, not one

| Hypothesis | Offenders | Meaning | Rebuild fixes it? |
|---|---|---|---|
| H-0 (by-design) | 5 | Isolated tool call kept verbatim — the locked ROADMAP SC1 decision, not a defect | N/A |
| H-i (rule-matching defect) | 2 | `SYNTHETIC_RULES` are all anchored `startsWith`; a marker embedded mid-event is invisible to them | No — reproduces |
| H-iii (stale derivation) | 4 | Corpus's shared contraction checkpoint is pinned to `hygiene-rules/v1`; Plan 11-20's v2 rules (`task-notification`, `local-command-caveat`) were never applied to this span of the corpus | Yes |
| H-ii (input-path bypass) | 0 | Not found — both derivation seams call `derivationContents` unconditionally | N/A |
| H-iv (non-summary path) | 0 | Every offender traced is `kind: summary` | N/A |

**The rebuild question:** `memory rebuild-derivations` is necessary but not sufficient. It will fix
every H-iii offender (the checkpoint version mismatch forces a full corpus rewind the next time it
runs) but will reproduce every H-i offender unchanged, because H-i is a code-level anchoring
limitation that hygiene-rules/v2's rule-table additions did not touch.

**Same cause or several:** three distinct causes, confirmed with per-offender evidence (file:line,
raw event content, re-derived text vs. stored text) in the finding document.

**GAP-11-E's "all summary-derived" claim:** confirmed. All 11 distinct offenders traced (across both
the doc-cited tool-call-text list and the probe's own `unhygienicItemCount` list) are `kind:
summary`.

## Unplanned finding: a measurement discrepancy

`11-RECALL-PROBE-V2.md`'s "Attribution of the residue" table (the evidence block this plan started
from) and the SAME probe artifact's own `unhygienicItemCount`/`unhygienicRanks` fields use two
different predicates — `containsToolCallText` vs. `derivationClass === "synthetic_injected" ||
markersFound.length > 0` — and name different items (Q1/Q3/Q4/Q10 vs. Q2/Q3/Q4/Q12), overlapping on
exactly one. Both happen to total 6 in `current-v2`, which is likely why this went unnoticed.
Documented in the finding with a recommendation for Plan 11-23 to reconcile which predicate SC7/SC3
sign-off should measure against.

## Unplanned finding: `origin`/`createdAt` are not usable staleness discriminators

`ContractionRunner.summaryForSpan` (`src/daemon/contraction-runner.ts:422`) hardcodes `origin:
"historical_bootstrap"` on every summary it produces regardless of whether the span came from a live
daemon slice or a bulk rebuild; `origin: "host_session"` is declared in the schema but never assigned
anywhere in `src/`. `createdAt` is `span.completedAt` — the underlying conversation's timestamp, not
a write timestamp. Neither field can distinguish a freshly rebuilt summary from a years-old one; only
the shared `daemon_contraction_checkpoint`'s `processorVersion` can, and that field is what the
finding's H-iii evidence turns on. This contradicts the plan's own interfaces section, which listed
`origin`/`createdAt`/`model` as "the available provenance discriminators" — recorded here as a
correction for anyone reading that section later.

## Deviations from plan

### Auto-fixed / self-corrected issues

**1. [investigation self-correction] First discriminator run mislabeled two H-iii offenders as
H-0/H-i**
- **Found during:** Task 2, first run of the script
- **Issue:** the initial "reproduces the text" check only verified that every re-derived entry
  appears as a substring of the stored text — a check that is vacuously true whenever current rules
  drop MORE than the rules that actually produced the stored summary (a strict subset is always a
  substring). This let Q3 rank 2 (a genuine H-iii case) get labeled H-0.
- **Fix:** added the decisive reverse-direction check — does the stored text contain content that
  CURRENT rules would classify `synthetic_injected` (and therefore drop), or an uncollapsed raw
  tool-call run that current rules would collapse? Either signal proves non-reproduction. Re-ran; the
  tally corrected from `{H-i:3, H-0:1, H-iii:2}` to `{H-i:2, H-iii:4}`, matching hand-verification
  against the raw canonical events.
- **Files modified:** `.planning/phases/11-derivation-input-hygiene/11-leak-attribution.ts`
- **Commit:** `65ba986` (fix folded into the same commit as the script's initial build, since the
  bug was caught before the script's first committed run)

No other deviations. No src/ or database changes — `git diff --stat src/` is empty for this plan.

## Verification

- `npm run typecheck` clean.
- `git diff --stat src/` empty — no product code modified.
- `.planning/phases/11-derivation-input-hygiene/11-GAP-11-E-FINDING.md` exists, contains `H-iii` and
  `would overturn`, and answers all three of GAP-11-E's open questions with per-offender evidence.
- Discriminator script tally sums to the offender count for every run (script fails loudly
  otherwise, per Task 2's acceptance criterion) — confirmed both runs summed correctly (6 = 6).
- Clone `stat` recorded unchanged (size + mtime) before and after both script runs
  (`cloneStatBefore`/`cloneStatAfter` in `leak-attribution-current-v2.json`, both reporting `Clone
  unchanged: true` on stderr).
- Neither `~/.memory/aaron.db` nor any `.pre-*` backup was opened by the script at any point — only
  the `cp -c` clone at
  `/private/tmp/claude-501/…/scratchpad/aaron-clone-11-22.db`.

## Self-Check

- FOUND: `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/.planning/phases/11-derivation-input-hygiene/11-leak-attribution.ts`
- FOUND: `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/.planning/phases/11-derivation-input-hygiene/11-GAP-11-E-FINDING.md`
- FOUND: `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/.planning/phases/11-derivation-input-hygiene/probe-v2/leak-attribution-current-v2.json`
- FOUND: `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/.planning/phases/11-derivation-input-hygiene/probe-v2/leak-attribution-current-v2.md`
- FOUND: `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/.planning/phases/11-derivation-input-hygiene/probe-v2/doc-cited-toolcall-6.json`
- FOUND commit `65ba986`: `feat(11-22): build GAP-11-E leak-attribution discriminator (read-only)`
- FOUND commit `0335745`: `docs(11-22): GAP-11-E finding -- three root causes, not one`

## Self-Check: PASSED

## Follow-ons

- **Plan 11-23** — owner decision: whether to run `rebuild-derivations` now (fixes H-iii, does not
  touch H-i), whether/how to fix H-i's anchored-rule limitation before or after, and whether to
  amend Plan 11-13's must_have to match ROADMAP SC1's isolated-tool-call carve-out (this finding's
  recommendation) or tighten SC1 instead. Also carries forward the `[phase:X]` rule question Plan
  11-20 deferred, and now also the tool-call-text-vs-unhygienic-item measurement-predicate
  reconciliation this plan surfaced.
- Corpus-wide census of H-iii's actual scope (how many summaries in the tail past the
  `hygiene-rules/v1` checkpoint carry v2-only markers) was out of scope for this plan; recommend
  `11-SCAFFOLD-AUDIT.md`'s census methodology if the owner wants a number before authorizing the
  rebuild.
