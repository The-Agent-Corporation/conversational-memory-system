---
phase: 05-generic-mcp-interface
plan: "07"
subsystem: mcp
tags: [mcp, mutations, confirmation, authorization, zod, atomicity]

requires:
  - phase: 05-generic-mcp-interface
    provides: Exact confirmation tickets and task-specific atomic mutation applications from 05-05
  - phase: 05-generic-mcp-interface
    provides: Shared dual response envelopes and SDK registration conventions from 05-06
provides:
  - Ten explicit fixed-purpose MCP mutation schemas as five preview/execute pairs
  - One-method handler routing for configured history ingestion, proposal approval/rejection, source revocation, and attributable deletion
  - Controlled preview effect counts, atomic receipts, stable sanitized errors, and conservative annotations
affects: [05-08, mcp-tool-catalog, stdio-server]

tech-stack:
  added: []
  patterns: [fixed-purpose mutation tools, exact preview-execute binding, one application call per handler, controlled dual envelopes]

key-files:
  created:
    - src/mcp/tools/mutation-tools.ts
  modified:
    - tests/mcp/mutation-tools.test.ts
    - tests/mcp/tool-catalog.test.ts

key-decisions:
  - "Keep proposal approval and rejection as separate named preview/execute pairs with no action discriminator."
  - "Expose only bounded effect counts and content-free receipt fields at the MCP boundary while retaining exact effect identifiers inside the application confirmation binding."
  - "Treat every preview as mutating server state and every execute as non-idempotent; mark only durable decision, revocation, and deletion executes destructive."

requirements-completed: [REQ-028, REQ-029]

coverage:
  - id: D1
    description: Ten strict schemas omit authority, arbitrary paths, and action discriminators while requiring exact execute parameters plus a confirmation token.
    requirement: REQ-029
    verification:
      - kind: unit
        ref: "tests/mcp/tool-catalog.test.ts#05-07 Task 1"
        status: pass
    human_judgment: false
  - id: D2
    description: Every preview and execute tool routes through exactly one established mutation application method and returns equivalent structured/text output.
    requirement: REQ-028
    verification:
      - kind: integration
        ref: "tests/mcp/mutation-tools.test.ts#05-07 Task 2"
        status: pass
    human_judgment: false
  - id: D3
    description: Confirmation remains server-enforced and catalog annotations conservatively describe ticket issuance and durable effects.
    requirement: REQ-029
    verification:
      - kind: integration
        ref: "npx vitest run tests/mcp/mutation-tools.test.ts tests/mcp/tool-catalog.test.ts"
        status: pass
    human_judgment: false

duration: 7min
completed: 2026-07-19
status: complete
---

# Phase 5 Plan 7: Explicit Confirmed MCP Mutations Summary

**Ten fixed-purpose MCP mutation tools now expose bounded preview tickets and exact-confirm atomic executes through one established application method per handler**

## Performance

- **Duration:** 7 min
- **Started:** 2026-07-19T00:09:17Z
- **Completed:** 2026-07-19T00:16:16Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Added five distinct preview/execute schema pairs for configured history ingestion, proposal approval, proposal rejection, source revocation, and attributable source deletion.
- Omitted database, profile, person, scope authority, raw paths, and generic action discriminators from every input while requiring the exact preview parameters plus confirmation token on execute.
- Registered all ten names through the official MCP SDK with one exact `MemoryMutationApplication` method per handler.
- Projected internal exact effects into bounded counts and internal receipts into content-free controlled receipts without person IDs, paths, memory content, or raw effect identifiers.
- Added stable sanitized failure codes and truthful annotations: previews are mutating/non-idempotent, ingest execute is additive, and proposal decisions/revoke/delete executes are destructive.
- Activated every 05-07-owned Wave 0 contract; only the two explicitly 05-08-owned catalog/STDIO contracts remain deferred.

## Task Commits

1. **Task 1 RED: fixed-purpose mutation schema contracts** - `18a841e` (test)
2. **Task 1 GREEN: bounded mutation schema pairs** - `d60c4a1` (feat)
3. **Task 2 RED: SDK routing and catalog contracts** - `7818de1` (test)
4. **Task 2 GREEN: explicit mutation registrations** - Not committed because the single required commit attempt failed with `.git/index.lock` permission denial.

The Task 1 RED commit also included the previously uncommitted 05-06 catalog activation already present in the shared file. The Task 2 RED commit likewise included the previously uncommitted 05-05 history-ingest application tests already present in the shared mutation suite. No contents were reverted or rewritten.

