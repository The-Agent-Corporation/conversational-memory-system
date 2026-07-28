---
phase: 11-derivation-input-hygiene
plan: 27
subsystem: derivation
tags: [anchors, hygiene, contraction, rebuild, gap-closure]

requires:
  - phase: 11-derivation-input-hygiene
    provides: "Plan 11-25's id-level rehearsal measurement (1,330 resurrected anchors) and the GAP-11-G diagnosis"
  - phase: 11-derivation-input-hygiene
    provides: "Plan 11-24's SC1 reversal in derivationContents, whose anchor-side twin was never applied"
provides:
  - "A single shared anchor minter (anchorsForTurn) used by both the contraction/rebuild path and the live Hermes bridge"
  - "An eventKind-aware forward gate, so the gate and commitUnhygienicAnchorPrune agree in both directions"
  - "Measured proof that a full rebuild regenerates ZERO of the 26,643 anchors Plan 11-18 deleted"
affects: [11-25 live rebuild, SC7, anchor retrieval quality]

tech-stack:
  added: []
  patterns:
    - "One derivation rule, one implementation: a duplicated rule is treated as a defect, not a style issue"

key-files:
  created: []
  modified:
    - src/daemon/contraction-runner.ts
    - src/anchors/anchor-detector.ts
    - src/integrations/hermes/adapter.ts
    - src/storage/sqlite-store.ts
    - tests/daemon/contraction-runner.test.ts
    - tests/anchors/anchor-detector.test.ts
    - tests/integrations/hermes-adapter.test.ts
    - docs/adr/0051-anchor-derivation-hygiene.md

key-decisions:
  - "Chose option (a): detectForTurn takes an optional eventKind parameter, rejecting metadata-carried (b) and a Turn schema field (c)"
  - "Unified the two anchor minters rather than leaving a documented duplicate — the duplicate IS what produced GAP-11-G"
  - "survivingDerivationIndices delegates to drivesTopicLabel instead of re-implementing the run walk"
  - "The 350 pre-existing synthetic_injected anchors are recorded as a separate open item, not pruned here"

patterns-established:
  - "Gate inputs must be a superset-or-equal of prune inputs in BOTH directions, not just the safe one"
  - "A contract comment that describes superseded behavior is a defect surface, not cosmetics"

requirements-completed: [REQ-052, REQ-053]

duration: 30min
completed: 2026-07-28
---

# Phase 11 Plan 27: Close GAP-11-G — the rebuild path's ungated anchor minter

**A full `rebuild-derivations` on a fresh clone of the live 292,407-event corpus now regenerates ZERO of the 26,643 anchors Plan 11-18 deleted (was 1,330), because the contraction path's private, ungated anchor minter is gone and the one remaining gate now classifies on `eventKind` the same way the store's prune does.**

## Performance

- **Duration:** ~30 min (of which ~10 min is the background rebuild)
- **Started:** 2026-07-28T01:00Z (approx.)
- **Completed:** 2026-07-28T01:25Z
- **Tasks:** 3/3
- **Files modified:** 8

## Accomplishments

### Task 1 — Gate the rebuild path (Defect 1)

`src/daemon/contraction-runner.ts` had its own local `anchorsForTurn` that never imported
`AnchorDetector`, so the GAP-11-D forward gate applied to `src/integrations/hermes/adapter.ts:89`
and to nothing else. The rebuild's only protection was `survivingDerivationIndices`, which
re-implemented `computeSegments`' run walk and still admitted a length-1 run — the pre-reversal SC1
carve-out Plan 11-24 had removed from `derivationContents`.

`survivingDerivationIndices` now delegates to the shared `drivesTopicLabel` predicate, so the
re-implementation is gone rather than merely corrected. The stale contract comment (previously lines
247–254, still stating "conversational events and ISOLATED single tool calls" verbatim) now states
the post-reversal rule and names GAP-11-G as what a stale comment cost.

**Pre-fix failure output, verbatim:**

