# Roadmap: Universal Personal Memory

## Overview

Build one local-first, person-scoped conversation timeline from explicitly approved agent histories, preserve native provenance, contract it into layered memory, and expose safe recall to any agent through MCP.

## Phases

- [x] **Phase 1: Host-Neutral Core and Canonical Timeline** — Establish person ownership, canonical events, provenance, and host-neutral services.
- [x] **Phase 2: Consentful Bootstrap Importers** — Import Codex, Claude Code, OpenClaw, and Hermes histories through metadata-first approval and resumable checkpoints.
- [x] **Phase 3: Source Lifecycle Control Plane** — Make approval durable and add revocation, attributable deletion, quarantine/replay, and retrieval boundaries.
- [x] **Phase 4: Continuous Local Daemon** — Keep approved sources synchronized and incrementally contract new history offline. (completed 2026-07-18)
- [x] **Phase 5: Generic MCP Interface** — Expose safe host-neutral memory tools to Codex, OpenClaw, Claude-compatible clients, and future agents. (completed 2026-07-19)
- [x] **Phase 6: Zero-Knowledge Multi-Device Sync** — Add encrypted device convergence after threat-model and protocol approval. (completed 2026-07-19)
- [ ] **Phase 7: Onboarding and Operational Readiness** — Package the product with first-run consent, audit, migration, backup, and performance surfaces.

## Phase Details

### Phase 1: Host-Neutral Core and Canonical Timeline

**Goal**: Replace implicit Hermes/session ownership with an explicit person-level canonical event model while preserving accordion memory.
**Requirements**: REQ-001, REQ-002, REQ-003, REQ-004, REQ-013, REQ-014, REQ-015, REQ-030, REQ-040
**Status**: Complete

### Phase 2: Consentful Bootstrap Importers

**Goal**: Make a new installation immediately useful from approved existing histories.
**Requirements**: REQ-005, REQ-009, REQ-010, REQ-011, REQ-012, REQ-022, REQ-024, REQ-037
**Status**: Complete

### Phase 3: Source Lifecycle Control Plane

**Goal**: Ensure every content read and destructive mutation is authorized, attributable, auditable, and isolated.
**Requirements**: REQ-006, REQ-007, REQ-008, REQ-016, REQ-024, REQ-026, REQ-038, REQ-039
**Success Criteria**:

  1. Import commands persist exact source grants and refuse revoked or mismatched grants.
  2. Revocation stops future reads without altering native history or unrelated sources.
  3. Confirmed deletion removes attributable canonical events and invalidates dependent memory with an audit trail.
  4. Malformed or unsupported source records enter a redacted quarantine that can be replayed after parser upgrades.
  5. Retrieval enforces explicit person and allowed-scope boundaries.

**Plans**: 1 plan
**Status**: Complete

Plans:

- [x] 03-01-PLAN.md — Implement the lifecycle registry, revocation/deletion, quarantine/replay, and retrieval boundaries.

### Phase 4: Continuous Local Daemon

**Goal**: Keep the canonical conversation current without manual synchronization.
**Requirements**: REQ-017, REQ-018, REQ-019, REQ-020, REQ-021, REQ-022
**Status**: Pending
**Plans:** 21/21 plans complete

Plans:
**Wave 1**

- [x] 04-01-PLAN.md — Define deterministic daemon persistence fixtures and contracts.
- [x] 04-02-PLAN.md — Define source cadence, fairness, failure, and health behavior.
- [x] 04-03-PLAN.md — Implement durable daemon storage and atomic stage foundations.
- [x] 04-04-PLAN.md — Implement approved-source runner and importer batch seams.
- [x] 04-05-PLAN.md — Implement database lease and durable writer authority.

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 04-06-PLAN.md — Implement backend-equivalent atomic import and contraction commits.
- [x] 04-07-PLAN.md — Implement scheduler, watchers, source health, power, and notification adapters.
- [x] 04-08-PLAN.md — Implement bounded incremental contraction and quiet/hourly proposals.

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 04-09-PLAN.md — Compose daemon loop, lifecycle commands, status, and macOS adapter.

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 04-10-PLAN.md — Reconcile approved grants into durable schedulable source state.

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 04-11-PLAN.md — Add backward-compatible generation, processed-boundary, and proposal metadata.
- [x] 04-14-PLAN.md — Compose reconciliation, independent heartbeat, and safe signaling.

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 04-15-PLAN.md — Migrate all durable-record producers and fixtures to strict schemas.

**Wave 7** *(blocked on Wave 6 completion)*

- [x] 04-12-PLAN.md — Consume generation and proposal timestamps in production runners.
- [x] 04-16-PLAN.md — Add fresh-token authority to every atomic daemon commit.

**Wave 8** *(blocked on Wave 7 completion)*

- [x] 04-17-PLAN.md — Wire source and contraction runners to guarded commits.
- [x] 04-18-PLAN.md — Stage and atomically publish proposal work under fresh authority.

**Wave 9** *(blocked on Wave 8 completion)*

- [x] 04-13-PLAN.md — Delegate HistoricalBootstrapper to the incremental runner.
- [x] 04-19-PLAN.md — Guard scheduler outcomes and prove end-to-end lease turnover.

**Wave 10** *(blocked on Wave 9 completion)*

- [x] 04-20-PLAN.md — Separate notification command acceptance from presentation and add a stable-identity smoke trigger.

**Wave 11** *(blocked on Wave 10 completion)*

- [x] 04-21-PLAN.md — Authorize Script Editor and verify one visible content-safe synthetic notification.

### Phase 5: Generic MCP Interface

**Goal**: Let any supported local agent use the same personal memory safely.
**Requirements**: REQ-023, REQ-025, REQ-027, REQ-028, REQ-029
**Status**: Gap Closure Planned (10/11 must-haves verified)
**Plans:** 9/9 plans complete

