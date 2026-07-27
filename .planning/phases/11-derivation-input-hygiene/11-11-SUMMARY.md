---
phase: 11-derivation-input-hygiene
plan: 11
subsystem: storage
tags: [sqlite, in-memory-store, mutation-contract, gap-closure, deletion]

# Dependency graph
requires:
  - phase: 11-derivation-input-hygiene
    provides: "SummaryFilter { personId?, scopeIds?, states? } and idx_summaries_person_state (Plan 11-10) — reused by listSupersededSummaryIds/summarizeSupersededSummaries"
  - phase: 11-derivation-input-hygiene
    provides: "isRetrievableState / RETRIEVAL_CANDIDATE_STATES, the retrievability allow-list (Plan 11-08) — the superseded state this plan removes is one of the excluded states that predicate already refuses to surface"
provides:
  - "commitSupersededSummaryPrune(input) — the only sanctioned removal path for pure derivations, atomic in SqliteStore, staged-then-replaced in InMemoryStore, identical eligibility/receipt semantics in both"
  - "listSupersededSummaryIds(personId, { limit, afterId }) — cheap ascending-id cursor for dry-run/resume"
  - "summarizeSupersededSummaries(personId) — cheap count + byte-footprint aggregate, no per-row parse loop"
  - "CommitSupersededSummaryPruneInputSchema / SupersededSummaryPruneReceiptSchema in mcp-mutation-contracts.ts"
