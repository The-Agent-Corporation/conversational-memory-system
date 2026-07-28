---
phase: 12-daemon-incremental-embedding
plan: 04
subsystem: daemon
tags: [embedding-repair, bounded-cost, failure-isolation, crash-recovery, tdd, req-043]

requires:
  - phase: 12
    plan: 01
    provides: "`DifferingIdentityEmbedder` — the two-identity fixture the convergence assertion needs"
  - phase: 12
    plan: 02
    provides: "`listSummaryIdsMissingVector`'s `{ limit }` parameter, the state predicate, and `listSummariesByIds`"
  - phase: 12
    plan: 03
    provides: "the `summaryEmbedder` closure variable in `daemon-command.ts` and the `after_contraction_checkpoint` crash window this plan heals"
provides:
  - "`EmbeddingRepairRunner` — the bounded missing-set repair pass"
  - "the optional `embeddingRepair` daemon dependency, invoked in BOTH `drainOne` and `runOnce`"
  - "`repairRunner`, built in the same memoized initializer that resolves the one process embedder"
affects: [12-05, 12-06, 12-07]

tech-stack:
  added: []
  patterns:
    - "A budget belongs in the query, not in a `.slice()` after it — otherwise the pass allocates and discards 99.6% of its result every tick"
    - "Forward progress can be structural rather than cursor-based: an ascending-ordered query over a set each pass shrinks converges by taking the first K every time"
    - "An always-spread dependency whose backing object may be undefined expresses 'off' as a no-op call, not as an absent field — the only shape available when the backing object resolves after construction"

key-files:
  created:
    - src/daemon/embedding-repair.ts
    - tests/daemon/embedding-repair.test.ts
  modified:
    - src/daemon/daemon.ts
    - src/daemon/daemon-command.ts

key-decisions:
  - "The budget is pushed into `listSummaryIdsMissingVector` as `{ limit }` and asserted with a store spy on the call arguments — a JS slice would pass a count assertion and fail this one"
  - "`nextDueAt` is set BEFORE the work, so a persistently failing query is rate limited rather than retried on every drain"
  - "The result field is `remainingInBatch`, not `remaining`: because the query is limited, `examined === budget` means 'at least this many remain', and a field named `remaining` would be read as a total"
  - "An id the bounded fetch does not resolve counts `failed` rather than throwing — it was deleted between query and fetch, which is not an error"
  - "`embeddingRepair` takes no `DaemonWriteAuthority`: it writes only to the derived vector sidecar, on ids the store itself reports missing"
  - "Wired like `syncReplication` (swallow, keep the lease, never touch `didWork`), explicitly NOT like `proposalScheduler`, whose throw calls `loseAuthority()`"

requirements-completed: []
requirements-advanced: [REQ-043]

metrics:
  duration: 18min
  tasks: 2
  files: 4
  completed: 2026-07-28
---

# Phase 12 Plan 04: The Bounded Repair Pass Summary

A summary that a crash left committed without its vector now heals itself on a later daemon tick, at
a cost of at most 200 embeds per invocation and one limited query, in both `run` and `once` modes.

## What was built

**Task 1 — `EmbeddingRepairRunner` (commit `7c5b13a`).** `runDue()` reads the injected monotonic
clock, returns a frozen skipped result if the 15-minute minimum interval has not elapsed, then:

```
ids = listSummaryIdsMissingVector(provider, model, { limit: budget })   // budget IN the query
summaries = listSummariesByIds(ids)                                     // never a whole-table load
embed each (passage mode), skip-and-count a falsy personId
one batched saveSummaryVectors(records)
```

Defaults are `budget = 200` and `minimumIntervalMs = 15 * 60 * 1000`. `nextDueAt` is set *before*
the work, so a query that fails every time is still rate limited. The whole body is wrapped; every
per-summary embed and the batched save have their own catch. `runDue` returns a result on every
path and throws on none. On `failed > 0` it writes one stderr line carrying counts, provider, and
model — never an id, never summary text.

