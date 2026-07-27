# Phase 11 — Live Anchor Prune Receipt (GAP-11-D Live-Corpus Remediation)

**Run date:** 2026-07-27
**Database:** `~/.memory/aaron.db`
**Git commit:** `b7ae28b73c5e12ff76ba8a17a517173dc08528e0`
**Command:**
```
npx tsx src/cli/bin.ts prune-unhygienic-anchors --db ~/.memory/aaron.db --person aaron \
  --apply --confirm-backup ~/.memory/aaron.db.pre-anchor-prune
```
**Elapsed (apply loop):** 21.1s wall clock (`18:51:44Z` -> `18:52:05Z` UTC), 92 batches (batch size 500,
one final partial batch), `~1,263 anchors/sec`.

---

## Authorization audit trail (Task 1)

Owner authorization was granted before this plan ran, on the basis of an earlier session's dry-run and
the subsequent fix (`b7ae28b`) that made the dry-run agree with what apply deletes (25,792 -> 26,643,
closing the 851-row assistant-role-gated `synthetic_injected` undercount). This executor independently
reproduced the four checks Task 1 requires, from the live system, before treating that authorization as
still valid:

**1. Fresh dry-run** (`prune-unhygienic-anchors --db ~/.memory/aaron.db --person aaron`, no `--apply`):
```json
{
  "ok": true, "applied": false, "personId": "aaron",
  "totalCount": 45911,
  "countsByClass": { "conversational": 19268, "tool_activity": 8911, "synthetic_injected": 17732 },
  "unhygienicCount": 26643, "unhygienicPayloadBytes": 214615234,
  "unattributedCount": 0
}
```
Matches the orchestrator's cited post-fix figure (26,643) exactly.

**2. Backup verification:**
```
-rw-r--r--  1 aaronwhaley  staff  5031448576 Jul 27 11:23 ~/.memory/aaron.db.pre-anchor-prune
-rw-r--r--  1 aaronwhaley  staff  4962574336 Jul 26 19:26 ~/.memory/aaron.db.pre-phase11
```
Both present, regular files, non-empty, sizes matching the orchestrator's stated values. Neither was
touched by this plan.

**3. Test suite / typecheck at commit `b7ae28b`:**
- `npx vitest run`: 109 test files passed, 1 failed (`tests/mcp/mutation-tools.test.ts` > "05-04 Task 2
  rolls back every durable effect at each injected transaction boundary", 5000ms timeout under
  full-parallel-suite load), 4 skipped — 997 passed / 1 failed / 4 skipped of 1002 total. Isolated re-run
  of the same test (`npx vitest run tests/mcp/mutation-tools.test.ts -t "05-04 ..."`) passed in 441ms.
  This is the identical pre-existing flake documented in `11-17-SUMMARY.md` and `deferred-items.md`
  (last touched by Plan 05-04, commit `e969499`, long before Phase 11) — not a regression introduced by
  this plan or its dependencies, and not touched here per the executor scope-boundary rule.
- `npm run typecheck`: clean, no output beyond the `tsc --noEmit` invocation line.

**4. Live anchor count vs. census:** `totalCount: 45911` (dry-run above) matches the 45,911-anchor census
in `11-GAP-11-D.md` and ADR 0051 exactly — no drift between the census and the state at execution time.

**Irreversibility, stated plainly:** the prune deletes anchor rows permanently. There is no
`rebuild-anchors` command (ADR 0051, Recovery section) — forward recovery of a wrongly deleted anchor
means restoring `~/.memory/aaron.db.pre-anchor-prune` or `~/.memory/aaron.db.pre-phase11`, or re-deriving
through a future contraction pass over the untouched canonical events (anchors regenerate as a side
effect of turns being reprocessed, not on demand). Canonical events, turns, and summaries are not touched
by this command — verified structurally below.