affects: ["11-12 (the prune command will call these three methods for dry-run, resume, and execution)", "11-13 (the live prune, gated on owner authorization)", "11-14"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Authoritative in-transaction eligibility recompute: the caller's summaryIds list is a request, never an authorization — every id is re-checked against not_found/not_superseded/person_mismatch and four reference kinds inside the store's own transaction, mirroring commitSourceDeletion's expected-state-check idiom but with no caller-supplied effects payload at all"
    - "Reference sets built once per batch (box.summaryIds, trace.summaryIds, proposal.sourceSummaryIds, other summaries' sourceSummaryIds), not once per candidate id — O(tables) not O(tables x ids) per prune call"
    - "SqliteStore: inline deletes within one begin-immediate transaction, explicitly avoiding the existing deleteSummaryVectors/deleteInjectionsReferencingSummaryIds single-purpose helpers to prevent nested transactions"
    - "InMemoryStore: compute all replacement arrays first, mutate this.summaries/this.summaryVectors/this.injections only at the very end — throwing anywhere before that point (fault injection) leaves the store byte-for-byte unchanged, the in-memory analogue of SQLite rollback"

key-files:
  created:
    - tests/storage/superseded-prune.test.ts
  modified:
    - src/storage/mcp-mutation-contracts.ts
    - src/storage/memory-store.ts
    - src/storage/sqlite-store.ts
    - src/storage/in-memory-store.ts

key-decisions:
  - "Precedence order for skip reasons is fixed and identical in both stores: not_found, then not_superseded, then person_mismatch, then referenced_by_box/trace/proposal/summary — verified by the same table-driven test cases running unmodified against both backends"
  - "payloadBytes/freedPayloadBytes is computed the same way in both stores (JSON.stringify(the zod-parsed summary object).length) rather than a looser heuristic, because SqliteStore's payload column is stored as exactly JSON.stringify(SummarySchema.parse(summary)) — so SQL's length(payload) and JS's JSON.stringify(...).length agree exactly for the same input, verified by an explicit test assertion rather than documented as an acceptable divergence"
  - "Proposal references are checked via the proposal's top-level sourceSummaryIds field (present on every proposal type), not by narrowing into proposalType-specific payload shapes — simpler and equivalent, since sourceSummaryIds is always populated alongside the type-specific payload"
  - "No sync operation kind is emitted for a prune: summaries are device-local derivations (confirmed against sync-contracts.ts:18-25 before implementation), so a prune never produces an outbox row and never replicates to other devices"

patterns-established:
  - "A destructive commit* method with zero caller-supplied effects payload — eligibility is entirely store-computed, unlike commitSourceDeletion which trusts a caller-fingerprinted effects object. Establishes the shape for any future prune-style operation over derived (non-canonical) state."

requirements-completed: [REQ-053, REQ-054]

# Metrics
duration: ~25min
completed: 2026-07-26
---

# Phase 11 Plan 11: Superseded-Summary Prune Machinery Summary

**Adds `commitSupersededSummaryPrune`, `listSupersededSummaryIds`, and `summarizeSupersededSummaries` to both `SqliteStore` and `InMemoryStore` — an atomic, reference-checked, receipt-producing removal path for pure derivations that recomputes eligibility from scratch inside its own transaction, never trusting a caller-supplied id list.**

## Performance

- **Duration:** ~25 min (three atomic task commits)
- **Tasks:** 3
- **Files modified:** 4 (1 created, 3 modified) plus one test-fixture fix folded into Task 2's commit
- **Test suite:** 925 passed, 4 skipped (105 files passed, 1 skipped) — full unmodified regression green
- **New tests:** 24, all green (12 shared cases × 2 backends, minus one atomicity case that runs once per backend outside the shared describe block)

## Accomplishments

- `CommitSupersededSummaryPruneInputSchema` (`.strict()`, `operation: "superseded_summary_prune"`, `personId`, `summaryIds` bounded 1-1000, `requestedAt`) and `SupersededSummaryPruneReceiptSchema` (`prunedSummaryIds`, `deletedVectorRows`, `deletedInjectionIds`, `freedPayloadBytes`, `skipped: { summaryId, reason }[]`, `committedAt`) added to `mcp-mutation-contracts.ts` alongside — never modifying — `CommitSourceDeletionInputSchema`. Three new fault boundaries (`superseded_prune_before_write`, `superseded_prune_after_vectors`, `superseded_prune_after_injections`) added to `McpMutationFaultBoundary`.
- `MemoryStore` interface gains three doc-commented method declarations explaining prune is the only sanctioned derivation-removal path and that eligibility is authoritative inside the transaction.
- `SqliteStore.commitSupersededSummaryPrune` opens one `begin immediate`, loads all summaries/boxes/traces/proposals once to build reference sets for the whole batch, recomputes each id's eligibility in the fixed precedence order, then deletes `summary_vectors` rows, referencing `injections` rows, and finally the `summaries` rows inline in the same transaction — verified by grep to never call `deleteSummaryVectors`/`deleteInjectionsReferencingSummaryIds` (which open their own transactions) and to never issue a `delete from canonical_events/turns/anchors`.
- `SqliteStore.listSupersededSummaryIds`/`summarizeSupersededSummaries` are single indexed queries against `idx_summaries_person_state` (`json_extract` equality/order-by-id-asc/`limit`, and `count(*)`/`coalesce(sum(length(payload)),0)` respectively) — no full-payload parse loop.
- `InMemoryStore` implements all three methods with identical semantics: same precedence order, same ascending-id cursor, and — critically — mutates `this.summaries`/`this.summaryVectors`/`this.injections` only after every eligibility decision and every fault-boundary check has already run, so a mid-batch throw leaves the store completely unchanged.
- `tests/storage/superseded-prune.test.ts` runs nine table-driven case families (unreferenced prune, four reference-kind refusals, non-superseded refusal, cross-person refusal, idempotency, non-interference with canonical events/turns/anchors, pagination, byte-footprint aggregation) against both backends from one shared fixture set, plus a dedicated atomicity test that injects a fault via each store's existing `faultInjector` idiom and asserts summary/vector/injection counts are unchanged.

## Task Commits

1. **Task 1: RED prune contract tests over both stores** - `ee5cd79` (test) — includes the contract schema addition needed to construct valid inputs
2. **Task 2: Contract, interface, and SqliteStore implementation** - `a80925b` (feat)
3. **Task 3: InMemoryStore parity** - `4ec7848` (feat)

## Files Created/Modified

- `tests/storage/superseded-prune.test.ts` (new) - Table-driven RED→GREEN tests over `SqliteStore`/`InMemoryStore` plus a separate fault-injection atomicity suite; fixture factories for `Summary`/`Box`/`MemoryTrace`/`MemoryProposal`/`InjectionPacket`/`CanonicalEvent`/`Turn`/`Anchor`.
- `src/storage/mcp-mutation-contracts.ts` - Adds `CommitSupersededSummaryPruneInputSchema`, `SupersededSummaryPruneSkipReasonSchema`, `SupersededSummaryPruneReceiptSchema`, their inferred types, and three new `McpMutationFaultBoundary` members. `CommitSourceDeletionInputSchema` untouched (`git diff` on that block is empty).
- `src/storage/memory-store.ts` - Three new `MemoryStore` interface methods with doc comments.
- `src/storage/sqlite-store.ts` - `commitSupersededSummaryPrune` (one `begin immediate` transaction, inline deletes, rollback-on-throw), `listSupersededSummaryIds`, `summarizeSupersededSummaries`.
- `src/storage/in-memory-store.ts` - Same three methods, staged-then-replaced mutation so atomicity holds without a real transaction.

## Decisions Made

- Skip-reason precedence is fixed at not_found → not_superseded → person_mismatch → referenced_by_box → referenced_by_trace → referenced_by_proposal → referenced_by_summary, identical in both stores, exercised by the same test cases against both backends.
- `freedPayloadBytes`/`payloadBytes` use `JSON.stringify(parsedSummary).length` in both stores rather than accepting a documented divergence, because `SqliteStore.upsertPayload` stores `JSON.stringify(item)` verbatim as the `payload` column, so SQL's `length(payload)` and JS's `JSON.stringify(...).length` are provably identical for the same zod-parsed object — confirmed with an explicit equality assertion in case (i) rather than a loose bound.
- Proposal reference checks use the proposal's top-level `sourceSummaryIds` field (present on every `MemoryProposalSchema` instance regardless of `proposalType`) rather than narrowing into the `boxType`-specific payload shape, since that field is always kept in sync with the payload's own summary references.
- No sync outbox row or `SyncOperationKind` is emitted for a prune — confirmed against `sync-contracts.ts:18-25` (no summary-related kind exists) before writing any code, consistent with derived summaries being device-local and never replicated.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed the "referenced by proposal" test fixture's payload/top-level field mismatch**
- **Found during:** Task 2 (running the RED test suite against the new SqliteStore implementation)
- **Issue:** The test fixture's default `MemoryProposal.payload.sourceSummaryIds` was `[]` while `BoxProposalPayloadSchema.sourceSummaryIds` requires `.min(1)`; the case-(b)-proposal test only overrode the top-level `sourceSummaryIds` field, leaving the payload's own array empty and failing `MemoryProposalSchema`'s `superRefine` payload-shape check on `saveProposal`.
- **Fix:** The test now overrides both the top-level `sourceSummaryIds` and the nested `payload.sourceSummaryIds` together so the fixture is a schema-valid box proposal.
- **Files modified:** `tests/storage/superseded-prune.test.ts`
- **Verification:** `npx vitest run tests/storage/superseded-prune.test.ts` — 24/24 passing after the fix; full suite unaffected.
- **Committed in:** `a80925b` (part of Task 2's commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — a test fixture bug caught by the store's own schema validation, not a defect in the store implementation itself).
**Impact on plan:** None beyond the fixture correction — no scope change, no new behavior added beyond what the plan specified.

## Issues Encountered

None beyond the fixture fix documented above.

## User Setup Required

None. No schema migration, no new configuration, no external service. This plan builds machinery only — nothing in this plan reads, writes, or connects to `~/.memory/aaron.db` or any path derived from `MEMORY_DB`; every test seeds and tears down its own temp-file `SqliteStore` or a fresh `InMemoryStore`.

## Next Phase Readiness

- Plan 11-12 (the prune CLI command) can now call `listSupersededSummaryIds` for its dry-run listing and resume cursor, `summarizeSupersededSummaries` for its dry-run footprint report, and `commitSupersededSummaryPrune` for the actual batched deletion — all three already tested for correctness, atomicity, and cross-store parity.
- The live prune against the owner's 87,727-summary database remains gated on Plan 11-13's explicit owner authorization; this plan touched no live data.
- `npx vitest run` (105 files, 925 tests, 4 skipped) and `npm run typecheck` are both green with no new warnings.
- No blockers for Plans 11-12 through 11-14.

## Self-Check: PASSED

All 4 claimed modified/created files found on disk; all 3 claimed commit hashes (`ee5cd79`, `a80925b`, `4ec7848`) found in `git log --oneline`.

---
*Phase: 11-derivation-input-hygiene*
*Completed: 2026-07-26*
