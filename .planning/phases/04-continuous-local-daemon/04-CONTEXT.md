# Phase 4: Continuous Local Daemon - Context

**Gathered:** 2026-07-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver a local background daemon that continuously rescans durably approved Codex, Claude Code, OpenClaw, and Hermes sources, imports new canonical events idempotently, and incrementally contracts only affected timeline ranges while offline. This phase includes a portable daemon core, macOS LaunchAgent integration, lifecycle controls, health reporting, crash recovery, and bounded background resource use. It does not add the Phase 5 MCP surface, cross-platform service installers, multi-device synchronization, or onboarding UI.

</domain>

<decisions>
## Implementation Decisions

### Process lifecycle
- **D-01:** The daemon auto-starts at login only after explicit user enablement. A foreground `run` path remains available for debugging and supervision.
- **D-02:** Phase 4 ships a portable daemon core plus macOS LaunchAgent integration. Windows and Linux service adapters are outside this phase.
- **D-03:** One daemon owns one memory database and acts as its single background writer. It schedules people independently if a database contains more than one person; the normal installation is expected to contain one person.
- **D-04:** Provide explicit `run`, `start`, `stop`, `restart`, `status`, and `once` controls. Status includes process identity, heartbeat, and last successful scan; stop is graceful.

### Scan timing and scheduling
- **D-05:** Filesystem watchers accelerate synchronization, but periodic incremental rescans remain the correctness mechanism. Watcher signals should make new history visible within seconds, and every approved source is rescanned at least once per minute under normal power conditions.
- **D-06:** Coalesce watcher changes for about two seconds and schedule one incremental scan per burst instead of scanning on every filesystem event.
- **D-07:** On battery, watcher-triggered work remains immediate while the safety-rescan cadence relaxes from one minute to five minutes. Restore the normal cadence when external power returns.
- **D-08:** Use a fair single-writer work queue. Watcher-triggered sources receive prompt priority, but round-robin fairness prevents a continuously busy source from starving others.

### Failure containment and recovery
- **D-09:** A source failure is isolated. Other approved sources continue synchronizing while the failed source retries with bounded exponential backoff and returns to its normal cadence after success.
- **D-10:** Persist privacy-safe structured diagnostics containing source identity, error category, attempt count, and timestamps without conversation content. Mark a source degraded after three consecutive failures or fifteen minutes and send one macOS notification rather than notifying on every failure.
- **D-11:** Import and contraction are separate durable stages. Advance each checkpoint only after its writes commit; after a crash or forced shutdown, replay the earliest incomplete stage idempotently.
- **D-12:** Revalidate the durable source grant before source access and at each stage boundary. Revocation aborts before additional writes commit. Rotation or temporary absence resumes from durable source identity, and incomplete records leave the import checkpoint before the partial record. Source deletion remains a separate exact-confirmation action.

### Incremental contraction
- **D-13:** After each committed import batch, enqueue only its new canonical event range for asynchronous contraction. Source scanning must not wait for summarization or proposal generation.
- **D-14:** When a newly discovered event belongs earlier in canonical time, perform a bounded rewind from the earliest affected topic span. Supersede only downstream derived objects that changed; do not append it out of order or rebuild unaffected earlier history.
- **D-15:** Contraction runs in configurable interactive-friendly slices, defaulting to about two seconds or 250 events before yielding. Resume from a durable checkpoint.
- **D-16:** Use a two-tier derivation policy. Topics, summaries, and anchors update immediately. Box and trace proposal generation runs after ten minutes of quiet or at least hourly, and proposals are never auto-approved.

### the agent's Discretion
- Exact module and class boundaries, SQLite schema names, LaunchAgent label and plist location, CLI output schema, PID/lease representation, maximum backoff cap, jitter strategy, macOS power-state API, and notification adapter.
- Exact test decomposition and synthetic fixture shapes, provided tests never open real personal history.
- Exact fairness weights and queue data structures, provided D-08's starvation and prompt-wakeup guarantees are verifiable.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product and phase scope
- `.planning/PROJECT.md` — Product vision and local-first privacy boundaries.
- `.planning/REQUIREMENTS.md` — REQ-017 through REQ-022 define continuous local operation and incremental contraction.
- `.planning/ROADMAP.md` — Phase 4 boundary and ordering before MCP and synchronization work.
- `.planning/phases/03-source-lifecycle-control-plane/03-CONTEXT.md` — Locked approval, revocation, deletion, quarantine, tool-call, and retrieval-isolation decisions inherited by the daemon.