Plans:
**Wave 1**

- [x] 05-01-PLAN.md — Establish audited MCP dependencies and all synthetic Wave 0 contracts.

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 05-02-PLAN.md — Implement immutable profiles and semantically pure scoped reads.

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 05-03-PLAN.md — Implement budgeted whole-subject expansion and authenticated continuation.
- [x] 05-04-PLAN.md — Add adapter-parity atomic mutation storage contracts.

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 05-05-PLAN.md — Add exact confirmation and scoped mutation application services.

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 05-06-PLAN.md — Register the explicit read tool surface.

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 05-07-PLAN.md — Register the explicit preview/execute mutation surface.

**Wave 7** *(blocked on Wave 6 completion)*

- [x] 05-08-PLAN.md — Compose and verify the clean explicit-profile STDIO server.

**Wave 8** *(blocked on Wave 7 completion)*

- [x] 05-09-PLAN.md — Close proposal payload authorization and exact execute-state revalidation across both storage adapters.

### Phase 6: Zero-Knowledge Multi-Device Sync

**Goal**: Synchronize memory without giving the relay decryption capability.
**Requirements**: REQ-031, REQ-032, REQ-033, REQ-034, REQ-035, REQ-036
**Status**: Complete — verification passed (CR-01, CR-02 closed; 8 review warnings resolved) 2026-07-20
**Plans:** 13/13 plans complete (8 base + 5 gap-closure)

Plans:

**Wave 1**

- [x] 06-01-PLAN.md — Benchmark padding, specify/trace ADR 0047, and obtain independent composed-protocol approval.

**Wave 2** *(blocked on Wave 1 approval)*

- [x] 06-02-PLAN.md — Install audited packages and implement strict protocol schemas, synthetic fixtures, and approved envelope cryptography.
- [x] 06-03-PLAN.md — Implement host-neutral DeviceSecretStore, deterministic fake, and macOS Keychain adapter.

**Wave 3** *(blocked on Wave 2)*

- [x] 06-04-PLAN.md — Add backend-equivalent atomic local outbox, immutable pre-upload envelope sealing, remote apply, replay, tombstone, conflict, quarantine, and affected-range storage.
- [x] 06-05-PLAN.md — Implement the account-provider boundary, opaque append-only relay storage/service, and bounded versioned HTTP/HTTPS server.

**Wave 4** *(blocked on Wave 3)*

- [x] 06-06-PLAN.md — Implement complete-history enrollment, recovery, revocation, future-key/recovery rotation, and production HttpSyncRelay client/control-flow proof.
- [x] 06-07-PLAN.md — Materialize convergence, wire every authoritative producer including BoxReviewer, propagate revocation/deletion, and enforce both quarantine resolutions.

**Wave 5** *(blocked on Wave 4)*

- [x] 06-08-PLAN.md — Implement immutable sealed-byte push/pull, replay defense, production daemon transport selection, complete loopback convergence, structural validation, and blocking real-Keychain UAT.

**Gap Closure — Wave 1** *(from 06-VERIFICATION.md + 06-REVIEW.md; parallel, disjoint files)*

- [x] 06-09-PLAN.md — [BLOCKING GAP-1/CR-01] Bind recovery-seed possession (CMSRSIG1) into recovery enrollment; adversarial account-only test.
- [x] 06-10-PLAN.md — [BLOCKING GAP-2/CR-02] Chain envelope hash on the predecessor ciphertextDigest; multi-op-per-device convergence.
- [x] 06-11-PLAN.md — Bound client remote-apply gap allocation (WR-02) and evict relay rate-limit windows (WR-08).
- [x] 06-12-PLAN.md — Surface dropped sync emissions (WR-06), fix takePlan guard (WR-01), remove Keychain read deadlock (WR-05).

**Gap Closure — Wave 2** *(blocked on 06-09; shared relay/control files)*

- [x] 06-13-PLAN.md — Recovery-challenge freshness/single-use (WR-03), Argon2id unwrap floor (WR-04), revoked-device reactivation guard (WR-07).

### Phase 7: Onboarding and Operational Readiness

**Goal**: Turn the architecture into a product a user can install, inspect, and trust.
**Requirements**: REQ-039 (audit surface); REQ-040 constrains every surface to deterministic/local operation.
**Status**: Planned
**Plans:** 6 plans in 5 waves

Plans:
**Wave 1**

- [ ] 07-01-PLAN.md — Unified `memory` CLI dispatcher + mechanical `main(argv)` export refactor across all 20 command modules.

**Wave 2** *(blocked on Wave 1; disjoint files, parallel)*

- [ ] 07-02-PLAN.md — Guided interactive `memory init`: discover → per-source consent → bootstrap → offer daemon.
- [ ] 07-04-PLAN.md — Versioned SQLite schema migration (`pragma user_version` + `schema_migrations`) + `getSchemaVersion`/`dbFileSizeBytes`.

**Wave 3** *(blocked on Wave 2)*

- [ ] 07-03-PLAN.md — REQ-039 audit surface: `memory explain <id>` CLI + 7th read-only `memory_explain` MCP tool + exportable append-only audit log.

**Wave 4** *(blocked on Wave 3)*

- [ ] 07-05-PLAN.md — Health/status inspection surface + performance reporting and bounded tuning knobs.

**Wave 5** *(blocked on Wave 4)*

- [ ] 07-06-PLAN.md — Encrypted backup/restore (`cms.backup.v1` domain) + clearly-labeled `export --plaintext` escape hatch.

## Sequencing Principle

Lifecycle controls precede the daemon. The daemon precedes MCP. Remote synchronization cannot weaken local authority, auditability, deletion, or retrieval isolation.
