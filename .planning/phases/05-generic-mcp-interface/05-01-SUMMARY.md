---
phase: 05-generic-mcp-interface
plan: "01"
subsystem: testing
tags: [mcp, stdio, sqlite, zod, vitest, authorization]

requires:
  - phase: 04-continuous-local-daemon
    provides: person-scoped canonical memory, strict retrieval boundaries, source lifecycle controls, and SQLite authority
provides:
  - Audited MCP SDK 1.29.0 and Zod 3.25.76 dependency lock
  - Synthetic two-person, three-scope SQLite fixture with mixed derived-memory dependencies
  - Compilable named contracts for every Phase 5 read, mutation, catalog, confirmation, and STDIO boundary
  - Complete Wave 0 validation ownership map without premature Nyquist sign-off
affects: [05-02, 05-03, 05-04, 05-05, 05-06, 05-07, 05-08]

tech-stack:
  added: ["@modelcontextprotocol/sdk@1.29.0", "zod@3.25.76"]
  patterns: [synthetic temporary SQLite fixtures, explicit owned deferred contracts, dual-output contract assertions]

key-files:
  created:
    - tests/mcp/fixtures.ts
    - tests/mcp/profile-loader.test.ts
    - tests/mcp/read-tools.test.ts
    - tests/mcp/subject-expansion.test.ts
    - tests/mcp/confirmation-service.test.ts
    - tests/mcp/mutation-tools.test.ts
    - tests/mcp/tool-catalog.test.ts
    - tests/mcp/stdio-server.test.ts
  modified:
    - package.json
    - package-lock.json
    - .planning/phases/05-generic-mcp-interface/05-VALIDATION.md

key-decisions:
  - "Pin the supported MCP v1 SDK and compatible Zod v3 release exactly, avoiding the beta v2 generation."
  - "Keep production-dependent Wave 0 behavior as explicit named it.todo contracts owned by later Phase 5 tasks while executing fixture and schema-shape assertions immediately."
  - "Use only temporary synthetic profiles, roots, and SQLite databases; no default host-history location is resolved or inspected."

patterns-established:
  - "Wave 0 contract ownership: every deferred test name starts with its production owner task."
  - "Synthetic authority fixture: two people, three scopes, safe aliases, and mixed-scope summary/box/trace/proposal dependencies."

requirements-completed: [REQ-023, REQ-025, REQ-027, REQ-028, REQ-029]

coverage:
  - id: D1
    description: Audited MCP SDK and Zod versions are exactly pinned and reproducible.
    requirement: REQ-027
    verification:
      - kind: integration
        ref: "npm ls @modelcontextprotocol/sdk zod"
        status: pass
    human_judgment: false
  - id: D2
    description: Synthetic MCP fixtures prove two-person and three-scope isolation without live history access.
    requirement: REQ-025
    verification:
      - kind: unit
        ref: "tests/mcp/profile-loader.test.ts#creates only explicit named profiles with immutable person and complete scope authority"
        status: pass
      - kind: integration
        ref: "tests/mcp/read-tools.test.ts#snapshots every semantic fixture table deterministically without reading host history"
        status: pass
    human_judgment: false
  - id: D3
    description: Every Phase 5 production behavior has a compilable named contract and explicit activation owner.
    requirement: REQ-029
    verification:
      - kind: unit
        ref: "npx vitest run tests/mcp"
        status: pass
    human_judgment: false
  - id: D4
    description: Wave 0 validation mappings are complete while final Nyquist status remains pending.
    requirement: REQ-028
    verification:
      - kind: other
        ref: "05-VALIDATION.md marker assertion command"
        status: pass
    human_judgment: false

duration: 7min
completed: 2026-07-18
status: complete
---

# Phase 5 Plan 1: Wave 0 MCP Contracts Summary

**Pinned official MCP dependencies plus a temporary synthetic SQLite fixture and 57 explicitly owned contracts for authorization, pure reads, bounded expansion, confirmation, atomic mutation, catalog annotations, and STDIO lifecycle**

## Performance

- **Duration:** 7 min
- **Started:** 2026-07-18T22:49:29Z
- **Completed:** 2026-07-18T22:56:44Z
- **Tasks:** 3
- **Files modified:** 11

## Accomplishments

- Pinned `@modelcontextprotocol/sdk` 1.29.0 and Zod 3.25.76 exactly in both manifest and lockfile.
- Added a temporary two-person, three-scope SQLite fixture with safe aliases, deterministic canonical events, mixed-scope derived dependencies, fake time, fault injection, and byte-equivalent semantic snapshots.
- Added seven executable contract modules containing 13 immediate green assertions and 57 explicit production-owned deferred assertions across D-01 through D-17.
- Updated `05-VALIDATION.md` so every Wave 0 artifact is created and mapped while `nyquist_compliant: false` and behavior rows remain pending.

## Task Commits

1. **Task 1: Install the audited production MCP SDK generation** - `b6746de` (chore)
2. **Task 2: Create synthetic profile, read, and subject-expansion contracts** - `d3c63ce` (test)
3. **Task 3: Create confirmation, mutation, catalog, and STDIO contracts** - `4c44910` (test)

Task 2's first commit attempt failed with the known `.git/index.lock` permission error. A later retry succeeded without altering Git metadata or bypassing hooks. Task 3 committed before that retry, so commit chronology differs from task order while each task remains isolated.

## Files Created/Modified