### Import and contraction contracts
- `docs/adr/0042-resumable-historical-bootstrap.md` — Person-level ordering, compatibility turns, incremental checkpoints, deterministic contraction, and review-only proposals.
- `docs/adr/0043-multi-source-history-importers.md` — Source-specific discovery/import contracts, read-only native stores, deterministic checkpoints, exclusions, and parser behavior.
- `docs/adr/0045-bounded-parser-quarantine-and-replay.md` — Bounded redacted quarantine and confirmed replay through ordinary importer paths.

### Authorization and isolation
- `docs/adr/0044-source-revocation-and-attributable-deletion.md` — Durable source grants, immediate revocation semantics, attributable deletion, audit state, and anti-reimport behavior.
- `docs/adr/0046-person-and-retrieval-scope-boundaries.md` — Person ownership, immutable source scope, and fail-closed derived-memory dependencies.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/imports/history-import-command.ts` and `src/imports/codex-import-command.ts`: Existing discovery-to-approved-import orchestration that daemon source runners can call or refactor behind a common service boundary.
- `src/service/source-lifecycle-service.ts`: Durable grant assertion, revocation, deletion, quarantine replay, and audit behaviors that every daemon stage must honor.
- `src/bootstrap/historical-bootstrapper.ts`: Existing deterministic topic, summary, anchor, box-proposal, and trace-proposal pipeline with resumable person-level checkpoints.
- `src/bootstrap/status-command.ts`: Existing read-only operational snapshot that can be extended with daemon health without creating a separate authority.
- `src/storage/memory-store.ts` with `src/storage/sqlite-store.ts`: Current storage boundary and SQLite authority for checkpoints, grants, canonical events, and derived objects.

### Established Patterns
- Importers checkpoint only complete records and use deterministic canonical identities, so repeated scans are already designed to be idempotent.
- Historical bootstrap currently treats any changed processed prefix as a full reset; D-14 requires replacing that broad fallback with a bounded affected-range rewind for continuous operation.
- Source deletion invalidates the person bootstrap checkpoint and supersedes affected derived objects; daemon recovery must tolerate this without reintroducing revoked content.
- Deterministic summarization is the offline default. External model adapters remain optional and cannot be required for daemon correctness.

### Integration Points
- Add daemon orchestration beside `src/bootstrap/` and `src/imports/`, keeping operating-system service integration outside host-neutral domain and storage modules.
- Extend `package.json` with daemon lifecycle commands while preserving existing explicit discovery/import/bootstrap/status commands.
- Extend status/storage contracts with durable daemon lease, heartbeat, stage checkpoints, per-source health, and queued contraction state.
- Verify with synthetic append, burst, partial-write, rotation, revocation, deletion, late-event, restart, battery-policy, and source-starvation scenarios.

</code_context>

<specifics>
## Specific Ideas

- Normal powered operation: watcher wakeups plus a one-minute safety rescan.
- Battery operation: watcher wakeups remain immediate; safety rescans run every five minutes.
- Watcher burst window: approximately two seconds.
- Degraded-source threshold: three failures or fifteen minutes, followed by one notification.
- Default contraction slice: approximately two seconds or 250 events.
- Higher-level proposal cadence: after ten minutes of quiet or at least hourly.

</specifics>

<deferred>
## Deferred Ideas

- Windows and Linux background-service adapters belong to a later packaging/readiness phase.
- Generic MCP access remains Phase 5.
- Zero-knowledge multi-device synchronization remains Phase 6.
- First-run onboarding UI and broader operational packaging remain Phase 7.

</deferred>

---

*Phase: 4-continuous-local-daemon*
*Context gathered: 2026-07-17*
