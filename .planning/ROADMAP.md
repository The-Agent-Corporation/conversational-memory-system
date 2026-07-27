# Roadmap: Universal Personal Memory

## Overview

Build one local-first, person-scoped conversation timeline from explicitly approved agent histories, preserve native provenance, contract it into layered memory, and expose safe recall to any agent through MCP.

**v1.1** replaces the shared-term all-pairs trace algorithm with local vector embeddings and nearest-neighbor search, and reuses those embeddings for semantic recall over summaries — without weakening REQ-040 (deterministic, local, no external models or services).

## Phases

- [x] **Phase 1: Host-Neutral Core and Canonical Timeline** — Establish person ownership, canonical events, provenance, and host-neutral services.
- [x] **Phase 2: Consentful Bootstrap Importers** — Import Codex, Claude Code, OpenClaw, and Hermes histories through metadata-first approval and resumable checkpoints.
- [x] **Phase 3: Source Lifecycle Control Plane** — Make approval durable and add revocation, attributable deletion, quarantine/replay, and retrieval boundaries.
- [x] **Phase 4: Continuous Local Daemon** — Keep approved sources synchronized and incrementally contract new history offline. (completed 2026-07-18)
- [x] **Phase 5: Generic MCP Interface** — Expose safe host-neutral memory tools to Codex, OpenClaw, Claude-compatible clients, and future agents. (completed 2026-07-19)
- [x] **Phase 6: Zero-Knowledge Multi-Device Sync** — Add encrypted device convergence after threat-model and protocol approval. (completed 2026-07-19)
- [x] **Phase 7: Onboarding and Operational Readiness** — Package the product with first-run consent, audit, migration, backup, and performance surfaces. (completed 2026-07-20)
- [x] **Phase 8: Vector Storage Foundation** — Add a scope-safe, tombstone-ready `summary_vectors` store with exact-match parity between SqliteStore and InMemoryStore. (completed 2026-07-21)
- [x] **Phase 9: Embedding Model + Embedder** — Resolve the hash-vs-ONNX decision; ship a pinned, deterministic embedder with the hash embedder remaining the default. (completed 2026-07-21)
- [x] **Phase 10: Embedding Backfill** — Resumable, idempotent, checkpointed backfill of vectors for all 135,366 existing summaries. (completed 2026-07-21)
- [ ] **Phase 11: Derivation Input Hygiene** — Collapse tool-call runs into activity descriptions and exclude harness-injected scaffolding from derivations, keeping the canonical timeline intact. (implementation complete 2026-07-27; GAP-11-A gap closure in progress, plans 11-08..11-14; GAP-11-B closure plan 11-15)
- [ ] **Phase 12: Daemon Incremental Embedding** — Embed newly contracted summaries per device, per tick, never synced.
- [ ] **Phase 13: Forward-Only Vector Trace Discovery** — Replace shared-term all-pairs trace discovery with forward-only nearest-neighbor discovery, preserving the review flow.
- [ ] **Phase 14: Semantic Recall** — Swap MemoryRetriever candidate selection to a vector top-K pre-filter ahead of unchanged boundary filtering.
- [ ] **Phase 15: Deletion-Invalidation Closure + Operator Surface** — Close the embedding-deletion correctness gap and surface backfill/model health to operators.

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
**Status**: Complete — verification passed (9/9 decisions delivered) 2026-07-20
**Plans:** 6/6 plans complete

Plans:
**Wave 1**

- [x] 07-01-PLAN.md — Unified `memory` CLI dispatcher + mechanical `main(argv)` export refactor across all 20 command modules.

**Wave 2** *(blocked on Wave 1; disjoint files, parallel)*

- [x] 07-02-PLAN.md — Guided interactive `memory init`: discover → per-source consent → bootstrap → offer daemon.
- [x] 07-04-PLAN.md — Versioned SQLite schema migration (`pragma user_version` + `schema_migrations`) + `getSchemaVersion`/`dbFileSizeBytes`.

**Wave 3** *(blocked on Wave 2)*

