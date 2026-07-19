---
phase: 05-generic-mcp-interface
plan: "02"
subsystem: mcp
tags: [mcp, authorization, retrieval, sqlite, read-only, pagination]

requires:
  - phase: 05-generic-mcp-interface
    provides: Wave 0 synthetic profiles and deferred read/profile contracts from Plan 05-01
  - phase: 04-continuous-local-daemon
    provides: person-scoped status, SQLite authority, and strict retrieval boundaries
provides:
  - Explicit versioned named-profile loading with immutable person and scope authority
  - Disclosure-safe restricted-scope aliases with a generic non-identifying fallback
  - Semantically pure scoped search, recall, review, and status services
  - Deterministic authority/filter-bound review pagination and dual response envelopes
  - SQLite read-only/no-migration connections with bounded busy timeout
affects: [05-03, 05-04, 05-05, 05-06, 05-07, 05-08]

tech-stack:
  added: []
  patterns: [startup-bound immutable authority, filter-before-disclosure, dependency-closed authorization, semantic read purity, authority-bound opaque cursors]

key-files:
  created:
    - src/mcp/authority.ts
    - src/mcp/profile-loader.ts
    - src/mcp/disclosure-labels.ts
    - src/mcp/response-envelope.ts
    - src/retrieval/memory-query-service.ts
  modified:
    - src/storage/sqlite-store.ts
    - src/types/node-sqlite.d.ts
    - tests/mcp/profile-loader.test.ts
    - tests/mcp/read-tools.test.ts

key-decisions:
  - "Resolve and freeze database, person, full normalized scope list, ingest scope, source roots, and safe aliases exactly once at startup."
  - "Treat another person's records as wholly undisclosable; restricted labels are derived only from same-person out-of-scope dependencies."
  - "Bind review cursors to the authority fingerprint, normalized filters, and last deterministic sort tuple without embedding memory content."
  - "Use SQLite's read-only constructor option and skip migrations entirely for MCP read connections."

patterns-established:
  - "Authorization precedes formatting: summaries are person/scope filtered first, and boxes/traces survive only when every referenced summary survives."
  - "Read purity: search, recall, review, and status call list/snapshot methods only and are verified by byte-equivalent semantic snapshots."

requirements-completed: [REQ-025, REQ-028, REQ-029]

coverage:
  - id: D1
    description: Explicit named profiles fail closed and resolve to immutable normalized authority with safe aliases.
    requirement: REQ-029
    verification:
      - kind: unit
        ref: "tests/mcp/profile-loader.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: Scoped search and budgeted recall return provenance-rich assistive results without semantic writes.
    requirement: REQ-025
    verification:
      - kind: integration
        ref: "tests/mcp/read-tools.test.ts#memory search and contextual recall"
        status: pass
    human_judgment: false
  - id: D3
    description: Memory review paginates the exact authorized dependency-closed set and rejects cursor substitution.
    requirement: REQ-028
    verification:
      - kind: integration
        ref: "tests/mcp/read-tools.test.ts#memory review"
        status: pass
    human_judgment: false
  - id: D4
    description: Offline status and read-only SQLite remain usable without migrations, database creation, or memory mutation.
    requirement: REQ-029
    verification:
      - kind: integration
        ref: "tests/mcp/read-tools.test.ts#source status"
        status: pass
      - kind: integration
        ref: "tests/storage/sqlite-store.test.ts"
        status: pass
    human_judgment: false

duration: 8min
completed: 2026-07-18
status: complete
---

# Phase 5 Plan 2: Startup Authority and Pure MCP Reads Summary

**Startup-bound profile authority with dependency-closed search, budgeted recall, deterministic review pagination, offline status, dual envelopes, and storage-enforced read-only SQLite access**

## Performance

- **Duration:** 8 min
- **Started:** 2026-07-18T23:00:43Z
- **Completed:** 2026-07-18T23:08:06Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments

- Added explicit version-1 profile configuration that rejects absent/unknown profiles, relative paths, invalid versions, empty authority, and ingest scopes outside the allow-list before transport or database startup.
- Added deeply immutable, deterministically fingerprinted authority plus disclosure labels that never fall back to raw scope, source, title, session, thread, or path metadata.
- Added pure scoped search and recall with deterministic ranking, explicit positive budgets, provenance, confidence, timestamps, source references, scopes, and assistive disclosure.
- Added dependency-closed summary/anchor/box/trace review with stable ordering, bounded pages, exact concatenation, and authority/filter-bound opaque continuation.
- Added offline-aware person-filtered status and SQLite read-only/no-migration connections that fail rather than create a missing database.
- Activated every 05-02-owned Wave 0 contract; only the six explicitly 05-06-owned protocol-registration contracts remain deferred in `read-tools.test.ts`.

## Task Commits

Task commits could not be created in this execution environment. The required normal commit attempt failed with:

