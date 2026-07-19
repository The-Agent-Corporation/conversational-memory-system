---
phase: 05-generic-mcp-interface
plan: "09"
subsystem: mcp
tags: [mcp, authorization, proposals, sqlite, atomicity, confirmation]

requires:
  - phase: 05-generic-mcp-interface
    provides: Profile-bound proposal review, exact confirmation tickets, and task-specific atomic proposal commits from Plans 05-04, 05-05, and 05-08
provides:
  - Payload-first recursive proposal authorization over Summary, Box, and Trace dependencies
  - Exact startup-scope and present-or-absent affected-object snapshots in proposal commit plans
  - Backend-equivalent pre-write drift rejection with zero effects and consumed confirmation
affects: [phase-05-verification, phase-06-sync, phase-07-onboarding, local-agent-integrations]

tech-stack:
  added: []
  patterns: [payload-first authorization, cycle-safe dependency closure, exact absence snapshots, shared pure transactional validator]

key-files:
  created: []
  modified:
    - src/proposals/scoped-proposal-reviewer.ts
    - src/storage/mcp-mutation-contracts.ts
    - src/storage/in-memory-store.ts
    - src/storage/sqlite-store.ts
    - tests/mcp/mutation-tools.test.ts
    - .planning/phases/05-generic-mcp-interface/05-VALIDATION.md

key-decisions:
  - "Authorize the union of declared proposal references, parsed payload references, recursive Summary sources, Box relationships, Trace dependencies, and next effects before constructing a decision plan."
  - "Bind normalized startup scopes, exact Summary records, and exact present-or-absent Box and Trace states inside the process-local confirmed plan."
  - "Use one pure proposal-state validator in both adapters after stage lookup or BEGIN IMMEDIATE and before the first write."

patterns-established:
  - "Proposal closure: deterministic sorted fixpoint across Summary source edges, Box parent/child/summary edges, and Trace box/summary edges."
  - "TOCTOU rejection: any proposal, dependency, or affected-state difference returns content-free STATE_CHANGED with empty counts before a fault/write seam."

requirements-completed: [REQ-023, REQ-025, REQ-027, REQ-028, REQ-029]

coverage:
  - id: D1
    description: Payload-only unauthorized Summary and Box dependencies fail closed before proposal DTO or effect construction.
    requirement: REQ-028
    verification:
      - kind: adversarial
        ref: "tests/mcp/mutation-tools.test.ts#05-09 Task 1"
        status: pass
    human_judgment: false
  - id: D2
    description: Exact recursive dependency and present-or-absent affected-object snapshots are bound to proposal decisions.
    requirement: REQ-028
    verification:
      - kind: contract
        ref: "tests/mcp/mutation-tools.test.ts#05-09 Task 1"
        status: pass
    human_judgment: false
  - id: D3
    description: In-memory and SQLite commits reject Summary, Box, Trace, and absent-target drift with no additional writes.
    requirement: REQ-028
    verification:
      - kind: integration
        ref: "tests/mcp/mutation-tools.test.ts#05-09 Task 2"
        status: pass
    human_judgment: false
  - id: D4
    description: Single-use confirmation, exact sixteen-tool STDIO catalog, pure reads, provenance, and disclosure remain unchanged.
    requirement: REQ-029
    verification:
      - kind: regression
        ref: "tests/mcp/confirmation-service.test.ts, tests/mcp/tool-catalog.test.ts, tests/mcp/stdio-server.test.ts"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-07-19
status: complete
---

# Phase 5 Plan 9: Proposal Closure and Atomic Revalidation Summary

**Proposal decisions now authorize the complete stored-payload dependency closure and atomically reject stale Summary, Box, or Trace state in both storage adapters before any write**

## Performance

