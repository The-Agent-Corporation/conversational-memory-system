---
phase: 11-derivation-input-hygiene
plan: 20
subsystem: derivation-hygiene
tags: [derivation-hygiene, classification, rule-coverage, gap-closure, ADR]

requires:
  - phase: 11-derivation-input-hygiene
    provides: "SYNTHETIC_MARKERS/markerFor pattern and the recall probe's per-item attribution (Plan 11-19)"
provides:
  - "task-notification and local-command-caveat synthetic rules in SYNTHETIC_RULES/SYNTHETIC_MARKERS"
  - "HYGIENE_RULE_VERSION bumped to hygiene-rules/v2, marking every existing contraction checkpoint stale via PROCESSOR_VERSION"
  - "11-SCAFFOLD-AUDIT.md: counted census of the live corpus's unrecognised scaffolding shapes"
  - "ADR 0048 v2 addendum recording the rule additions, evidence, and deferred needs-owner shape"
affects: ["11-21", "11-22", "11-23", "11-25"]

tech-stack:
  added: []
  patterns: ["census-before-rule: a rule addition is backed by a counted census row, never intuition"]

key-files:
  created:
    - .planning/phases/11-derivation-input-hygiene/11-scaffold-census.ts
    - .planning/phases/11-derivation-input-hygiene/11-SCAFFOLD-AUDIT.md
  modified:
    - src/topic/derivation-hygiene.ts
    - tests/topic/derivation-hygiene.test.ts
    - docs/adr/0048-derivation-input-hygiene.md

key-decisions:
  - "Census ran against a `cp -c` read-only clone of the live 5 GB db, never the original; mtime/size asserted byte-identical before and after (T-11-64)."
  - "Only two shapes got add-rule: <task-notification> and <local-command-caveat>, both anchored literal-prefix Claude-Code-injected wrapper tags with no ambiguity."
  - "[phase:X] orchestration prompts (~1,676 events, anchored and templated but carrying real task-driving content) marked needs-owner and deferred to the Plan 11-23 checkpoint rather than decided here."
  - "Mission-Control-relay and Slack-relay shapes left conversational despite an anchored prefix, because they wrap genuine human-authored content that a rule would silently delete along with the wrapper."

requirements-completed: [REQ-053, REQ-054]

duration: ~40min
completed: 2026-07-27
---

# Phase 11 Plan 20: Rule Coverage Gap Closure Summary

**Censused all 292,407 live canonical events against the shipped classifier, added two counted-evidence rules (`task-notification`, `local-command-caveat`) to close GAP-11-E's product-side gap, and bumped `HYGIENE_RULE_VERSION` to `hygiene-rules/v2`, marking the live corpus's derivations stale per REQ-054.**

## Performance

- **Duration:** ~40 min
- **Tasks:** 2/2 completed
- **Files modified:** 3 product/doc files; 2 files created

## Accomplishments

- Wrote `11-scaffold-census.ts` (throwaway, phase-local, precedent `11-hygiene-sim.ts`/`11-recall-probe.ts`): opens a `cp -c` read-only clone of `~/.memory/aaron.db`, classifies every canonical event via the shipped `classifyEvent`, and reports (a) per-rule hit counts against the 11-CONTEXT.md 2026-07-26 baseline and (b) the top 60 leading-shape signatures among still-`conversational` events with per-row `add-rule`/`leave`/`needs-owner` verdicts. Wrote `11-SCAFFOLD-AUDIT.md` from the run.
- Confirmed the live db's `~/.memory/aaron.db` mtime (`2026-07-27T18:59:51.713Z`) and size (5,031,448,576 bytes) were byte-identical before and after the census.
- Added two rules to `src/topic/derivation-hygiene.ts` following Plan 11-19's `SYNTHETIC_MARKERS`/`markerFor` pattern: `task-notification` (`<task-notification>`) and `local-command-caveat` (`<local-command-caveat>`), both anchored `startsWith` predicates, no role gate.
- Bumped `HYGIENE_RULE_VERSION` from `hygiene-rules/v1` to `hygiene-rules/v2`.
- Appended a dated addendum to `docs/adr/0048-derivation-input-hygiene.md` recording the census method, the two additions with evidence, the deferred `[phase:X]` shape, and the version-bump consequence. Pure addition — `git diff` shows only insertions, no deletions from the original decision text.

## Task Commits

