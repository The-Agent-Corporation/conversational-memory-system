---
phase: 05-generic-mcp-interface
plan: "04"
subsystem: storage
tags: [atomicity, sqlite, rollback, mcp, source-lifecycle, proposals]

requires:
  - phase: 05-generic-mcp-interface
    provides: Startup authority, read-only SQLite mode, and Wave 0 mutation contracts
  - phase: 04-continuous-local-daemon
    provides: Staged in-memory commits and BEGIN IMMEDIATE SQLite transaction patterns
provides:
  - Exact preview-bound schemas for history import, proposal decisions, source revocation, and source deletion
  - Equivalent staged in-memory and transactional SQLite mutation commits
  - STATE_CHANGED zero-write handling for expected-state drift
  - Named rollback seams across every multi-effect mutation group
affects: [05-05, 05-07, 05-08]

tech-stack:
  added: []
  patterns: [exact effect fingerprint, stage-then-swap, begin-immediate revalidation, bounded busy timeout, WAL writer discipline]

key-files:
  created:
    - src/storage/mcp-mutation-contracts.ts
  modified:
    - src/storage/memory-store.ts
    - src/storage/in-memory-store.ts
    - src/storage/sqlite-store.ts
    - tests/mcp/mutation-tools.test.ts

key-decisions:
  - "Expose four task-specific commit methods rather than a generic transaction callback or CRUD mutation surface."
  - "Return a content-free STATE_CHANGED receipt with zero effect counts when transaction-time state differs from the preview."
  - "Keep revocation and deletion separate: deletion requires an exact already-revoked grant plus the complete attributable effect set."
  - "Enable WAL only for writable SQLite connections and bound every connection timeout to 1-30000 milliseconds."

patterns-established:
  - "Preview binding: person, target, checkpoint/source/grant state, normalized parameters, exact effect IDs, and SHA-256 effect fingerprint travel together."
  - "Atomic parity: memory clones and swaps only after every seam; SQLite revalidates under BEGIN IMMEDIATE and rolls back on every error."

requirements-completed: [REQ-028, REQ-029]

coverage:
  - id: D1
    description: Exact contracts reject cross-person, incomplete, drifted, and invalid lifecycle inputs.
    requirement: REQ-029
    verification:
      - kind: unit
        ref: "tests/mcp/mutation-tools.test.ts#05-04 Task 1"
        status: pass
    human_judgment: false
  - id: D2
    description: All four operations produce identical receipts and reopened final state across both adapters.
    requirement: REQ-028
    verification:
      - kind: integration
        ref: "tests/mcp/mutation-tools.test.ts#commits identical receipts"
        status: pass
    human_judgment: false
  - id: D3
    description: Every named fault boundary leaves byte-equivalent semantic storage state.
    requirement: REQ-028
    verification:
      - kind: integration
        ref: "tests/mcp/mutation-tools.test.ts#rolls back every durable effect"
        status: pass
    human_judgment: false

duration: 11min
completed: 2026-07-18
status: complete
---

# Phase 5 Plan 4: Atomic Mutation Storage Summary

**Exact preview-to-execute state/effect binding with staged in-memory swaps, `BEGIN IMMEDIATE` SQLite revalidation, zero-write drift rejection, and exhaustive rollback fault proof**

## Performance

- **Duration:** 11 min
- **Started:** 2026-07-18T23:18:54Z
- **Completed:** 2026-07-18T23:29:54Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Added strict Zod contracts for history import, proposal approve/reject, source revocation, and already-revoked source deletion without exposing a generic transaction escape hatch.
- Bound imports to exact source/checkpoint/grant state, normalized parameters, target canonical event IDs, complete effect IDs, deterministic fingerprints, and content-free receipts.
- Implemented zero-write `STATE_CHANGED` results and atomic clean commits in both storage adapters.
- Added named pre-write and between-effect fault seams, with every boundary tested in-memory and through SQLite rollback/reopen.
- Verified identical clean receipts and final state for all four operations across adapters.
- Preserved native histories: all tests use synthetic temporary fixtures and storage methods only.

## Task Commits

1. **RED: Add failing exact mutation contract assertions** - `b8fdb2e` (test)
2. **Task 1: Define exact atomic mutation contracts** - `56272f1` (feat)
3. **Task 2: Implement adapter-parity atomic commits** - `e969499` (feat)

## Files Created/Modified

