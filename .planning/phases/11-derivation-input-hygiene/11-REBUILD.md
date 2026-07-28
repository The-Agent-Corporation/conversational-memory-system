# Phase 11 — Live Derivation Rebuild (Plan 11-25)

**Status:** **STOPPED AT TASK 2. The live rebuild was NOT run.**
**Reason:** the rehearsal tripped stop condition (a) — 1,330 anchors that Plan 11-18 pruned are
resurrected by the rebuild, every one of them carrying raw `[Tool call: …]` text.

**Run date:** 2026-07-28 (UTC)
**Git commit:** `455ba7d4841d335c6a834fefbc6634dbced32978`
**Database under test:** APFS clones of `~/.memory/aaron.db`; the live database was never opened for
writing by this plan.

---

## Authorization evidence

### Owner authorization, granted in advance

The owner authorized the live rebuild before the rehearsal existed. Verbatim, as relayed by the
orchestrator:

> "go ahead don't worry about the credentials those are really old"

That authorization was given against **simulated** figures from Plan 11-24, not against a measured
rehearsal. The orchestrator therefore attached a decision rule, stated to the owner before this plan
ran: the authorization stands **only if the rehearsal broadly matches the projection**, and the plan
must stop at Task 2 without running anything live if any of the following occurs:

| # | Stop condition | Result |
|---|---|---|
| (a) | Any anchor that Plan 11-18 pruned is resurrected | **TRIPPED — 1,330 anchors resurrected** |
| (b) | Interrupt-and-resume does not converge to the same receipt | not tripped — converged exactly |
| (c) | `--force` turns out to be required | not tripped — `--force` was never used or needed |

**Condition (a) is tripped, so the rehearsal did NOT fall within the decision rule's bounds and the
owner's advance authorization does not extend to this operation.** Task 3 was not executed. The live
corpus is byte-identical to its pre-plan state (evidenced below).

This is threat **T-11-90** in the plan's own register — "the rebuild resurrecting anchors that Plan
11-18 pruned, silently undoing a closed gap" — firing exactly as anticipated, caught by the mitigation
the plan required (mandatory before/after anchor counts and a resurrection verdict, checked *before*
authorization rather than discovered after a live run).

### Scope this plan operated under