## Files Created/Modified

- `src/mcp/tools/mutation-tools.ts` - Ten bounded schema pairs, name/annotation catalog, SDK registrations, controlled effect/receipt projection, dual envelopes, and sanitized errors.
- `tests/mcp/mutation-tools.test.ts` - Real in-memory SDK list/call proof for all preview/execute handlers, one-call routing, exact tokens, response redaction, error sanitization, and annotations.
- `tests/mcp/tool-catalog.test.ts` - Schema separation, authority/action/path omission, controlled outputs, complete names, and exact annotation assertions.

## Decisions Made

- Proposal approval and rejection remain separate operations rather than one decision tool with an action parameter.
- The MCP preview response exposes only token, expiry, an effects digest, and operation-specific counts. Exact effect IDs remain process-local inside the confirmation/application seam.
- `STATE_CHANGED` receipts allow an empty controlled count object because drift produces zero durable effects.
- Host prompts and annotations remain descriptive only; authorization is enforced by exact process-local ticket consumption in the existing mutation application.

## Deviations from Plan

None - plan behavior was implemented exactly as written.

## Issues Encountered

- The required Task 2 GREEN commit attempt failed with `fatal: Unable to create '/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/.git/index.lock': Operation not permitted`. Exactly one attempt was made; no hook bypass, Git metadata change, force-stage, stash, reset, clean, or retry workaround was used.
- Because the shared checkout contained prior-plan changes in both test files, the successful RED commits necessarily captured the already-present 05-06 catalog activation and 05-05 configured-history tests alongside the new assertions. Their behavior remained unchanged and all regression tests pass.

## TDD Gate Compliance

- Task 1 has a failing RED commit (`18a841e`) followed by a passing GREEN commit (`d60c4a1`).
- Task 2 has a failing RED commit (`7818de1`); the GREEN implementation passes all focused and full tests but remains uncommitted solely because the one permitted commit attempt hit the documented index-lock denial.

## Known Stubs

None - no 05-07-owned todo, placeholder, TODO, FIXME, empty render value, or mock production data path remains. The two remaining catalog/STDIO todos are explicitly owned by Plan 05-08.

## Verification

- Task 1 focused schema command — PASS; 4 matching tests passed.
- `npx vitest run tests/mcp/mutation-tools.test.ts tests/mcp/tool-catalog.test.ts` — PASS; 23 tests passed, 2 later-plan todos.
- `npm test` — PASS; 56 files, 374 tests passed, 10 intentional later-plan todos.
- `npm run typecheck` — PASS.
- `git diff --check` — PASS.
- 05-07 deferred-contract scan — PASS; no matches.

## Privacy and Workspace-Isolation Review

- Only source code, planning artifacts, ADRs 0041/0044/0046, and synthetic temporary fixtures were inspected. No live Codex, Claude Code, OpenClaw, Hermes, or other personal history was opened.
- Tool inputs cannot widen startup-bound person/scope/database authority or select arbitrary filesystem paths; history ingestion accepts only a configured safe alias and supported source kind.
- Proposal authorization and source lifecycle isolation remain in the established application/service layers; handlers neither perform global lookups nor directly mutate storage.
- Confirmation tokens, raw source paths, person IDs, memory content, and exact effect identifiers are excluded from successful MCP output and sanitized failures.
- Revocation and deletion remain separate operations, native histories remain read-only, and every durable effect stays behind task-specific atomic store commits.
- The only new trust surface is the planned T-05-SMUGGLE/T-05-APPROVAL MCP handler boundary; no unplanned network endpoint, schema table, auth path, generic CRUD surface, or STDIO server was introduced.

## User Setup Required

None - no external service, credentials, or live-history configuration required.

## Next Phase Readiness

- Plan 05-08 can compose the six read and ten mutation registrations into the real STDIO server without adding a generic dispatcher.
- The verified Task 2 GREEN source change and this summary need a Git-writable environment for their final commits.
- The checkout was substantially dirty before execution and remains dirty with preserved unrelated work plus the documented uncommitted Task 2 implementation/summary.

## Self-Check: PASSED

- All three planned source/test files and this summary exist.
- Commits `18a841e`, `d60c4a1`, and `7818de1` exist in Git history; the exact index-lock exception accounts for the uncommitted Task 2 GREEN implementation.
- Every 05-07 acceptance criterion and plan-level verification command passed.

---
*Phase: 05-generic-mcp-interface*
*Completed: 2026-07-19*
