---
phase: 06-zero-knowledge-multi-device-sync
plan: "08"
subsystem: sync
tags: [replication, replay-verification, daemon, http-sync-relay, evidence-validator]

requires:
  - phase: 06-04
    provides: "atomic local sync storage seam (commitLocalSyncOperation/commitRemoteSyncApply/sealClaimedOutboxEnvelope)"
  - phase: 06-05
    provides: "OpaqueRelayService, RelayStore adapters, createRelayHttpServer"
  - phase: 06-06
    provides: "SyncControlService (device identity/epoch-key DeviceSecretStore binding convention), HttpSyncRelay client"
  - phase: 06-07
    provides: "SyncMaterializer deterministic reducer, producer-wiring outbox emission"
provides:
  - "src/sync/replication/replay-verifier.ts - ReplayVerifier: schema/membership/signature verification before AEAD, plus independent per-device envelope hash chain rollback/fork detection"
  - "src/sync/replication/sync-replication-service.ts - SyncReplicationService: bounded sealed-byte push (claim/seal-once/upload) and cross-device-batched pull/materialize/commit"
  - "src/sync/replication/sync-status.ts - deriveSyncStatus: content-free offline/pending/incomplete/conflict/synced derivation"
  - "src/daemon/daemon.ts - optional DaemonLoopDependencies.syncReplication.runCycle(authority), never affects lease authority on failure"
  - "src/daemon/daemon-command.ts - resolveProductionSyncReplicationDependency: env-driven HTTPS-only HttpSyncRelay production selection"
  - "scripts/verify-phase06-evidence.mjs - deterministic --automated structural validator and --keychain-evidence bundle validator"
affects: []

tech-stack:
  added: []
  patterns:
    - "Chain digest reuse: envelope N+1's header.previousEnvelopeHash == envelope N's own ciphertextDigest (no second envelope-hash concept introduced)"
    - "Cross-device single-batch pull materialization: every verified operation from every peer device in one pull cycle is passed to SyncMaterializer.materializeBatch ONCE, so control-first tombstone/quarantine ordering applies across devices, not just within one device's stream"
    - "Daemon sync-cycle failure isolation: syncReplication.runCycle is invoked under the same captured DaemonWriteAuthority as every other bounded work item, wrapped in try/catch that never calls loseAuthority()"

key-files:
  created:
    - src/sync/replication/replay-verifier.ts
    - src/sync/replication/sync-replication-service.ts
    - src/sync/replication/sync-status.ts
    - tests/sync/replay-equivocation.test.ts
    - tests/integration/multi-device-sync.test.ts
    - scripts/verify-phase06-evidence.mjs
  modified:
    - src/daemon/daemon.ts
    - src/daemon/daemon-command.ts
    - tests/daemon/daemon-loop.test.ts
    - .planning/phases/06-zero-knowledge-multi-device-sync/06-VALIDATION.md

