# Phase 7: Onboarding and Operational Readiness - Context

**Gathered:** 2026-07-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Turn the existing architecture (host-neutral timeline, importers, source lifecycle controls, local daemon, MCP interface, zero-knowledge sync) into a product a single user can **install, inspect, and trust** — without weakening local authority, auditability, deletion, or retrieval isolation.

This phase adds **product surfaces** over already-built subsystems; it does not add new memory capabilities. Everything is local, deterministic, and privacy-first. This is the final roadmap phase.

**Note to planner:** This is a large phase spanning six decision areas (audit surface, unified CLI, guided onboarding, health/status, backup+migration, performance). Scope was deliberately kept broad by the owner — do NOT trim it. Instead consider splitting into sequenced waves/sub-phases (suggested grouping: (1) unified CLI + guided init/onboarding; (2) REQ-039 audit/explain + audit log; (3) operational surfaces: health, backup/export, migration, performance). Respect the roadmap sequencing principle: lifecycle → daemon → MCP; sync must not weaken local guarantees.
</domain>

<decisions>
## Implementation Decisions

### Audit / "Why" Surface (REQ-039)
- **D-01:** Deliver BOTH forms of inspection. (a) A per-item human-readable trace via a CLI `memory explain <id>` command that reconstructs why an item was imported, summarized, synchronized, retrieved, expanded, approved, rejected, or deleted; and (b) the same provenance exposed as a **read-only MCP tool** so an agent can ask "why" through the existing bounded read-tool + authority surface.
- **D-02:** ALSO provide a queryable / exportable **append-only audit log** (structured JSON) for bulk/forensic review — complementary to the per-item explain, not a replacement.
- **D-03:** The explain trace and audit log read from existing provenance/audit data already persisted in the stores; this phase surfaces it, it does not re-instrument the pipeline. Must cover every lifecycle verb named in REQ-039.

### Install & Entry Surface
- **D-04:** Introduce a unified `bin` CLI — a single `memory` executable with subcommands (`memory import`, `memory daemon`, `memory status`, `memory explain`, `memory init`, `memory backup`, …) that WRAP the existing command modules. The ~30 `memory:*` npm scripts remain as thin aliases; no reimplementation of command logic.

### First-Run Consent / Onboarding
- **D-05:** Ship a guided interactive `memory init`: discover available agent histories → show the user what was found → **explicit per-source consent** → bootstrap → offer to start the daemon. Consent is front-and-center (reinforces the "trust" goal); it drives the existing per-source grant/approval path rather than bypassing it.

### Operational Scope (all four surfaces IN scope)
- **D-06:** Health/status inspection — extend the existing status command into a health surface: daemon state, DB size, last import, sync lag, pending proposals. Core to "inspect".
- **D-07:** Backup / export — default `memory backup` produces an **encrypted** backup (portable, safe to store anywhere) with restore; a separate, clearly-labeled `memory export --plaintext` provides a user-controlled plaintext escape hatch for migrating into another tool. Encryption must not weaken the zero-knowledge boundary (see ADR 0047).
- **D-08:** Schema migration — provide a versioned migration path for the SQLite schema so memory survives across releases.
- **D-09:** Performance — reporting AND tuning. Surface query/retrieval latency, DB size, and index health (fold reporting into the health surface, D-06), plus user-adjustable knobs (e.g., cache sizes, retention/contraction thresholds, index rebuild).

### Claude's Discretion
- Exact CLI framework / argument-parsing approach, subcommand naming conventions, and how npm scripts alias into the bin (planner + researcher decide).
- Backup encryption scheme details — must reuse the project's existing crypto primitives (libsodium, per ADR 0047) rather than introduce new ones; exact key handling is a research/planning decision but must not require an external service.
- Audit-log storage location/format specifics and explain-trace rendering format.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & Roadmap
- `.planning/ROADMAP.md` §"Phase 7: Onboarding and Operational Readiness" — goal and sequencing principle (lifecycle → daemon → MCP; sync must not weaken local guarantees).
- `.planning/REQUIREMENTS.md` — **REQ-039 (Auditability)** is the named requirement for this phase; **REQ-040 (No mandatory external model)** constrains backup/performance/onboarding to stay deterministic and local (no external LLM dependency).
- `.planning/PROJECT.md` — product boundaries (histories read-only; content only after grant; memory is assistive, never authority; person/workspace/scope isolation).

