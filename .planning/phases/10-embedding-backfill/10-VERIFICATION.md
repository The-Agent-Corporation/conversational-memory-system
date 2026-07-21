---
phase: 10-embedding-backfill
verified: 2026-07-21T17:35:00Z
status: human_needed
score: 3/4 must-haves verified (code-level), 0/4 verified at real-corpus scale
human_verification:
  - test: "Run `node <cli-entry> backfill-embeddings --db <path-to-live-292407-event/135366-summary-DB>` to completion against the actual production/dogfooding database (not a seeded test fixture)."
    expected: "Command exits 0; `memory status` afterward reports `embeddingBackfill.missingVectors === 0` and `completedFraction === 1` for the active (provider, model); progress lines appeared on stdout throughout the run."
    why_human: "Requires the real ~3.5GB dogfooding database (292,407 events / 135,366 summaries) and, if the ONNX embedder is enabled, a multi-minute-to-hours runtime. No live database exists in this repo/worktree or verifier sandbox — SC1 has only been exercised against small seeded fixtures (20-250 rows) in automated tests, never against the actual corpus the phase goal names."
  - test: "Kill the backfill process (real SIGKILL, not the injected onBatchComplete hook the tests use) partway through the real-corpus run, then restart it with the same `--db` flag."
    expected: "Restart resumes from the true missing set; no summary is re-embedded; `getSummaryVector` for every previously-committed id is unchanged; the run reaches completion with zero missing vectors."
    why_human: "The automated SC2 test (`tests/operations/backfill-embeddings-command.test.ts`) simulates the interruption by throwing from an injected `onBatchComplete` deps hook, not a real OS-level process kill against the live command entrypoint. This is a reasonable and explicitly-planned substitute for CI speed, but it has not been supplemented by an actual kill/restart drill against the real corpus as the roadmap SC2 requires ('Killing the backfill process partway through')."
  - test: "After the real-corpus run completes, re-run `backfill-embeddings` a second time to completion against the same live database."
    expected: "Zero additional `summary_vectors` writes; `processed === 0`; missing-set stays `[]` before and after."
    why_human: "SC3 is only exercised at 20-row seeded scale in automated tests. The idempotency test's store-spy assertion is also observably broken (WR-04 below) — the command constructs its own internal `SqliteStore`, so the spied `store` instance's `saveSummaryVectors`/`saveSummaryVector` can never be called regardless of what the command does; only `second.processed === 0` (the command's own self-reported count) carries the claim. A real second full-corpus run with an independent post-hoc row-count/timestamp check would give a much stronger idempotency guarantee than the current test provides."
---

# Phase 10: Embedding Backfill Verification Report

**Phase Goal:** All 135,366 existing summaries receive embeddings through a job that survives interruption without corrupting or duplicating work.
**Verified:** 2026-07-21T17:35:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth (Roadmap SC) | Status | Evidence |
|---|---------|------------|-----------|
| 1 | SC1 — Running backfill against the **full existing corpus** completes with zero summaries missing a vector | ? UNCERTAIN | Code path exists and is exercised by an integration test at 250-row seeded scale (`tests/operations/backfill-embeddings-command.test.ts`, "completes full corpus" case — PASSES). No evidence the command was ever run against the real 135,366-summary / 292,407-event database this phase's goal names. No live DB found anywhere in this worktree; `10-VALIDATION.md` "Manual-Only Verifications" row for exactly this behavior is unchecked and "Approval: pending". `10-03-SUMMARY.md` itself states: "The full-corpus live-DB run, kill/restart drill, and zero-write rerun against the real 135,366-summary database are manual verification steps tracked in `10-VALIDATION.md`, **not a task in this plan**." |
| 2 | SC2 — Killing the backfill process partway through and restarting resumes cleanly, no re-embed, no corruption | ? UNCERTAIN (code-level: VERIFIED at seeded scale) | `tests/operations/backfill-embeddings-command.test.ts` "resumes after interruption" case passes: an injected `onBatchComplete` hook throws after N batches, restart resumes via `listSummaryIdsMissingVector`, missing-set reaches `[]`, no duplicate rows. This is a simulated interruption (thrown JS error), not an actual OS-level `SIGKILL` against the running process — the literal event the roadmap SC describes has not been drilled against the real corpus. |
| 3 | SC3 — Re-running backfill to completion a second time performs zero additional writes | ? UNCERTAIN (code-level: PARTIALLY VERIFIED) | `tests/operations/backfill-embeddings-command.test.ts` "idempotent rerun" case passes on `second.processed === 0` and `listSummaryIdsMissingVector` staying `[]`. However the test's `saveSpy`/`saveSingleSpy` assertions are vacuous (see WR-04 below, confirmed by direct code read): they spy on the test-fixture `store`, but `runBackfillEmbeddingsCommand` opens its own internal `SqliteStore`, so those spies can never fire regardless of command behavior. The zero-additional-writes claim is carried only by the command's own self-reported `processed` count, not an independently observed store call count. Not run against the real corpus. |
| 4 | SC4 — Backfill progress (processed/total) visible through the operator surface | ✓ VERIFIED | Two independently-verified halves: (a) live half — `runBackfillEmbeddingsCommand` emits one JSON `{event:"progress", processed, total, provider, model}` line per batch via `progressSink`/stdout, confirmed both by reading `backfill-embeddings-command.ts` and by observing real progress lines in the test run output (e.g. `{"event":"progress","processed":250,"total":250,...}`); (b) point-in-time half — `memory status`'s new `embeddingBackfill: {provider, model, totalSummaries, missingVectors, completedFraction}` field, live-queried, confirmed by `tests/bootstrap/status-command.test.ts` (5/5 passing, 3 new cases). |

