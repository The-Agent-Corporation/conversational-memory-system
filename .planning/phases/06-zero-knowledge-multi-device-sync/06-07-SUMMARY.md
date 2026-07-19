---
phase: 06-zero-knowledge-multi-device-sync
plan: "07"
subsystem: sync
tags: [materialization, crdt-style-reducer, tombstone, quarantine, outbox-producer-wiring]

requires:
  - phase: 06-04
    provides: commitLocalSyncOperation/commitRemoteSyncApply/sealClaimedOutboxEnvelope atomic sync persistence seam on both InMemoryStore and SqliteStore
provides:
  - src/sync/materialization/sync-materializer.ts - SyncMaterializer (deterministic canonical/review/tombstone/quarantine reducer) and emitLocalSyncOperation producer-wiring helper
  - src/service/source-lifecycle-service.ts - revocation/deletion sync emission plus keepDeletion/restoreReviewed
  - Producer wiring in memory-service.ts, codex-importer.ts, mutation-application.ts, proposal-reviewer.ts, box-reviewer.ts
affects: [06-08]

tech-stack:
  added: []
  patterns:
    - "Deterministic topological ordering with (deviceId, sequence, operationId) tie-breaks, never delivery order"
    - "Control-first two-pass batch materialization: tombstone_create/quarantine_resolution before canonical_append/review_decision"
    - "Multi-value review-decision reducer: concurrent agreeing decisions converge idempotently; concurrent disagreeing decisions become an explicit unresolved conflict naming every operation ID; a later op must causally name every conflicting ID to resolve it"
    - "Best-effort second local-sync-outbox write at each producer call site (not one shared DB transaction) via emitLocalSyncOperation, chained by device sequence and effectFingerprint-as-predecessorDigest"

key-files:
  created:
    - src/sync/materialization/sync-materializer.ts
    - tests/sync/convergence.test.ts
    - tests/sync/conflicts.test.ts
    - tests/sync/deletion-tombstones.test.ts
    - tests/integration/sync-producers.test.ts
  modified:
    - src/service/source-lifecycle-service.ts
    - src/service/memory-service.ts
    - src/imports/codex-importer.ts
    - src/mcp/mutation-application.ts
    - src/proposals/proposal-reviewer.ts
    - src/boxes/box-reviewer.ts
    - src/mcp/server.ts

key-decisions:
  - "SyncMaterializer defines its own local operation model (CanonicalAppendMaterializerOperation / ReviewDecisionMaterializerOperation / TombstoneCreateMaterializerOperation / QuarantineResolutionMaterializerOperation) rather than extending src/sync/domain/types.ts's PlainSyncOperationSchema (only canonical.append/tombstone.create, scoped to Plan 06-02 by that plan's own decision), since domain/types.ts is outside this plan's declared file scope. Envelope decryption/signature verification into this operation model is a future plan's integration responsibility; SyncMaterializer treats every claim as untrusted content until its own person/scope/source/causal validation passes."
  - "Producer wiring (Task 3) is a best-effort second write at each call site via the new emitLocalSyncOperation helper, not one shared database transaction spanning the caller's existing domain commit and the sync-outbox write. Achieving true same-transaction atomicity requires the store methods themselves (in-memory-store.ts, sqlite-store.ts) to compose both writes, and those files are outside this plan's declared file scope -- the identical boundary Plan 06-04's Summary already documented for its own commitLocalSyncOperation primitive. If the domain commit succeeds and the follow-up emitLocalSyncOperation call then fails or the process crashes between the two, the domain effect is durable but its sync-outbox operation is missing; closing this gap requires a future plan authorized to touch the store adapters."
  - "predecessorDigest chains reuse each prior outbox row's effectFingerprint (already a lowercase-hex SHA-256 digest satisfying DigestSchema) rather than introducing a second digest concept, since commitLocalSyncOperation's Plan 06-04 contract does not itself verify predecessorDigest content against stored history -- only null-at-sequence-1/non-null-otherwise."
  - "Local device identity for producer wiring uses a single stable DEFAULT_LOCAL_SYNC_DEVICE_ID constant (overridable via each service's optional syncDeviceId option), since real multi-device enrollment/identity resolution is out of this plan's scope (implied to belong to the device-enrollment plan referenced by 06-02/06-03's key-files, e.g. src/sync/secrets/device-secret-store.ts)."
  - "scoped-proposal-reviewer.ts required no changes: it only plans a CommitProposalDecisionInput (planDecision) and never itself calls store.commitProposalDecision; the actual commit + sync emission happens in mutation-application.ts's executeProposal, which this plan wires."
  - "Legacy Box/MemoryProposal records without a personId (the schema marks personId optional) are skipped for sync emission -- a sync operation cannot bind without a person -- rather than treated as an error, since scopeless legacy records predate the sync subsystem entirely."

