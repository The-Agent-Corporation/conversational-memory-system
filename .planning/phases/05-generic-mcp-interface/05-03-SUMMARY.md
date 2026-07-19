---
phase: 05-generic-mcp-interface
plan: "03"
subsystem: retrieval
tags: [mcp, authorization, canonical-events, pagination, hmac, read-purity]

requires:
  - phase: 05-generic-mcp-interface
    provides: immutable named-profile authority and pure read-service patterns from Plan 05-02
  - phase: 04-continuous-local-daemon
    provides: person-scoped canonical events and dependency-scoped derived memory
provides:
  - Strict normalized whole-subject resolution across summaries, boxes, and traces
  - Dependency-closed canonical event expansion with deterministic tuple ordering
  - Whole-event token packing with provenance-rich assistive disclosure
  - HMAC-authenticated stateless continuation bound to authority, subject, budget, estimator, tuple, and expiry
affects: [05-06, 05-08]

tech-stack:
  added: []
  patterns: [authorize before canonical lookup, deterministic whole-record packing, authenticated stateless continuation, semantic read purity]

key-files:
  created:
    - src/retrieval/subject-expansion-service.ts
    - src/mcp/continuation-cursor.ts
  modified:
    - tests/mcp/subject-expansion.test.ts
    - .planning/phases/05-generic-mcp-interface/05-VALIDATION.md

key-decisions:
  - "Resolve exactly one normalized authorized summary, box, or trace and collapse unknown, ambiguous, mixed-scope, and other-person subjects to one unavailable result."
  - "Bind continuation to the next canonical tuple and the complete authority/subject/budget/estimator policy so each page starts exactly where the prior page stopped."
  - "Count and pack complete deterministic event renderings, stopping before the first event that cannot fit rather than skipping it."

patterns-established:
  - "Whole-subject closure: recursive summary dependencies must all survive person and complete-scope authorization before canonical IDs are loaded."
  - "Cursor purity: signed cursors contain only hashes, ordering metadata, budget policy, estimator version, and expiry; no memory text, scope labels, or source paths."

requirements-completed: [REQ-023, REQ-025, REQ-028]

coverage:
  - id: D1
    description: Authorized normalized subjects expand only their complete dependency-closed canonical event set.
    requirement: REQ-023
    verification:
      - kind: integration
        ref: "tests/mcp/subject-expansion.test.ts#05-03 Task 1"
        status: pass
    human_judgment: false
  - id: D2
    description: Whole canonical event renderings remain deterministically ordered, provenance-rich, and within the explicit token budget.
    requirement: REQ-025
    verification:
      - kind: integration
        ref: "tests/mcp/subject-expansion.test.ts#returns only the authorized first page within the exact token budget"
        status: pass
    human_judgment: false
  - id: D3
    description: Authenticated continuation rejects substitution, tampering, and expiry while concatenating to the exact ordered event set without mutation.
    requirement: REQ-028
    verification:
      - kind: integration
        ref: "tests/mcp/subject-expansion.test.ts#05-03 Task 2"
        status: pass
    human_judgment: false

duration: 6min
completed: 2026-07-18
status: complete
---

# Phase 5 Plan 3: Authorized Whole-Subject Expansion Summary

**Dependency-closed subject expansion with deterministic provenance-rich event pages and HMAC continuation that rejects authority, subject, budget, policy, expiry, and payload substitution**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-18T23:11:00Z
- **Completed:** 2026-07-18T23:17:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Added strict normalized subject resolution for summaries, boxes, and traces without accepting caller-selected global object-ID arrays.
- Closed recursive summary dependencies under the startup-bound person and complete allowed-scope authority before loading any canonical events.
- Expanded only person-owned, allowed-scope canonical IDs in `(occurredAt, nativeSequence, id)` order with stable source/native provenance, timestamps, confidence, scopes, estimator facts, and assistive disclosure.
- Added whole-event deterministic token packing that never exceeds the requested positive budget and never skips an oversized next event.
- Added timing-safe HMAC continuation bound to authority fingerprint, normalized subject hash, exact next tuple, token budget, estimator version, and expiry.
- Activated all seven 05-03 contracts, proved exact no-gap/no-duplicate concatenation and byte-equivalent semantic tables, and marked only the mapped REQ-023 validation row green.

## Task Commits

1. **Task 1 RED: failing subject-expansion contracts** - `5086616` (test)
2. **Task 1 GREEN / Task 2: production expansion, authenticated continuation, complete tests, and validation** - Not committed because both normal commit attempts failed with `.git/index.lock` permission denial.