- [x] 07-03-PLAN.md — REQ-039 audit surface: `memory explain <id>` CLI + 7th read-only `memory_explain` MCP tool + exportable append-only audit log.

**Wave 4** *(blocked on Wave 3)*

- [x] 07-05-PLAN.md — Health/status inspection surface + performance reporting and bounded tuning knobs.

**Wave 5** *(blocked on Wave 4)*

- [x] 07-06-PLAN.md — Encrypted backup/restore (`cms.backup.v1` domain) + clearly-labeled `export --plaintext` escape hatch.

### Phase 8: Vector Storage Foundation

**Goal**: Every summary can have a locally computed vector embedding persisted in a dedicated, scope-aware, deletion-tombstonable store, with exact result parity between SqliteStore and InMemoryStore.
**Depends on**: Phase 7 (existing storage/schema-migration machinery)
**Requirements**: REQ-041
**Success Criteria**:

  1. A vector can be saved for a summary, tagged with the embedder provider, model, and dimensionality that produced it, and retrieved by summary ID.
  2. A query for summary IDs missing a vector under a given (provider, model) returns exactly the correct set, in stable order.
  3. A nearest-neighbor query returns identical top-K results (same ranking, same scores, same tie-break) from SqliteStore and InMemoryStore given identical input vectors — not "closely enough," an exact match.
  4. The storage schema and query surface support scope-partitioned lookups (person/workspace/case) and per-vector deletion/tombstoning, verified by tests, even though nothing invokes deletion yet.
  5. The schema migration is additive and safe against the live ~3.5GB database — existing summaries, tests, and daemon startup are unaffected.

**Plans**: 5 plans (4 waves — 4 base + 1 gap-closure)

- [x] 08-01-PLAN.md — BLOB codec + MemoryStore vector contract + Wave 0 parity suite (RED)
- [x] 08-02-PLAN.md — SqliteStore vectors + summary_vectors migration (version 2)
- [x] 08-03-PLAN.md — InMemoryStore vectors (exact-parity twin)
- [x] 08-04-PLAN.md — SC3 cross-store exact-parity gate + full-suite verification
- [x] 08-05-PLAN.md — gap closure: exact-parity under NaN/minimumScore + dimension-mismatch, codec endianness/alignment, deterministic tie-break, transactional delete

### Phase 9: Embedding Model + Embedder

**Goal**: The milestone's open embedding-model decision is resolved and recorded, with a pinned-deterministic local embedder available while the keyword-hash embedder remains the always-on default and fallback.
**Depends on**: Phase 8 (vectors need somewhere to land, though this phase does not yet call backfill)
**Requirements**: REQ-044, REQ-051
**Success Criteria**:

  1. The existing keyword-hash DeterministicEmbedder remains the default/fallback embedder with zero behavior change for users who take no action.
  2. An operator can explicitly opt in to a local ONNX sentence-transformer embedder that runs fully offline with no runtime network dependency.
  3. Embedding a fixed golden set of summary texts under the pinned ONNX configuration (CPU execution provider, fixed thread count, fixed graph-optimization level) reproduces a committed golden-vector hash, verified by the `npm run test:golden` gate (repo has no CI yet; CI adoption deferred — a ready-to-enable workflow snippet ships with this phase).
  4. For a fixed embedder configuration, re-running embedding on identical input text is deterministic and vector search results over those vectors are stable across repeated runs.
  5. Every vector produced records the embedder provider, model, and version so a later phase can detect stale-model vectors.

**Plans**: 6 plans (4 waves)

Plans:
**Wave 1**

- [x] 09-01-PLAN.md — AsymmetricEmbedder contract + skeleton modules + Wave 0 RED tests + D-08 golden-set fixture
- [x] 09-02-PLAN.md — Install @huggingface/transformers@4.2.0 behind a blocking package-legitimacy checkpoint

**Wave 2** *(blocked on Wave 1)*

- [x] 09-03-PLAN.md — TransformerEmbedder (pinned fp32, cls-pooling, asymmetric) + hash-verified vendoring

**Wave 3** *(blocked on Wave 2)*

