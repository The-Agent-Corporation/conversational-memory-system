---
phase: 12-daemon-incremental-embedding
plan: 01
subsystem: embeddings
tags: [embedder-identity, gap-closure, backfill, tdd, req-045]

requires:
  - phase: 10
    provides: "`memory backfill-embeddings` and `listSummaryIdsMissingVector` as the resume key"
  - phase: 09
    provides: "TransformerEmbedder, its pinned revision, and the golden-vector regression"
provides:
  - "`composeModelIdentity(repo, revision)` — the one expression in the codebase that builds a vector-key model identity"
  - "A TransformerEmbedder whose advertised `model` is byte-identical to the `model` it stamps"
  - "`DifferingIdentityEmbedder` (tests/embeddings/fixtures.ts) — the shared two-identity fake 12-03 and 12-04 must reuse"
  - "A backfill that converges: missing set empties, rerun writes nothing, under both the fake and the real ONNX embedder"
  - "A `memory status` that queries the identity vectors are actually written under"
affects: [12-02, 12-03, 12-04, 12-06, 12-07]

tech-stack:
  added: []
  patterns:
    - "A query key and its write key must be the same EXPRESSION, not two strings that happen to agree"
    - "A fixture whose two identities coincide cannot detect a two-key bug — pick the fixture that can"

key-files:
  created:
    - src/embeddings/embedder-identity.ts
    - tests/embeddings/embedder-identity.test.ts
    - tests/embeddings/fixtures.ts
  modified:
    - src/embeddings/transformer-embedder.ts
    - src/operations/backfill-embeddings-command.ts
    - src/bootstrap/status-command.ts
    - tests/operations/backfill-embeddings-command.test.ts
    - tests/bootstrap/status-command.test.ts

key-decisions:
  - "Fix shape (a): the identity is composed once and shared, not widened into a revision column — a column would ripple through MemoryStore, SummaryVectorRecord, both stores and every vector call site for a schema migration, and would not have fixed the retriever instance"
  - "An empty or whitespace-only revision composes to the bare repo string, so `keyword-hash-v1` and every deterministic row already persisted keep their exact bytes"
  - "Composition is idempotent for the SAME revision (re-composing `repo@r1` with `r1` returns it unchanged) but appends for a DIFFERENT one (`repo@r1` + `r2` -> `repo@r1@r2`), since that is a real identity change"
  - "`composeModelIdentity` throws on an empty repo id — a revision-only key is indistinguishable across models"
  - "`TransformerEmbedder.model` is assigned in the constructor BODY; a field initializer runs first and would burn `\"…@undefined\"` into every persisted vector key (T-12-02)"
  - "`pipeline()` keeps the bare `this.repo`; the composed id would not resolve against the vendored on-disk layout (T-12-01)"
  - "`memory status` fixed here as a Rule 1 deviation — it is the same two-key bug and the objective names it explicitly"

requirements-completed: [REQ-045]

metrics:
  duration: 25min
  tasks: 3
  files: 8
  completed: 2026-07-28
---

# Phase 12 Plan 01: One Canonical Embedder Identity Summary

`TransformerEmbedder` now advertises exactly the `repo@revision` string it stamps, composed by a single
exported `composeModelIdentity`, so the backfill's missing-set query key and its written row key are one
expression — the missing set finally shrinks, and a rerun is a no-op.

## What was built

**Task 1 — `src/embeddings/embedder-identity.ts` (commit `0d27ee0`).** One exported
`composeModelIdentity(repo, revision)`. Empty/whitespace/absent revision returns the bare repo unchanged;
same-revision re-composition is idempotent; a different revision appends; an empty repo throws. The
docstring names GAP-12-A as the reason the function exists and states that nothing else may compose a
vector-key identity. 9 tests, pure function, no network, no model files, no clock.

**Task 2 — `src/embeddings/transformer-embedder.ts` (commit `8934379`).** Split the two meanings that
shared the `model` field: a new `private readonly repo` (bare, used only at the `pipeline()` call) and
`readonly model: string` assigned in the constructor body from `composeModelIdentity(this.repo,
this.revision)`. The emit at what was line 103 became `model: this.model`. `provider`, `dimensions`,
`pooling: "cls"`, `normalize: true`, the session options, `QUERY_INSTRUCTION`, the `embed`/`embedQuery`
split, and every Phase 9 comment block are byte-unchanged. `npm run test:golden`: **16 passed / 1 skipped**
— vectors unchanged.