```
 ❯ tests/daemon/contraction-runner.test.ts (32 tests | 1 failed | 30 skipped) 15ms
   × ContractionRunner > GAP-11-G: an isolated tool call mints no anchor on the rebuild path, conversational anchors unchanged 14ms
     → expected true to be false // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/daemon/contraction-runner.test.ts > ContractionRunner > GAP-11-G: an isolated tool call mints no anchor on the rebuild path, conversational anchors unchanged
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ tests/daemon/contraction-runner.test.ts:624:81
    622|
    623|     const anchors = await store.listAnchors();
    624|     expect(anchors.some((anchor) => anchor.canonicalEventId === "gap11…
       |                                                                                 ^
```

The fixture (`embeddedToolEvent`) is the exact shape the rehearsal found in all 1,330 resurrections:
an `eventKind: "tool_call"` event whose content CONTAINS `[Tool call: ` without starting with it,
isolated between conversational events.

Two existing tests pinned the pre-reversal rule and were flipped, with the reason recorded inline:
`"keeps anchors for an isolated single tool call"` → `"excludes …"`, and the withheld-boundary test's
final assertion (the deferred decision now resolves to "no anchor" at every slice size, which is
still the slice-size-independence property that test exists to pin).

### Task 2 — eventKind-aware gate (Defect 2)

**Pre-fix failure output, verbatim:**

```
 ❯ tests/anchors/anchor-detector.test.ts (10 tests | 1 failed) 7ms
   × AnchorDetector > eventKind-aware gate (GAP-11-G) > creates no anchors for a tool_call-kind turn whose content does not start with the prefix 3ms
     → expected [ { …(10) }, { …(10) }, { …(10) } ] to deeply equal []

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/anchors/anchor-detector.test.ts > AnchorDetector > eventKind-aware gate (GAP-11-G) > creates no anchors for a tool_call-kind turn whose content does not start with the prefix
AssertionError: expected [ { …(10) }, { …(10) }, { …(10) } ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   Object {
+     "anchorType": "deadline",
+     "content": "Checking the build first.
+ [Tool call: Bash] {\"command\":\"npm test\",\"note\":\"we decided this because of the deadline risk\"}",
+     "id": "anchor_turn_kind_tool_deadline",
…3 anchors: deadline, decision, strategic_insight
```

The other two tests in that block passed pre-fix, which is what makes the failure meaningful: the
no-eventKind path already produced those three anchors and still does.

**Mechanism chosen: (a) — `detectForTurn(turn, { eventKind })`.**

- **(b), metadata-carried eventKind, rejected.** `turn.metadata` is an untyped
  `Record<string, unknown>` bag that is *persisted*, so the gate's behavior would depend on when a
  turn was written: turns already in the corpus have no `eventKind` key and would classify
  differently from turns written after the change. A silent, data-age-dependent asymmetry in the
  hygiene classifier is the same failure shape as GAP-11-G itself.
- **(c), a `Turn.eventKind` field, rejected.** It is a domain-contract change (`src/domain/types.ts`
  Zod schema) requiring edits to both `SqliteStore` and `InMemoryStore` per CLAUDE.md, plus a schema
  migration, to carry information that only two call sites need and that is always recomputable from
  the canonical event.
- **(a) accepted.** It is additive, type-checked, defaulted, and the no-eventKind path is literally
  the same expression as before (`eventKind: undefined` → `event.eventKind ?? null` → the identical
  content-prefix branch). A test pins that path explicitly.

**Two anchor implementations no longer remain — they were unified.** `anchorsForTurn` is now one
exported pure function in `src/anchors/anchor-detector.ts`; `AnchorDetector.detectForTurn` is that
function plus a save, and `ContractionRunner` calls it directly, passing the `CanonicalEvent`'s
`eventKind`. This was deliberate rather than the smaller "keep both, document the invariant" option:
nothing structural kept the copies in agreement before, the plan's own acceptance criterion flags an
unexplained duplicate as the root cause class, and — decisively — after Task 2 the eventKind
parameter would otherwise have had **no production caller at all**, since Hermes never emits a kind.
Unification makes the fix load-bearing on the exact path that produced the 1,330.