**Score:** 1/4 truths fully VERIFIED; 3/4 have strong code-level (seeded-scale) evidence but are UNCERTAIN against the literal roadmap wording ("full existing corpus", "killing the backfill process") because the manual, real-corpus validation step this phase's own plan explicitly deferred to `10-VALIDATION.md` was never executed (VALIDATION.md sign-off checklist unchecked, "Approval: pending"; no evidence of an actual run in git log, STATE.md, or any UAT artifact for phase 10).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | ----------- | ------ | ------- |
| `src/storage/memory-store.ts` | `saveSummaryVectors(records[])` on interface | ✓ VERIFIED | Present, documented; wired |
| `src/storage/sqlite-store.ts` | Transactional batch write (begin immediate/commit/rollback) | ✓ VERIFIED | `begin immediate` / `commit` / `rollback` present (lines ~1293-1332); atomicity test passes |
| `src/storage/in-memory-store.ts` | Loop-equivalent batch write | ✓ VERIFIED | Delegates to `saveSummaryVector` in a loop |
| `tests/storage/summary-vectors.test.ts` | Batch-transaction + parity cases | ✓ VERIFIED | 31 tests, all passing |
| `src/bootstrap/status-command.ts` | `EmbeddingBackfillSnapshot` + `embeddingBackfill` field | ✓ VERIFIED | Present, wired into `Promise.all` result; no `resolveEmbedder` import (grep confirms) |
| `tests/bootstrap/status-command.test.ts` | Assertions for disabled/populated/empty corpus | ✓ VERIFIED | 5 tests, all passing |
| `src/operations/backfill-embeddings-command.ts` | `memory backfill-embeddings` command | ✓ VERIFIED (exists, substantive, wired) | 172 lines; exports `main`, `runBackfillEmbeddingsCommand`; resolveEmbedder→missing-set→batch embed+save→stdout progress pipeline confirmed by direct read |
| `src/cli/command-registry.ts` | `backfill-embeddings` subcommand registration | ✓ VERIFIED | `"backfill-embeddings": () => import("../operations/backfill-embeddings-command.js")` present |
| `tests/operations/backfill-embeddings-command.test.ts` | SC1-SC4 integration tests | ✓ VERIFIED (exists, substantive) — see Truths 1-3 for scale caveat | 6 tests, all passing at seeded scale (max 250 rows) |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | --- | --- | ------ | ------- |
| `backfill-embeddings-command.ts` | `resolveEmbedder(databasePath)` | resolved once per run | ✓ WIRED | Confirmed by grep + read; D-05 hard-error not caught |
| `backfill-embeddings-command.ts` | `store.listSummaryIdsMissingVector` | resume key, queried once | ✓ WIRED | Confirmed; not re-queried per batch |
| `backfill-embeddings-command.ts` | `store.saveSummaryVectors(records)` | one transactional batch per slice | ✓ WIRED | Confirmed |
| `backfill-embeddings-command.ts` | `process.stdout` / `progressSink` | one JSON line per batch | ✓ WIRED | Confirmed by direct observation of test stdout |
| `status-command.ts embeddingBackfill` | `listSummaryIdsMissingVector` + `listSummaries` | live count query | ✓ WIRED | Confirmed |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| REQ-042 | 10-01, 10-02, 10-03 | Resumable, idempotent, checkpointed backfill command | ? NEEDS HUMAN (code delivered, real-corpus proof outstanding) | Code implements the missing-set-as-checkpoint pattern correctly per all code-level review; `.planning/REQUIREMENTS.md` traceability table (line 106) still reads `REQ-042 \| Phase 10 — Embedding Backfill \| Pending` — not updated to Complete, consistent with the outstanding manual validation gap. |

