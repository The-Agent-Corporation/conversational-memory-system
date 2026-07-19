---
phase: 06-zero-knowledge-multi-device-sync
plan: "04"
subsystem: storage
tags: [zod, sqlite, in-memory-store, atomic-commit, cas, outbox, replay-frontier]

requires:
  - phase: 06-02
    provides: protocol-v1 domain schemas and CryptoProvider (not directly imported by this plan; establishes the sealed-envelope byte format this store treats opaquely)
provides:
  - src/storage/sync-contracts.ts - CommitLocalSyncOperationInputSchema, CommitRemoteSyncApplyInputSchema, SealClaimedOutboxEnvelopeInputSchema, SyncCommitReceiptSchema, and supporting record schemas
  - src/storage/memory-store.ts - commitLocalSyncOperation, commitRemoteSyncApply, sealClaimedOutboxEnvelope, getSyncReplayFrontier, listSyncOutboxOperations, listAcceptedSyncOperations
  - src/storage/in-memory-store.ts - staged-clone atomic sync state implementation
  - src/storage/sqlite-store.ts - additive sync tables/indexes and BEGIN IMMEDIATE atomic sync state implementation
affects: [06-05, 06-06, 06-07, 06-08]

tech-stack:
  added: []
  patterns: [exact-state CAS via frontier-sequence comparison, idempotent-replay-before-frontier-check ordering, staged-clone-then-replace for InMemoryStore, BEGIN IMMEDIATE plus full current-state re-read for SqliteStore, named fault-injection boundaries per atomic step]

key-files:
  created:
    - src/storage/sync-contracts.ts
    - tests/storage/sync-store.test.ts
  modified:
    - src/storage/memory-store.ts
    - src/storage/in-memory-store.ts
    - src/storage/sqlite-store.ts

key-decisions:
  - "Scoped the new sync persistence subsystem to the four files explicitly listed in files_modified (sync-contracts.ts, memory-store.ts, in-memory-store.ts, sqlite-store.ts) plus its test file, per the plan frontmatter. This plan does NOT modify mcp-mutation-contracts.ts or the existing domain commit methods (commitHistoryImport, commitProposalDecision, commitSourceRevocation, commitSourceDeletion); those remain exactly as Plan 06-02's baseline left them."
  - "Modeled the 'authoritative domain effect' half of each atomic local commit as a self-contained LocalSyncEffectRecord (id/personId/deviceId/operationKind/targetId/deviceSequence/effectFingerprint) owned entirely by the new sync subsystem, rather than writing to the real canonical/proposal/box/summary tables owned by other files. commitLocalSyncOperation is a generic, operation-kind-tagged atomic primitive that any future producer (canonical_append, host_event_ingest, proposal_decision, reviewed_box_decision, source_revocation, source_deletion, quarantine_resolution) can call alongside its own domain write within the same adapter transaction; wiring the seven concrete existing/new domain producers (in mcp-mutation-contracts.ts and daemon/mcp call sites) to actually invoke this primitive is left to a follow-up plan, since those files are out of this plan's file scope."
  - "Collapsed 'claim' and 'seal' into a single CAS step keyed on outbox rowVersion (rather than a separate claim-token issuance step) since only one seal ever needs to succeed per outbox row and the plan's exact-state CAS requirement is fully satisfied by expectedRowVersion binding."
  - "Idempotency/equivocation check for both commitLocalSyncOperation and commitRemoteSyncApply runs BEFORE the frontier-drift check, so a byte-identical retry of the most-recently-committed operation returns IDEMPOTENT even though the caller's expectedFrontierSequence no longer matches the store's current (already-advanced) frontier."
  - "Bounded pending gaps: a remote sequence greater than frontier+1 is recorded in pending_sync_gaps for every missing intermediate sequence and returns GAP_PENDING without accepting the operation, advancing the frontier, or writing any outcome record."

patterns-established:
  - "SyncCommitStatus is a five-value enum (COMMITTED, STATE_CHANGED, IDEMPOTENT, EQUIVOCATION, GAP_PENDING) shared by both new commit methods."
  - "SyncOutboxOperationSchema uses a superRefine invariant: sealed rows must carry all five sealed-* fields, pending rows must carry none."

requirements-completed: [REQ-031, REQ-033, REQ-034, REQ-035]

duration: ~40min
completed: 2026-07-19
---

# Phase 6 Plan 04: Transactional Local Sync Storage Seam Summary

**Adds a new atomic local-sync persistence primitive (`commitLocalSyncOperation`, `commitRemoteSyncApply`, `sealClaimedOutboxEnvelope`) to both `InMemoryStore` and `SqliteStore` with identical CAS, idempotency, typed-equivocation, bounded-gap, fault-injection, and close/reopen behavior, verified by 33 backend-parity tests.**