`11-REMEDIATION-DECISION.md` Decision 1 authorized the rebuild ("Run/enable `rebuild-derivations`
remediation for the H-iii offenders (the live application itself is Plan 11-25, owner-gated)"). This
plan attempted exactly that operation and no wider one.

**GAP-11-F (the live credential in the corpus) is explicitly out of scope.** The owner declined
rotation as stale. The rebuild reproduces that credential faithfully into new summaries from the
untouched canonical events. This is known, accepted, and was not "fixed" opportunistically here.

### Backup evidence

The orchestrator took the fresh backup this plan requires before execution began. Verified by `stat`
as an existing regular non-empty file:

```
-rw-r--r--  aaronwhaley  5031448576  2026-07-27T19:30:48Z  /Users/aaronwhaley/.memory/aaron.db.pre-rebuild-v3
```

5,031,448,576 bytes — byte-for-byte the size of `~/.memory/aaron.db`, with an identical mtime
(`2026-07-27T19:30:48Z`), confirming it is an APFS clone (`cp -c`) of the **current** state and that
nothing has written to the live database since it was taken. `~/.memory/aaron.db-wal` was 0 bytes at
clone time, so no uncheckpointed WAL content was omitted from the backup.

It is **not** `pre-phase11` and **not** `pre-anchor-prune`; both of those predate the current state and
were rejected as substitutes. Both survive this plan untouched — see "Backups after this plan" below.

---

## Task 1 — Rehearsal on a clone

Three runs against three independent `cp -c` clones. The live database was never a target.

| clone | purpose | path |
|---|---|---|
| `rehearsal.db` | Run A — clean uninterrupted rebuild | `…/scratchpad/rehearsal.db` |
| `rehearsal-b.db` | Runs B1/B2 — interrupt and resume | `…/scratchpad/rehearsal-b.db` |
| `baseline-v3check.db` | read-only control: classify today's live anchors under `hygiene-rules/v3` | `…/scratchpad/baseline-v3check.db` |

Scratchpad root:
`/private/tmp/claude-501/-Users-aaronwhaley-Agent-Corporation-conversational-memory-system/6ea0c5f7-ef88-4139-838b-47b0e29baa9d/scratchpad`

Command (identical to what a live run would be, modulo `--db`):

```
NODE_OPTIONS=--max-old-space-size=8192 npx tsx src/cli/bin.ts \
  rebuild-derivations --db <clone> --person aaron
```

### Staleness / `--force`

`--force` was **not required and was never passed.** The staleness predicate
(`rebuild-derivations-command.ts:99`) fired on its own, as Plan 11-24 predicted:

| | value |
|---|---|
| live checkpoint `processorVersion` (before) | `continuous-contraction/v1+hygiene-rules/v1` |
| code `PROCESSOR_VERSION` | `continuous-contraction/v1+hygiene-rules/v3` |
| `HYGIENE_RULE_VERSION` | `hygiene-rules/v3` |
| `checkpoint.processorVersion !== PROCESSOR_VERSION` | true → `isStale` → full rewind |

Generation went 2 → 3 and `earliestAffected` rewound to the first canonical event, as designed.

### Run A — clean full rebuild

**Elapsed: 9 min 40 s** (`2026-07-28T00:30:49Z` → `2026-07-28T00:40:29Z`), 1,170 slices at 250 events
per slice, ≈504 events/sec.

Receipt, verbatim from the command's stdout:

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

Final progress line, verbatim:

```json
{"event":"progress","slices":1170,"processedEvents":292407,"complete":true}
```

### Before / after counts (Run A)

| metric | before | after | delta |
|---|---:|---:|---:|
| canonical events | 292,407 | 292,407 | 0 |
| turns | 584,814 | 584,814 | 0 |
| summaries — **active** | 50,551 | **49,253** | −1,298 |
| summaries — **superseded** | 87,727 | **89,120** | +1,393 |
| summaries — total rows | 138,278 | 138,373 | +95 |
| **anchors** | 19,268 | **20,598** | **+1,330** |
| summary vectors | 0 | 0 | 0 |
| boxes / traces / proposals | 0 / 0 / 0 | 0 / 0 / 0 | 0 |
| file size (bytes) | 5,031,448,576 | 5,031,448,576 | 0 |
| `pragma user_version` | 3 | 3 | 0 |
| checkpoint `processorVersion` | `…+hygiene-rules/v1` | `…+hygiene-rules/v3` | — |
| checkpoint `generation` | 2 | 3 | +1 |
| checkpoint `immediateStage` | complete | complete | — |

### Arithmetic check

Row-level consistency:

> active −1,298 + superseded +1,393 = total +95 ✓ (138,278 + 95 = 138,373 ✓)

Reconciling the receipt against the row counts requires one non-obvious fact, stated here rather than
left as an apparent discrepancy: **`summariesWritten: 50,422` is overwhelmingly upserts, not inserts.**
138,278 + 50,422 would be 188,700 rows if every write were an insert; the actual total is 138,373. The
difference (50,327) is writes landing on the *same deterministic summary id*
(`summaryId(personId, firstEventId, topicLabel)`), i.e. `saveSummary` updating a row in place. This is
the intended design — `rebuild-derivations` deliberately reuses `historicalContractionJobId` precisely
so it supersedes and rewrites the existing summary set rather than deriving a parallel one
(`rebuild-derivations-command.ts:20-23`).

Likewise `supersededSummaries: 50,435` far exceeds the net superseded growth of +1,393: the invalidator
supersedes a summary and the same run then re-derives and re-writes it active under the same id. Only
1,393 summaries are superseded *and* never re-derived — those are the ones the v3 hygiene rules
eliminate outright.

**File size is unchanged at 5,031,448,576 bytes.** SQLite does not shrink a file without `VACUUM`,
which this command correctly does not run. **The ~64.6 MB figure in Plan 11-24's projection is a
logical payload figure, not a file-size figure — a live rebuild will not reduce the 4.6 GB file at
all.** This should be stated plainly to the owner, since "135,366 → 49,253 summaries, ~64.6 MB" reads
like a disk-space claim and is not one.

### Rehearsal vs. Plan 11-24's projection

| figure | projected (11-24, `hygiene-rules/v3`) | measured (Run A) | divergence |
|---|---:|---:|---|
| active summaries after | 49,253 (recommended pass) | **49,253** | **exact match** |
| active summaries after (raw pass) | 110,308 | 49,253 | n/a — the recommended pass is what the product runs |
| isolated tool-call events affected | 15,996 | (not directly reported by the receipt) | see anchor finding below |

The recommended-pass projection was exact to the row. The retired pre-revision targets (55,930
summaries / 77.6 MB) are not quoted as expectations anywhere in this document.

### Interrupt-and-resume convergence (REQ-054 / SC5) — **CONVERGED**

- **Run B1:** started on a fresh clone at `00:41:51Z`, `SIGKILL`ed at `00:44:53Z` after **518 slices /
  129,500 events** (≈44% through). No receipt was emitted, confirming a genuine mid-run kill.
- **Interrupted intermediate state** (recorded because it is an operational hazard worth the owner
  knowing): active summaries had collapsed to **22,217** with 116,077 superseded. **An interrupted
  rebuild leaves the corpus badly degraded for memory purposes until it is resumed** — most content is
  superseded and not yet re-derived. Checkpoint sat at `…v3`, generation 3, `immediateStage: pending`.
- **Run B2 (resume, no `--force`):** `00:45:09Z` → `00:51:49Z`, 6 min 40 s. Receipt, verbatim:

```json
{
  "ok": true,
  "rebuilt": true,
  "personId": "aaron",
  "hygieneRuleVersion": "hygiene-rules/v3",
  "processorVersion": "continuous-contraction/v1+hygiene-rules/v3",
  "slices": 652,
  "processedEvents": 162907,
  "summariesWritten": 27688,
  "supersededSummaries": 0
}
```

It **resumed rather than restarting from zero** (T-11-16): 129,500 + 162,907 = **292,407 exactly**, and
518 + 652 = **1,170 slices**, identical to Run A's slice count. `supersededSummaries: 0` on the resume
is correct — the invalidation happened once, on the generation bump in B1.

Final-state comparison, clean run vs. interrupted-and-resumed run:

| metric | Run A (clean) | Run B (interrupt+resume) | match |
|---|---:|---:|---|
| `pragma user_version` | 3 | 3 | YES |
| canonical events | 292,407 | 292,407 | YES |
| turns | 584,814 | 584,814 | YES |
| summaries total | 138,373 | 138,373 | YES |
| summaries active | 49,253 | 49,253 | YES |
| summaries superseded | 89,120 | 89,120 | YES |
| anchors | 20,598 | 20,598 | YES |
| summary vectors | 0 | 0 | YES |
| file size | 5,031,448,576 | 5,031,448,576 | YES |
| checkpoint `processorVersion` | `…+hygiene-rules/v3` | `…+hygiene-rules/v3` | YES |
| checkpoint `generation` | 3 | 3 | YES |
| checkpoint `immediateStage` | complete | complete | YES |
| checkpoint `sliceCount` | 3,510 | 3,510 | YES |

The **anchor id sets are byte-identical** between the two runs (`diff` on 20,598 sorted ids: no
difference). Resumability and idempotence are confirmed. **Stop condition (b) is not tripped.**

---

## FINDING — Anchor resurrection (stop condition (a)) — BLOCKING

### Verdict

**1,330 anchors that Plan 11-18 permanently deleted are re-created by the rebuild, and every single one
of them contains raw `[Tool call: …]` payload text.**

Method (id-level, not count-level): the pruned set was reconstructed exactly by differencing the anchor
ids in `~/.memory/aaron.db.pre-anchor-prune` (45,911) against those in `~/.memory/aaron.db` (19,268),
yielding **26,643 pruned ids — matching 11-18's `prunedCount: 26643` receipt exactly.** That set was
then intersected with the post-rebuild clone's anchor ids.

| set | count |
|---|---:|
| anchors before 11-18's prune | 45,911 |
| anchors pruned by 11-18 | 26,643 |
| anchors in live corpus now | 19,268 |
| anchors on the clone after rebuild | 20,598 |
| **pruned ∩ post-rebuild — RESURRECTED** | **1,330** |
| pre-rebuild live anchors dropped by the rebuild | 0 |
| brand-new anchors never seen before | 0 |

All 1,330 resurrected anchors were inspected directly: **1,330 / 1,330 contain the substring
`[Tool call:`**. By type: 481 `decision`, 365 `key_fact`, 264 `strategic_insight`, 219 `deadline`,
1 `bookmark`. Sample content, verbatim (truncated):

```
anchor_personal_turn_event_006a3a46…_decision
  [Tool call: Bash] {"command":"cd \"/Users/aaronwhaley/Github/Active Projects/OpenClaw_repos/…

anchor_personal_turn_event_009c6719…_decision
  [Tool call: Write] {"file_path":"/tmp/dolt-dog-run.sh","content":"#!/usr/bin/env bash\n…

anchor_personal_turn_event_00b3f6da…_decision
  [Tool call: Agent] {"description":"Re-review Task 4 after fix","model":"sonnet",…
```

Independent confirmation via the product's own classifier
(`prune-unhygienic-anchors` dry-run on the post-rebuild clone):

```json
{
  "totalCount": 20598,
  "countsByClass": { "conversational": 18918, "tool_activity": 1330, "synthetic_injected": 350 },
  "unhygienicCount": 1680,
  "unhygienicPayloadBytes": 6962802,
  "unattributedCount": 0
}
```

`tool_activity: 1330` matches the resurrected set exactly. Before the rebuild, the live corpus has
`tool_activity: 0` (11-18's post-prune dry-run, and reconfirmed below under v3 rules).

### Root cause

`src/daemon/contraction-runner.ts:469` — `survivingDerivationIndices` still implements the **old,
now-reversed SC1 rule**:

```ts
const flushRun = (): void => {
  if (currentRun.length === 1) survivors.add(currentRun[0]!);   // isolated tool call "survives"
  currentRun = [];
};
```

An event in `survivors` produces anchors via `anchorsForTurn` (line 258), whose `content` is the
event's **raw text**, never the hygiene-processed derivation text.

Plan 11-24 reversed SC1 in `derivationContents` — it removed the `segment.entries.length === 1`
verbatim short-circuit so an isolated tool call now *collapses* into the summary. It did **not** make
the corresponding change to `survivingDerivationIndices`, which is that decision's anchor-side twin.
The comment immediately above the call site (lines 247-254) still states the pre-reversal contract
verbatim, and is now factually wrong:

> "Anchors follow derivation content exactly (REQ-053): an event produces anchors only when it
> contributed its OWN text to the summary — conversational events and **ISOLATED single tool calls**."

After 11-24 an isolated single tool call no longer contributes its own text to the summary, so the
anchor gate and the summary derivation now **disagree**. This is the same class of invariant ADR 0048
protects for `openToolRunStart`/`derivationContents` ("can never disagree about where a run begins") —
the anchor-side agreement was simply not maintained through the SC1 reversal. 11-24's SUMMARY
explicitly reasoned about `openToolRunStart` and concluded the shared-`computeSegments` invariant was
untouched; `survivingDerivationIndices` is a *separate* reimplementation of the same rule and was not
considered.

1,330 rather than all 15,996 corpus-wide isolated tool-call events resurrect because `anchorsForTurn`
only emits an anchor when the raw text matches one of its five keyword regexes — `decision`, `because`,
`risk`, `confirmed`, and so on. Tool-call JSON blobs hit those keywords incidentally.

### Why this is blocking, not a footnote

- It **reverses a completed gap closure.** GAP-11-D was closed by permanently deleting these rows;
  ADR 0051 records that no `rebuild-anchors` command exists and restore-from-backup is the only
  recovery path. Re-creating them means the live run would undo 11-18's work as a side effect.
- It **re-introduces the exact text SC3 forbids** into the anchor retrieval path — the path 11-18
  measured as responsible for tool-call leakage in the recall probe.
- It is **not self-correcting.** A follow-up prune would delete them again, but the *next* rebuild
  would recreate them again. The fix belongs in `survivingDerivationIndices`, not in a repeated prune.

### Recommended remediation (not performed — outside this plan's scope)

Make `survivingDerivationIndices`' `flushRun` drop isolated single tool calls (delete the
`if (currentRun.length === 1) survivors.add(...)` line) so the anchor gate matches post-11-24
`derivationContents`, update the now-wrong comment at lines 247-254, add a regression test pinning
"an isolated tool call produces no anchor", and re-rehearse. This is a code change of the same class as
11-24's and needs its own plan.

---

## Second finding — 350 pre-existing unhygienic anchors, NOT caused by the rebuild

The post-rebuild clone also shows `synthetic_injected: 350`. These are **not** resurrected — the
resurrected set and the survivor set are provably disjoint (intersection 0). Read-only control run:
today's live corpus, unrebuilt, classified under `hygiene-rules/v3`:

```json
{
  "totalCount": 19268,
  "countsByClass": { "conversational": 18918, "tool_activity": 0, "synthetic_injected": 350 },
  "unhygienicCount": 350,
  "unhygienicPayloadBytes": 4120178,
  "unattributedCount": 0
}
```

So **350 anchors that survived 11-18's prune as `conversational` under `hygiene-rules/v1` classify as
`synthetic_injected` under `hygiene-rules/v3`.** This is Plan 11-24's H-i fix (line-anchored embedded
marker matching) detecting scaffolding the v1 rules could not see. It is a v3 improvement, it exists in
the live corpus right now independent of any rebuild, and it is a separate item from this plan's
blocker. Recorded here so it is not later mistaken for rebuild damage. Per 11-24's own analysis, some
fraction of these may be prose that merely mentions a marker at a line start; each should be inspected
before any second prune.