key-decisions:
  - "Scoped SyncReplicationService's wire-level push/pull to the two operation kinds src/sync/domain/types.ts already defines (canonical.append, tombstone.create). domain/types.ts is NOT in this plan's declared files_modified frontmatter -- the identical file-boundary precedent already documented by Plans 06-04/06-06/06-07. host_event_ingest is pushed as canonical.append (via an injectable resolveOperationContent callback); proposal_decision, reviewed_box_decision, and quarantine_resolution outbox rows have no wire representation yet and are surfaced via skippedUnsupportedKinds rather than silently dropped or fabricated onto an unrelated wire shape."
  - "ReplayVerifier's rollback/fork chain check defines the per-device envelope hash chain as envelope N+1.header.previousEnvelopeHash == envelope N.ciphertextDigest -- reusing an existing 32-byte wire field rather than inventing a second envelope-hash concept. commitLocalSyncOperation/commitRemoteSyncApply (Plan 06-04) already own exact-tuple idempotency/equivocation/gap classification from the numeric sequence alone; ReplayVerifier supplies the membership/signature/chain layer those primitives do not."
  - "Pull materializes every verified operation across ALL peer devices as one SyncMaterializer batch per pull cycle (not per-operation), so control-first tombstone/quarantine ordering genuinely applies across devices within one cycle, then commits each already-classified outcome individually through commitRemoteSyncApply (which still owns the durable per-device frontier/gap/equivocation CAS)."
  - "Production daemon sync composition (daemon-command.ts) enforces HTTPS-only HttpSyncRelay selection and fail-closed misconfiguration for MEMORY_SYNC_RELAY_BASE_URL/_TOKEN_PATH/MEMORY_SYNC_PERSON_ID/_ID/_DEVICE_ID/_EPOCH, and reads device signing/AEAD secrets via the exact DeviceSecretStore binding/byte convention SyncControlService.createDeviceIdentity/storeEpochKey (Plan 06-06) already writes. The concrete DeviceSecretStore adapter (production MacosKeychainSecretStore vs. a test double) is left injectable rather than hardwiring the Swift Keychain helper process-spawn here, since packaging/locating that compiled helper binary is Plan 06-03's own deployment concern, outside this plan's declared files. Without an injected store, sync composition stays a documented no-op rather than fabricating placeholder crypto identity -- this is why the production CLI entrypoint (main()) does not yet enable real network sync end-to-end."
  - "scripts/verify-phase06-evidence.mjs's --automated task-row gate excludes 06-08-03 (the separate blocking real-Keychain human gate) from its 'every row complete' requirement, since Task 06-08-02's own literal verify command runs this validator BEFORE Keychain signoff exists by design."

patterns-established:
  - "SyncReplicationService accepts injectable resolveOperationContent and buildMaterializationContext callbacks rather than reaching into concrete domain-content-fetching/authorization logic itself, keeping the replication engine decoupled from exactly which future plan wires real CanonicalEvent-by-targetId resolution and real scope/source authorization snapshots."

requirements-completed: []

duration: ~150min
completed: 2026-07-19
---

# Phase 6 Plan 08: Sealed-Byte Replication, Daemon Transport Composition, and Real-Loopback Multi-Device Proof Summary

**Implements `ReplayVerifier` (membership/signature/rollback-chain verification) and `SyncReplicationService` (bounded sealed-byte push, cross-device-batched pull/materialize/commit) proven against both an in-process relay and a real ephemeral HTTP loopback server, composes an optional HTTPS-only production `HttpSyncRelay` daemon sync cycle that never affects writer-lease authority on failure, and adds a deterministic two-mode structural/Keychain-evidence validator -- Task 06-08-03's blocking real-macOS-Keychain human-inspected gate remains pending and is NOT executed by this automated run.**

## Performance

- **Duration:** ~150 min
- **Tasks:** 2 of 3 complete (Task 3 is a blocking `checkpoint:human-verify` requiring a real macOS host and independent human inspection; not executable by this automated worktree run)
- **Files modified:** 10 (6 created, 4 modified)

## Accomplishments