- `package.json`, `package-lock.json` - Exact audited SDK/Zod versions and reproducible dependency graph.
- `tests/mcp/fixtures.ts` - Temporary synthetic database/config builder, semantic snapshot, fake clock, and fault injector.
- `tests/mcp/profile-loader.test.ts` - Explicit profile selection, immutable authority, and safe-alias contracts.
- `tests/mcp/read-tools.test.ts` - Pure read and equivalent structured/text response contracts.
- `tests/mcp/subject-expansion.test.ts` - Authorized deterministic budgeted expansion and continuation contracts.
- `tests/mcp/confirmation-service.test.ts` - Exact binding, expiry, consumption, and replay contracts.
- `tests/mcp/mutation-tools.test.ts` - Preview/execute, rollback, concurrency, revocation, and deletion contracts.
- `tests/mcp/tool-catalog.test.ts` - Six-read/ten-mutation catalog and annotation contract.
- `tests/mcp/stdio-server.test.ts` - Official SDK client and real child-process lifecycle contract.
- `.planning/phases/05-generic-mcp-interface/05-VALIDATION.md` - Complete Wave 0 artifact and task-owner mappings.

## Decisions Made

- Retained the supported SDK v1 generation because execution occurred before the research recheck boundary and the audited packages remained installable.
- Used explicit `it.todo` declarations for production-dependent behavior. This is the plan's controlled Wave 0 RED strategy: contracts compile and are discoverable now, and named later tasks must activate them before final sign-off.
- Kept all fixture paths beneath a per-test temporary directory and used only synthetic content, people, profiles, sources, and scopes.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Correctness] Converted npm's default compatible ranges to exact dependency pins**
- **Found during:** Task 1
- **Issue:** The authorized `npm install` command wrote caret ranges even though the plan requires pinned versions.
- **Fix:** Changed both dependency declarations to exact versions and refreshed the lockfile.
- **Files modified:** `package.json`, `package-lock.json`
- **Verification:** Root lock dependencies equal `1.29.0` and `3.25.76`; `npm ls` resolves those exact versions.
- **Committed in:** `b6746de`

---

**Total deviations:** 1 auto-fixed (1 missing correctness requirement)
**Impact on plan:** The adjustment made the declared dependency contract match the locked plan; no scope expansion.

## Issues Encountered

- Task 2's initial `git add` could not create `.git/index.lock`. Per the execution instructions, files were left intact and work continued. The retry succeeded later; all three task commits exist and no hook was bypassed.
- `npm install` reported existing dependency-audit findings. No unplanned upgrade or forced audit fix was attempted because that would change the authorized package graph and is outside this Wave 0 plan.

## Known Stubs

- `tests/mcp/profile-loader.test.ts` — five intentional contracts deferred to 05-02 Task 1.
- `tests/mcp/read-tools.test.ts` — ten intentional contracts deferred to 05-02 Task 2 and 05-06 Task 2.
- `tests/mcp/subject-expansion.test.ts` — seven intentional contracts deferred to 05-03 Tasks 1-2.
- `tests/mcp/confirmation-service.test.ts` — eight intentional contracts deferred to 05-05 Task 1.
- `tests/mcp/mutation-tools.test.ts` — thirteen intentional contracts deferred to 05-04, 05-05, and 05-07 owners.
- `tests/mcp/tool-catalog.test.ts` — six intentional contracts deferred to 05-06 through 05-08 owners.
- `tests/mcp/stdio-server.test.ts` — eight intentional contracts deferred to 05-08 Task 2.

These deferred declarations are the plan's intended output and do not block Plan 05-01. `05-VALIDATION.md` keeps all production behavior pending until the named owners turn them into passing executable assertions.

## Verification

- `npm ls @modelcontextprotocol/sdk zod` — PASS; SDK 1.29.0 and Zod 3.25.76.
- `npx vitest run tests/mcp/...` — PASS; 7 files, 13 executable assertions, 57 explicit todos.
- Nearest regression suites — PASS; 5 files and 46 tests covering retrieval, source lifecycle, proposals, Hermes ingest, and SQLite.
- `npm test` — PASS; 56 files, 325 tests passed, 57 intentional todos.
- `npm run typecheck` — PASS.
- `git diff --check` — PASS.
- Wave 0 validation marker assertion — PASS; no `TBD`, `wave_0_complete: true`, `nyquist_compliant: false`.

## Privacy and Workspace-Isolation Review

- No real Codex, Claude Code, OpenClaw, Hermes, or other agent history was read.
- Every fixture database, profile config, and configured source root is created beneath a temporary synthetic directory and removed after each test.
- Person/scope authority is fixed by named profiles; safe aliases deliberately avoid raw scope, source, session, title, or path metadata.
- No production endpoint, authentication path, file-access behavior, or schema trust boundary was added in this plan.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plans 05-02 through 05-08 have named contract groups to activate and exact test commands in `05-VALIDATION.md`.
- Final Nyquist sign-off correctly remains pending until 05-08 Task 2 activates every owned contract.
- The checkout was dirty before execution and remains dirty only with unrelated earlier-phase/user work; Plan 05-01 files are committed except this summary and subsequent planning metadata.

## Self-Check: PASSED

- All 11 planned dependency, test, fixture, and validation files exist.
- Task commits `b6746de`, `d3c63ce`, and `4c44910` exist in Git history.
- All acceptance criteria and plan-level verification commands passed.

---
*Phase: 05-generic-mcp-interface*
*Completed: 2026-07-18*