- [x] 09-04-PLAN.md — Config sidecar + embedder-resolver (default/enabled/broken) + `memory embeddings` CLI command

**Wave 4** *(blocked on Wave 3)*

- [x] 09-05-PLAN.md — Real vendoring run: capture manifest sha256 + revision + committed golden hashes, golden suite GREEN
- [x] 09-06-PLAN.md — `memory status` embedder-health surface (D-06) + `test:golden` gate + operator/CI docs

### Phase 10: Embedding Backfill

**Goal**: All 135,366 existing summaries receive embeddings through a job that survives interruption without corrupting or duplicating work.
**Depends on**: Phase 9 (embedder must be chosen and pinned before backfill runs at scale)
**Requirements**: REQ-042
**Success Criteria**:

  1. Running the backfill command against the full existing corpus completes and leaves zero summaries missing a vector for the active (provider, model).
  2. Killing the backfill process partway through and restarting it resumes from where it left off without re-embedding already-completed summaries or corrupting saved vectors.
  3. Re-running backfill to completion a second time after it already finished performs zero additional writes.
  4. Backfill progress (processed/total) is visible through the operator surface rather than a silent multi-minute-to-hours black box.

**Plans**: 3 plans (2 waves)

Plans:
**Wave 1** *(disjoint files, parallel)*

- [x] 10-01-PLAN.md — Add transactional `saveSummaryVectors(records[])` batch write to MemoryStore + both stores.
- [x] 10-02-PLAN.md — `memory status` `embeddingBackfill` completeness snapshot (live-queried, ground-truth).

**Wave 2** *(blocked on 10-01)*

- [x] 10-03-PLAN.md — `memory backfill-embeddings` command: missing-set-as-checkpoint resume, batch embed+save, per-batch stdout progress.

### Phase 11: Derivation Input Hygiene

**Goal**: Derivations are built from conversational content — consecutive tool-call runs collapse into compact activity descriptions and harness-injected scaffolding is excluded from summarization, embedding, trace discovery, and injection — while the canonical event timeline stays complete, immutable, and auditable.
**Depends on**: Phase 10 (backfill machinery and its resumable/checkpointed pattern are reused for retroactive rebuild)
**Requirements**: REQ-052, REQ-053, REQ-054
**Scope insert**: `.planning/phases/11-derivation-input-hygiene/11-SCOPE-INSERT.md` (evidence, design decisions, open questions)
**Success Criteria**:

  1. A contraction pass over a slice containing a run of consecutive tool calls produces exactly one derived activity line naming the distinct tools and their counts, containing no invocation arguments; a slice containing a single isolated tool call summarizes it in its existing form.
  2. Deterministic classification assigns every canonical event exactly one derivation class, is stable across repeated runs on identical input, and requires no model or network.
  3. Summaries built under the new rules contain no verbatim harness-injected content and no `[Tool call:` argument text from collapsed runs.
  4. Every event excluded from derivation remains retrievable through direct canonical-event queries and reports, through the audit surface, the specific rule ID and rule version that excluded it.
  5. Rebuilding derivations for the existing corpus is resumable and idempotent: interrupting and restarting produces the same result as an uninterrupted run, with no duplicated or orphaned summaries, vectors, or trace assignments.
  6. Measured against the live corpus, summary count and total summary text volume both fall materially, and no summary derived purely from a collapsed tool-call run survives as an independently recallable memory.
  7. Recall quality does not regress: a fixed set of known conversational queries returns the same or better summaries after hygiene than before.

**Plans:** 13/15 plans executed

Plans:
**Wave 1**

- [x] 11-01-PLAN.md — Shared pure classify/collapse module (`derivation-hygiene.ts`) + rule-table tests + sim rewired onto production code.

**Wave 2** *(blocked on Wave 1)*

- [x] 11-02-PLAN.md — Hygiene-aware `drainSlice`/`summaryForSpan`: label-input gating, per-span raw windows, provenance preserved, rule-version staleness gate, anchor gating.
- [x] 11-03-PLAN.md — Apply the same module to the live Hermes seam (`hermes/adapter.ts` + `pre-compactor.ts`).