1. **Task 1: Census unrecognised scaffolding in the live corpus** — `6e872b8` (docs)
2. **Task 2 (RED): failing coverage for the two new rules** — `29bd7cc` (test)
3. **Task 2 (GREEN): add the rules, bump the version** — `478f8fa` (feat)
4. **Task 2: ADR 0048 addendum** — `82325f5` (docs)

## Files Created/Modified

- `.planning/phases/11-derivation-input-hygiene/11-scaffold-census.ts` (created) — census script; `node:sqlite` `DatabaseSync({ readOnly: true })` against a `cp -c` clone; never writes to the original.
- `.planning/phases/11-derivation-input-hygiene/11-SCAFFOLD-AUDIT.md` (created) — the counted census output: rule-id hit-count table, top-60 signature table with verdicts, `<task-notification>` containment count and sample positions, verdict rationale.
- `src/topic/derivation-hygiene.ts` — two new `SYNTHETIC_MARKERS`/`SYNTHETIC_RULES` entries, `HYGIENE_RULE_VERSION` bumped to `hygiene-rules/v2`, module header comment updated to record the v2 addition and its evidence source.
- `tests/topic/derivation-hygiene.test.ts` — positive cases for both new rules in the shared `synthetic rules` table-driven block, two near-miss negative tests (content merely mentioning the marker mid-sentence stays `conversational`), and a dedicated test pinning `HYGIENE_RULE_VERSION === "hygiene-rules/v2"`.
- `docs/adr/0048-derivation-input-hygiene.md` — appended `## Addendum 2026-07-27 — v2 rule set (Plan 11-20)`.

## Rules added and their evidence

| Rule id | Marker | Events reclassified (exact `startsWith` count) | Census evidence |
|---|---|---:|---|
| `task-notification` | `<task-notification>` | 1,060 | Verified Claude-Code-injected `task-id`/`tool-use-id`/`output-file` wrapper structure, not user-authored; Q12's post-prune top recall-probe memory (GAP-11-E anomaly 2); top-60 signature rows 14 and 57 |
| `local-command-caveat` | `<local-command-caveat>` | 122 | Same class as the already-shipped `local-command-stdout`/`system-reminder-only` rules; fixed boilerplate body; top-60 signature row 29 |

## Blast radius

- **Composition shift (live corpus, exact per-rule count):** a dedicated `startsWith` count against the live corpus (292,407 events) gives **1,060** events starting with `<task-notification>` and **122** events starting with `<local-command-caveat>` — **1,182 events total** reclassify from `conversational` to `synthetic_injected` once the v2 rules are applied (via a future `memory rebuild-derivations`, not run in this plan). That is 1.5% of the 80,528 events the v1 corpus classified `conversational` (composition before this plan, from `11-SCAFFOLD-AUDIT.md`: tool_activity 186,548 (63.8%) / conversational 80,528 (27.5%) / synthetic_injected 25,331 (8.7%)). After a rebuild, conversational drops to ~79,346 and synthetic_injected rises to ~26,513.
- **Downstream effect:** any future summary/embedding/trace/injection derived from these ~1,000+ events will no longer include their raw text once `memory rebuild-derivations` is run (not run in this plan — owner-gated to Plans 11-23/11-25). Live derivations remain unchanged until that rebuild executes; the version bump only marks them stale.
- **hygiene-corpus-ratio.test.ts (CI-safe synthetic fixture):** re-run and confirmed unaffected — its fixture (`tests/fixtures/hygiene-corpus.ts`) generates only `[SYSTEM:`/`[cron:` synthetic templates, never `<task-notification>`/`<local-command-caveat>` content, so before/after numbers for this test are identical: **count reduction 88.5%, volume reduction 78.8%**, both comfortably above the 40%/45% floors. No loosening was needed or performed; the guard's expectation was re-derived (confirmed unchanged) rather than assumed.

## Deliberately NOT added (and why)

