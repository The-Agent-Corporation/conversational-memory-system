# Phase 11 — Live Derivation Rebuild (Plan 11-25)

**Status:** **COMPLETE. The live rebuild was applied to `~/.memory/aaron.db` on 2026-07-28.**

This document has two halves, in the order they happened:

1. **Tasks 1–2 (2026-07-28T00:28–00:56Z, commit `4781658`) — rehearsal, then STOP.** The first rehearsal
   tripped stop condition (a): 1,330 anchors that Plan 11-18 pruned were resurrected, every one carrying
   raw `[Tool call: …]` text. Task 3 was not run. Recorded below unchanged, as the evidence that gated
   the operation.
2. **Task 3 (2026-07-28T01:26–01:36Z, commit `504685d`) — live run.** Plan 11-27 fixed the two defects
   behind the resurrection; the orchestrator re-verified the stop rule (resurrection 0) and released the
   gate. The live rebuild ran and its receipt is recorded at the end of this document.

**Git commit at rehearsal:** `47816582d7fe83b2f848521543a8a791d576540b`
**Git commit at live run:** `504685d4c26a75f71f74030a262053376424d9ef`

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

| # | Stop condition | Result at first rehearsal (`4781658`) | Result after Plan 11-27 (`504685d`) |
|---|---|---|---|
| (a) | Any anchor that Plan 11-18 pruned is resurrected | **TRIPPED — 1,330 anchors resurrected** | **cleared — 0 resurrected** |
| (b) | Interrupt-and-resume does not converge to the same receipt | not tripped — converged exactly | unchanged |
| (c) | `--force` turns out to be required | not tripped — `--force` was never used or needed | unchanged |

**At the first rehearsal, condition (a) tripped, so the rehearsal did NOT fall within the decision
rule's bounds and the owner's advance authorization did not extend to that operation.** Task 3 was not
executed at that point, and the live corpus was left byte-identical to its pre-plan state.

This is threat **T-11-90** in the plan's own register — "the rebuild resurrecting anchors that Plan
11-18 pruned, silently undoing a closed gap" — firing exactly as anticipated, caught by the mitigation
the plan required (mandatory before/after anchor counts and a resurrection verdict, checked *before*
authorization rather than discovered after a live run).

**Gate release.** Plan 11-27 (`54cc66f`, `90e25ae`, `504685d`) fixed the two defects behind the
resurrection and re-ran a full rebuild on a fresh clone, measuring resurrection at id level as **0**,
with the post-rebuild anchor id set identical to live (19,268) and classifier `tool_activity: 0`. Its
rebuild receipt was byte-identical to this document's Run A, confirming the fix touched anchors and
nothing else. On that basis the orchestrator confirmed every branch of the owner's decision rule is now
satisfied and released the gate. Task 3 then ran — see "Task 3 — Live run" at the end of this document.

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
-rw-r--r--  aaronwhaley  5031448576  2026-07-27T19:30:48-0400  /Users/aaronwhaley/.memory/aaron.db.pre-rebuild-v3
                                     (= 2026-07-27T23:30:48Z)  inode 181199709
```

5,031,448,576 bytes — byte-for-byte the size of `~/.memory/aaron.db`, with an identical mtime,
confirming it is an APFS clone (`cp -c`) of the **current** state and that nothing has written to the
live database since it was taken. It is a **distinct inode** (181199709) from `aaron.db` (171672602),
so a write to the live database cannot reach it. `~/.memory/aaron.db-wal` was 0 bytes at clone time, so
no uncheckpointed WAL content was omitted from the backup.

> **Timezone note.** `stat -f %Sm` on this machine renders **local time (EDT, UTC−4)**. Every `mtime`
> quoted in this document is local; wall-clock run timings from `date -u` are true UTC. Both are
> labelled explicitly from here on.

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

### Remediation — done by Plan 11-27, not by this plan

Recommended at the time: make `survivingDerivationIndices` drop isolated single tool calls so the
anchor gate matches post-11-24 `derivationContents`, fix the now-wrong comment, add a regression test,
and re-rehearse.

That became **Plan 11-27 / GAP-11-G** (`54cc66f`, `90e25ae`, `504685d`), which found the defect was in
fact twofold and removed the duplicated rule entirely rather than patching the copy:
`survivingDerivationIndices` now delegates to the same `drivesTopicLabel` predicate every other call
site uses, so no second copy of the rule remains to drift out of agreement with `derivationContents`.
11-27's own clone rehearsal measured resurrection at **0**. The live run in Task 3 below confirms it on
the real corpus.

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

## Prediction recorded before the live run (measured on clones, not estimated)

This is the prediction Task 3 was later compared against. Recorded at the time of the STOP, on the
evidence of two independent full rehearsals:

- ~10 minutes of wall clock (9 m 40 s clean), during which the corpus is unusable for normal agent
  memory; if interrupted, it stays degraded (≈22k active summaries) until resumed.
- Active summaries 50,551 → 49,253; superseded 87,727 → 89,120; total rows 138,278 → 138,373.
- **Anchors 19,268 → 20,598, of which 1,330 are resurrected raw tool-call anchors** (the blocker — this
  is the one figure Plan 11-27 deliberately changed before Task 3 ran).
- Unhygienic anchors 350 → 1,680.
- Canonical events, turns, `user_version`, and **file size all unchanged**. No disk space is reclaimed.
- Summary vectors: 0 before and after — the corpus has no summary vectors at all (embeddings are
  disabled by default), so the command's T-11-18 vector-tombstoning step is a no-op on this corpus.

**As of the STOP, none of this had been applied and the live corpus was untouched:** `stat` on
`~/.memory/aaron.db` was identical before Task 1 (`2026-07-28T00:28:50Z` UTC) and after Task 2 —
5,031,448,576 bytes, mtime 2026-07-27T19:30:48 EDT, inode 171672602.

---

## Tooling divergence noted

`11-25-PLAN.md`'s `<interfaces>` block documents the invocation as
`memory rebuild-derivations --database <path> --person aaron`. The actual flag parsed by
`rebuild-derivations-command.ts:225` is **`--db`**; `--database` is silently ignored and the command
then fails with "Missing memory database path." Minor, but it is a documented interface that does not
match the code.

---

# Task 3 — Live run against `~/.memory/aaron.db`

**Applied 2026-07-28.** Git commit `504685d4c26a75f71f74030a262053376424d9ef` (includes Plan 11-27's
anchor-gate fix). Authorization: the owner's advance authorization, released by the orchestrator after
Plan 11-27 cleared stop condition (a) — see "Gate release" above.

Command, run in the background with output captured to a log and polled to exit:

```
NODE_OPTIONS=--max-old-space-size=8192 npx tsx src/cli/bin.ts \
  rebuild-derivations --db /Users/aaronwhaley/.memory/aaron.db --person aaron