- **Duration:** 15 min
- **Started:** 2026-07-19T02:04:34Z
- **Completed:** 2026-07-19T02:19:34Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Parsed type-specific proposal payloads before listing or decision formatting and authorized the union of declared, payload-only, recursive Summary, Box parent/child, and Trace-to-Box dependencies under the fixed profile person and complete allowed-scope list.
- Added deterministic exact closure schemas carrying normalized scopes, complete Summary records, and `{id,value}` Box/Trace states where `null` binds an expected absence.
- Enforced contract ownership, active/non-superseded allowed-scope summaries, recursive closure completeness, deterministic uniqueness, required dependency presence, affected-target coverage, effect fingerprints, and receipt bindings.
- Re-read and compared the complete proposal closure inside in-memory stage-before-swap and SQLite `BEGIN IMMEDIATE` paths before the first proposal write/fault seam.
- Added synthetic adapter-matrix proof for scope/state/recursive Summary drift, parent/child Box drift, existing Trace drift, absent-target insertion, clean SQLite-reopen parity, rollback seams, and confirmation replay rejection.
- Preserved the six-read/ten-mutation MCP surface, semantic read purity, disclosure/provenance behavior, and local STDIO lifecycle.

## Task Commits

1. **Task 1 RED: failing payload and closure contracts** — normal commit attempt failed because `.git/index.lock` creation was denied.
2. **Task 1 GREEN: complete payload authorization and exact snapshots** — normal commit attempt failed for the same index-lock restriction.
3. **Task 2 RED: failing adapter drift and confirmation matrix** — normal commit attempt failed for the same index-lock restriction.
4. **Task 2 GREEN: atomic backend revalidation and validation ownership** — normal commit attempt failed for the same index-lock restriction.

Every required commit was attempted exactly once at its boundary. No hook bypass, retry, force-stage, stash, reset, clean, or Git-metadata workaround was used.

## Files Created/Modified

- `src/proposals/scoped-proposal-reviewer.ts` — payload-first cycle-safe authorization and exact decision snapshot capture.
- `src/storage/mcp-mutation-contracts.ts` — named closure/state schemas plus the shared pure authorization and current-state validator.
- `src/storage/in-memory-store.ts` — full snapshot comparison before stage creation and swaps.
- `src/storage/sqlite-store.ts` — full snapshot comparison after `BEGIN IMMEDIATE` and before the first write.
- `tests/mcp/mutation-tools.test.ts` — synthetic payload bypass, closure contract, drift matrix, parity, rollback, and replay proofs.
- `.planning/phases/05-generic-mcp-interface/05-VALIDATION.md` — REQ-028 ownership extended to Plan 05-09; pre-existing green signoff changes outside that row were preserved.

## Decisions Made

- Declared proposal references and stored payload references are not required to match. Their authorized union, including recursively reached dependencies and affected target state, is the security boundary.
- A missing target is security-relevant state, so every new Box or Trace is bound as an explicit `null` lookup snapshot and becomes stale if created before execute.
- Storage does not load a live profile or transport authority. The process-local plan carries normalized startup scopes, and both adapters rerun one shared pure validator against transaction-current records.
- Drift is a content-free normal result: `STATE_CHANGED`, empty effect counts, no write seam reached, and the already-consumed confirmation cannot be replayed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Rechecked a Box that becomes required after an earlier optional visit**
- **Found during:** Final Task 2 diff review.
- **Issue:** A Box ID first visited as an optional absent declared target could later become mandatory through an existing Trace edge; the cycle guard returned early without rechecking required presence.
- **Fix:** On revisiting an already-seen Box, both the reviewer and shared contract validator now fail closed when the Box has become required but remains absent.
- **Files modified:** `src/proposals/scoped-proposal-reviewer.ts`, `src/storage/mcp-mutation-contracts.ts`.
- **Verification:** Focused proposal/storage suite (31 tests), typecheck, and diff hygiene pass.
- **Commit:** Unavailable because the required normal commit attempt was denied by `.git/index.lock`.

---

**Total deviations:** 1 auto-fixed bug.
**Impact on plan:** The fix strengthens the planned cycle-safe closure and prevents a required dependency from being mistaken for an allowed absent target.