**Task 3 — backfill convergence (commit `f59219e`).** `tests/embeddings/fixtures.ts` exports
`DifferingIdentityEmbedder` (repo `fake-repo`, revision `r1`, model `fake-repo@r1`, deterministic hash
vector, injected `createdAt`, and an `embedCalls` counter so a convergence test can assert "not one
re-embed"). The backfill test file gained four cases on top of the six existing deterministic ones, which
are unmodified:

- the standalone tripwire `embedder.model === (await embedder.embed("x")).model`;
- convergence under the fake: 25 summaries, missing set `[]` after run 1, run 2 reports
  `totalMissingAtStart === 0` / `processed === 0` and `embedCalls` does not move;
- convergence under the **real `TransformerEmbedder`**, via a real `enabled: true` embeddings sidecar,
  guarded by `existsSync` on `MEMORY_MODEL_PATH ?? "tests/fixtures/models"` so it skips rather than fails
  without the fixture (the fixture IS present here, so it ran);
- a non-retrievable-state case pinning the load-scope change.

The command itself got two edits: the query-key/write-key invariant written down at the call site, and
`store.listSummaries({ states: [...RETRIEVABLE_MEMORY_STATES] })` in place of the unfiltered full load
(138,373 Zod parses on the live corpus, one row 818 KB). Non-retrievable ids the store's missing-set query
still returns fall through the existing defensive `if (!summary) continue`. The `personId` fail-loud guard
(T-10-05) is untouched.

Because the command resolves its embedder internally, the fake is injected by mocking `resolveEmbedder`
through a `vi.hoisted` override that defaults to the real resolver — the deterministic and ONNX cases run
the real resolution path.

## The pre-fix failures, verbatim

**Task 1 RED** (module did not exist):

```
 FAIL  tests/embeddings/embedder-identity.test.ts [ tests/embeddings/embedder-identity.test.ts ]
Error: Failed to load url ../../src/embeddings/embedder-identity.js (resolved id: ../../src/embeddings/embedder-identity.js) in /Users/aaronwhaley/Agent-Corporation/conversational-memory-system/tests/embeddings/embedder-identity.test.ts. Does the file exist?
```

**Task 2 RED — GAP-12-A itself, both halves:**

```
 ❯ tests/embeddings/embedder-identity.test.ts (14 tests | 2 failed) 143ms
   × embedder advertised identity === emitted identity > TransformerEmbedder advertises the composed repo@revision identity 2ms
     → expected 'Xenova/bge-small-en-v1.5' to be 'Xenova/bge-small-en-v1.5@ea104dae' // Object.is equality
   × embedder advertised identity === emitted identity > TransformerEmbedder stamps exactly the identity it advertises 139ms
     → expected 'Xenova/bge-small-en-v1.5@main' to be 'Xenova/bge-small-en-v1.5' // Object.is equality
```

**Task 3 RED — the load-scope change** (unfiltered load wrote a vector for a `superseded` summary):

```
 ❯ tests/operations/backfill-embeddings-command.test.ts:287
   expect(await store.getSummaryVector("summary_superseded", embedder.provider, embedder.model)).toBeNull();
   → expected { provider: 'fake-differing', summaryId: 'summary_superseded', … } to be null
```

**Task 3 RED — the measured consequence.** With the emit temporarily restored to its pre-fix shape
(`this.model = this.repo` plus `` model: `${this.repo}@${this.revision}` ``), the ONNX convergence test
fails first on the identity assertion; with that one assertion temporarily relaxed, the real consequence
shows:

```
 FAIL  tests/operations/backfill-embeddings-command.test.ts > converges under the real TransformerEmbedder: missing set empties and a rerun writes nothing
AssertionError: expected [ 'summary_0', 'summary_1', …(1) ] to deeply equal []

- Array []
+ Array [
+   "summary_0",
+   "summary_1",
+   "summary_2",
+ ]
```

That is GAP-12-A measured, not asserted in prose: after a complete run over 3 summaries, all 3 are still
missing. Both temporary edits were reverted immediately; `git diff src/embeddings/transformer-embedder.ts`
was empty afterward (restored byte-for-byte against the committed fix).

## The second instance — verified, not edited

`src/retrieval/memory-retriever.ts:584-585` (`embeddingScore`) compares
`memoryEmbedding.provider !== options.embedder.provider || memoryEmbedding.model !== options.embedder.model`
and returns `null` on mismatch. Under the pre-fix `TransformerEmbedder`, a stored embedding carried
`Xenova/bge-small-en-v1.5@<rev>` while `options.embedder.model` was the bare repo id, so the comparison
could never match and `embeddingScore` returned `null` for **every** memory — semantic ranking silently
doing nothing, and failing in the "safe" direction (score dropped, not a wrong score), which is why nothing
ever surfaced it.

It now has a chance of matching, by construction and without editing the file:
`Summary.embedding` is only ever populated from `embedder.embed(...)` (`src/compaction/pre-compactor.ts:44`
and the backfill), so the stored `model` is the same `composeModelIdentity` output the retriever compares
against, for the same configured revision. **The file is unchanged.** A stale-model vector still correctly
scores `null` — that is REQ-045's detectability, preserved.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] A THIRD instance of the same two-key bug, in `memory status`**
- **Found during:** Task 3, while grepping every `listSummaryIdsMissingVector` caller
- **Issue:** `src/bootstrap/status-command.ts:194-195` derived `activeModel` from `probeEmbedderHealth`,
  which reports the sidecar's **bare** `config.model` and its `config.revision` as separate fields. Status
  therefore queried the missing set with a key nothing is ever written under, and would report
  `missingVectors == totalSummaries` on a fully backfilled corpus — the exact symptom the objective names,
  and the number the owner is meant to gate the live backfill on.
- **Fix:** `composeModelIdentity(embedder.model, embedder.revision)` when enabled; the `"keyword-hash-v1"`
  disabled branch is unchanged (and composes to itself). Added a test writing an `enabled: true` sidecar
  and an ONNX-keyed vector row, asserting `missingVectors === 0` and `model === "Xenova/bge-small-en-v1.5@main"`.
  Verified RED by temporarily reverting the one line: `expected 'Xenova/bge-small-en-v1.5' to be
  'Xenova/bge-small-en-v1.5@main'`.
- **Files modified:** src/bootstrap/status-command.ts, tests/bootstrap/status-command.test.ts
- **Commit:** `b0fd216`
- **Scope note for Plan 12-02:** this is edit **1 of 2** in 12-02's Task 2 (`activeModel` becomes
  `composeModelIdentity(...)`). It is already applied and tested. 12-02's edit 2 — the **denominator**
  counting only embeddable summaries — is untouched and remains 12-02's work.