---

## What a live run would do to `~/.memory/aaron.db` (measured, not estimated)

Had Task 3 been authorized and run, on the evidence of two independent full rehearsals:

- ~10 minutes of wall clock (9 m 40 s clean), during which the corpus is unusable for normal agent
  memory; if interrupted, it stays degraded (≈22k active summaries) until resumed.
- Active summaries 50,551 → 49,253; superseded 87,727 → 89,120; total rows 138,278 → 138,373.
- **Anchors 19,268 → 20,598, of which 1,330 are resurrected raw tool-call anchors** (the blocker).
- Unhygienic anchors 350 → 1,680.
- Canonical events, turns, `user_version`, and **file size all unchanged**. No disk space is reclaimed.
- Summary vectors: 0 before and after — the corpus has no summary vectors at all (embeddings are
  disabled by default), so the command's T-11-18 vector-tombstoning step is a no-op on this corpus.

**None of this was applied. Task 3 did not run.**

---

## Live corpus and backups after this plan

`~/.memory/aaron.db` `stat`, recorded before Task 1 and again after Task 2 — identical, confirming the
plan never wrote to it:

| when | size | mtime |
|---|---:|---|
| before Task 1 (`2026-07-28T00:28:50Z`) | 5,031,448,576 | 2026-07-27T19:30:48Z |
| after Task 2 | 5,031,448,576 | 2026-07-27T19:30:48Z |

