---
phase: 05-generic-mcp-interface
plan: "05"
subsystem: mcp
tags: [confirmation, authorization, atomicity, proposals, source-lifecycle, history-import]

requires:
  - phase: 05-generic-mcp-interface
    provides: Startup-bound profile authority and pure scoped reads from 05-02
  - phase: 05-generic-mcp-interface
    provides: Task-specific atomic mutation contracts and store commits from 05-04
  - phase: 03-source-lifecycle-control-plane
    provides: Approved-source grants, revocation, attributable deletion, and audit rules
provides:
  - Exact short-lived single-use confirmation tickets bound to profile, tool, targets, parameters, effects, and expiry
  - Dependency-scoped proposal review plus explicit approve/reject preview and execute methods
  - Separate exact source revocation and deletion applications using atomic store commits
  - Configured-alias history import previews for Codex, Claude Code, OpenClaw, and Hermes with drift revalidation
affects: [05-06, 05-07, 05-08, mcp-transport, mutation-tools]

tech-stack:
  added: []
  patterns: [consume-before-write confirmation, stored exact preview plan, dependency-closed proposal authorization, configured-source staging, transaction-time drift rejection]

key-files:
  created:
    - src/mcp/confirmation-service.ts
    - src/mcp/mutation-application.ts
    - src/proposals/scoped-proposal-reviewer.ts
  modified:
    - src/service/source-lifecycle-service.ts
    - src/imports/history-import-command.ts
    - src/imports/codex-import-command.ts
    - src/storage/mcp-mutation-contracts.ts
    - src/storage/memory-store.ts
    - src/storage/in-memory-store.ts
    - src/storage/sqlite-store.ts
    - tests/mcp/confirmation-service.test.ts
    - tests/mcp/mutation-tools.test.ts

key-decisions:
  - "Confirmation tickets persist only an opaque token hash, intent digest, and expiry in process memory; they are consumed before any write attempt or validation result returns."
  - "Mutation application methods retain the exact preview plan process-locally, while task-specific store commits remain the sole durable write path."
  - "Proposal authorization closes over every referenced summary, box, trace, and recursive summary dependency before formatting or planning effects."
  - "History ingestion resolves only startup-configured aliases and stages the existing four importers into an in-memory preview before committing one deterministic resource batch."

patterns-established:
  - "Exact preview binding: caller parameters are canonicalized, effect identifiers are fingerprinted, and a changed method/profile/target/parameter/effect consumes and rejects the ticket."
  - "Zero-write drift: source, checkpoint, grant, target-event, or effect drift returns STATE_CHANGED after ticket consumption."

requirements-completed: [REQ-028, REQ-029]

coverage:
  - id: D1
    description: Exact process-local confirmation tickets reject cross-profile, changed-input, expiry, and replay attempts and cannot authorize twice.
    requirement: REQ-029
    verification:
      - kind: unit
        ref: "tests/mcp/confirmation-service.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: Proposal decisions and source lifecycle mutations require complete profile authority and commit through one atomic operation.
    requirement: REQ-028
    verification:
      - kind: integration
        ref: "tests/mcp/mutation-tools.test.ts#05-05 Task 2"
        status: pass
      - kind: integration
        ref: "tests/service/source-lifecycle-service.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: All four supported history formats use configured aliases and existing read-only importers with exact preview revalidation and zero writes on drift.
    requirement: REQ-028
    verification:
      - kind: integration
        ref: "tests/mcp/mutation-tools.test.ts#05-05 Task 3"
        status: pass
      - kind: integration
        ref: "tests/imports/multi-source-history.test.ts"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-07-18
status: complete
---

# Phase 5 Plan 5: Confirmed Scoped Mutation Applications Summary

**Exact consume-before-write confirmations now guard dependency-scoped proposal decisions, separate source lifecycle transitions, and configured-alias history imports that revalidate state and effects before atomic commit**

## Performance

- **Duration:** 15 min
- **Started:** 2026-07-18T23:32:20Z
- **Completed:** 2026-07-18T23:47:26Z
- **Tasks:** 3
- **Files modified:** 12

## Accomplishments

