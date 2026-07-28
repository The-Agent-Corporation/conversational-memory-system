---
phase: 11-derivation-input-hygiene
plan: 28
subsystem: derivation
tags: [hygiene, classification, silent-sentinel, gap-closure, tdd]

requires:
  - phase: 11-derivation-input-hygiene
    provides: "Plan 11-24's line-anchored matchesEmbedded (hygiene-rules/v3), whose block-vs-sentinel conflation this plan corrects"
provides:
  - "`isSentinelOnly` — a residue-empty predicate used by exactly one rule (`silent-sentinel`)"
  - "hygiene-rules/v4 (REQ-054), marking every contraction checkpoint stale for Plan 11-29's rebuild"
  - "Regression tests pinning BOTH sides of the sentinel distinction, using real corpus shapes"
  - "ADR 0048 addendum recording the false-positive class and its counted blast radius"
affects: [11-29 corpus rebuild and 330-anchor prune, any future rule-table change]

tech-stack:
  added: []
  patterns:
    - "A marker's SEMANTICS (leading block vs trailing sentinel) decides its matching strategy, not the rule table's uniformity"

key-files:
  created: []
  modified:
    - src/topic/derivation-hygiene.ts
    - tests/topic/derivation-hygiene.test.ts
    - docs/adr/0048-derivation-input-hygiene.md

key-decisions:
  - "silent-sentinel fires only when the event IS the sentinel (residue empty once marker-led lines are removed), not when it merely CONTAINS one"
  - "Lines are dropped when they START with the marker rather than when they EQUAL it: the two predicates disagree on 0 of 292,407 live events, and the looser one keeps the pinned single-line shape synthetic and the SYNTHETIC_MARKERS drift guard honest"
  - "matchesEmbedded left untouched — the other ten rules are correct and widening the fix would re-open GAP-11-E"
  - "HYGIENE_RULE_VERSION bumped to hygiene-rules/v4 — the third bump in this phase, which is correct behavior for a rule set that changes classifyEvent output"

patterns-established:
  - "Pattern: measure two candidate predicates against the whole corpus and pick on evidence, not aesthetics — the disagreement count (0) made the choice free"

requirements-completed: [REQ-053, REQ-054]

duration: 30min
completed: 2026-07-28
---

# Phase 11 Plan 28: Narrow `silent-sentinel` to the sentinel-only shape Summary

**A trailing `[SILENT]` line no longer condemns the real agent reasoning that precedes it: `silent-sentinel` now fires only when the event IS the sentinel, flipping exactly 123 of 292,407 live events back to `conversational` while all 2,784 pure sentinels stay scaffolding.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-07-28T14:09:00Z
- **Completed:** 2026-07-28T14:23:00Z
- **Tasks:** 1/1
- **Files modified:** 3

## Accomplishments

### The census, re-derived independently BEFORE any code changed

The plan required verifying the pre-plan numbers rather than trusting them. A from-scratch
read-only script (`scratchpad/1128-census.ts`, opened with `readOnly: true`, never writing) walked
all 292,407 canonical events and computed BOTH candidate residue predicates in one pass:

```
canonical events (whole corpus)     = 292407
assistant events w/ [SILENT] line   = 2907
predicate A (exact-line filter):  pure=2784  trailing=123
predicate B (startsWith filter):  pure=2784  trailing=123
starts with marker but has residue  = 0
events where A and B disagree       = 0
```

Matches the pre-plan census exactly: **2,784 / 123 / 0**. No stop condition.

### RED — the failing tests, verbatim

Both sides of the distinction were written first, using real corpus shapes cited by event id
(`event_ae2065736d33…`, `event_c5970551…`). Run against unmodified `hygiene-rules/v3`:

```
 FAIL  tests/topic/derivation-hygiene.test.ts > classifyEvent > classify — silent-sentinel is a trailing sentinel, not a block (GAP-11-H, Plan 11-28) > classify — GAP-11-H's real corpus shape: reasoning followed by a trailing sentinel is conversational
AssertionError: expected 'synthetic_injected' to be 'conversational' // Object.is equality

Expected: "conversational"
Received: "synthetic_injected"

 ❯ tests/topic/derivation-hygiene.test.ts:208:38

 FAIL  tests/topic/derivation-hygiene.test.ts > classifyEvent > classify — silent-sentinel is a trailing sentinel, not a block (GAP-11-H, Plan 11-28) > classify — GAP-11-H's second corpus shape (`PID 89914 is not alive…`) is conversational
AssertionError: expected 'synthetic_injected' to be 'conversational' // Object.is equality

Expected: "conversational"
Received: "synthetic_injected"

 ❯ tests/topic/derivation-hygiene.test.ts:221:38

 FAIL  tests/topic/derivation-hygiene.test.ts > classifyEvent > classify — silent-sentinel is a trailing sentinel, not a block (GAP-11-H, Plan 11-28) > classify — a fenced sentinel inside real reasoning is conversational (fence lines are residue)
AssertionError: expected 'synthetic_injected' to be 'conversational' // Object.is equality

Expected: "conversational"
Received: "synthetic_injected"

 ❯ tests/topic/derivation-hygiene.test.ts:229:38

 FAIL  tests/topic/derivation-hygiene.test.ts > classifyEvent > classify — determinism > classify — HYGIENE_RULE_VERSION is hygiene-rules/v3 (Plan 11-24 bump)
AssertionError: expected 'hygiene-rules/v3' to be 'hygiene-rules/v4' // Object.is equality

Expected: "hygiene-rules/v4"
Received: "hygiene-rules/v3"

 ❯ tests/topic/derivation-hygiene.test.ts:275:36

 Test Files  1 failed (1)
      Tests  4 failed | 48 passed (52)
```