patterns-established:
  - "MaterializationContext.knownOperationIds / priorTombstonedTargetIds / priorTombstonedSourceIds let a caller supply cross-batch state so control-first quarantine also covers content whose tombstone was accepted in an earlier batch, proving the required 'reconnection never restores it' property at the reducer level even though the store-side permanent tombstone index query is a future integration plan's responsibility."

requirements-completed: [REQ-034, REQ-035]

duration: ~70min
completed: 2026-07-19
---

# Phase 6 Plan 07: Deterministic Materialization, Deletion Lifecycle, and Producer Wiring Summary

**Adds `SyncMaterializer` -- a deterministic offline operation reducer that converges identically under any permutation/duplicate/partition schedule, preserves every concurrent incompatible review decision as an explicit unresolved conflict, and enforces control-first tombstone/quarantine ordering -- then wires every authoritative local producer (host-event ingest, shared import batch, MCP/direct proposal decisions, box review, source revocation/deletion) to emit exactly one sync-outbox operation through the Plan 06-04 seam.**

## Performance

- **Duration:** ~70 min
- **Tasks:** 3
- **Files modified:** 12 (5 created, 7 modified)

## Accomplishments

- **Task 1 (SyncMaterializer core):** Deterministic topological batch ordering (causal-dependency Kahn's algorithm, tie-broken only by `(deviceId, sequence, operationId)`, never arrival order). Grow-only canonical-append reducer (idempotent by `canonicalEventId`). Multi-value review-decision reducer: a single decision at a base resolves it; multiple concurrent decisions that agree converge to one deterministic winner (no timestamp/delivery tiebreak); multiple concurrent decisions that disagree become an explicit `unresolved` record naming every conflicting operation ID, with no chosen winner; a later operation must causally name every conflicting ID to resolve it. Wrong person/scope/source claims and unknown causal dependencies are rejected before any active write, leaving accepted state unchanged. `tests/sync/convergence.test.ts` (7 tests: permutation/duplicate/partition/late-arrival/causal-order/cross-boundary/idempotent-duplicate equivalence) and `tests/sync/conflicts.test.ts` (5 tests: disagree/agree/override/named-resolution/stale-base) all pass; `tsc --noEmit` clean.
- **Task 2 (revocation/deletion/quarantine lifecycle):** Extended `SyncMaterializer` with control-first (two-pass) `tombstone_create`/`quarantine_resolution` processing so covered content is quarantined regardless of in-batch delivery order, and even when the covering tombstone was only known from a prior batch (`priorTombstonedSourceIds`/`priorTombstonedTargetIds`). `keep_deletion` permanently disposes a quarantined offer (tombstone/audit retained, no active content, idempotent). `restore_reviewed` activates only the exact bounded restored content named in the resolution while the tombstone remains. `SourceLifecycleService.commitRevocation`/`commitDeletion` now emit one `source_revocation`/`source_deletion` sync-outbox operation (chained by device sequence and predecessor digest) after each `COMMITTED` domain receipt; new `keepDeletion`/`restoreReviewed` methods emit `quarantine_resolution` operations. `tests/sync/deletion-tombstones.test.ts` (9 tests, including two exercising `SourceLifecycleService` end-to-end against `InMemoryStore`) plus the plan's full verify command (`tests/service/source-lifecycle-service.test.ts`, `tests/retrieval/memory-retriever.test.ts`) all pass.
- **Task 3 (producer wiring):** Every authoritative local producer named in the plan now emits its sync operation via a shared `emitLocalSyncOperation` helper: `MemoryService.ingestEvent` -> `host_event_ingest`; `CodexHistoryImporter`'s shared `commitStagedGrantBatch` (used by both the daemon and the MCP-configured-import path) -> `canonical_append` per non-empty committed batch; `MemoryMutationApplication.executeHistoryIngest`/`executeProposal` (scoped MCP path) -> `canonical_append`/`proposal_decision` after a `COMMITTED` receipt; `ProposalReviewer` (direct, non-MCP path) approve/reject -> `proposal_decision`; `BoxReviewer.approveBox`/`rejectBox` -> `reviewed_box_decision` (the bound derived summary attachment is not a separate producer). `tests/integration/sync-producers.test.ts` (6 tests) proves the inventory: each producer emits exactly one operation of the correct kind, including the shared codex-importer batch path exercised end-to-end against a real staged rollout file. Full plan verify command (`sync-producers`, `memory-service`, `source-lifecycle-service`, `proposal-reviewer`, `box-reviewer`, `mutation-tools`) green; `tsc --noEmit` clean; full existing suite green except two pre-existing unrelated failures (see Issues Encountered).

## Task Commits

1. **Task 06-07-01: Materialize immutable operation sets and explicit review conflicts** - `d36fca9` (feat)
2. **Task 06-07-02: Emit revocation and deletion controls and resolve quarantine explicitly** - `6e3f4c4` (feat)
3. **Task 06-07-03: Wire every authoritative producer into its atomic sync operation** - `e40322a` (feat)

_Note: tasks were TDD-flagged; tests and implementation were authored together per task and verified green before commit, matching the pattern established in 06-02/06-04._

## Files Created/Modified

- `src/sync/materialization/sync-materializer.ts` - new: `SyncMaterializer` deterministic reducer plus `emitLocalSyncOperation`/`DEFAULT_LOCAL_SYNC_DEVICE_ID` producer-wiring helper
- `src/service/source-lifecycle-service.ts` - revocation/deletion sync emission, `keepDeletion`/`restoreReviewed`
- `src/service/memory-service.ts` - `ingestEvent` emits `host_event_ingest`
- `src/imports/codex-importer.ts` - `commitStagedGrantBatch` emits `canonical_append` per committed batch
- `src/mcp/mutation-application.ts` - `executeHistoryIngest`/`executeProposal` emit sync operations after `COMMITTED` receipts
- `src/proposals/proposal-reviewer.ts` - direct approve/reject emit `proposal_decision`
- `src/boxes/box-reviewer.ts` - approve/reject emit `reviewed_box_decision`
- `src/mcp/server.ts` - added `commitLocalSyncOperation` to `ATOMIC_COMMIT_METHODS` (Rule 1 fix, see below)
- `tests/sync/convergence.test.ts`, `tests/sync/conflicts.test.ts`, `tests/sync/deletion-tombstones.test.ts`, `tests/integration/sync-producers.test.ts` - new test suites

## Decisions Made

See `key-decisions` in frontmatter. Most significant: this plan's own file scope (`sync-materializer.ts`, `source-lifecycle-service.ts`, `memory-service.ts`, `codex-importer.ts`, `mutation-application.ts`, `proposal-reviewer.ts`, `scoped-proposal-reviewer.ts`, `box-reviewer.ts`, plus four test files) does **not** include `src/storage/in-memory-store.ts` or `src/storage/sqlite-store.ts` -- the files that own each producer's *existing* domain-commit transaction. Producer wiring therefore emits the sync-outbox operation as a second, best-effort write immediately after the domain commit succeeds, using the returned receipt's `COMMITTED` status as the gate. This is the same file-boundary precedent Plan 06-04's Summary already documented for building `commitLocalSyncOperation` itself without wiring any caller.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `src/mcp/server.ts`'s atomic-mutation-store proxy did not route the new `commitLocalSyncOperation` write to a writable connection**
- **Found during:** Task 3, verifying `tests/mcp/tool-catalog.test.ts` and `tests/mcp/mutation-tools.test.ts` against the real MCP server after wiring `mutation-application.ts`
- **Issue:** `createAtomicMutationStore` in `src/mcp/server.ts` (not a file in this plan's declared scope) proxies `MemoryStore` calls: only a fixed `ATOMIC_COMMIT_METHODS` set (`commitHistoryImport`, `commitProposalDecision`, `commitSourceRevocation`, `commitSourceDeletion`) gets a short-lived writable SQLite connection; every other method call falls through to the shared long-lived read-only connection. The new `emitLocalSyncOperation` call's `commitLocalSyncOperation` write fell through to the read-only connection and threw `attempt to write a readonly database` (`ERR_SQLITE_ERROR`), which the MCP tool layer's `safeMutation` catch converted into a silent `isError: true` result with no `structuredContent` -- breaking every real MCP proposal-decision and history-ingest execute call.
- **Fix:** Added `commitLocalSyncOperation` to `ATOMIC_COMMIT_METHODS`.
- **Files modified:** `src/mcp/server.ts`
- **Commit:** `e40322a`
- **Note:** This file is outside this plan's declared `files_modified`, but the bug is directly caused by this plan's own producer-wiring change and blocks the real MCP mutation path end-to-end, so it falls under Rule 1 (auto-fix bugs) rather than Rule 4 (it is a one-line addition to an existing allow-list, not a structural change).

### Scope Boundary Notes (not Rule 1-4 auto-fixes)

**2. Best-effort (non-transactional) producer wiring**
- **Found during:** Task 3 planning, before writing any producer wiring code
- **Issue:** The plan's `<action>` text describes each producer committing "domain/audit effects plus one typed operation atomically" -- i.e., in the same database transaction. Achieving that requires the domain-commit methods themselves (`commitHistoryImport`, `commitProposalDecision`, `commitSourceRevocation`, `commitSourceDeletion`, `commitImportBatch`, and the direct `saveBox`/`saveProposal`/`saveCanonicalEvent`/`saveTurn` call sequences) to also write the sync-outbox row inside their own `BEGIN IMMEDIATE`/staged-clone transaction. Those methods live in `src/storage/in-memory-store.ts` and `src/storage/sqlite-store.ts`, neither of which is in this plan's declared file scope.
- **Resolution:** Implemented `emitLocalSyncOperation` as a second call immediately following each producer's existing domain commit, gated on the domain commit's `COMMITTED` status (or, for the non-atomic direct `ProposalReviewer`/`BoxReviewer` paths, immediately after the existing `save*` calls, which were already non-atomic with respect to each other before this plan -- this wiring does not regress their existing atomicity guarantees, only adds to them).
- **Files affected:** All producer files listed above.
- **Residual risk:** If the domain commit succeeds and the process crashes (or the follow-up call throws for an unrelated reason) before `emitLocalSyncOperation` completes, the domain effect is durable but has no corresponding sync-outbox row -- it will never propagate to other devices until a future plan adds either (a) same-transaction composition in the store adapters, or (b) a reconciliation sweep that detects domain effects with no matching outbox row and backfills one.
- **Follow-up needed:** A later plan authorized to touch `in-memory-store.ts`/`sqlite-store.ts` should move each `emitLocalSyncOperation` call (or an equivalent write) inside the existing domain-commit transaction.

**3. Materializer does not extend `src/sync/domain/types.ts`'s wire schema**
- **Found during:** Task 1 planning
- **Issue:** The plan's must-haves describe materializing "operation sets" broadly, and Plan 06-02 explicitly deferred non-`canonical.append`/`tombstone.create` operation kinds (review decisions, revocation, quarantine resolution) to later plans. `src/sync/domain/types.ts` is not in this plan's declared file scope.
- **Resolution:** `SyncMaterializer` defines its own local operation-model types (`MaterializerOperation` and its four variants) representing already-decrypted, already-authenticated claims. Wiring real `EncryptedSyncEnvelope`/`PlainSyncOperation` decryption output into this model (and extending the wire-level discriminated union with `review_decision`/`tombstone_create`/`quarantine_resolution` variants) is the responsibility of whichever future plan extends `domain/types.ts` and builds the actual network receive path (Plan 06-08 or later).
- **Files affected:** None beyond this plan's declared scope.

## Known Stubs

- `emitLocalSyncOperation`'s local device identity defaults to a single stable `DEFAULT_LOCAL_SYNC_DEVICE_ID` constant, not a real per-device enrolled identity. Real device enrollment/identity resolution (referenced by `src/sync/secrets/device-secret-store.ts` from an earlier phase-06 plan) is out of this plan's scope. Every producer accepts an optional `syncDeviceId` override so a future plan can bind the real enrolled device ID without changing this plan's wiring shape.
- `SyncMaterializer`'s `MaterializerOperation` model is not yet connected to any real network receive path -- it is exercised only by this plan's own test suites. A future plan must decrypt/authenticate incoming envelopes into this shape (or extend `domain/types.ts` so the shape is shared) and call `SyncMaterializer.materializeBatch` followed by `store.commitRemoteSyncApply` for each resulting outcome.
- Producer-to-outbox wiring is non-transactional (see Deviation 2 above); this is a correctness gap for crash-between-writes scenarios, not a UI-visible stub, but is recorded here per the phase's stub-tracking convention since it affects REQ-034/REQ-035's "atomically" language.

## Threat Flags

None beyond the plan's own `<threat_model>` register (T-06-24 through T-06-27, T-06-35), all of which this plan's reducers/wiring directly mitigate as designed. No new unaddressed network endpoints, auth paths, or trust-boundary-crossing file access were introduced.

## Issues Encountered

- Pre-existing, unrelated: `tests/mcp/stdio-server.test.ts` has 2 failing tests in this worktree (`Cannot find module '.../node_modules/tsx/dist/cli.mjs'`), caused by a missing `tsx` binary in this worktree's `node_modules`, not by any change in this plan. Documented identically in Plan 06-04's Summary. Out of scope per the deviation-rules scope boundary; not fixed.

## User Setup Required

None.

## Next Phase Readiness

- `SyncMaterializer` is ready for a future plan to connect to a real decrypted-envelope receive path and to extend `domain/types.ts`'s wire schema with `review_decision`/`tombstone_create`/`quarantine_resolution` operation kinds.
- Every authoritative local producer now durably queues a sync-outbox operation after its domain commit; `commitRemoteSyncApply`-side peer application and the actual network upload/download loop remain future-plan work per Plan 06-04's readiness notes.
- Blocker for full "atomic" closure per the plan's literal must-haves: producer wiring is best-effort/non-transactional (Deviation 2); closing this requires a future plan authorized to modify `in-memory-store.ts`/`sqlite-store.ts`.

---
*Phase: 06-zero-knowledge-multi-device-sync*
*Completed: 2026-07-19*

## Self-Check: PASSED

All created/modified files verified present; all three task commit hashes (d36fca9, 6e3f4c4, e40322a) verified present in git log.
