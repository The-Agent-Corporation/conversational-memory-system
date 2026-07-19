# Roadmap: Universal Personal Memory

## Overview

Build one local-first, person-scoped conversation timeline from explicitly approved agent histories, preserve native provenance, contract it into layered memory, and expose safe recall to any agent through MCP.

## Phases

- [x] **Phase 1: Host-Neutral Core and Canonical Timeline** — Establish person ownership, canonical events, provenance, and host-neutral services.
- [x] **Phase 2: Consentful Bootstrap Importers** — Import Codex, Claude Code, OpenClaw, and Hermes histories through metadata-first approval and resumable checkpoints.
- [x] **Phase 3: Source Lifecycle Control Plane** — Make approval durable and add revocation, attributable deletion, quarantine/replay, and retrieval boundaries.
- [x] **Phase 4: Continuous Local Daemon** — Keep approved sources synchronized and incrementally contract new history offline. (completed 2026-07-18)
- [ ] **Phase 5: Generic MCP Interface** — Expose safe host-neutral memory tools to Codex, OpenClaw, Claude-compatible clients, and future agents. (verification gaps found)
- [ ] **Phase 6: Zero-Knowledge Multi-Device Sync** — Add encrypted device convergence after threat-model and protocol approval.
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
**Status**: Gaps Found (10/11 must-haves verified)
**Plans:** 8/8 implementation plans complete; targeted gap closure required

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

### Phase 6: Zero-Knowledge Multi-Device Sync

**Goal**: Synchronize memory without giving the relay decryption capability.
**Requirements**: REQ-031, REQ-032, REQ-033, REQ-034, REQ-035, REQ-036
**Status**: Research-gated

### Phase 7: Onboarding and Operational Readiness

**Goal**: Turn the architecture into a product a user can install, inspect, and trust.
**Requirements**: REQ-039
**Status**: Pending

## Sequencing Principle

Lifecycle controls precede the daemon. The daemon precedes MCP. Remote synchronization cannot weaken local authority, auditability, deletion, or retrieval isolation.