- Added cryptographically random, bounded-TTL, single-use confirmation authority bound to immutable profile fingerprint, execute method, sorted exact targets, canonical parameters, effect fingerprint, and exact expiry.
- Added scoped proposal listing/planning that fails closed unless the profile person and every recursive summary/box/trace dependency scope are authorized.
- Added explicit proposal approve/reject and source revoke/delete preview/execute methods; confirmation is consumed before the sole task-specific atomic store commit.
- Refactored source lifecycle execution onto exact atomic revocation/deletion inputs while preserving audit events, prior-revocation enforcement, native-source preservation, and derived-memory invalidation.
- Added configured-source import planning for Codex, Claude Code, OpenClaw, and Hermes by staging the existing parsers without durable writes, then revalidating candidate, source, checkpoint, grant, parameters, target events, and effects before commit.
- Activated every 05-05 Wave 0 contract. Only the two explicitly 05-07-owned transport-routing todos remain in the mutation suite.

## Task Commits

1. **Task 1 RED: exact confirmation intent contracts** - `0307e9c` (test)
2. **Task 2 RED: scoped mutation application contracts** - `d300aff` (test)
3. **Tasks 1-2 GREEN: confirmation, scoped proposal, and lifecycle applications** - `0a173a0` (feat)
4. **Task 3: configured-source history import application** - Not committed because the single normal commit attempt failed with `.git/index.lock` permission denial.

No hook bypass, Git metadata alteration, force-stage, stash, reset, or cleanup workaround was used. Task 3 source and tests remain intact in the shared working tree.

## Files Created/Modified

- `src/mcp/confirmation-service.ts` - Opaque ticket issue/consume, stable intent serialization, timing-safe comparison, expiry, and replay protection.
- `src/mcp/mutation-application.ts` - Explicit preview/execute methods and exact stored-plan orchestration for each supported mutation.
- `src/proposals/scoped-proposal-reviewer.ts` - Person/scope/dependency-authorized proposal listing and exact decision plans.
- `src/service/source-lifecycle-service.ts` - Exact atomic revocation/deletion planning and execution with ADR 0044 effects and audits.
- `src/imports/history-import-command.ts` - Configured-alias four-format staging and exact history commit planning.
- `src/imports/codex-import-command.ts` - Re-exports the configured import seam alongside the existing Codex command.
- `src/storage/mcp-mutation-contracts.ts`, `src/storage/memory-store.ts`, `src/storage/in-memory-store.ts`, `src/storage/sqlite-store.ts` - Task-specific exact deletion-effect inspection shared by preview and atomic revalidation.
- `tests/mcp/confirmation-service.test.ts`, `tests/mcp/mutation-tools.test.ts` - Activated confirmation, proposal, lifecycle, import, drift, replay, and native-read-only contracts.

## Decisions Made

- Tickets store no memory content, source path, normalized parameter body, or secret: only the hashed opaque token, SHA-256 intent digest, and expiry remain process-local.
- A previewed plan is removed before confirmation consumption, so mismatched, expired, faulted, drifted, and successful attempts all require a new preview.
- Source deletion effects are inspected through a task-specific storage method because complete injection/quarantine/checkpoint attribution is adapter-owned; no generic CRUD or transaction callback was introduced.
- History preview processes one deterministic changed resource per confirmation. Repeated previews preserve importer checkpoint idempotency while keeping each execute to one atomic domain mutation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added adapter-owned exact deletion-effect inspection**
- **Found during:** Task 2 source deletion preview construction.
- **Issue:** The lifecycle service could not enumerate all injections, quarantine records, and bootstrap checkpoints through existing public list methods, so it could not produce the complete deletion effect set required for exact confirmation.
- **Fix:** Added `inspectSourceDeletionEffects` as a source-deletion-specific store method and reused the same computation for transaction-time revalidation in both adapters.
- **Files modified:** `src/storage/memory-store.ts`, `src/storage/in-memory-store.ts`, `src/storage/sqlite-store.ts`, `src/storage/mcp-mutation-contracts.ts`.
- **Verification:** Lifecycle regression tests, mutation rollback/parity tests, full suite, and typecheck pass.
- **Committed in:** `0a173a0`.

---

**Total deviations:** 1 auto-fixed (1 missing critical correctness seam).
**Impact on plan:** The added method is task-specific and content-safe; it closes the exact-effects requirement without exposing generic storage mutation authority.

