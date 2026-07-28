---
phase: 12-daemon-incremental-embedding
plan: 03
subsystem: daemon
tags: [embedding-seam, contraction, failure-isolation, sync-negative-test, adr, tdd, req-043, req-045]

requires:
  - phase: 12
    plan: 01
    provides: "`composeModelIdentity` and `DifferingIdentityEmbedder` — the two-identity fixture this plan imports"
  - phase: 12
    plan: 02
    provides: "the state-predicated missing set the repair pass in 12-04 will query, and `listSummariesByIds`"
  - phase: 10
    provides: "`saveSummaryVectors` / `deleteSummaryVectors` and the `SummaryVectorRecord` shape copied here"
provides:
  - "the post-commit embed stage in `ContractionRunner.drainSlice`, gated on an optional `summaryEmbedder`"
  - "the additive `embedded: { attempted, persisted, failed }` slice result"
  - "the `summaryEmbedder` closure variable in `daemon-command.ts` that Plan 12-04 reads"
  - "one process-lifetime embedder, probe-gated, in the daemon"
  - "`tests/sync/embeddings-never-sync.test.ts` — SC3 as a tripwire, including the closed-enum pin"
  - "ADR 0052"
affects: [12-04, 12-05, 12-06, 12-07]

tech-stack:
  added: []
  patterns:
    - "A derived-cache stage driven by the set a transaction just committed costs O(committed), not O(corpus), and needs no query"
    - "A stage that must never fail its caller belongs BELOW the boundary that classifies its caller's throws"
    - "An async dependency of a synchronously-constructed object is a memoized closure variable read at call time, not a conditionally-spread field"
    - "A negative test earns its keep by pinning the closed enum, not by scanning bytes for a shape it was told to expect"

key-files:
  created:
    - tests/sync/embeddings-never-sync.test.ts
    - docs/adr/0052-daemon-incremental-embedding-seam.md
  modified:
    - src/daemon/contraction-runner.ts
    - src/daemon/daemon-command.ts
    - tests/daemon/contraction-runner.test.ts
    - tests/daemon/daemon-commands.test.ts
    - tests/bootstrap/historical-bootstrapper.test.ts

key-decisions:
  - "The stage sits inside `drainSlice`, one boundary below the research's placement, so an embedder fault is structurally incapable of being reported as `storage_failure` (daemon.ts:145-148) or of dropping the writer lease (daemon.ts:158-161)"
  - "`summaryEmbedder` is optional and absent means off, which is why `rebuild-derivations-command.ts` and `historical-bootstrapper.ts` needed no edit and still do not embed"
  - "Write-then-delete, decided rather than incidental: the tombstone wins for an id in both sets. Production's `preserveIds` makes that overlap unreachable, so the test injects it"
  - "Counts are the reporting channel; a single stderr line on failure carries counts/provider/model and nothing else"
  - "The daemon probes (`probeEmbedderHealth`) rather than resolving blind, so a corrupt model degrades to no-new-vectors instead of stopping memory formation — recorded in ADR 0052 as PENDING OWNER CONFIRMATION"
  - "The overlap and no-personId cases are driven by a passthrough Proxy over InMemoryStore that perturbs the commit input AFTER the commit validator has run — the validator rejects a personId-less summary, so a pre-commit hook could not express the case"

requirements-completed: []
requirements-advanced: [REQ-043, REQ-045]

metrics:
  duration: 22min
  tasks: 3
  files: 7
  completed: 2026-07-28
---

# Phase 12 Plan 03: The Embed Seam Summary

The daemon now writes a vector for exactly the summaries each contraction slice committed — post-commit,
inside `drainSlice`, with no query at all — and cannot be broken, stalled, or de-authorized by an
embedder fault.

## What was built

**Task 1 — the stage (commit `a8dd559`).** `ContractionRunnerOptions` gained an optional
`summaryEmbedder`. After `commitContractionSlice` resolves and after the existing
`faults?.reach("after_contraction_checkpoint")`, `embedCommittedSummaries(summaries, supersessions)`
runs: one `embedder.embed(summary.summaryText)` per committed summary (passage mode; `embedQuery`
appears nowhere under `src/daemon/`), one batched `saveSummaryVectors(records)` for the whole slice,
then `deleteSummaryVectors(supersededSummaryIds)` from `slice.supersessions` filtered to
`kind === "summary"`. `ContractionSliceResult` gained `embedded: { attempted, persisted, failed }`,
added at both return sites including the complete-checkpoint early return.