- **`[phase:draft]` / `[phase:evaluation]` / `[phase:review]` / `[phase:integration]` / `[phase:validation]` / `[phase:response]`** (~1,676 events combined across the top-60 table) — anchored bracket prefix, templated body ("per your seeded instructions" recurs verbatim), consistent with a multi-agent orchestration harness. Marked **`needs-owner`**, not `add-rule`: unlike pure metadata noise (cron tags, session banners), a `[phase:X]` line is the literal instruction that drove real agent work — excluding it changes what the derivation remembers about *why* the agent acted, a product judgment call rather than a pure hygiene one. Deferred to the Plan 11-23 owner checkpoint per the plan's explicit instruction.
- **`[Mission Control task comment relay]`** (128 events) and **`System: [...] Slack message`** (90 events) — considered, left `conversational`. Both have an anchored system-relay prefix but wrap genuine human-authored content underneath (an actual task comment with `Author: Aaron`, an actual Slack message body). Excluding the whole event would silently delete real human content along with the relay boilerplate — the failure mode this phase's conservative-by-default stance exists to prevent.
- **Everything else in the top 60** — ordinary prose leads (greetings, task descriptions, agent report/run-log text) or short generic reply fragments (`HEARTBEAT_OK`, `pong`, `ok`, `Status`, `[toolCall]`) that are genuine conversational content, not harness injection, and have no anchored structural marker to anchor a rule on.

## Decisions Made

- **Census-first, rule-second.** No rule was added on the strength of a single observed shape (e.g. Q12's probe output); every addition traces to a counted `add-rule` row in `11-SCAFFOLD-AUDIT.md`.
- **Proper RED/GREEN TDD gate honored.** `src/topic/derivation-hygiene.ts` was reverted to its pre-plan state via `git checkout --` after Task 1's implementation was drafted, the test file was written and confirmed to fail with exactly 3 assertions against the reverted (v1) classifier, committed as `test(11-20)`, then the implementation was reapplied and confirmed green, committed as `feat(11-20)`.
- **Marker-driven, per Plan 11-19's pattern.** Both new rules register a `SYNTHETIC_MARKERS` entry and reference it via `markerFor` in their `SYNTHETIC_RULES.test` body — no inline literal duplication. The Plan 11-19 marker/rule set-equality drift-guard test passes unmodified against the extended rule set.

## Deviations from Plan

None — plan executed as written. The plan's Task 2 acceptance criterion `grep -c 'hygiene-rules/v2' src/topic/derivation-hygiene.ts` is `1` required careful comment wording (avoiding repeating the literal string `hygiene-rules/v2` in surrounding prose comments) but this is implementation detail within Task 2's own action, not a deviation from plan scope.

## Live-corpus safety

- **Daemon-not-running check:** `ps aux | grep -i "memory.*daemon\|contraction-runner"` and `pgrep -fl "memory daemon"` both returned no matching process before this task closed. No daemon is running against `~/.memory/aaron.db`; the version bump's staleness effect will not trigger unattended re-derivation.
- **No live database was written.** The census opened only a `cp -c` clone in `{ readOnly: true }` mode; `~/.memory/aaron.db`'s mtime and size were confirmed byte-identical before and after (recorded in `11-SCAFFOLD-AUDIT.md`).
- `11-RECALL-QUERIES.md` and `11-recall-probe.ts` are byte-unchanged (`git diff --stat` empty for both).

## Issues Encountered

None.

## User Setup Required

None.

## Next Phase Readiness

- `memory rebuild-derivations` will now see the live corpus as stale on next invocation (owner-gated decision, Plans 11-23/11-25 — not run in this plan).
- Plan 11-21 (live re-baseline of the recall probe) should run AFTER whichever plan decides to execute the rebuild, since the probe measures derived summaries/anchors, not raw events, and those will not reflect the v2 rules until rebuilt.
- Plan 11-23's owner checkpoint has a concrete, evidenced decision waiting: whether `[phase:X]` orchestration prompts (~1,676 events) should also be excluded from derivation.

## Self-Check: PASSED

- FOUND: `.planning/phases/11-derivation-input-hygiene/11-scaffold-census.ts`
- FOUND: `.planning/phases/11-derivation-input-hygiene/11-SCAFFOLD-AUDIT.md`
- FOUND: commit `6e872b8` (Task 1)
- FOUND: commit `29bd7cc` (Task 2 RED)
- FOUND: commit `478f8fa` (Task 2 GREEN)
- FOUND: commit `82325f5` (ADR addendum)
- `npx vitest run` — 110 passed | 1 skipped (1007 tests passed, 4 skipped) — green
- `npm run typecheck` — clean
- `git diff --stat -- .planning/phases/11-derivation-input-hygiene/11-RECALL-QUERIES.md .planning/phases/11-derivation-input-hygiene/11-recall-probe.ts` — empty

---
*Phase: 11-derivation-input-hygiene*
*Completed: 2026-07-27*