### Deferred

None.

## Authentication gates

None — no network path, no credentials, no live database opened.

## Verification

- `npx vitest run`: **1057 passed | 4 skipped, 111 files passed | 1 skipped** — fully green, including the
  two MCP files flagged as known parallel-load flakes (they passed this run).
- `npm run typecheck`: clean.
- `npm run test:golden`: 16 passed / 1 skipped.
- `grep -rn --include='*.ts' '@\${' src/embeddings/ | grep -v embedder-identity` → empty. Widened to all of
  `src/` → also empty: there is no other `@${...}` model composition anywhere in the source tree.

## Known Stubs

None.

## Threat Flags

None — no new network endpoint, auth path, file-access pattern, or schema change. `~/.memory/aaron.db` was
never opened, in any mode; all four `~/.memory/` backups are untouched. No packages installed.

## Surprises

- The vendored fixture model **is** present at `tests/fixtures/models/Xenova/bge-small-en-v1.5/onnx/model.onnx`,
  so the ONNX-guarded cases actually executed rather than skipping — the plan's convergence claim is
  measured against the real embedder, not only the fake.
- `listSummaryIdsMissingVector` has no state predicate of its own (it is a bare `not exists` over all of
  `summaries`), which is why the load-scope change needed the defensive `if (!summary) continue` to carry
  the correctness rather than the query. That is GAP-12-B's territory and is left to 12-02, as planned.
- The retriever instance fails in the safe direction (a `null` score, not a wrong one), which is exactly why
  it survived unnoticed. Worth remembering as a detection lesson: the backfill instance was loud because it
  wasted work; this one was silent because it only lost quality.

## Self-Check: PASSED

Files verified present: `src/embeddings/embedder-identity.ts`, `tests/embeddings/embedder-identity.test.ts`,
`tests/embeddings/fixtures.ts`. Commits verified in `git log`: `0d27ee0`, `8934379`, `f59219e`, `b0fd216`.