**Task 2 — the wiring (commit `aebd9ac`).** `DaemonLoopDependencies` gained
`embeddingRepair?: { runDue(): Promise<unknown> }`, docstring'd against the `syncReplication`
precedent. A private `runEmbeddingRepair()` guards on `assertLeaseAuthority()`, calls `runDue()`,
and swallows. It is invoked from `drainOne` (after the sync block, before `return didWork`) and
from `runOnce` (after that method's own contraction loop, before the proposal tier).
`daemon-command.ts` builds `repairRunner` inside the same memoized initializer that resolves
`summaryEmbedder`, and spreads `embeddingRepair: { runDue: async () => repairRunner?.runDue() }`
unconditionally.

## The pre-fix failures, verbatim

**Task 1 RED, step 1 — the module did not exist:**

```
 ❯ tests/daemon/embedding-repair.test.ts (0 test)
 FAIL  tests/daemon/embedding-repair.test.ts [ tests/daemon/embedding-repair.test.ts ]
Error: Failed to load url ../../src/daemon/embedding-repair.js (resolved id: ../../src/daemon/embedding-repair.js) in /Users/aaronwhaley/Agent-Corporation/conversational-memory-system/tests/daemon/embedding-repair.test.ts. Does the file exist?
```

**Task 1 RED, step 2 — against a no-op stub, so the failures are per-case rather than one import
error.** 8 of 10:

```
 ❯ tests/daemon/embedding-repair.test.ts (10 tests | 8 failed) 31ms
   × EmbeddingRepairRunner > embeds at most the budget per invocation and converges to zero across successive invocations 13ms
     → expected { skipped: false, examined: +0, …(3) } to match object { skipped: false, examined: 200, …(2) }
   × EmbeddingRepairRunner > pushes the budget into the query as `{ limit }` rather than slicing in JS 6ms
     → expected [] to have a length of 1 but got +0
   × EmbeddingRepairRunner > heals a summary a crash left committed without its vector 9ms
     → expected { skipped: false, examined: +0, …(3) } to match object { skipped: false, examined: 2, …(1) }
   × EmbeddingRepairRunner > never throws when the embedder throws 0ms
     → expected { skipped: false, examined: +0, …(3) } to match object { skipped: false, examined: 3, …(2) }
   × EmbeddingRepairRunner > never throws when the store write rejects 0ms
     → expected { skipped: false, examined: +0, …(3) } to match object { skipped: false, examined: 3, …(2) }
   × EmbeddingRepairRunner > rate limits with the injected clock: work at most once inside the minimum interval 1ms
     → expected +0 to be 4 // Object.is equality
   × EmbeddingRepairRunner > never embeds a superseded summary 0ms
     → expected { skipped: false, examined: +0, …(3) } to match object { examined: 1, persisted: 1, …(1) }
   × EmbeddingRepairRunner > skips and counts a summary with no personId, never substituting one (T-10-05) 0ms
     → expected { skipped: false, examined: +0, …(3) } to match object { Object (examined, persisted, ...) }
```

The clearest one expanded:

```
 FAIL  … > embeds at most the budget per invocation and converges to zero across successive invocations
AssertionError: expected { skipped: false, examined: +0, …(3) } to match object { skipped: false, examined: 200, …(2) }

- Expected
+ Received

  Object {
-   "examined": 200,
+   "examined": 0,
    "failed": 0,
-   "persisted": 200,
+   "persisted": 0,
    "skipped": false,
  }
```

**The two cases that passed against the stub, stated plainly:** "does no work at all when nothing is
missing" and "never throws when the missing-set query rejects" are both negative assertions, and a
no-op stub satisfies them vacuously. They earn their keep only against the real implementation,
where they constrain it.

**Task 2 RED** — three wiring cases, before `embeddingRepair` existed on the dependency type:

```
 ❯ tests/daemon/embedding-repair.test.ts (15 tests | 3 failed) 116ms
   × DaemonLoop embeddingRepair wiring > invokes the repair pass on every drain, and its throw never fails the drain or drops the lease 4ms
     → expected [] to have a length of 3 but got +0
   × DaemonLoop embeddingRepair wiring > invokes the repair pass in `runOnce` too, which has its own loop and never calls drainOne (F11) 1ms
     → expected [ 'proposals' ] to deeply equal [ 'repair', 'proposals' ]
   × daemon repair-pass wiring through the real dependency path (F2) > runs the pass in `once` mode when an embedder resolves, with the budget in the query 28ms
     → expected [] to deeply equal [ [ 'fake-differing', …(2) ] ]
```

The `runOnce` failure is F11 caught mechanically: `["proposals"]` with no `"repair"` is exactly the
"wired only into `drainOne`" state the finding described.

## Proof the pass is bounded

The store spy records every call with its arguments. With 500 summaries missing and `budget: 200`:

```js
const queries = callsTo(calls, "listSummaryIdsMissingVector");
expect(queries).toHaveLength(1);
expect(queries[0]!.args).toEqual([embedder.provider, embedder.model, { limit: 200 }]);
```

**One query per invocation, and the budget is inside it.** An implementation that fetched all 49,314
ids and sliced in JS would satisfy every count assertion in the suite and fail this one — that is
the whole reason the assertion is on the arguments rather than on the result size. The bounded fetch
is checked the same way: `listSummariesByIds` is called once, with exactly 200 ids.

Convergence, across four invocations on the same 500-summary store: `examined` 200 / 200 / 100 / 0,
`embedCalls` totalling 500, and `listSummaryIdsMissingVector(provider, model)` unbounded returning
`[]` at the end. Not just the per-pass cap — the set actually empties, which is where a
reintroduced GAP-12-A two-key mismatch would surface as an endless 200-per-tick re-embed. The
fixture is `DifferingIdentityEmbedder` from `tests/embeddings/fixtures.ts`; no embedder double is
defined in this file except `ThrowingEmbedder`, which is a fault injector with no vector identity to
coincide with.

`listSummaries` is asserted **never called** by the spy, on top of the grep:

```
$ grep -c "listSummaries(" src/daemon/embedding-repair.ts
0
$ grep -c "Date.now\|performance.now" src/daemon/embedding-repair.ts
0
```

## Proof it is wired into BOTH loops

Two separate loop-level tests, because `drainOne` and `runOnce` are separate code paths:

- **`drainOne`**: three drains against a `runDue` that throws every time → `runDueCalls` length 3,
  `proposalRuns` 3 (local work still flows), lease still owned by `owner-repair-drain`, and a
  subsequent `requestStop` + drain releases it cleanly.
- **`runOnce`**: one call against a throwing `runDue` → the recorded order is exactly
  `["repair", "proposals"]`. Both halves matter: `"repair"` present proves F11 is closed, and
  `"proposals"` after it proves the throw was swallowed rather than ending the run.

And end-to-end through the real `createDefaultDependencies` path, with the resolver mocked and
`SqliteStore.prototype.listSummaryIdsMissingVector` spied, `memory daemon once` against a temp
database records:

```js
expect(missingSetQueries).toEqual([["fake-differing", "fake-repo@r1", { limit: 200 }]]);
expect(embedderMock.calls).toEqual(["probe", "resolve"]);
```

So Plan 12-06's `memory daemon once` clone check exercises a pass that really runs — and the
`["probe", "resolve"]` pin is the same one-embedder-per-process assertion 12-03 makes, now covering
the repair path too.

## The no-op-when-no-embedder assertion

Same harness, embeddings disabled:

```js
const { result, missingSetQueries } = await runOnceAgainstTempDatabase("disabled");
expect(result).toMatchObject({ ok: true, subcommand: "once" });
expect(missingSetQueries).toEqual([]);
expect(embedderMock.calls).toEqual(["probe"]);
```

**Zero store queries**, through the real production wiring, with the dependency present the whole
time. This is F2's restated criterion exactly: the field is always spread (it must be — the embedder
resolves after `new DaemonLoop({...})` returns), and "off" is a `runDue` that no-ops because
`repairRunner` is still `undefined`.