- **Task 06-08-01 (sealed-byte replication + replay verification):**
  - `ReplayVerifier` verifies envelope schema, active device membership, and Ed25519 signature (via the already-existing `openSyncEnvelope` from Plan 06-02) before any plaintext is trusted, then independently checks the per-device envelope hash chain (`previousEnvelopeHash == prior ciphertextDigest`) to catch rollback/fork tampering the storage seam's sequence-only CAS cannot see on its own. Every failure path returns a stable, content-free `SyncErrorCode`.
  - `SyncReplicationService.pushPending()` claims bounded outbox pages, seals each still-pending row exactly once through the Plan 06-04 `sealClaimedOutboxEnvelope` CAS, and uploads only the exact stored bytes; a reopened/retried instance never re-invokes encryption for an already-sealed row (proven with a resolver that throws if ever called again). `pullAndApply()` verifies every peer envelope, materializes every verified operation from every peer device as ONE `SyncMaterializer` batch per cycle (so control-first tombstone/quarantine ordering genuinely applies across devices), then commits each classified outcome individually through `commitRemoteSyncApply`.
  - `sync-status.ts` derives one honest, mutually-exclusive `offline`/`pending`/`incomplete`/`conflict`/`synced` state from bounded counts only -- no plaintext, semantic label, token, or key.
  - `tests/sync/replay-equivocation.test.ts` (9 tests): sealed-byte crash/retry against a real in-process `OpaqueRelayService`/`InMemoryRelayStore`, two-device push/pull convergence, bounded gap classification, and `ReplayVerifier` membership/signature/rollback/schema rejection.
  - `tests/integration/multi-device-sync.test.ts` (5 tests): real ephemeral HTTP loopback (`createRelayHttpServer` + `HttpSyncRelay`, no in-process fake) proof of convergence, sealed-byte crash/retry, server-side revoked-device denial with historical local access preserved, a relay-storage plaintext/identifier negative-knowledge scan, and content-free offline status derivation.
  - Exact plan verify command green: `npx vitest run tests/sync/replay-equivocation.test.ts tests/sync/convergence.test.ts tests/sync/deletion-tombstones.test.ts tests/integration/multi-device-sync.test.ts && npm run typecheck`.

- **Task 06-08-02 (production daemon composition + evidence validator):**
  - `DaemonLoop` gains an optional `syncReplication.runCycle(authority)` dependency, invoked under the same captured `DaemonWriteAuthority` as every other bounded work item once per `drainOne()`; any failure is swallowed exactly like the existing `safePowerState()`/notification failure paths and never loses writer-lease authority, blocks local ingestion/contraction/proposal work, or prevents graceful shutdown. Absent (`undefined`, the default) is byte-identical to Phase 05 daemon behavior.
  - `resolveProductionSyncReplicationDependency` (daemon-command.ts) reads `MEMORY_SYNC_RELAY_BASE_URL`/`_TOKEN_PATH` and `MEMORY_SYNC_PERSON_ID`/`_ID`/`_DEVICE_ID`/`_EPOCH`, enforces HTTPS (or an explicit `MEMORY_SYNC_RELAY_ALLOW_INSECURE_LOOPBACK=true` loopback-test acknowledgement), and constructs the real Plan 06 `HttpSyncRelay` -- there is no code path in this composition that can select a fake/in-process relay. Device signing/AEAD secret retrieval reuses the exact `DeviceSecretStore` binding/byte convention `SyncControlService.createDeviceIdentity`/`storeEpochKey` (Plan 06-06) already writes.
  - `scripts/verify-phase06-evidence.mjs`: `--automated` mode checks exactly eight plan files plus seven prior SUMMARYs, required artifact presence, zero skip/todo test declarations across `tests/{sync,relay,storage,daemon,mcp,integration}`, exact `canonicalize`/`jose`/`libsodium-wrappers-sumo` package versions, ADR 0047's approval/digest/disposition markers, the complete seven-producer-kind inventory (across `sync-producers.test.ts` + `deletion-tombstones.test.ts`), production-transport ownership (daemon-command.ts constructs `HttpSyncRelay` and never references a fake/in-process relay), and 06-VALIDATION.md's per-task Status rows (excluding the separate blocking 06-08-03 row) plus `wave_0_complete: true`. `--keychain-evidence <path>` mode independently validates one external content-free evidence bundle's required fields, exact operation sequence, zero leakage-scan counts, and a recomputed digest binding -- rejecting missing, edited, replayed, or inconsistent evidence.
  - `06-VALIDATION.md` updated: every automated task row `06-01-00` through `06-08-02` marked `complete`, `wave_0_complete: true`. `nyquist_compliant` stays `false` and Task `06-08-03`'s row stays `pending` until the separate blocking real-Keychain human gate is independently approved.
  - Exact plan verify command green except the pre-existing, unrelated `tests/mcp/stdio-server.test.ts` failure documented below: `node scripts/benchmark-sync-padding.mjs && npx vitest run tests/sync tests/relay tests/integration/multi-device-sync.test.ts tests/storage/sync-store.test.ts tests/daemon/contraction-runner.test.ts tests/daemon/daemon-loop.test.ts tests/daemon/daemon-commands.test.ts tests/mcp && npm test && npm run typecheck && node scripts/verify-phase06-evidence.mjs --automated`.