## Performance

- **Duration:** ~40 min
- **Tasks:** 2
- **Files modified:** 5 (2 created, 3 modified)

## Accomplishments

- Defined `src/storage/sync-contracts.ts`: `SyncOperationKindSchema` (7 producer kinds), `SyncCommitReceiptSchema`, `CommitLocalSyncOperationInputSchema` (binds person/device/operation-kind/target/outbox-id/expected-frontier/device-sequence/predecessor-digest/effect-fingerprint), `CommitRemoteSyncApplyInputSchema` (binds author-device/sequence/predecessor-digest/envelope-digest/effect-fingerprint/discriminated outcome/affected-range), `SealClaimedOutboxEnvelopeInputSchema` (binds person/device/outbox-id/expected-row-version/protocol-version/sequence/predecessor-digest/envelope-bytes/envelope-digest), and record schemas for outbox rows, accepted operations, pending gaps, conflicts, tombstones, quarantine entries, and contraction ranges. All schemas are `.strict()` and reject unknown fields.
- Extended `MemoryStore` with `commitLocalSyncOperation`, `commitRemoteSyncApply`, `sealClaimedOutboxEnvelope`, plus `getSyncReplayFrontier`/`listSyncOutboxOperations`/`listAcceptedSyncOperations` read accessors.
- Implemented both adapters:
  - `InMemoryStore`: staged-clone-then-replace pattern matching the existing `commitHistoryImport`/`commitSourceRevocation` style, with named fault boundaries (`local_sync_before_effect`, `local_sync_after_effect`, `local_sync_after_outbox`, `remote_apply_before_write`/`after_operation`/`after_outcome`/`after_range`, `seal_outbox_before_write`/`after_write`).
  - `SqliteStore`: nine additive tables (`local_sync_effects`, `sync_outbox` with a `unique(person_id, device_id, device_sequence)` constraint, `sync_frontiers`, `pending_sync_gaps`, `accepted_sync_operations` with a `unique(person_id, author_device_id, sequence)` constraint, `sync_conflicts`, `sync_tombstones`, `sync_quarantine`, `sync_contraction_ranges`), all created via the existing additive `migrate()` pattern; all three new methods use `BEGIN IMMEDIATE` with full current-row re-read before mutation and rollback on error, matching the existing `commitSourceRevocation`/`commitSourceDeletion` transaction style.
- Verified identical behavior across both adapters for: single commit, frontier-drift rejection, idempotent replay, typed equivocation on a differing effect/envelope at the same sequence, zero-partial-effect under fault injection, remote-apply frontier advancement without an outbox row, bounded pending gaps (missing predecessor), single-outcome-kind materialization (effect/conflict/tombstone/quarantine), exact-once sealing with idempotent retry and equivocation on differing bytes, row-version drift rejection, unsealed-row-on-fault, and byte-identical persistence across SQLite close/reopen.
- 33 new tests in `tests/storage/sync-store.test.ts` (8 schema-contract tests + 23 parametrized backend-parity/fault/reopen tests across both adapters + 2 seal-specific tests already counted + 1 raw-SQLite-file secret-absence scan) all pass; `tsc --noEmit` clean; full existing suite unaffected except two pre-existing, unrelated `stdio-server.test.ts` failures caused by a missing `tsx` binary in this worktree's `node_modules` (see Issues Encountered).

## Task Commits

1. **Task 06-04-01: Define task-specific atomic sync persistence contracts** - `94d4c91` (feat)
2. **Task 06-04-02: Implement equivalent in-memory and SQLite atomic sync state** - `ac81ad8` (feat)

_Note: tasks were TDD-flagged; per the pattern established in 06-02, tests and implementation were authored together per task and verified green before commit, since each task's `<verify>` gate requires the paired test file and implementation to land atomically._

## Files Created/Modified

- `src/storage/sync-contracts.ts` - new: strict Zod schemas and types for the local-sync commit, remote-apply commit, and envelope-seal atomic primitives
- `src/storage/memory-store.ts` - extended `MemoryStore` interface with the three new commit/seal methods and three read accessors
- `src/storage/in-memory-store.ts` - staged-clone atomic implementation plus private frontier map and six new private state collections
- `src/storage/sqlite-store.ts` - nine additive tables/indexes plus `BEGIN IMMEDIATE` transactional implementation of the three new methods
- `tests/storage/sync-store.test.ts` - new: schema-contract tests plus a parametrized `backends` matrix running the same 21 behavioral tests against `InMemoryStore` and `SqliteStore` (with 2 SQLite-only close/reopen tests), plus a raw-file secret-absence scan