`fatal: Unable to create '/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/.git/index.lock': Operation not permitted`

No `--no-verify`, Git metadata alteration, stash, reset, clean, or force-stage workaround was used. All task changes remain intact in the shared working tree for a Git-writable environment to commit.

## Files Created/Modified

- `src/mcp/authority.ts` - Immutable profile authority and stable content-free fingerprint.
- `src/mcp/profile-loader.ts` - Strict versioned config validation and explicit named-profile resolution.
- `src/mcp/disclosure-labels.ts` - Bounded configured aliases and generic restricted fallback.
- `src/mcp/response-envelope.ts` - One structured object rendered into equivalent MCP TextContent.
- `src/retrieval/memory-query-service.ts` - Pure authorized search, recall, review, cursor, and status services.
- `src/storage/sqlite-store.ts` - Read-only/no-migration mode and bounded connection timeout.
- `src/types/node-sqlite.d.ts` - Node SQLite timeout constructor typing.
- `tests/mcp/profile-loader.test.ts` - Five activated 05-02 profile/authority/disclosure contracts.
- `tests/mcp/read-tools.test.ts` - Four activated 05-02 pure-read contracts covering in-memory and SQLite fixtures.

## Decisions Made

- Another person's records do not produce even a restricted-context label. Same-person out-of-scope matches may disclose only a configured coarse alias or `restricted-context`.
- Review order is `updatedAt` descending, then `kind` and `id` ascending. Cursors bind the exact filter normalization and last tuple so changed filters or profiles fail with one sanitized error.
- Read responses expose assistive status and provenance but never call injection, access-recording, strength, revival, supersession, or save methods.
- SQLite read-only mode passes the runtime's `readOnly` flag, applies a bounded timeout, and deliberately skips every migration path.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Extended the local Node SQLite type declaration for bounded timeout**
- **Found during:** Task 2
- **Issue:** The repository's local `node:sqlite` declaration exposed `readOnly` but not the runtime-supported `timeout` option required by the plan.
- **Fix:** Added `timeout?: number` to the constructor declaration and matching internal constructor interface.
- **Files modified:** `src/types/node-sqlite.d.ts`, `src/storage/sqlite-store.ts`
- **Verification:** `npm run typecheck` and SQLite storage tests pass.
- **Committed in:** Not committed due the read-only `.git/index.lock` environment limitation.

---

**Total deviations:** 1 auto-fixed (1 blocking type-surface issue)
**Impact on plan:** Required only to express the planned bounded SQLite timeout; no feature or architecture expansion.

## Issues Encountered

- The single normal Git commit attempt failed because the sandbox cannot create `.git/index.lock`. Execution continued exactly as directed, with no Git metadata workaround.

## Known Stubs

- `tests/mcp/read-tools.test.ts` retains six intentional `it.todo` declarations owned by 05-06 Task 2 for MCP protocol registration/routing. No 05-02-owned contract remains deferred.

## Verification

- `npx vitest run tests/mcp/profile-loader.test.ts tests/mcp/read-tools.test.ts tests/retrieval/memory-retriever.test.ts tests/bootstrap/bootstrap-commands.test.ts tests/storage/sqlite-store.test.ts` — PASS; 5 files, 44 tests passed, 6 later-owner todos.
- `npm test` — PASS; 56 files, 334 tests passed, 48 intentional later-plan todos.
- `npm run typecheck` — PASS.
- `git diff --check` — PASS.
- `rg -n 'it.todo\\(\"05-02' tests/mcp/profile-loader.test.ts tests/mcp/read-tools.test.ts` — PASS; no matches.

## Privacy and Workspace-Isolation Review

- Only synthetic temporary fixtures and source code/planning artifacts were inspected; no real native history was opened.
- Person filtering precedes scope filtering and disclosure. Other-person content, identifiers, and scope labels are never exposed.
- Mixed-scope summaries and every box/trace depending on an excluded summary fail closed before DTO creation.
- Safe aliases never fall back to raw identifiers or metadata, and cursors contain no memory text.
- No network endpoint, remote authentication path, external LLM call, schema migration, or native-source mutation was introduced.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 05-03 can consume immutable `ProfileAuthority` and the established read-only response/cursor patterns.
- Plan 05-06 can register the pure services and activate its six remaining protocol-level read-tool contracts.
- A Git-writable environment must create the required task and metadata commits; implementation verification itself is complete.

## Self-Check: FAILED

- PASS: All nine planned/required implementation and test files exist.
- PASS: All 05-02 acceptance criteria and plan-level verification commands pass.
- PASS: No 05-02-owned deferred contract remains.
- FAIL: Required task and metadata commits do not exist because `.git/index.lock` is not writable in this execution environment.

---
*Phase: 05-generic-mcp-interface*
*Completed: 2026-07-18*