## The `resolveEmbedder` count

```
$ grep -n "resolveEmbedder" src/daemon/daemon-command.ts
11:import { probeEmbedderHealth, resolveEmbedder } from "../embeddings/embedder-resolver.js";
325:          summaryEmbedder = await resolveEmbedder(databasePath);
```

Two lines, **ONE call site** — unchanged from 12-03. The plan's `grep -c … returns 1` criterion is
mis-specified because `grep -c` counts the import line; the property it stands for (one resolve,
therefore one ONNX session per process, T-12-23) holds and is asserted mechanically by the
`["probe", "resolve"]` pin. `repairRunner` is constructed from the already-resolved
`summaryEmbedder` on the line immediately after it.

## Deviations from Plan

None. No Rule 1/2/3 fix was needed and no Rule 4 decision arose.

Two things worth flagging as judgement calls rather than deviations:

1. **The RED step ran twice.** The first run failed at module resolution (one error, no per-case
   information), so a no-op stub was committed to nothing and used to produce per-case RED output,
   then replaced. Both are recorded above.
2. **Two comments were reworded after GREEN** so the plan's verification greps stay mechanically
   clean. `grep "listSummaries("` and `grep "Date.now\|performance.now"` were each matching a
   docstring that *forbade* the thing — a gate that fails on its own prohibition is a bad gate, so
   the prose now says "never a whole-table load" and "reads no host wall clock and no host
   monotonic clock". Behavior unchanged.