No orphaned requirement IDs found — REQ-042 is the only ID declared across all three phase-10 plans and is the only one REQUIREMENTS.md maps to Phase 10.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `src/bootstrap/status-command.ts` | 194-195 | Hardcoded `"deterministic"`/`"keyword-hash-v1"` strings instead of importing constants from `embedder.ts` | ⚠️ Warning (from 10-REVIEW.md, unaddressed) | If `DeterministicEmbedder`'s identity ever changes, status silently queries the wrong key and the SC4 point-in-time half drifts from what backfill actually writes, with no test or compile-time signal (contradicts the plan's own T-10-08 "never a hardcoded string" principle, applied here only to the backfill command, not to status). |
| `src/bootstrap/status-command.ts` | 194-196 | Unreadable embeddings config → `probeEmbedderHealth` returns `provider:"unknown"` → snapshot reports fabricated 0% completeness instead of "indeterminate" | ⚠️ Warning (unaddressed) | Misleading operator-surface output under a specific failure mode; no test covers it. |
| `src/storage/sqlite-store.ts` | 1293-1332 | `saveSummaryVectors` copy-pastes (does not reuse) `saveSummaryVector`'s validation + SQL, contradicting its own doc comment; error messages carry the wrong method-name prefix (`saveSummaryVector:` inside the batch path) | ⚠️ Warning (unaddressed, confirmed by direct read) | Future edits to per-record validation will not propagate to the batch path — the two paths can silently drift despite the doc comment's explicit claim they cannot. |
| `tests/operations/backfill-embeddings-command.test.ts` | 124-131 | Idempotency test spies on a `store` instance the command never uses internally | ⚠️ Warning (unaddressed, confirmed by direct read) | `expect(saveSpy).not.toHaveBeenCalled()` / `expect(saveSingleSpy).not.toHaveBeenCalled()` pass trivially regardless of command behavior — the idempotency claim is carried only by `second.processed === 0`. Directly relevant to the outstanding SC3 human-verification item above. |

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers found in any phase-10 file. No blocker-level anti-patterns.

### Human Verification Required

See `human_verification` in frontmatter — three items, all converging on the same root gap: **the phase's own plan explicitly deferred the full-corpus (135,366-summary) run, the real kill/restart drill, and the real idempotent-rerun check to `10-VALIDATION.md` as manual verification, and there is no evidence in the repository, git log, or STATE.md that this manual verification was ever performed.** `10-VALIDATION.md`'s sign-off checklist is entirely unchecked and its frontmatter still reads `status: draft` / `wave_0_complete: false` / `Approval: pending`.

### Gaps Summary

The phase delivered solid, well-tested code: `saveSummaryVectors` batch transactions, the `backfill-embeddings` CLI command built on the missing-set-as-checkpoint pattern, and the `memory status` `embeddingBackfill` snapshot are all present, substantive, and correctly wired, with 42/42 automated tests passing and clean typecheck. The core algorithm design (resolve-once, query-missing-set-once, per-batch transaction, no separate checkpoint table) is sound and gives high confidence the approach works.

However, the phase goal is stated in terms of the **actual 135,366-summary corpus** ("All 135,366 existing summaries receive embeddings... survives interruption without corrupting or duplicating work"), and all four roadmap Success Criteria are worded as concrete real-world events ("Running the backfill command against the full existing corpus", "Killing the backfill process partway through", "Re-running backfill... a second time after it already finished"). None of these three literal events has actually happened yet — they were consciously deferred to a manual validation pass (`10-VALIDATION.md`) that remains unexecuted (unchecked checklist, `Approval: pending`, no DB found, no UAT artifact, no git-log evidence). This is a real gap between "code exists and passes seeded-scale tests" and "the phase goal is demonstrated true," not a nitpick — the whole reason Phase 10 exists is the risk profile of a multi-hour, un-interruptible-by-design operation over the real corpus, and that specific risk has not yet been exercised.

Recommendation: run the three manual verification items above against the real dogfooding database before considering Phase 10 fully closed, and separately fix the four code-review warnings (WR-01 through WR-04) since three of them (WR-01, WR-03, WR-04) directly touch the exact correctness properties (identity-string consistency, validation-drift, and idempotency-test soundness) this phase exists to guarantee.

---

_Verified: 2026-07-21T17:35:00Z_
_Verifier: Claude (gsd-verifier)_