Cost is `summaries.length` with **no query**, which is how SC2 holds by construction. The stage never
throws: a per-summary catch, a catch around the batched save, a catch around the tombstone, and an
outer catch as defence in depth. A falsy `personId` is skipped and counted `failed` — never
substituted. On `failed > 0` it writes one stderr line carrying `{event, attempted, persisted, failed,
provider, model}` and nothing else.

**Task 2 — wiring and SC3 (commit `a525a8b`).** `createLoop` gained
`let summaryEmbedder: Embedder | undefined` plus a memoized `initializeEmbedder()` awaited at the top
of both `run` and `runOnce`, so the per-slice `ContractionRunner` closure always reads a settled
value. The initializer calls `probeEmbedderHealth` first; `enabled && healthy` resolves,
`enabled && !healthy` writes the reason once and leaves the embedder undefined, and disabled leaves it
undefined. `tests/sync/embeddings-never-sync.test.ts` holds the four SC3 assertions.

**Task 3 — ADR 0052 (commit `03bff2b`).** Nine decisions, in the house format of 0050/0051 (no
frontmatter; `## Status` / `## Context` / `## Decision` / `## Consequences` / `## Requirement
Traceability`).

## The pre-fix failures, verbatim

**Task 1 RED**, 10 of 10 new cases failing before the stage existed:

```
 ❯ tests/daemon/contraction-runner.test.ts (42 tests | 10 failed) 99ms
   × ContractionRunner post-commit embed stage > persists one vector per summary the slice committed, calling embed exactly that many times 5ms
     → expected 1 to be 3 // Object.is equality
   × ContractionRunner post-commit embed stage > makes embed calls per slice depend on summaries written, not on corpus size (SC2) 1ms
     → expected +0 to be 1 // Object.is equality
   × ContractionRunner post-commit embed stage > refreshes a re-emitted active-span summary's vector instead of leaving it stale (upsert) 0ms
     → expected null not to be null
   × ContractionRunner post-commit embed stage > is entirely off when no summaryEmbedder is supplied 1ms
     → expected undefined to deeply equal { attempted: +0, persisted: +0, …(1) }
   × ContractionRunner post-commit embed stage > does not fail the contraction when the embedder throws on every call 0ms
     → expected 1 to be 3 // Object.is equality
   × ContractionRunner post-commit embed stage > does not fail the contraction when saveSummaryVectors rejects 0ms
     → expected undefined to deeply equal { attempted: 3, persisted: +0, …(1) }
   × ContractionRunner post-commit embed stage > skips a summary with no personId, counts it failed, and never substitutes one (T-10-05) 2ms
     → Contraction derivation ownership mismatch
   × ContractionRunner post-commit embed stage > tags every vector row with the summary's own personId and scopeIds 1ms
     → expected undefined to be 'person_contraction' // Object.is equality
   × ContractionRunner post-commit embed stage > tombstones vectors for the summaries a slice supersedes, leaving every other row intact 0ms
     → expected 1 to be greater than 1
   × ContractionRunner post-commit embed stage > writes before deleting, so an id both re-emitted and superseded in one slice ends tombstoned 1ms
     → expected [] to deeply equal [ 'save', 'delete' ]
```

The clearest three, expanded:

```
 FAIL  … > is entirely off when no summaryEmbedder is supplied
AssertionError: expected undefined to deeply equal { attempted: +0, persisted: +0, …(1) }

- Expected:
Object { "attempted": 0, "failed": 0, "persisted": 0 }
+ Received:
undefined

 FAIL  … > writes before deleting, so an id both re-emitted and superseded in one slice ends tombstoned
AssertionError: expected [] to deeply equal [ 'save', 'delete' ]

- Array [ "save", "delete" ]
+ Array []
```

**Task 2 RED — verified by removing the wiring, not assumed.** With `await initializeEmbedder();`
temporarily deleted from `runOnce`, all three wiring cases failed and were restored immediately:

```
 ❯ tests/daemon/daemon-commands.test.ts (15 tests | 3 failed) 148ms
   × daemon summary-embedder wiring (REQ-043, ADR 0052) > resolves no embedder when embeddings are disabled, so the daemon writes zero vectors 29ms
     → expected [] to deeply equal [ 'probe' ]
   × daemon summary-embedder wiring (REQ-043, ADR 0052) > surfaces the reason once and keeps running when an enabled embedder is unhealthy 23ms
     → expected [] to deeply equal [ 'probe' ]
   × daemon summary-embedder wiring (REQ-043, ADR 0052) > probes before resolving, and resolves exactly once per daemon process 25ms
     → expected [] to deeply equal [ 'probe', 'resolve' ]
```