## Issues Encountered

- The Task 1 GREEN commit attempt failed with `fatal: Unable to create '/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/.git/index.lock': Operation not permitted`. Those production changes were later included normally in `0a173a0` when Git became writable for the Task 2 commit.
- The Task 3 normal commit attempt failed with the same `.git/index.lock` error. Per instruction, it was attempted once and no workaround or retry was used.
- The required SDK metadata commit returned `committed: false`, `reason: commit_failed`, with `fatal: Unable to create '/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/.git/index.lock': Operation not permitted`. No raw Git fallback or force-stage was attempted.
- Task 3 tests were activated after the implementation seam was written and passed immediately. Functional behavior is fully covered, but that task did not produce an independent failing RED commit.

## TDD Gate Compliance

- Task 1: RED `0307e9c` followed by GREEN in `0a173a0`.
- Task 2: RED `d300aff` followed by GREEN `0a173a0`.
- Task 3: Functional tests pass, but no independent RED commit exists because the tests were activated after implementation. This is a documented process-gate violation; no behavioral coverage is missing.

## Known Stubs

None - no 05-05-owned todo, placeholder, TODO, FIXME, empty render value, or mock production data path remains. The two remaining mutation-tool todos are explicitly owned by Plan 05-07 transport routing.

## Verification

- `npx vitest run tests/mcp/confirmation-service.test.ts` — PASS; 10 tests.
- `npx vitest run tests/mcp/mutation-tools.test.ts tests/service/source-lifecycle-service.test.ts tests/proposals/proposal-reviewer.test.ts` — PASS; 23 tests, 4 then-later todos before Task 3 activation.
- `npx vitest run tests/mcp/mutation-tools.test.ts tests/imports/codex-commands.test.ts tests/imports/multi-source-history.test.ts` — PASS; 28 tests, 2 05-07-owned todos.
- Plan verification `npx vitest run tests/mcp/confirmation-service.test.ts tests/mcp/mutation-tools.test.ts && npm run typecheck` — PASS; 24 tests, 2 05-07-owned todos, typecheck green.
- `npm test` — PASS; 56 files, 362 tests passed, 22 intentional later-plan todos.
- `git diff --check` — PASS.
- 05-05 deferred-contract scan — PASS; no matches.

## Privacy and Workspace-Isolation Review

- Only synthetic temporary Codex roots, in-memory/temporary SQLite stores, source code, ADRs, and planning artifacts were inspected. No live Codex, Claude Code, OpenClaw, Hermes, or other personal history was opened.
- Profile person and complete allowed-scope authority are checked before proposal content or mutation effects are formatted. Unauthorized/global IDs share sanitized non-existence errors.
- History input accepts a configured alias and parser kind, never a caller path. The selected root and durable grant must exactly match the startup profile, person, profile name, immutable ingest scope, application, format, candidate, and source locator.
- Native histories remain read-only. Confirmation tickets and receipts contain no message text, raw source paths, tokens, credentials, or result payloads.
- The new file-access, confirmation, and mutation trust surfaces are exactly the planned T-05-CONFIRM and T-05-ROUTING boundaries; no network endpoint, MCP transport registration, database table, or generic transaction escape hatch was introduced.

## User Setup Required

None - no external service, credential, or live-history configuration is required.

## Next Phase Readiness

- Plan 05-06 can expose read services and stable response envelopes without adding mutation authority.
- Plan 05-07 can register each explicit preview/execute application method and truthful tool annotations; no generic action dispatcher is needed.
- Plan 05-08 can exercise the confirmation and mutation applications through real synthetic STDIO sessions.
- The parent executor must commit the intact Task 3 import/application/test changes and this summary from a Git-writable context.
- The checkout was substantially dirty before execution and remains dirty with preserved unrelated work plus the documented uncommitted Task 3/summary files.

## Self-Check: PASSED

- All 12 planned implementation/test files and this summary exist.
- Commits `0307e9c`, `d300aff`, and `0a173a0` exist in Git history; the documented index-lock exception accounts for Task 3's pending commit.
- Every 05-05 contract is active, all focused and full tests pass, typecheck passes, diff hygiene passes, and privacy/source boundaries were reviewed.

---
*Phase: 05-generic-mcp-interface*
*Completed: 2026-07-18*
