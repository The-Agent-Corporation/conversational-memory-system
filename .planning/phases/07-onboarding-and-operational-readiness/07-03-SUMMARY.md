---
phase: 07-onboarding-and-operational-readiness
plan: 03
subsystem: audit
tags: [zod, mcp, sqlite, audit-log, provenance, req-039]

# Dependency graph
requires:
  - phase: 07-onboarding-and-operational-readiness
    provides: "07-01/07-02 unified CLI dispatcher (src/cli/bin.ts, command-registry.ts) that this plan registers explain/audit-log into"
provides:
  - "src/audit/explain-service.ts: pure explain(store, itemId, authority, options) reconstructing all 8 REQ-039 lifecycle verbs from existing provenance/audit rows"
  - "src/audit/explain-command.ts: `memory explain --db --person --id [--all-scopes=true]` CLI"
  - "src/audit/audit-log-command.ts: `memory audit-log --db --person [--action --candidate --from --to]` exportable metadata-only audit export"
  - "memory_explain: 7th read-only MCP tool, authority-gated identically to the other 6"
affects: [mcp-tool-catalog, cli-dispatcher, req-039-verification]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Authority-bound service class (ExplainService) mirroring MemoryQueryService/ScopedProposalReviewer constructor shape for DI parity into MemoryReadToolApplication"
    - "sanitizeAuditDetail shared between explain-service.ts and audit-log-command.ts: strips audit `details` JsonObject down to bounded scalar-only metadata (ADR 0044 no-content-leak)"

key-files:
  created:
    - src/audit/explain-service.ts
    - src/audit/explain-command.ts
    - src/audit/audit-log-command.ts
    - tests/audit/explain-service.test.ts
    - tests/audit/explain-command.test.ts
    - tests/audit/audit-log-command.test.ts
  modified:
    - src/mcp/tools/read-tools.ts
    - src/mcp/tool-catalog.ts
    - src/mcp/server.ts
    - src/cli/command-registry.ts
    - tests/mcp/tool-catalog.test.ts
    - tests/mcp/read-tools.test.ts

key-decisions:
  - "itemId is polymorphic: memory-item ids (summary/anchor/box/trace) resolve via the four durable-memory tables; source-level ids (candidateId) resolve via SourceLifecycleService.grantId hash against source_grants — both paths funnel into the SAME UNAUTHORIZED_OR_NOT_FOUND error on scope-denial or not-found."
  - "Verb-to-evidence mapping: imported=source_lifecycle_audit 'approved'; deleted=source_lifecycle_audit 'deletion_completed'; approved/rejected=MemoryProposal.state targeting the item; summarized=Summary.createdAt provenance; synchronized=sync_outbox row whose targetId matches; retrieved/expanded=structural authorized-presence facts (no historical retrieval log exists to surface, so these are computed from current scope-authorized state, consistent with D-03 'surface, do not re-instrument')."
  - "CLI runs with local-owner ProfileAuthority (allowedScopeIds=[] by default); --all-scopes=true bypasses the scope filter for the owner. The MCP tool never sets allScopes — it always uses the caller's already-bound profile authority, exactly like every other read tool."

patterns-established:
  - "Explain/audit-log detail sanitization (sanitizeAuditDetail): the single chokepoint that guarantees no verbatim message content ever reaches an explain trace or audit-log export."

requirements-completed: [REQ-039, REQ-040]

# Metrics
duration: 55min
completed: 2026-07-20
---

# Phase 7 Plan 3: REQ-039 Audit/Explain Surface Summary

**`memory explain <id>` CLI + 7th read-only `memory_explain` MCP tool + exportable append-only `memory audit-log`, all reading existing provenance/audit rows with zero new instrumentation.**

## Performance

- **Duration:** 55 min
- **Tasks:** 3
- **Files modified/created:** 12

## Accomplishments
- `explain(store, itemId, authority, options)` reconstructs all 8 REQ-039 lifecycle verbs (imported, summarized, synchronized, retrieved, expanded, approved, rejected, deleted) purely by reading `source_lifecycle_audit`, `MemoryProposal` review state, summary/box/trace provenance, and `sync_outbox` rows — no new write paths anywhere in the pipeline.
- Scope-denied and nonexistent ids are byte-identical `UNAUTHORIZED_OR_NOT_FOUND` failures (asserted directly in tests/audit/explain-service.test.ts and via the MCP tool in tests/mcp/read-tools.test.ts) — explain is never a scope-existence oracle (ADR 0046).
- `memory_explain` registered as the 7th read-only MCP tool, routed through the same `safeRead`/`ProfileAuthority`-bound path as the other 6; `MEMORY_READ_TOOL_NAMES` and every hardcoded tool-count assertion (tool-catalog.test.ts 16→17/6→7, read-tools.test.ts name list, stdio-server.test.ts derived union) updated in the same wave.
- `memory audit-log` exports a filterable (action/candidate/time-range), append-only, metadata-only JSON audit log built on the same `source_lifecycle_audit` rows explain reads — every entry field is a bounded scalar; `sanitizeAuditDetail` is the shared chokepoint that strips any non-scalar `details` payload down to bounded metadata, shared by both explain-service and audit-log-command so there is exactly one place that can leak content.