The two implementations were verified equivalent before merging: identical five regexes, identical
`anchor_${turn.id}_${anchorType}` id scheme, identical field set. The only difference was that the
runner's copy wrote `String(turn.metadata.personId)` unconditionally while the detector's omits
absent keys; runner turns always carry all three keys (`turnFromEvent` sets them), so the merged
behavior is byte-identical on both paths.

**Hermes seam** (`src/integrations/hermes/adapter.ts`, the live agent bridge) forwards
`event.eventKind` to the anchor gate — the same third input the topic gate on the line above already
received. Hermes rows carry no `eventKind` today, so this is arming, not a behavior change. Explicit
coverage added in `tests/integrations/hermes-adapter.test.ts`: one test asserts the forwarding
actually happens (spy on the seam), one asserts observable behavior is unchanged (conversational row
still mints `deadline`/`key_fact` with byte-identical content; `role: "tool"` row still mints none).

`src/storage/sqlite-store.ts`'s comment about the gate/prune superset relation is corrected: the
inputs now agree in both directions for a caller that knows the kind, and remain a safe subset for
one that does not.

### Task 3 — Measured proof on a fresh clone

Full `rebuild-derivations` on a fresh `cp -c` clone at commit `cafc8e7`, run in the background,
elapsed **~10 min** (`01:09:14Z` → `01:19:24Z`), 1,170 slices. Receipt, verbatim:

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

Byte-identical to Plan 11-25 Run A's receipt, confirming the fix changed anchors and nothing else.

Id-level differencing, the same method Plan 11-25 used (pruned set reconstructed by differencing
`~/.memory/aaron.db.pre-anchor-prune` against live, then intersected with the post-rebuild set):

| set | Plan 11-25 (pre-fix) | Plan 11-27 (post-fix) |
|---|---:|---:|
| anchors before 11-18's prune | 45,911 | 45,911 |
| anchors pruned by 11-18 | 26,643 | 26,643 (receipt match) |
| anchors in live corpus now | 19,268 | 19,268 |
| anchors on the clone after rebuild | 20,598 | **19,268** |
| **pruned ∩ post-rebuild — RESURRECTED** | **1,330** | **0** |
| pre-rebuild live anchors dropped by the rebuild | 0 | 0 |
| brand-new anchors never seen before | 0 | 0 |

The post-rebuild anchor id set is now *identical* to the live corpus's — 0 added, 0 dropped.

Independent confirmation from the product's own classifier (`prune-unhygienic-anchors` dry run on
the post-rebuild clone):

```json
{
  "ok": true, "applied": false, "personId": "aaron",
  "totalCount": 19268,
  "countsByClass": { "conversational": 18918, "tool_activity": 0, "synthetic_injected": 350 },
  "unhygienicCount": 350, "unhygienicPayloadBytes": 4120178, "unattributedCount": 0
}
```

`tool_activity: 0` (was 1,330). Non-anchor counts on the clone match 11-25's Run A exactly —
canonical events 292,407, turns 584,814, summaries total 138,373 / active 49,253 / superseded 89,120.

**Live database untouched.** `stat` before and after Task 3, plus all three backups:

| path | size | mtime | inode |
|---|---:|---|---:|
| `~/.memory/aaron.db` (before, 01:08Z) | 5,031,448,576 | 2026-07-27T19:30:48Z | 171672602 |
| `~/.memory/aaron.db` (after, 01:20Z) | 5,031,448,576 | 2026-07-27T19:30:48Z | 171672602 |
| `~/.memory/aaron.db.pre-rebuild-v3` | 5,031,448,576 | 2026-07-27T19:30:48Z | 181199709 |
| `~/.memory/aaron.db.pre-anchor-prune` | 5,031,448,576 | 2026-07-27T11:23:59Z | 180214168 |
| `~/.memory/aaron.db.pre-phase11` | 4,962,574,336 | 2026-07-26T19:26:45Z | 179000198 |

Identical size, mtime, and inode. Nothing deleted, moved, or overwritten. The `pre-anchor-prune`
backup was opened read-only to reconstruct the pruned id set.

ADR 0051 gained a dated addendum (2026-07-28). Original text verified intact by diffing the first
173 lines against a pre-edit copy.

## Open item — the 350