- **Task 06-08-03 (blocking real-Keychain UAT):** NOT executed. This is a `checkpoint:human-verify` task with `gate="blocking-human"` requiring a real macOS host, a synthetic non-production Keychain item, and independent human inspection of actual provenance before `06-VALIDATION.md` may be marked Keychain PASS/`nyquist_compliant: true`. No automated agent action can satisfy this task per its own `<action>` text ("editing PASS text without valid external evidence and a successful validator cannot satisfy this task").

## Task Commits

1. **Task 06-08-01: Implement sealed-byte push, control-first pull, and replay verification** - `d2622b1` (feat)
2. **Task 06-08-02: Compose production daemon sync and close deterministic validation** - `985d7a4` (feat)

_Note: both tasks were TDD-flagged; tests and implementation were authored together per task and verified green (modulo the pre-existing unrelated `stdio-server.test.ts` failure) before commit, matching the pattern established by every prior plan in this phase._

**Plan metadata:** (this SUMMARY commit)

## Files Created/Modified

- `src/sync/replication/replay-verifier.ts` - `ReplayVerifier`, `ActiveDeviceMembership`, `ReplayVerificationContext/Outcome`
- `src/sync/replication/sync-replication-service.ts` - `SyncReplicationService`, `SyncReplicationServiceOptions`, `ResolveOperationContent`, `BuildMaterializationContext`, `PushResult`, `PullResult`
- `src/sync/replication/sync-status.ts` - `deriveSyncStatus`, `SyncStatusSnapshot`, `SyncStateLabel`
- `tests/sync/replay-equivocation.test.ts` - 9 tests: sealed-byte crash/retry, two-device convergence, bounded gap, ReplayVerifier chain/membership/signature/schema rejection, storage-seam idempotent/equivocation classification
- `tests/integration/multi-device-sync.test.ts` - 5 tests: real HTTP loopback convergence, crash/retry, revoked-device denial with historical access, relay negative-knowledge scan, offline status
- `scripts/verify-phase06-evidence.mjs` - new: `--automated` and `--keychain-evidence <path>` deterministic validator
- `src/daemon/daemon.ts` - optional `syncReplication` dependency, invoked and failure-isolated inside `drainOne()`
- `src/daemon/daemon-command.ts` - `resolveProductionSyncReplicationDependency`, wired into `createLoop()`'s `DaemonLoop` construction
- `tests/daemon/daemon-loop.test.ts` - 5 new tests: sync-cycle authority propagation, offline-never-blocks-lease, unconfigured no-op, HTTPS enforcement, fail-closed misconfiguration, real `HttpSyncRelay` construction with an injected `DeviceSecretStore`
- `.planning/phases/06-zero-knowledge-multi-device-sync/06-VALIDATION.md` - task-row/wave_0_complete/Wave-0-gap updates

## Decisions Made

See `key-decisions` in frontmatter. Most significant: this plan's own file scope excludes `src/sync/domain/types.ts`, so real wire-level push/pull is bounded to `canonical.append`/`tombstone.create` (the two operation kinds that schema already defines) -- matching the identical file-boundary precedent already documented by Plans 06-04, 06-06, and 06-07's Summaries.

## Deviations from Plan

### Scope Boundary Notes (not Rule 1-4 auto-fixes)