## Task Commits

Each task was committed atomically:

1. **Task 1: Wave 0 — failing explain/audit-log tests + update tool-count contracts** - `a2f44bf` (test)
2. **Task 2: explain-service + explain CLI + memory_explain MCP tool** - `2565eaa` (feat)
3. **Task 3: Exportable append-only audit log (metadata-only)** - `45bb2a2` (feat)

**Plan metadata:** (this commit, docs: complete plan)

_Note: this plan's tasks are `type="auto"` (not `tdd="true"`), so RED/GREEN gate enforcement does not apply; Task 1's tests were nonetheless written and verified failing before Tasks 2/3 landed the implementation._

## Files Created/Modified
- `src/audit/explain-service.ts` - Pure, authority-gated `explain()` + `ExplainService` class; reconstructs all 8 verbs from existing rows; `sanitizeAuditDetail` shared sanitizer.
- `src/audit/explain-command.ts` - `memory explain` CLI wrapper (owner authority, `--all-scopes` override).
- `src/audit/audit-log-command.ts` - `memory audit-log` CLI: filterable metadata-only export.
- `src/mcp/tools/read-tools.ts` - `memory_explain` tool registration (7th read tool), `MemoryExplainInputSchema`/`MemoryExplainOutputSchema`, `MemoryExplainReader` interface on `MemoryReadToolApplication`.
- `src/mcp/tool-catalog.ts` - Updated catalog-size comment (16→17 tools).
- `src/mcp/server.ts` - Wires `ExplainService(readStore, authority)` into the live MCP application.
- `src/cli/command-registry.ts` - Registers `explain` and `audit-log` subcommands.
- `tests/mcp/tool-catalog.test.ts`, `tests/mcp/read-tools.test.ts` - Tool-count/name-list contracts updated to 17/7; new `memory_explain` routing + no-oracle test.
- `tests/audit/explain-service.test.ts`, `tests/audit/explain-command.test.ts`, `tests/audit/audit-log-command.test.ts` - New coverage (24 test cases total across the three files, one block per REQ-039 verb plus the scope-oracle and no-content-leak assertions).

## Decisions Made
- itemId resolution is polymorphic across memory items (summary/anchor/box/trace) and source-level candidateIds, unified behind one `UNAUTHORIZED_OR_NOT_FOUND` failure mode for both scope-denial and not-found — see `key-decisions` in frontmatter for the full verb→evidence mapping and CLI-vs-MCP authority distinction.
- No new database tables or columns were added; every verb is surfaced from rows other services already write (source_lifecycle_audit, MemoryProposal, Summary/Box/Trace, sync_outbox), matching D-03's "surface, do not re-instrument" constraint exactly.

## Deviations from Plan

None — plan executed exactly as written. The "one assertion block per REQ-039 verb" acceptance criterion is satisfied with 9 tests in explain-service.test.ts (one per verb plus the scope-oracle case), 2 in explain-command.test.ts, and 4 in audit-log-command.test.ts (base export plus three filter variants).

## Issues Encountered
None. `npm run typecheck` and the full `npm test` suite (700 tests, 84 files) pass with no regressions.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- REQ-039 (Auditability) is fully satisfied: CLI + MCP + exportable audit log, all authority-gated.
- The read-tool catalog is now stably at 7 tools (17 total with mutations) with every count assertion updated — no future plan should need to touch these contracts unless intentionally adding another tool.
- No blockers for downstream Phase 7 plans (health/status, backup/export, migration, tuning) — this plan touched no shared infrastructure beyond the already-existing command-registry.ts and read-tools.ts extension points those plans also use.

---
*Phase: 07-onboarding-and-operational-readiness*
*Completed: 2026-07-20*

## Self-Check: PASSED

All created files verified present on disk; all task commit hashes (a2f44bf, 2565eaa, 45bb2a2) and the plan-metadata commit (702c776) verified present in git history.