350 anchors **already in the live corpus** classify `synthetic_injected` under `hygiene-rules/v3`
while they were `conversational` under v1 (Plan 11-24's H-i line-anchored marker matching detecting
scaffolding v1 could not see). They are not rebuild damage: disjoint from the 1,330, present on an
unrebuilt clone, and the post-fix rebuild leaves the count at exactly 350.

**Not fixed here, and no position taken on whether they should be.** Removing them would be a second
`prune-unhygienic-anchors --apply` run — a separate, owner-gated, irreversible operation. Per Plan
11-24's own analysis some fraction may be prose that merely quotes a marker at the start of a line,
the exact false positive `matchesEmbedded`'s conservative anchoring exists to prevent, so each should
be inspected before any prune. **Owner decision, deliberately left open.**

## Deviations from Plan

### Auto-fixed / scope judgments

**1. [Rule 2 — missing critical functionality] Unified the two anchor minters instead of documenting the duplicate**
- **Found during:** Task 2
- **Issue:** The plan permitted leaving two implementations with a written justification. After
  Task 2, no production caller would have supplied `eventKind` (Hermes has none, and the rebuild
  path used its own copy), leaving the defect-2 fix dead code on the path that caused the incident.
- **Fix:** Promoted `anchorsForTurn` to one exported pure function in `anchor-detector.ts`; deleted
  the runner's copy; runner passes the `CanonicalEvent`'s `eventKind`.
- **Files modified:** `src/anchors/anchor-detector.ts`, `src/daemon/contraction-runner.ts`
- **Commit:** `cafc8e7`

**2. [Rule 2] Corrected the `sqlite-store.ts` gate/prune superset comment**
- **Found during:** Task 2. The team-lead brief flagged it; the comment asserted a one-directional
  safety property that this plan changes.
- **Commit:** `cafc8e7`

**3. Flipped two existing tests that pinned the pre-reversal SC1 rule**
- Necessary, not optional: they encoded the behavior GAP-11-G is. Each carries an inline comment
  recording what it asserted before and why it changed.
- **Commit:** `ecbc1e2`

### Not done, deliberately

- **GAP-11-F** (credential in the corpus) — explicitly out of scope; owner declined rotation.
- **The 350 `synthetic_injected` anchors** — recorded above as an open item, no prune run.
- **`commitUnhygienicAnchorPrune`, `dedupeRankedMemory`, `derivationContents`, `computeSegments`,
  `SYNTHETIC_RULES`** — untouched, as required.

## Verification

- `npx vitest run` — **1,017 passed | 4 skipped**, 110 files passed / 1 skipped. The known
  `tests/mcp/*` parallel-load timing flake did not fire on either full run.
- `npm run typecheck` — clean.
- `npx vitest run tests/daemon/contraction-runner.test.ts` — 32 passed.
- `grep -q "GAP-11-G" docs/adr/0051-anchor-derivation-hygiene.md` — ADR_AMENDED.
- Both regression tests failed before their fix; both failure outputs recorded verbatim above.
- Id-level resurrection count: **0**.
- `~/.memory/aaron.db` `stat`-identical before and after.

## What surprised me

The `survivingDerivationIndices` walk turned out to be *entirely* vestigial once the length-1
admission was removed: with no carve-out, "conversational events, synthetic dropped, run members
dropped" is just "conversational events" — the run grouping computed nothing. The function was a
run-detection algorithm whose only remaining output was a plain `classifyEvent` filter. That is
probably why the divergence went unnoticed: it *looked* like it was mirroring `computeSegments`, so
reviewers checked that it matched the walk rather than asking whether it needed to be a walk at all.

## Commits

| Task | Commit | Description |
|---|---|---|
| 1 | `ecbc1e2` | Gate the rebuild path's anchor minting (defect 1) |
| 2 | `cafc8e7` | eventKind-aware gate + unified minter (defect 2) |
| 3 | (docs commit) | ADR 0051 addendum, SUMMARY, state |

## Self-Check: PASSED

All modified files exist on disk; both task commits (`ecbc1e2`, `cafc8e7`) resolve in `git log`;
ADR 0051 contains `GAP-11-G` and its pre-addendum 173 lines diff clean against a pre-edit copy.