## Issues Encountered

- Each Task 1/Task 2 RED and GREEN commit made one normal attempt and received `fatal: Unable to create '/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/.git/index.lock': Operation not permitted`. Verified changes remain intact and unstaged. No retry or workaround was used.
- The checkout was substantially dirty before execution. Existing unrelated changes, untracked planning/source trees, and prior Phase 5 validation signoff edits were preserved.

## TDD Gate Compliance

- Task 1 RED failed on the missing closure fields, then the GREEN implementation passed all three focused proposal payload/closure contracts.
- Task 2 RED returned `COMMITTED` for deliberate dependency drift, then the GREEN implementation passed the full drift/replay/parity matrix.
- Functional RED/GREEN evidence is complete, but no 05-09 Git commits exist because all single required commit attempts were denied by the environment.

## Known Stubs

None — no Plan 05-09 TODO, FIXME, placeholder production path, empty UI-bound value, or mock production dependency remains.

## Verification

- `npx vitest run tests/mcp/mutation-tools.test.ts tests/storage/sqlite-store.test.ts` — PASS; 31 tests.
- `npx vitest run tests/mcp/confirmation-service.test.ts tests/mcp/tool-catalog.test.ts tests/mcp/stdio-server.test.ts` — PASS; 24 tests.
- `npx vitest run tests/mcp` — PASS; 7 files, 73 tests.
- `npm test` — PASS; 56 files, 385 tests.
- `npm run typecheck` — PASS.
- `node scripts/verify-phase-05-signoff.mjs --self-test` — PASS.
- MCP JSON report plus `--vitest-json` structural gate — PASS; 73 passed, zero failed/pending/todo.
- `node scripts/verify-phase-05-signoff.mjs --validation .../05-VALIDATION.md` — PASS; exactly five green rows.
- `npm run hermes:smoke` — PASS with temporary synthetic SQLite state.
- `git diff --check` — PASS.

## Privacy and Workspace-Isolation Review

- Only source code, planning artifacts, ADRs, and temporary synthetic in-memory/SQLite fixtures were inspected. No real Codex, Claude Code, OpenClaw, Hermes, client, case, legal, or other personal history was opened or imported.
- Every reached Summary must belong to the startup-fixed person, must not be superseded, and must contain only scopes from the fixed complete allow-list. Every reached Box/Trace must belong to the same person.
- Dependency records and allowed scopes remain process-local inside confirmation binding and are not exposed through MCP inputs or responses.
- Confirmation remains server-enforced and single-use. Native source histories remain read-only, external models remain optional, and the sixteen-tool STDIO surface is unchanged.

## Threat Flags

None — the proposal payload, confirmation, and storage transaction surfaces are exactly the planned T-05-09-SCOPE, T-05-09-TOCTOU, T-05-09-ROLLBACK, and T-05-09-CONFIRM boundaries. No unplanned network endpoint, authentication path, file discovery, schema migration, or package surface was introduced.

## User Setup Required

None.

## Next Phase Readiness

- The Phase 5 verifier reproduction now fails closed, the REQ-028 structural owner includes 05-09, and all automated signoff gates are green.
- Phase 5 can be re-verified from a Git-writable environment without changing the implementation.
- The intact 05-09 production, test, validation, summary, and state files still require normal Git commits because this environment cannot create `.git/index.lock`.

## Self-Check: PASSED

- All five planned production/test files, the scoped validation artifact, and this summary exist.
- All acceptance criteria and plan-level verification commands pass, including synthetic adversarial, adapter parity, full MCP, full repository, typecheck, signoff, Hermes smoke, and diff hygiene checks.
- No 05-09 task commit exists; the documented single-attempt `.git/index.lock` restriction accounts for the unavailable commit hashes without hiding or discarding any verified file.

---
*Phase: 05-generic-mcp-interface*
*Completed: 2026-07-19*