## The `resolveEmbedder` count

```
$ grep -c "resolveEmbedder" src/daemon/daemon-command.ts
2
```

**Two lines, ONE call site.** Line 11 is the import; line 320 is the single
`summaryEmbedder = await resolveEmbedder(databasePath);` inside the memoized initializer. The
briefing's target of 1 is unreachable while the symbol is imported by name; the property it stands
for — one resolve, therefore one ONNX session per process — holds, and is asserted mechanically:
the wiring test pins `embedderMock.calls` to exactly `["probe", "resolve"]`. There is no second
resolve anywhere in the daemon.

The memoization is a single `Promise<void>` in the `createLoop` closure, awaited by both `run` and
`runOnce`. Stated precisely: **one resolve per `createLoop`, which is one per daemon process**,
since `runDaemonCommand` builds the loop once. The test pins one resolve per process entry; the
across-ticks property is structural (the per-slice closure reads the settled variable, it does not
re-initialize).

## The three-caller property — preserved, verified

```
$ grep -rn "new ContractionRunner" src/
src/bootstrap/historical-bootstrapper.ts:117:    }) ?? new ContractionRunner(this.store, {
src/operations/rebuild-derivations-command.ts:145:    const runner = new ContractionRunner(store, { authority });
src/daemon/daemon-command.ts:351:            new ContractionRunner(store, { clock, authority: captured, summaryEmbedder }).drainSlice(personId, jobId)
```

Only the daemon passes `summaryEmbedder`. The bootstrap and the rebuild command are **unedited** —
`summaryEmbedder` being optional is exactly what bought that — so bulk rebuilds still do not embed.
Nothing embeds unintentionally.

## The both-halves ordering assertion

`expect(calls).toEqual(["save", "delete"])` — an exact sequence, not a `toContain`. The recording
Proxy logs every `saveSummaryVectors` / `deleteSummaryVectors` call, and the same test asserts the
semantic consequence: the overlapped id has **no** vector row afterwards while the other two
summaries do.

The overlap had to be injected. `DerivationInvalidator.invalidateDependencies` filters
`affectedSummaryIds` through `preserveIds`, and `drainSlice` passes every new summary id as a
preserve id — so in production an id can never be in both `summaries` and `supersessions`. The test's
store double pushes the supersession onto the same array `drainSlice` passed to
`commitContractionSlice` and later reads, which exercises the real ordering code against a state
production cannot currently reach. That state is one `preserveIds` change away, which is the point of
pinning it.

The genuine supersession case is separate and uses no injection: a late event committed with an
occurredAt **before** the corpus head both rewinds the job and moves the first span's first event,
which changes that summary's deterministic id and produces a real supersession. Its vector is
tombstoned; the unchanged Zeta span's vector survives.

## What the SC3 test asserts

1. **No outbox growth, by deep equality.** A real `commitLocalSyncOperation` seeds one
   `canonical_append` row; the post-slice `listSyncOutboxOperations(personId)` must `toEqual` the
   pre-slice snapshot — same length, same rows, same fields — while `slice.embedded.persisted > 0`
   proves vectors really were written. Not "no vector-shaped row".
2. **The closed-enum tripwire.** `SyncOperationKindSchema.options` must deep-equal the exact
   seven-element array. This is the assertion with the long-term value: it fails the day an eighth
   kind is added, forcing whoever adds it to think about vectors.
3. **Vectors live only in the sidecar.** Every daemon-written summary has `embedding === null` while
   `getSummaryVector(id, provider, model)` returns a row of the expected dimensions.
   `SummarySchema.embedding` carries a full `vector: number[]`, so a populated field is the one latent
   path by which a vector could ride a future summary-bearing operation.
4. **Defence in depth, labelled in the test as the weakest of the four.** The serialized outbox
   contains neither `"summary_vectors"` nor the first float of a known written vector — with a guard
   (`probe.length > 3`) so a degenerate probe cannot make the assertion vacuously pass.

`DifferingIdentityEmbedder` is imported from `tests/embeddings/fixtures.ts`. No local embedder double
is defined in the SC3 file. (`ThrowingEmbedder` in the contraction-runner test is a fault injector,
not an identity fake — it exists to reject, and has no vector identity to coincide with.)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `tests/bootstrap/historical-bootstrapper.test.ts` constructs a literal `ContractionSliceResult`**

- **Found during:** Task 1, at the typecheck gate
- **Issue:** `TS2741: Property 'embedded' is missing in type … but required in type 'ContractionSliceResult'` — the
  additive result field broke a hand-built test fixture at `:227`.