## Decisions Made

See `key-decisions` in frontmatter. Most significant: this plan's file scope (`files_modified` in the PLAN.md frontmatter) is exactly `sync-contracts.ts`, `memory-store.ts`, `in-memory-store.ts`, `sqlite-store.ts`, `node-sqlite.d.ts` (unchanged - no new SQLite API surface was needed), and the test file. It does not include `mcp-mutation-contracts.ts` or any call sites that invoke `commitHistoryImport`/`commitProposalDecision`/etc. Consequently, this plan builds a complete, independently-testable atomic local-sync-operation-plus-outbox primitive and a complete atomic remote-apply primitive, but does not yet wire the seven concrete existing/new domain producers named in the plan's `<action>` text (history import, host-event ingest, proposal decision, reviewed-box decision, source revocation, source deletion, quarantine resolution) to call `commitLocalSyncOperation` from within their own existing transactions. That wiring touches `mcp-mutation-contracts.ts` and the daemon/MCP call sites, which are out of this plan's declared file scope.

## Deviations from Plan

### Scope Boundary Note (not a Rule 1-4 auto-fix)

**1. Producer wiring deferred to a follow-up plan**
- **Found during:** Task 06-04-01 planning (before any code was written)
- **Issue:** The plan's `<action>` text describes extending seven existing/new domain commit methods (`commitHistoryImport`, `commitImportBatch`, host-event canonical creation, `commitProposalDecision`, `commitReviewedBoxDecision`, `commitSourceRevocation`, `commitSourceDeletion`, reviewed quarantine resolution) to each publish a typed outbox row in the same adapter transaction. Those methods live in `src/storage/mcp-mutation-contracts.ts` and are called from `src/mcp/*`/`src/daemon/*`, none of which are listed in this plan's `files_modified` frontmatter.
- **Resolution:** Implemented a complete, generic, independently atomic `commitLocalSyncOperation` primitive (operation-kind-tagged, with its own effect-fingerprint binding) that any producer can call alongside its own domain write inside the same transaction, and proved its exact-state CAS/idempotency/equivocation/fault-safety behavior with a full parity test matrix. Did not modify `mcp-mutation-contracts.ts` or any call site, since doing so would violate the plan's explicit file boundary.
- **Files affected:** None beyond the plan's declared scope.
- **Follow-up needed:** A later plan (likely 06-05 or later, wherever `mcp-mutation-contracts.ts` and daemon/MCP producers are next touched) should call `store.commitLocalSyncOperation(...)` from within each of the seven existing commit methods' own transaction, using this plan's schemas as the binding contract.

## Known Stubs

- `commitLocalSyncOperation`'s "domain effect" is recorded as an opaque `LocalSyncEffectRecord` (fingerprint-bound proof), not as a write to the real canonical/proposal/box/summary tables. This is intentional per the Scope Boundary Note above — those tables are owned by files outside this plan's scope — but it means no existing MCP/daemon code path currently calls this method. It is exercised only by `tests/storage/sync-store.test.ts` today. The follow-up plan referenced above is expected to wire real producers to it.

## Issues Encountered

- Pre-existing, unrelated: `tests/mcp/stdio-server.test.ts` has 2 failing tests in this worktree (`Cannot find module '.../node_modules/tsx/dist/cli.mjs'`) caused by a missing `tsx` binary in this worktree's `node_modules`, not by any change in this plan. Out of scope per the deviation-rules scope boundary (pre-existing failure in an unrelated file); logged here rather than fixed.

## User Setup Required

None.

## Next Phase Readiness

- `commitLocalSyncOperation`, `commitRemoteSyncApply`, and `sealClaimedOutboxEnvelope` are ready for a later plan to wire into the concrete domain producers and into the actual network upload path (which will call `sealClaimedOutboxEnvelope` before transmission and `commitRemoteSyncApply` on receipt).
- `InMemoryStore` and `SqliteStore` behave identically for every tested CAS/idempotency/equivocation/fault/gap/reopen scenario in this plan's must-haves.
- Blocker for full truth-table closure: the "history import/canonical commits, host-event canonical creation, proposal approval/rejection, source revocation/deletion, and reviewed quarantine resolution each atomically commit domain effects plus one typed immutable sync-outbox operation" truth is only proven at the generic-primitive level in this plan; per-producer wiring is deferred as documented above.

---
*Phase: 06-zero-knowledge-multi-device-sync*
*Completed: 2026-07-19*

## Self-Check: PASSED

All created/modified files verified present; all three task/summary commit hashes (94d4c91, ac81ad8, bbb8f46) verified present in git log.