All backups present, none deleted, overwritten, or moved by this plan:

| path | size | mtime |
|---|---:|---|
| `~/.memory/aaron.db.pre-rebuild-v3` | 5,031,448,576 | 2026-07-27T19:30:48Z |
| `~/.memory/aaron.db.pre-anchor-prune` | 5,031,448,576 | 2026-07-27T11:23:59Z |
| `~/.memory/aaron.db.pre-phase11` | 4,962,574,336 | 2026-07-26T19:26:45Z |

---

## Tooling divergence noted

`11-25-PLAN.md`'s `<interfaces>` block documents the invocation as
`memory rebuild-derivations --database <path> --person aaron`. The actual flag parsed by
`rebuild-derivations-command.ts:225` is **`--db`**; `--database` is silently ignored and the command
then fails with "Missing memory database path." Minor, but it is a documented interface that does not
match the code.

## Verification

- `npm run typecheck` — clean. No code was modified by this plan, so this only confirms the tree is
  green at `455ba7d`.
- `npx vitest run` was **not** run: the plan requires it "after the run" as a guard that the live
  operation did not perturb anything, and no live operation occurred. The pre-existing full-suite
  parallel-load flake in `tests/mcp/mutation-tools.test.ts` / `tests/mcp/stdio-server.test.ts`
  (documented in `deferred-items.md`) remains untouched.

## No claim is made here about SC7, GAP-11-E, or recall quality

This plan changed nothing in the corpus. Whether the v3 rules improve recall is measured by Plan 11-26,
against a corpus that has not yet been rebuilt.