## Staleness — still out of scope, and it stayed that way

No stale-vector heuristic was written, and none was attempted. The pass heals a **missing** vector;
a vector whose summary text changed after embedding still has a row and is therefore never in the
missing set. The root cause was re-verified during this plan: `SummarySchema`
(`src/domain/types.ts:104-129`) has `createdAt`, `version`, and `lastAccessedAt` and no `updatedAt`,
and `contraction-runner.ts:447` sets `version: 1` unconditionally, so there is no monotonic field to
compare a vector's `createdAt` against. Recorded in ADR 0052 decision 6 and `12-DEFERRED.md`
(D-12-1); the module's own docstring repeats the prohibition at the point where a future editor
would be tempted.

## Authentication gates

None — no network path, no credentials. The end-to-end wiring cases mock the resolver, so no model
file is loaded and no ONNX session is constructed.

## Verification

- `npx vitest run`: **1,106 passed | 4 skipped, 113 files passed | 1 skipped**. Baseline after 12-03
  was 1,091/4; the +15 are this plan's cases (10 runner, 3 loop-level, 2 end-to-end wiring). Run
  twice, green both times.
- `npm run typecheck`: clean.
- `npx vitest run tests/daemon/`: 171 passed across 10 files.
- `grep -c "listSummaries(" src/daemon/embedding-repair.ts` → 0.
- `grep -c "Date.now\|performance.now" src/daemon/embedding-repair.ts` → 0.
- `grep -n "resolveEmbedder" src/daemon/daemon-command.ts` → one call site (plus the import).
- `git diff --diff-filter=D HEAD~1 HEAD` → no deletions on either commit.
- Staging: explicit paths on both commits, `git status --short` checked before each. No
  `git add -A`, no `git add .`, no `git stash`, no `git clean`.
- `~/.memory/aaron.db` was never opened, in any mode. The five `~/.memory/` backups are untouched.
  No packages installed.

## Known Stubs

None. (A no-op stub existed for one RED run and was replaced in the same task; it was never
committed.)

## Threat Flags

None. No new network endpoint, no auth path, no schema change, no new file-access pattern — the
repair pass reads and writes the same vector sidecar the contraction stage already writes.

## Surprises

- **The first full-suite run failed on an unrelated timeout.** One test file tripped vitest's
  default timeout under parallel load ("If this is a long-running test, pass a timeout value…"),
  1,105 passed / 1 failed. Two subsequent full runs were completely green (1,106/4). Consistent
  with the known flake class the briefing named; not caused by this plan, whose files run in 162 ms.
  Recorded rather than quietly re-run.
- **A skipped invocation costs exactly one clock read.** The rate-limit test asserts
  `listSummaryIdsMissingVector` was called once across three `runDue` calls — the interesting half
  is not that the second returns `skipped`, but that it touches the store zero times. A rate limiter
  that queried first and discarded the result would satisfy the return-value assertion.
- **The T-10-05 case needs the same post-fetch perturbation trick 12-03 needed**, for a different
  reason: the commit validator rejects a `personId`-less summary, so it cannot be seeded. Here the
  field is stripped on the way out of `listSummariesByIds`. The vector row written for the surviving
  summary is asserted to carry `PERSON_ID` — proving the pass skipped rather than substituted.
- **The plan's own `grep` gates matched its own prose.** Writing a docstring that names the
  forbidden call is good documentation and a self-defeating verification gate. Worth remembering
  when a plan specifies a grep-for-nothing criterion on a file that is also expected to explain
  why the thing is forbidden.

## Self-Check: PASSED

Files verified present: `src/daemon/embedding-repair.ts`, `tests/daemon/embedding-repair.test.ts`,
`src/daemon/daemon.ts`, `src/daemon/daemon-command.ts`. Commits verified in `git log`: `7c5b13a`,
`aebd9ac`.