**1. Wire-level push/pull scoped to `canonical.append`/`tombstone.create`**
- **Found during:** Task 1 planning, before writing any replication code
- **Issue:** The plan's must-haves describe replicating "every Plan 07 authoritative producer" (host_event_ingest, canonical_append, proposal_decision, reviewed_box_decision, source_revocation, source_deletion, quarantine_resolution) over the real network. `src/sync/domain/types.ts`'s `PlainSyncOperationSchema` (Plan 06-02, explicitly scoped there to `canonical.append`/`tombstone.create` only) is not in this plan's declared `files_modified`.
- **Resolution:** `SyncReplicationService.pushPending()` supports `canonical_append` and `host_event_ingest` (pushed as `canonical.append` via an injectable `resolveOperationContent` callback) and `pullAndApply()`/`ReplayVerifier` support both existing wire operation types. Outbox rows of the four other kinds are counted in `skippedUnsupportedKinds` rather than silently dropped or coerced onto an unrelated wire shape.
- **Files affected:** None beyond this plan's declared scope.
- **Follow-up needed:** A future plan authorized to extend `src/sync/domain/types.ts`'s `PlainSyncOperationSchema` discriminated union (adding `review_decision`/`tombstone.create`'s `source` targetType/`quarantine_resolution` variants) can then extend `SyncReplicationService`'s `toMaterializerOperation`/push-kind support without changing this plan's own architecture.

**2. Production daemon sync composition stays a documented no-op without an injected `DeviceSecretStore`**
- **Found during:** Task 2 planning
- **Issue:** Real end-to-end production sync requires an enrolled device's signing/AEAD secrets. The only production `DeviceSecretStore` adapter (`MacosKeychainSecretStore`) requires a compiled Swift helper binary (`src/sync/secrets/macos-keychain-helper.swift`) to be built and spawned -- that packaging/build-and-locate concern belongs to Plan 06-03's own deployment scope, not this plan's declared files.
- **Resolution:** `resolveProductionSyncReplicationDependency` fully implements and tests the transport-selection half (HTTPS enforcement, fail-closed misconfiguration for every required env var, and the exact `DeviceSecretStore` binding/byte convention already used by `SyncControlService`) and accepts an injectable `DeviceSecretStore` parameter; without one, it returns `undefined` (sync disabled) rather than fabricating a placeholder crypto identity. The production CLI entrypoint (`main()`) does not currently pass one, so real network sync is not yet reachable purely from `npm run memory:daemon -- run`.
- **Files affected:** None beyond this plan's declared scope.
- **Follow-up needed:** A future plan wiring real device enrollment/Keychain packaging into the daemon CLI entrypoint should pass a real `MacosKeychainSecretStore` (with its compiled helper binary path) into `createDefaultDependencies`.

**3. Cross-device pull membership resolution not yet control-record-driven**
- **Found during:** Task 2, implementing `resolveProductionSyncReplicationDependency`'s `runCycle`
- **Issue:** Full multi-device pull fan-out requires resolving the durable current `ControlRecord`/`MembershipCommit` (active + revoked devices) for the daemon's own `syncId`. Parsing/verifying that record is `SyncControlService`/relay-client wiring not owned by this plan's declared files.
- **Resolution:** The production `runCycle` currently resolves membership to this device's own stream only (`Map([[deviceId, ...]])`), so it can push/pull its own operations but does not yet fan out to peer devices' streams without a future plan supplying the durable membership snapshot. `SyncReplicationService` itself is membership-injectable and already proven against full multi-device membership maps in both test suites above.
- **Files affected:** None beyond this plan's declared scope.
- **Follow-up needed:** A future plan should resolve and refresh the current `ControlRecord` (via `SyncControlService` or a thin equivalent) and pass its `activeDevices` into `resolveProductionSyncReplicationDependency`'s `membership` callback.

## Known Stubs

- `resolveProductionSyncReplicationDependency`'s `resolveOperationContent` in production composition always returns `null` (no wire-schema producer content resolution wired yet) -- see Deviation 1. Sync therefore currently only *pulls* (once a `DeviceSecretStore` and enrolled device identity are supplied); it does not yet push real local content in production. This is intentional and documented, not a UI-visible stub, but is recorded per the phase's stub-tracking convention since REQ-034's "offline multi-writer convergence" is not yet reachable end-to-end from the CLI without a follow-up plan.
- Production daemon sync composition returns `undefined` (disabled) whenever no `DeviceSecretStore` is injected -- see Deviation 2.