### Zero-knowledge / crypto constraints (backup encryption)
- `docs/adr/0047-zero-knowledge-sync-threat-model-and-protocol.md` — the encryption boundary and primitives (libsodium) that an encrypted backup MUST honor; a backup or export must not create a weaker plaintext leak than the sync design forbids.

### Prior lifecycle/deletion/scope ADRs (audit surface must reflect these)
- `docs/adr/0044-source-revocation-and-attributable-deletion.md` — revoke/delete semantics the `explain` surface must faithfully report.
- `docs/adr/0046-person-and-retrieval-scope-boundaries.md` — scope boundaries that constrain what audit/explain may reveal.
- `docs/adr/0040-personal-canonical-timeline.md` — provenance model the explain trace reconstructs.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/bootstrap/status-command.ts` — extend into the health/status surface (D-06); already aggregates status.
- `src/imports/*-command.ts` (history/codex discover + import, `source-revoke-command.ts`, `source-delete-command.ts`, `quarantine-command.ts`) — orchestrated by guided `memory init` (D-05) and wrapped by the unified CLI (D-04).
- `src/daemon/daemon-command.ts`, `src/daemon/daemon.ts` — `init` offers to start the daemon; health surface reports daemon state.
- `src/mcp/tools/read-tools.ts`, `src/mcp/tool-catalog.ts`, `src/mcp/authority.ts` — pattern to add the read-only "explain"/audit MCP tool (D-01) through the existing bounded, authority-gated read surface.
- Provenance/audit data in `src/storage/{in-memory-store,sqlite-store,memory-store}.ts`, `src/retrieval/subject-expansion-service.ts`, `src/retrieval/memory-query-service.ts` — source data for explain traces and the audit log (D-01, D-02).
- `src/sync/crypto/libsodium-crypto-provider.ts` — reuse for encrypted backup (D-07); do not introduce new crypto.

### Established Patterns
- Command modules are individual `*-command.ts` files invoked via `memory:*` npm scripts — the unified `bin` CLI wraps these, keeping logic in place.
- MCP surface is bounded read tools + confirmation-gated mutations under an authority check — the audit MCP tool follows the read-tool pattern (no new mutation authority).
- SQLite store is the durability anchor — schema migration (D-08) attaches here.

### Integration Points
- New `bin` entry in `package.json` (currently empty) → dispatches to existing command modules.
- Health surface composes daemon status + store metrics + sync status (from Phase 6 `sync-status`).
- Backup/export reads the SQLite store and encrypts via the existing libsodium provider.
</code_context>

<specifics>
## Specific Ideas

- Backup is a trust decision: encrypted-by-default with an explicit, clearly-labeled plaintext export escape hatch — never plaintext-by-default (owner was explicit here).
- Consent must be visible and per-source during onboarding, not buried — it reinforces the "trust" half of the phase goal.
- Performance work is bounded to reporting + a defined set of tuning knobs, not open-ended optimization.
</specifics>

<deferred>
## Deferred Ideas

None — the owner deliberately kept all six surfaces in scope for this final phase. If the planner finds the combined scope exceeds a single phase's context budget, the recommended response is to SPLIT into sequenced sub-phases/waves (see the planner note in Phase Boundary), not to defer capabilities to a non-existent future phase (this is the last roadmap phase).
</deferred>

---

*Phase: 7-onboarding-and-operational-readiness*
*Context gathered: 2026-07-20*