Authorization for `apply` was granted by the owner in the prior session against this evidence class (see
teammate message accompanying this plan's execution); this executor treated that as standing and produced
fresh confirming evidence rather than re-soliciting a decision already made.

---

## Apply receipt (Task 2)

Full JSON result from the `--apply` invocation:
```json
{
  "ok": true, "applied": true, "personId": "aaron",
  "totalCount": 45911,
  "countsByClass": { "conversational": 19268, "tool_activity": 8911, "synthetic_injected": 17732 },
  "unhygienicCount": 26643, "unhygienicPayloadBytes": 214615234,
  "unattributedCount": 0,
  "prunedCount": 26643,
  "prunedByClass": { "tool_activity": 8911, "synthetic_injected": 17732 },
  "skippedByReason": { "retained_conversational": 19268 },
  "freedPayloadBytes": 214615234,
  "batches": 92,
  "backupPath": "/Users/aaronwhaley/.memory/aaron.db.pre-anchor-prune",
  "backupBytes": 5031448576
}
```

`ruleVersion`: the command's receipt schema does not surface a distinct `ruleVersion` field (unlike
`rebuild-derivations`'s `hygieneRuleVersion`) — `commitUnhygienicAnchorPrune` classifies via the same
unversioned `classifyEvent` used by the forward gate; the `hygiene-rules/v1` rule table is the only
version in play across this phase and is unchanged by this plan.

No skip reason other than `retained_conversational` occurred — `skippedByReason` has exactly one key.
No `person_mismatch` or `person_unattributed` skips occurred (both are live, tested paths per ADR 0051,
neither fired here since this is a single-person corpus).

---

## Independent read-only re-census (not trusting the command's own report)

Queried `~/.memory/aaron.db` directly via `node:sqlite` `{ readOnly: true }` after the apply run
completed, and separately queried the untouched `~/.memory/aaron.db.pre-anchor-prune` backup for the
before-state, since no before-snapshot of `turns`/`summaries` counts was captured prior to the apply run
itself:

| Table | Before (`.pre-anchor-prune` backup) | After (`aaron.db`) | Delta |
|---|---:|---:|---:|
| `anchors` | 45,911 | 19,268 | −26,643 |
| `canonical_events` | 292,407 | 292,407 | 0 |
| `turns` | 584,814 | 584,814 | 0 |
| `summaries` (all states) | 138,278 | 138,278 | 0 |

**Arithmetic:** 45,911 − 26,643 = 19,268. Matches the post-run `anchors` count exactly.

**Dry-run re-run after apply** (confirms live classification state, not just row count):
```json
{
  "ok": true, "applied": false, "personId": "aaron",
  "totalCount": 19268,
  "countsByClass": { "conversational": 19268, "tool_activity": 0, "synthetic_injected": 0 },
  "unhygienicCount": 0, "unhygienicPayloadBytes": 0, "unattributedCount": 0
}
```

- **0 anchors classify as `tool_activity`.** 0 anchors classify as `synthetic_injected`.** No residual —
  nothing to list.
- **Conversational anchor count identical before and after: 19,268 = 19,268.** The prune removed no
  conversational anchor.
- **Canonical event count, turn count, and total summary row count are unchanged** (292,407 / 584,814 /
  138,278 both before and after) — confirms the command touched only the `anchors` table, consistent with
  ADR 0051's "structurally scoped deletion" property (inline `delete from anchors where id = ?`, no
  `deleteAnchors`, never touching `canonical_events`, `turns`, `summaries`, `boxes`, `traces`,
  `proposals`, or `injections`).

## Database file size

| | Before | After |
|---|---:|---:|
| `~/.memory/aaron.db` | 5,031,448,576 bytes | 5,031,448,576 bytes |

The on-disk file size is unchanged — SQLite does not shrink the file on row deletion without a `VACUUM`,
which this command correctly does not run (an operator-triggered maintenance step, out of scope for this
plan and not requested). `freedPayloadBytes` (214,615,234 bytes, ~205 MB) reflects logical payload freed
within the existing pages, not a file-size reduction; this is expected SQLite behavior, not a defect.

## Backups (unchanged, retained)

| Path | Size | mtime |
|---|---:|---|
| `~/.memory/aaron.db.pre-anchor-prune` | 5,031,448,576 | 2026-07-27 11:23 |
| `~/.memory/aaron.db.pre-phase11` | 4,962,574,336 | 2026-07-26 19:26 |

Neither backup was deleted, overwritten, or moved by this plan. Both remain the only recovery path for a
mis-pruned anchor (ADR 0051, Recovery section).

## Pruned-count vs. 25,792 census — reconciliation

The original content-only census in `11-GAP-11-D.md` reported 25,792 gated anchors. The actual pruned
count is **26,643** — 851 more. This is the expected, already-diagnosed cause (`b7ae28b`): the dry-run
previously classified anchors content-only (`role: null`, `eventKind: null`), while
`commitUnhygienicAnchorPrune` enriches classification with the resolved canonical event's `role`/
`eventKind` before deciding eligibility — a strict superset of the forward gate's inputs (ADR 0051 §3).
851 `synthetic_injected` rows fired only the `silent-sentinel` rule, which requires `role: "assistant"`
and is structurally invisible to content-only classification. `b7ae28b` fixed the dry-run to also enrich,
so the dry-run in this plan's Task 1 already reported 26,643 — matching what apply actually deleted, with
no further discrepancy.