- `src/storage/mcp-mutation-contracts.ts` - Operation-specific schemas, receipts, effect sets, deterministic fingerprints, and named fault boundaries.
- `src/storage/memory-store.ts` - Four explicit atomic mutation method contracts.
- `src/storage/in-memory-store.ts` - Expected-state revalidation, clone/stage/swap commits, drift receipts, and fault seams.
- `src/storage/sqlite-store.ts` - Bounded timeout/WAL setup plus `BEGIN IMMEDIATE` commits, rollback, exact effect recomputation, and drift receipts.
- `tests/mcp/mutation-tools.test.ts` - Contract rejection, stale writer, every-boundary rollback, clean parity, and SQLite reopen proof.

## Decisions Made

- Fingerprints use stable key-sorted JSON and SHA-256. They bind content-free state/effect descriptions, while receipts contain only identifiers, counts, operation status, and timestamps.
- History imports reject occupied target event IDs inside the transaction; no partial idempotent overwrite is accepted as a confirmed preview execution.
- Source deletion recomputes attributable sources, canonical events, compatibility turns, anchors, injections, quarantine rows, bootstrap checkpoints, and dependency-derived supersessions before writing.
- Import checkpoints and revoked grants remain as ADR 0044 anti-reimport/audit state; only the attributable historical bootstrap checkpoint is removed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Made in-memory lifecycle audit ordering match SQLite**
- **Found during:** Task 2 clean adapter-parity verification
- **Issue:** Audit rows with identical timestamps preserved insertion order in memory but sorted by ID in SQLite.
- **Fix:** Added the ID tie-breaker to in-memory lifecycle audit listing.
- **Files modified:** `src/storage/in-memory-store.ts`
- **Verification:** All four clean mutation operations now have byte-identical reopened adapter snapshots.
- **Committed in:** `e969499`

---

**Total deviations:** 1 auto-fixed bug.
**Impact on plan:** The fix strengthens deterministic adapter parity without adding product scope.

## Issues Encountered

- The shared checkout began substantially dirty with prerequisite Phase 3/4 and earlier Phase 5 storage work. Task 2 necessarily committed the complete current versions of `in-memory-store.ts` and `sqlite-store.ts`; those files therefore include their existing prerequisite implementation along with Plan 05-04 changes. No unrelated file was staged, reverted, or cleaned.
- Normal per-task Git commits succeeded in this run; no hook bypass or Git metadata workaround was used.
- The single required SDK metadata-commit attempt failed because it could not create `.git/index.lock` (`Operation not permitted`). Per instruction, no retry, force-stage, or Git metadata workaround was attempted; this summary remains on disk for the orchestrator.

## Known Stubs

- `tests/mcp/mutation-tools.test.ts` retains eight intentional `it.todo` declarations owned by Plans 05-05 and 05-07. No 05-04-owned assertion remains deferred.

## Verification

- `npx vitest run tests/storage/sqlite-store.test.ts tests/mcp/mutation-tools.test.ts` — PASS; 2 files, 17 tests passed, 8 later-owner todos.
- `npm test` — PASS; 56 files, 347 tests passed, 36 intentional later-plan todos.
- `npm run typecheck` — PASS.
- `git diff --check` — PASS.
- Stub scan — PASS; no 05-04 todo, TODO, FIXME, placeholder, or unimplemented production path.

## Privacy and Workspace-Isolation Review

- Only synthetic in-memory data and temporary SQLite databases were used; no native Codex, Claude Code, OpenClaw, Hermes, or other live history was inspected.
- Every schema and adapter rejects cross-person effects before writing.
- Source deletion is restricted to exact person/candidate attribution and never opens, modifies, moves, or deletes a native source path.
- Receipts and fingerprints do not copy imported/deleted content, raw paths, or secrets.

## User Setup Required

None.

## Next Phase Readiness

- Plan 05-05 can consume only these atomic commit methods for preview-confirm-execute services.
- The later MCP catalog/server layer remains intentionally untouched.
- The worktree was dirty before execution and remains dirty with unrelated prior/user files; all Plan 05-04 implementation files and tests are committed.

## Self-Check: PASSED

- All five planned contract/store/test files exist.
- Commits `b8fdb2e`, `56272f1`, and `e969499` exist in Git history.
- Every 05-04-owned assertion is active and passing.
- Focused storage/MCP tests, full suite, typecheck, and diff hygiene all pass.
- The summary file exists and its claims are verified; its metadata commit is pending because the SDK could not create `.git/index.lock`.

---
*Phase: 05-generic-mcp-interface*
*Completed: 2026-07-18*