No hook bypass, Git metadata alteration, forced staging, stash, reset, or cleanup workaround was used. All uncommitted plan changes remain intact in the shared working tree for the parent executor to commit from a Git-writable context.

## Files Created/Modified

- `src/retrieval/subject-expansion-service.ts` - Authorized whole-subject resolution, recursive dependency closure, canonical event mapping, deterministic ordering, token packing, disclosure, and continuation orchestration.
- `src/mcp/continuation-cursor.ts` - HMAC cursor codec with timing-safe verification and authority/subject/budget/estimator/tuple/expiry bindings.
- `tests/mcp/subject-expansion.test.ts` - Nine executable synthetic contracts covering ordering, authorization, provenance, budget, continuation, tampering, expiry, exact pagination, and read purity.
- `.planning/phases/05-generic-mcp-interface/05-VALIDATION.md` - REQ-023 expansion row changed from pending to green only after its complete mapped test command passed.

## Decisions Made

- Subject matching normalizes case and whitespace but returns content only when exactly one authorized derived object matches. Unauthorized and ambiguous matches share the same sanitized error.
- Recursive `sourceSummaryIds` participate in authorization and canonical-ID collection; boxes and traces are accepted only when every referenced summary and its dependency closure survives.
- Continuation stores the next event tuple rather than the last rendered tuple. Resumption must find that exact tuple in the freshly authorized event set, preventing silent drift, gaps, or duplicates.
- A budget too small for the next whole event fails explicitly instead of emitting an empty self-repeating page or skipping data.

## Deviations from Plan

None - plan behavior and scope were implemented exactly as specified.

## Issues Encountered

- The Task 1 RED commit succeeded normally as `5086616`.
- The subsequent normal production commit attempts failed with `fatal: Unable to create .../.git/index.lock: Operation not permitted`. Execution continued as explicitly directed, without `--no-verify` or any Git workaround.
- Task 2 contracts passed on first activation because the cursor codec was already required to satisfy Task 1's first-page continuation contract. The full contract suite independently exercises every Task 2 binding and failure mode.

## Known Stubs

None - no 05-03-owned deferred contracts, placeholders, TODOs, empty render values, or mock data paths remain.

## Verification

- `npx vitest run tests/mcp/subject-expansion.test.ts -t "authorization|budget|ordering|provenance"` — PASS.
- `npx vitest run tests/mcp/subject-expansion.test.ts` — PASS; 9 tests passed, zero todos.
- `npm test` — PASS; 56 files, 341 tests passed, 41 intentional later-plan todos.
- `npm run typecheck` — PASS.
- `git diff --check` — PASS.
- `rg -n 'it.todo\("05-03' tests/mcp/subject-expansion.test.ts` — PASS; no matches.
- REQ-023 validation marker assertion — PASS; row is `✅ green` after the complete mapped suite passed.

## Privacy and Workspace-Isolation Review

- Only synthetic temporary SQLite fixtures, source code, ADRs, and planning artifacts were inspected; no live native histories were opened.
- Person and complete dependency-scope filtering occurs before canonical lookup or rendering. Other-person and mixed-scope subjects disclose no IDs, labels, titles, content, or existence detail.
- Cursors contain no memory text, raw scope labels, source paths, or credentials and are authenticated before their ordering tuple is used.
- Expansion calls list methods only; semantic snapshots remain byte-equivalent across every page.
- The new security surface is exactly the planned subject/cursor trust boundary covered by T-05-SCOPE and T-05-CURSOR; no unplanned network, auth, filesystem, or schema boundary was introduced.

## User Setup Required

None - no external services, live histories, or host configuration are required.

## Next Phase Readiness

- Plan 05-06 can register `SubjectExpansionService` behind the MCP read-tool boundary and reuse its structured result directly.
- Plan 05-08 can exercise continuation through the real SDK transport without adding durable read-side state.
- The parent executor must commit the intact production/test/validation/summary changes from a Git-writable context.
- The checkout was substantially dirty before execution with unrelated prior-phase and user work. It remains dirty after execution with that preserved work plus the uncommitted 05-03 files listed above.

## Self-Check: PASSED

- All four planned implementation, test, and validation files exist, and this summary exists on disk.
- RED commit `5086616` exists in Git history; the documented environment exception accounts for the unavailable production commit.
- All task acceptance criteria, plan-level verification, full tests, typecheck, validation ownership, privacy boundaries, and diff hygiene passed.

---
*Phase: 05-generic-mcp-interface*
*Completed: 2026-07-18*