- **Fix:** added `embedded: { attempted: 0, persisted: 0, failed: 0 }` with a comment noting that the
  bootstrap passes no `summaryEmbedder` and so never embeds.
- **Files modified:** tests/bootstrap/historical-bootstrapper.test.ts
- **Commit:** `a8dd559`

### Scope additions

**Three wiring cases added to `tests/daemon/daemon-commands.test.ts`, a file not in `files_modified`.**
Task 2's acceptance criteria require that "an unhealthy enabled embedder logs its reason once and
leaves the daemon running" and that "a disabled config results in zero vector writes" be *verified*,
and neither is observable from the SC3 test. The wiring is only reachable through the real
`createDefaultDependencies` path — which is not exported and which every other test in that file
bypasses with fake dependencies — so the cases mock `embedder-resolver.js` and drive
`runDaemonCommand({subcommand: "once"})` against a temp database. Adding them to the existing daemon
test file keeps them inside Task 2's own `npx vitest run … tests/daemon/` verification command. No
production code was added for them.

### Deferred

None.

## Authentication gates

None — no network path, no credentials. The wiring tests mock the resolver, so no model file is loaded
and no ONNX session is constructed.

## Verification

- `npx vitest run`: **1091 passed | 4 skipped, 112 files passed | 1 skipped**. Baseline after 12-02
  was 1074/4; the +17 are this plan's cases (10 embed stage, 3 wiring, 4 SC3). The known MCP
  parallel-load flakes passed.
- `npm run typecheck`: clean.
- `npm run test:golden`: 16 passed / 1 skipped.
- The stage appears textually after the `commitContractionSlice` await in the diff.
- `grep -rn "embedQuery" src/daemon/` → one hit, and it is the comment forbidding it. No call.
- `grep -n "deleteSummaryVectors" src/daemon/contraction-runner.ts` → `463: await this.store.deleteSummaryVectors(supersededSummaryIds);`
- Staging: explicit paths on all three commits, `git status --short` checked before each. No
  `git add -A`, no `git add .`, no `git stash`, no `git clean`.
- `~/.memory/aaron.db` was never opened, in any mode. The five `~/.memory/` backups are untouched. No
  packages installed.

## Known Stubs

None.

## Threat Flags

None. No new network endpoint, no auth path, no schema change. The one new file-access pattern —
`probeEmbedderHealth` reading the embeddings sidecar at daemon start — already existed on the
`memory status` and backfill paths and adds no new trust boundary.

## Surprises

- **The `personId`-stripping case could not be expressed with a pre-commit hook.**
  `InMemoryStore.validateContractionOwnership` (`in-memory-store.ts:1658`) rejects any summary whose
  `personId !== input.personId`, and `undefined` fails that. The perturbation therefore has to happen
  **after** the commit validator and **before** the embed stage reads the array — a narrow window that
  exists only because the stage is post-commit and reads the same object graph. Also worth recording:
  the field has to be `delete`d rather than set to `""`, because `SummarySchema` makes it
  `.min(1).optional()`.
- **`isTopicChange` requires a ZERO-word intersection between labels.** The first fixtures used
  "Alpha embed planning roadmap" / "Switch to Beta embed launch rollout" — sharing the word "embed"
  was enough to collapse three intended spans into one, so a test written to prove "three summaries
  produce three vectors" silently exercised one. Fully disjoint labels were needed. A shared token in a
  fixture is an easy way to write a test that passes while testing a third of what it claims.
- **Producing a real supersession is harder than it looks.** A late event inside the corpus does not
  do it: `preserveIds` covers every re-emitted id, and a late event that only extends a span leaves
  every deterministic id unchanged. It takes a late event landing *before* the corpus head that also
  joins the first span, so that span's first event — and therefore its id — changes.
- **The stage catches store failures too, which was not separately specified but falls straight out of
  "wrap the entire stage".** A rejecting `saveSummaryVectors` reports `{attempted: 3, persisted: 0,
  failed: 3}` and the contraction still completes. It has its own case.

## Self-Check: PASSED

Files verified present: `src/daemon/contraction-runner.ts`, `src/daemon/daemon-command.ts`,
`docs/adr/0052-daemon-incremental-embedding-seam.md`, `tests/sync/embeddings-never-sync.test.ts`,
`tests/daemon/contraction-runner.test.ts`, `tests/daemon/daemon-commands.test.ts`,
`tests/bootstrap/historical-bootstrapper.test.ts`. Commits verified in `git log`: `a8dd559`,
`a525a8b`, `03bff2b`.