**Wave 3** *(blocked on Wave 2)*

- [x] 11-04-PLAN.md — Audit surface: `explain` reports derivation class, rule id, and rule version, recomputed on demand.
- [x] 11-05-PLAN.md — `memory rebuild-derivations`: resumable, idempotent, checkpointed full rebuild with vector cleanup.

**Wave 4** *(blocked on Wave 3)*

- [x] 11-06-PLAN.md — CI-safe proportional-corpus count-AND-volume guard, blast-radius sweep (boxes/traces/retrieval), ADR 0048.

**Wave 5** *(blocked on Wave 4)*

- [x] 11-07-PLAN.md — Live-corpus measurement re-run + human rebuild/recall sign-off (SC5/SC6/SC7). **Found GAP-11-A: superseded summaries remain retrievable and injectable.**

**Wave 6** *(GAP-11-A closure, blocked on Wave 5)*

- [x] 11-08-PLAN.md — Central retrievable-state filter in `applyRetrievalBoundary` + GAP-11-A regression tests + deferred revival + ADR 0049.

**Wave 7** *(blocked on Wave 6)*

- [x] 11-09-PLAN.md — Sweep sibling candidate-selection paths (MCP read/search, subject expansion, vector search in both stores) + `11-RETRIEVAL-SWEEP.md`.

**Wave 8** *(blocked on Wave 7)*

- [x] 11-10-PLAN.md — Push person/scope/state filtering into `listSummaries`, schema migration 3 index, row-count and wall-clock acceptance at 20k summaries.

**Wave 9** *(blocked on Wave 8)*

- [x] 11-11-PLAN.md — `commitSupersededSummaryPrune` store contract with in-transaction eligibility and orphan prevention, in both store implementations.

**Wave 10** *(blocked on Wave 9)*

- [x] 11-12-PLAN.md — `memory prune-superseded`: dry-run default, fail-closed backup gate, resumable batches, ADR 0050.

**Wave 11** *(GAP-11-B closure, blocked on Wave 10)*

- [x] 11-15-PLAN.md — Fix the O(anchors x summaries) dedup hotspot: hoist per-summary normalization, cheap box/thread guards first, differential equivalence oracle + deterministic throughput benchmark.

**Wave 12** *(blocked on Wave 11)*

- [ ] 11-13-PLAN.md — Frozen recall query set + probe harness, before/after-filter/after-prune capture, owner-authorized live prune.

**Wave 13** *(blocked on Wave 12)*

- [ ] 11-14-PLAN.md — Owner SC7 semantic sign-off, `11-SC7-SIGNOFF.md`, GAP-11-A closure.

### Phase 12: Daemon Incremental Embedding

**Goal**: The daemon embeds every newly contracted summary automatically, per device, without recomputing embeddings for the existing corpus and without ever syncing embeddings across devices.
**Depends on**: Phase 10 (existing corpus already has vectors; incremental step only needs to handle new arrivals cleanly)
**Requirements**: REQ-043, REQ-045
**Success Criteria**:

  1. A newly contracted summary has a persisted vector embedding within one subsequent daemon tick, without recomputing vectors for the rest of the corpus.
  2. Per-tick embedding cost is bounded by the number of new summaries in that tick, not by total corpus size.
  3. Embeddings never appear in any sync payload or outbox operation — a freshly paired device recomputes its own vectors locally from replicated canonical events rather than receiving them from a peer.
  4. Each device's vectors record embedder provider/model/version, so a device running a stale model relative to its peers is detectable.

**Plans**: TBD

### Phase 13: Forward-Only Vector Trace Discovery