## Threat Flags

| Flag | File | Description |
|------|------|--------------|
| threat_flag: scope-reduction | src/sync/replication/sync-replication-service.ts | Wire-level replication is bounded to `canonical.append`/`tombstone.create` (Deviation 1); the other five producer kinds cannot yet cross the network, so REQ-034/REQ-035's full producer-inventory convergence claim is proven at the local-materializer level (Plan 06-07) and the two-kind network level (this plan) but not yet end-to-end for every kind. Flagged for reconciliation once a follow-up plan extends the wire schema. |
| threat_flag: incomplete-production-wiring | src/daemon/daemon-command.ts | Production sync composition requires an injected `DeviceSecretStore` and does not yet resolve real cross-device membership (Deviations 2-3); the daemon CLI entrypoint does not yet enable real network sync end-to-end. No new unmitigated network-facing surface is introduced -- `HttpSyncRelay`'s existing HTTPS/bounded/content-free posture (Plan 06-06) is reused unchanged. |

## Issues Encountered

- Pre-existing, unrelated: `tests/mcp/stdio-server.test.ts` has 2 failing tests in this worktree (`Cannot find module '.../node_modules/tsx/dist/cli.mjs'`), already tracked in `.planning/phases/06-zero-knowledge-multi-device-sync/deferred-items.md` since Plan 06-03. Not touched by this plan; confirmed unrelated by full-suite diff.

## User Setup Required

Per the plan's `user_setup` frontmatter, production sync requires:
- `MEMORY_SYNC_RELAY_BASE_URL` - HTTPS base URL of the Phase 06 relay deployment (plain HTTP accepted only with explicit `MEMORY_SYNC_RELAY_ALLOW_INSECURE_LOOPBACK=true` loopback test mode)
- `MEMORY_SYNC_RELAY_TOKEN_PATH` - filesystem path to a file containing the current relay-account bearer token (re-read fresh on every call; never logged)
- `MEMORY_SYNC_PERSON_ID`, `MEMORY_SYNC_ID`, `MEMORY_SYNC_DEVICE_ID`, `MEMORY_SYNC_EPOCH` - this device's already-enrolled sync identity
- A `DeviceSecretStore` adapter must be injected into `createDefaultDependencies` for sync to actually activate (not yet wired into the CLI entrypoint; see Deviation 2)

No external service configuration was performed as part of this plan; all automated tests use `InMemoryDeviceSecretStore`/`InMemoryRelayStore`/a real ephemeral HTTP loopback server.

## Next Phase Readiness

- `ReplayVerifier`, `SyncReplicationService`, and `sync-status.ts` are complete, tested, and ready for a future plan to extend `src/sync/domain/types.ts`'s wire schema and wire real per-kind content resolution.
- `DaemonLoop`'s `syncReplication` composition point and `resolveProductionSyncReplicationDependency`'s transport-selection logic are complete and tested; a future plan supplying a real `DeviceSecretStore` (Keychain helper packaging) and control-record-driven membership resolution can activate real end-to-end production sync without further changes to this plan's files.
- `scripts/verify-phase06-evidence.mjs --automated` passes; `--keychain-evidence` is implemented and ready for the blocking Task 06-08-03 human-inspected gate.
- **Blocker for phase closure (`nyquist_compliant: true`):** Task 06-08-03's real macOS Keychain UAT, external content-free evidence bundle, and independent human inspection. This CANNOT be produced by an automated agent per the task's own text.

---
*Phase: 06-zero-knowledge-multi-device-sync*
*Completed: 2026-07-19 (Tasks 1-2 only; Task 3 pending)*

## Self-Check: PASSED

All 10 created/modified files verified present; both task commit hashes (`d2622b1`, `985d7a4`) verified present in git log. Task 3 (blocking real-Keychain human-verify checkpoint) intentionally not executed -- see "Task Commits" and "Next Phase Readiness" above.