The three pure-sentinel / mid-sentence-quote / one-rule-wide guards passed in the same RED run —
they pin behavior that must NOT change, so they were expected green from the start.

Committed as RED: `15eb8e9`.

### GREEN — the predicate, and why this one

```ts
const isSentinelOnly = (content: string, marker: string): boolean => {
  const lines = content.split("\n");
  if (!lines.some((line) => line.trimStart().startsWith(marker))) return false;
  return lines.filter((line) => !line.trimStart().startsWith(marker)).join("\n").trim().length === 0;
};
```

This differs from the plan's suggested shape in one respect: lines are dropped when they **start
with** the marker, not when they **equal** it. Three reasons, in order of weight:

1. **Measured, not assumed.** Both variants were computed over all 292,407 events in the same
   census pass. They disagree on **0** events — the corpus has no case where a line opens with
   `[SILENT]` and carries same-line residue. So on the live corpus the choice is free, and the
   deciding evidence is what happens off-corpus.
2. **It preserves already-pinned behavior.** The exact-equality variant would have flipped
   `[SILENT] no response needed` (the existing fixture at `derivation-hygiene.test.ts:49`, and
   `[SILENT] internal bookkeeping note` in `anchor-hygiene-prune.test.ts`) to conversational —
   an unmeasured behavior change smuggled in alongside a measured one. A line that opens with the
   sentinel is wholly a sentinel emission.
3. **It keeps the T-11-60 drift guard honest.** `SYNTHETIC_MARKERS` is guarded by
   `rule.test(marker + "x") === true` for every marker. Under exact-equality, `"[SILENT]x"` leaves
   itself as residue and the guard would have failed for this rule — forcing either a special case
   in the guard or a silently weakened invariant.

The rule entry and `HYGIENE_RULE_VERSION` are the only behavioral lines that changed. `roles:
["assistant"]` is unchanged. `matchesEmbedded` is byte-identical to what Plan 11-24 left (T-11-95).

### Post-fix re-verification against the live corpus, read-only

Driving the **real** `classifyEvent` over the live database opened `readOnly: true`:

```
HYGIENE_RULE_VERSION                    = hygiene-rules/v4
canonical events                        = 292407
assistant events with a [SILENT] line   = 2907
still synthetic via silent-sentinel     = 2784   (expected 2784)
flipped to conversational               = 123   (expected 123)
claimed by some OTHER rule / class      = 0
```

Both measured numbers match the pre-plan census. The "claimed by some other rule = 0" line is the
extra check that the 123 genuinely reached `conversational` rather than being swallowed by a
neighbouring rule.

### Version bump — stated plainly

`HYGIENE_RULE_VERSION` is now **`hygiene-rules/v4`** (REQ-054). This is the third bump in Phase 11
(v2 in Plan 11-20, v3 in Plan 11-24, v4 here). It is correct, not something to bury: the rule set
changes `classifyEvent` output for 123 events, and the bump is what marks every contraction
checkpoint stale via `PROCESSOR_VERSION` so Plan 11-29's rebuild fires without `--force`.

### ADR 0048 addendum

Appended `## Addendum 2026-07-28 — GAP-11-H: [SILENT] is a trailing sentinel, not a block (Plan 11-28)`:
the false-positive class and its opposite failure direction from GAP-11-D/E/G, the narrowed
predicate and the startsWith-vs-equals evidence, the counted blast radius table, the v4 bump and
its rebuild consequence, and why the v3 review missed it. **Addendum only — nothing deleted.**

## Verification