```

`--force` was **not** passed and was not needed: the live checkpoint was still at
`continuous-contraction/v1+hygiene-rules/v1` / generation 2 immediately before the run, against a code
`PROCESSOR_VERSION` of `continuous-contraction/v1+hygiene-rules/v3`, so the staleness predicate fired on
its own exactly as it did on the clones.

**Elapsed: 9 min 51 s** (`2026-07-28T01:26:48Z` → `2026-07-28T01:36:39Z` UTC), 1,170 progress lines.

## Live receipt (verbatim)

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

**This receipt is byte-identical to the rehearsal's Run A receipt.**

## Before / after counts (live)

| metric | before | after | delta | rehearsal Run A predicted | matches prediction |
|---|---:|---:|---:|---:|---|
| canonical events | 292,407 | 292,407 | 0 | 292,407 | yes |
| turns | 584,814 | 584,814 | 0 | 584,814 | yes |
| summaries — **active** | 50,551 | **49,253** | −1,298 | 49,253 | yes |
| summaries — **superseded** | 87,727 | **89,120** | +1,393 | 89,120 | yes |
| summaries — total rows | 138,278 | 138,373 | +95 | 138,373 | yes |
| **anchors** | 19,268 | **19,268** | **0** | 20,598 | **no — see divergence 1** |
| summary vectors | 0 | 0 | 0 | 0 | yes |
| boxes / traces / proposals | 0 / 0 / 0 | 0 / 0 / 0 | 0 | 0 / 0 / 0 | yes |
| file size (bytes) | 5,031,448,576 | 5,031,448,576 | 0 | 5,031,448,576 | yes |
| `pragma user_version` | 3 | 3 | 0 | 3 | yes |
| checkpoint `processorVersion` | `…+hygiene-rules/v1` | `…+hygiene-rules/v3` | — | `…+hygiene-rules/v3` | yes |
| checkpoint `generation` | 2 | 3 | +1 | 3 | yes |
| checkpoint `immediateStage` | complete | complete | — | complete | yes |
| checkpoint `sliceCount` | 2,340 | 3,510 | +1,170 | 3,510 | yes |

## Arithmetic consistency check

> active −1,298 + superseded +1,393 = total +95 ✓
> 138,278 + 95 = 138,373 ✓
> checkpoint `sliceCount` 2,340 + receipt `slices` 1,170 = 3,510 ✓

Receipt-to-rows reconciliation, identical in structure to the rehearsal's and stated again so the
apparent gap is not read as a discrepancy: `summariesWritten: 50,422` would imply 188,700 total rows if
every write were an insert, but the actual total is 138,373. The 50,327 difference is writes landing on
the **same deterministic summary id** — `saveSummary` updating in place. This is the intended design;
`rebuild-derivations` reuses `historicalContractionJobId` precisely so it supersedes and rewrites the
existing summary set rather than deriving a parallel one. Likewise `supersededSummaries: 50,435` far
exceeds the net superseded growth of +1,393 because the invalidator supersedes a summary and the same
run re-derives and re-writes it active under the same id; only **1,393** summaries are superseded and
never re-derived — those are the ones the v3 hygiene rules eliminate outright.

**File size did not shrink and was never going to.** 5,031,448,576 bytes before and after. SQLite does
not release pages without a `VACUUM`, which this command correctly does not run. **The ~64.6 MB figure
from Plan 11-24's projection is logical payload, not disk**, and should not be read as a disk-space
claim.

## Anchor verdict (id level, not count level)

| set | count |
|---|---:|
| anchors before the live run | 19,268 |
| anchors after the live run | 19,268 |
| **anchors from 11-18's 26,643-id pruned set present after the run — RESURRECTED** | **0** |
| pre-run anchors dropped by the run | 0 |
| brand-new anchors never seen before | 0 |

The post-run anchor id set is **byte-identical** to the pre-run set (`diff` on 19,268 sorted ids: no
difference). Classifier confirmation, run read-only on a `cp -c` clone of the post-rebuild live corpus:

```json
{
  "totalCount": 19268,
  "countsByClass": { "conversational": 18918, "tool_activity": 0, "synthetic_injected": 350 },
  "unhygienicCount": 350,
  "unhygienicPayloadBytes": 4120178,
  "unattributedCount": 0
}
```

`tool_activity: 0`. The 350 pre-existing `synthetic_injected` anchors are unchanged in count and
payload bytes — they were **not** pruned by this plan and remain an open owner decision.

## Divergences from the rehearsal

**1. Anchors: 19,268 live vs 20,598 rehearsed — a −1,330 divergence. Intended, and the reason the
rehearsal existed.** Cause: the rehearsal ran at `4781658`, before Plan 11-27; the live run ran at
`504685d`, after it. The rehearsal's 1,330 resurrected raw tool-call anchors are exactly the rows
11-27's fix suppresses, and the live delta is exactly 1,330 — the same number, from the same id set. In
consequence, unhygienic anchors went 350 → 350 live, against the rehearsal's predicted 350 → 1,680.

This divergence is a *changed code path*, not a rehearsal that failed to predict the tooling. That
distinction matters because Plan 11-18 hit the opposite case — a preview that under-reported its own
apply by 851 rows. Here the rehearsal predicted its own code exactly, and every figure produced by code
that 11-27 did **not** touch is identical between the two runs, including the receipt byte-for-byte.
That identity is itself the evidence that 11-27's fix was surgical: had it perturbed summary derivation,
`summariesWritten`, `supersededSummaries`, `slices`, or the summary counts would have moved. None did.

**2. Elapsed: 9 m 51 s live vs 9 m 40 s rehearsed — +11 s (+1.9 %).** Machine noise on an otherwise
identical 1,170-slice / 292,407-event workload. No structural cause; the live database and the clone
share the same physical device and the clone shares its unmodified blocks with the original.

**No other divergence of any magnitude was observed.** Every remaining figure in the table above matches
the rehearsal exactly.

## Live corpus and backups after Task 3

`~/.memory/aaron.db` — mtime advanced, as expected for a database that was written; inode unchanged, so
it is the same file and no backup was swapped in:

| when | inode | size | mtime (local, EDT) |
|---|---:|---:|---|
| before Task 3 | 171672602 | 5,031,448,576 | 2026-07-27T19:30:48 |
| after Task 3 | 171672602 | 5,031,448,576 | 2026-07-27T21:36:32 |

All three backups present, at distinct inodes, none deleted, moved, or overwritten by this plan:

| path | inode | size | mtime (local, EDT) | mtime (UTC) |
|---|---:|---:|---|---|
| `~/.memory/aaron.db.pre-rebuild-v3` | 181199709 | 5,031,448,576 | 2026-07-27T19:30:48 | 2026-07-27T23:30:48Z |
| `~/.memory/aaron.db.pre-anchor-prune` | 180214168 | 5,031,448,576 | 2026-07-27T11:23:59 | 2026-07-27T15:23:59Z |
| `~/.memory/aaron.db.pre-phase11` | 179000198 | 4,962,574,336 | 2026-07-26T19:26:45 | 2026-07-26T23:26:45Z |

Every backup mtime is unchanged from its pre-Task-3 value. `~/.memory/aaron.db-wal` is 0 bytes after the
run, so the database is fully checkpointed and the file on disk is the complete state. ADR 0051's
restore-from-backup path is intact.

## GAP-11-F

Out of scope and untouched, per the owner's decision to decline rotation as stale. The rebuild
re-derived summaries from the untouched canonical events and will therefore have faithfully reproduced
the mission-control credential into the new summary text. Known, accepted, not remediated here.

## Verification

- `npx vitest run` — **110 test files passed, 1 skipped; 1,017 tests passed, 4 skipped**, 22.63 s. Fully
  green. The pre-existing `tests/mcp/mutation-tools.test.ts` / `tests/mcp/stdio-server.test.ts`
  parallel-load timeout flake (documented in `deferred-items.md`) did not reproduce on this run.
- `npm run typecheck` — clean, no output beyond the `tsc --noEmit` invocation line.
- No source file was modified by this plan; the corpus changed, the code did not.

## No claim is made here about SC7, GAP-11-E, or recall quality

This plan produced a receipt, not an acceptance. Whether the `hygiene-rules/v3` rebuild improved recall
is measured by **Plan 11-26**, against the now-rebuilt corpus.