**Goal**: Recurring cross-session traces are discovered via nearest-neighbor similarity over summary embeddings, evaluated forward-only against new summaries so the full corpus is never rescanned or restaged after bootstrap, while the existing proposal/review contract is preserved exactly.
**Depends on**: Phase 12 (new summaries must already carry vectors by the time trace discovery runs), Phase 11 (candidate quality depends on hygienic derivation input)
**Requirements**: REQ-046, REQ-047, REQ-048
**Success Criteria**:

  1. New trace proposals are produced from nearest-neighbor-above-threshold similarity over summary embeddings, not the shared-term all-pairs candidate algorithm.
  2. A daemon trace-discovery cycle evaluates only summaries created/changed since the last successful pass against existing neighbors — it does not reload, rescan, or restage the entire person corpus to find new traces (closing the `createStagingStore` full-corpus-restage gap, not just replacing the candidate algorithm).
  3. Vector-derived trace proposals carry the identical `TraceCandidate`/`MemoryProposal` shape as before, flow through the unchanged review/accept/reject decision path, and include a human-readable rationale explaining why the summaries were linked.
  4. Running the trace-discovery step twice with exactly one new summary added between runs leaves every pre-existing trace assignment unchanged — no nightly churn, no collapse into an unbounded mega-trace.
  5. Trace-discovery cost per daemon cycle stays flat as new summaries arrive at growing corpus size, rather than growing with total corpus size.

**Plans**: TBD

### Phase 14: Semantic Recall

**Goal**: A user or agent can retrieve summaries by semantic meaning via a bounded vector top-K pre-filter, with every existing privacy boundary and traceability guarantee preserved exactly.
**Depends on**: Phase 10 (semantic recall is only meaningful once the existing corpus has vectors); benefits from Phase 13 shipping first but has no hard code dependency on it
**Requirements**: REQ-049
**Success Criteria**:

  1. A recall/search query returns summaries ranked by semantic similarity to the query's meaning, not solely by keyword overlap.
  2. Candidate selection for recall is a bounded vector top-K pre-filter, computed before `applyRetrievalBoundary`, rather than scoring every summary in the corpus on every call.
  3. All existing person/workspace/case/sensitivity retrieval boundaries are honored identically to the prior keyword-based path — a query never surfaces a summary outside the caller's authorized scope, verified with a cross-scope fixture.
  4. Every recalled summary still carries full source traceability (source summary IDs, turn ranges, box IDs) unchanged from the prior retrieval path.
  5. When no embedder is configured or an embedding is missing for a candidate, recall degrades gracefully to the existing keyword-overlap path with no errors.

**Plans**: TBD

### Phase 15: Deletion-Invalidation Closure + Operator Surface

**Goal**: Source deletion leaves no orphaned embeddings, and operators can see backfill completeness and model-version skew across devices.
**Depends on**: Phase 8 (tombstoning capability must exist in storage), Phase 10 (there must be embeddings worth invalidating to prove this works end to end)
**Requirements**: REQ-050
**Success Criteria**:

  1. Confirming a source deletion invalidates/tombstones the embeddings of every summary affected by that deletion in the same operation as the existing deletion cascade — no separate follow-up step required.
  2. A deleted or redacted summary's prior vector is unreachable via nearest-neighbor queries and semantic recall immediately after the deletion commits, verified by an extension of the existing source-deletion test suite.
  3. The operator surface (`memory health`/`memory tune`) reports embedding backfill completeness — how many summaries still lack a vector for the active (provider, model).
  4. The operator surface reports model-version skew — vectors present under a stale provider/model relative to the currently configured one — so a lagging device is visible rather than silent.

**Plans**: TBD

## Sequencing Principle

Lifecycle controls precede the daemon. The daemon precedes MCP. Remote synchronization cannot weaken local authority, auditability, deletion, or retrieval isolation.

**v1.1 sequencing**: Storage before anything reads/writes it (Phase 8). The embedding-model decision before backfill, since backfill's worker shape and determinism guarantees depend on which embedder runs (Phase 9). Backfill before daemon incremental embedding assumes a fully-embedded history (Phase 10 → 11). Daemon incremental embedding before forward-only trace discovery, which assumes new summaries already carry vectors (Phase 11 → 12). Trace discovery lands before semantic recall because it is the milestone's stated primary motivation, though the two are otherwise independent (Phase 12, 13). Deletion-invalidation closure depends on both the storage tombstoning capability and a populated corpus to prove against, and the operator surface reports on everything above it, so it lands last (Phase 14).