| Check | Result |
|---|---|
| Pre-fix failure output recorded | Yes, verbatim above (4 failures) |
| Both sides pinned by tests, real corpus shapes | Yes — 7 new tests, ids cited in comments |
| `matchesEmbedded` unchanged | Yes — `git diff` on it is empty |
| `git diff src/` confined to one rule + version + comments | Yes (see Deviations for a commit-attribution note) |
| 123 / 2,784 re-verified read-only after the change | Yes — 123 flipped, 2,784 retained, 0 elsewhere |
| `HYGIENE_RULE_VERSION` = `hygiene-rules/v4` | Yes |
| ADR 0048 addendum, nothing deleted | Yes |
| `npx vitest run` | **110 passed / 1 skipped files; 1024 passed / 4 skipped tests; 0 failed** |
| `npm run typecheck` | Clean |
| Proportional-corpus ratio guard | Passed unchanged — its expectation did not move, so nothing was re-derived or widened |

The known `tests/mcp/*` parallel-load flake did not trip in this run (both files passed).

No writes of any kind were made to `~/.memory/aaron.db`; every corpus query used
`new DatabaseSync(path, { readOnly: true })`. No rebuild, no prune. The three backups
(`.pre-rebuild-v3`, `.pre-anchor-prune`, `.pre-phase11`) are untouched.

## Deviations from Plan

**1. [Rule 1 - Bug] Predicate widened from the plan's suggested exact-line filter to a
starts-with-line filter**

- **Found during:** Task 1, while checking the suggested shape against existing pinned fixtures
- **Issue:** The plan's suggested `l.trim() !== marker` filter would have additionally flipped
  `[SILENT] no response needed` (an existing pinned synthetic fixture in two test files) to
  conversational, and would have broken the `SYNTHETIC_MARKERS` drift guard for this rule, since
  `rule.test("[SILENT]x")` would return false.
- **Fix:** Drop lines that START with the marker. Measured against the whole corpus first: the two
  predicates disagree on 0 of 292,407 events, so the live-corpus blast radius is identical.
- **Files modified:** `src/topic/derivation-hygiene.ts`
- **Commit:** `184d6bc` (predicate itself landed in `30aa34e`, see below)

**2. [Process] Commit attribution collision with a concurrent agent**

- **Found during:** Task 1, immediately after the GREEN edits
- **Issue:** Another agent active in this session committed `30aa34e docs(11): plan the close-out
  chain (11-29, 11-30, 11-31)` with a broad `git add` that swept my in-flight
  `src/topic/derivation-hygiene.ts` edits into its commit. The code is correct and present in the
  tree; only the attribution is wrong. Nothing was lost or overwritten.
- **Fix:** No code change. The follow-up commit `184d6bc` carries the correct
  `fix(11-28): …` message and records the collision in its body, so `git log` reads honestly.
- **Note for the phase:** this is a real hazard of parallel agents on one worktree, and worth
  flagging to the orchestrator independently of this plan.

**3. [Process] The carried-forward `gsd-sdk` indexing bug bit again**

- **Found during:** state updates
- **Issue:** `state.advance-plan` errored (`Cannot parse Current Plan or Total Plans`), `state.update-progress` found no Progress field, `state.record-metric` rejected positional args, and `state.record-session` rewrote `current_plan` to a nonsensical `22` and stripped the quoting from `stopped_at`. This is the same upstream bug STATE.md already carries forward from Plan 11-26.
- **Fix:** `current_plan` set to `29` by hand, `stopped_at` re-quoted and rewritten for this plan, the GAP-11-H entry and three decisions added by hand. `roadmap.update-plan-progress` and `requirements.mark-complete` both worked. Not fixable from this repository.

## Known Stubs

None.

## Threat Flags

None — this plan added no network, auth, file-access, or schema surface. It narrows one
classification predicate.

## Notes for the next plan (11-29)

- The 123 events are now `conversational` but their text is still absent from the derived corpus,
  because the v3 rebuild excluded it. Only the rebuild puts it back.
- `hygiene-rules/v4` marks every checkpoint stale, so 11-29's rebuild should fire without `--force`.
- 11-29's stop condition ("the eligible set IS the 330") is now checkable: after this fix the 20
  `silent-sentinel` anchors are no longer prune-eligible.
- No SC7 claim is made here; GAP-11-F is untouched.

## Self-Check: PASSED

- Files verified present: `src/topic/derivation-hygiene.ts`, `tests/topic/derivation-hygiene.test.ts`, `docs/adr/0048-derivation-input-hygiene.md`, this summary
- Commits verified in `git log`: `15eb8e9` (RED), `184d6bc` (GREEN + header), `b6a6303` (ADR addendum). The predicate and version bump were physically committed in `30aa34e` by a concurrent agent's broad `git add` — see Deviations #2.
- `git diff 9aa381b -- src/topic/derivation-hygiene.ts` (pre-plan baseline → now), excluding comments, is exactly: the version constant, the new `isSentinelOnly` helper, and the one rule entry. `matchesEmbedded`'s body appears on no changed line.
