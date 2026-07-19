---
phase: 05-generic-mcp-interface
plan: "06"
subsystem: mcp
tags: [mcp, read-only, authorization, provenance, pagination, zod]

requires:
  - phase: 05-generic-mcp-interface
    provides: Startup-bound immutable authority and pure scoped query services from 05-02
  - phase: 05-generic-mcp-interface
    provides: Authenticated whole-subject expansion from 05-03
  - phase: 05-generic-mcp-interface
    provides: Dependency-scoped proposal review from 05-05
provides:
  - Six explicit authority-free MCP read schemas with finite input and output bounds
  - SDK registrations for search, recall, review, subject expansion, status, and proposal listing
  - Equivalent structured and rendered responses with sanitized stable error codes
  - Truthful read-only, non-destructive, idempotent, closed-world annotations
affects: [05-07, 05-08, mcp-tool-catalog, stdio-server]

tech-stack:
  added: []
  patterns: [captured-authority handlers, strict zod boundaries, shared dual envelope, semantic read snapshots, sanitized protocol errors]

key-files:
  created:
    - src/mcp/tools/read-tools.ts
  modified:
    - tests/mcp/read-tools.test.ts
    - tests/mcp/tool-catalog.test.ts
    - .planning/phases/05-generic-mcp-interface/05-VALIDATION.md

key-decisions:
  - "Keep all authority outside tool inputs and capture only the already-authorized query, expansion, and proposal services in the registration closure."
  - "Return service DTOs through one shared structured-to-text envelope and map failures to stable content-free protocol codes."
  - "Expose proposal payload-free bounded listing only after ScopedProposalReviewer dependency authorization."

patterns-established:
  - "Read tool boundary: strict schema parse, one strict service call, shared envelope, and no semantic write path."
  - "Catalog truth: all six reads declare readOnly=true, destructive=false, idempotent=true, and openWorld=false."

requirements-completed: [REQ-023, REQ-025, REQ-028, REQ-029]

coverage:
  - id: D1
    description: Six finite task-specific schema pairs cannot select database, profile, person, or scopes.
    requirement: REQ-029
    verification:
      - kind: unit
        ref: "tests/mcp/tool-catalog.test.ts#05-06 Task 1 registers all six read schemas with no authority-widening inputs"
        status: pass
    human_judgment: false
  - id: D2
    description: Search, recall, review, expansion, status, and proposal listing route through strict scoped services with equivalent dual output.
    requirement: REQ-028
    verification:
      - kind: integration
        ref: "tests/mcp/read-tools.test.ts#05-06 Task 2"
        status: pass
    human_judgment: false
  - id: D3
    description: Review pagination preserves exact authorized ordering and all six reads leave semantic storage byte-equivalent.
    requirement: REQ-025
    verification:
      - kind: integration
        ref: "npx vitest run tests/mcp/read-tools.test.ts tests/mcp/tool-catalog.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: Whole-subject expansion preserves explicit budget, provenance, disclosure, and bounded continuation through the MCP boundary.
    requirement: REQ-023
    verification:
      - kind: integration
        ref: "tests/mcp/read-tools.test.ts#registers and routes memory_expand_subject with bounded continuation"
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-07-19
status: complete
---

# Phase 5 Plan 6: Read-Only MCP Tool Layer Summary

**Six startup-authorized MCP reads now expose bounded schemas, provenance-rich dual output, deterministic pagination and budgets, sanitized failures, and truthful no-write annotations**

## Performance

- **Duration:** 10 min
- **Started:** 2026-07-18T23:53:30Z
- **Completed:** 2026-07-19T00:03:03Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Added strict named Zod input/output pairs for `memory_search`, `memory_recall`, `memory_review`, `memory_expand_subject`, `source_status`, and `proposal_list`; every string, array, budget, limit, result page, and cursor is finite and authority-changing inputs are absent.
- Registered all six reads with the audited MCP SDK using captured pure services, shared structured/text envelopes, stable sanitized error codes, and exact read-only safety annotations.
- Proved search, recall, deterministic review pagination, whole-subject expansion, offline daemon status, and scoped proposal filtering through real in-memory SDK `tools/list` and `tools/call` sessions.
- Proved byte-equivalent semantic memory before and after every protocol read and changed only the mapped REQ-025 validation row to green for this plan.

## Task Commits

1. **Task 1: Define bounded read tool input and output schemas** - `1469332` (feat)
2. **Task 2 RED: Register explicit read tool routing contracts** - `8218a16` (test)
3. **Task 2 GREEN: Complete read registrations and validation** - Not committed because the single required commit attempt failed with `.git/index.lock` permission denial.

Task 1's failing RED commit attempt also hit the same permission denial. The subsequent Task 1 GREEN commit succeeded and necessarily contains both its test and implementation. No hook bypass, force-stage, Git metadata change, stash, reset, clean, or commit retry was used.

## Files Created/Modified

- `src/mcp/tools/read-tools.ts` - Six strict schema pairs, catalog metadata, captured-service application contract, SDK registrations, shared envelopes, and sanitized error mapping.
- `tests/mcp/read-tools.test.ts` - Real SDK in-memory list/call routing, dual representation, pagination, error-redaction, offline-status, scoped-proposal, and semantic no-write proof.
- `tests/mcp/tool-catalog.test.ts` - Authority omission, finite-bound, output-completeness, name, and annotation assertions.
- `.planning/phases/05-generic-mcp-interface/05-VALIDATION.md` - REQ-025 changed to green after its mapped complete suite passed; the pre-existing REQ-023 green change remains preserved as prior-plan work.

## Decisions Made

- The tool layer receives already-constructed `MemoryQueryService`, `SubjectExpansionService`, and `ScopedProposalReviewer` instances. It cannot accept or reconstruct database, person, profile, or allowed-scope authority.
- Each handler performs one strict service operation. The only protocol transformation is a shallow structured DTO copy into the shared envelope; proposal listing adds a static assistive disclosure and never requests payloads.
- Failures expose only `UNAVAILABLE`, `INVALID_CONTINUATION`, `BUDGET_TOO_SMALL`, `UNAUTHORIZED_OR_NOT_FOUND`, or `INVALID_REQUEST`; raw exception text, cursor material, memory content, IDs, and paths are not returned.
- Proposal listing uses the scoped reviewer and a schema-bounded limit. Mutation decisions and payload exposure remain outside the read catalog.

## Deviations from Plan

None - plan behavior and scope were implemented exactly as specified.

## Issues Encountered

- The Task 1 RED commit attempt failed because the environment could not create `.git/index.lock`; Task 1 GREEN later committed successfully as `1469332` with the RED assertion included.
- Task 2 RED committed successfully as `8218a16`. The single Task 2 GREEN staging/commit attempt then failed with the same intermittent `.git/index.lock` permission denial. Per execution instruction, it was not retried or worked around; verified production/test/validation changes remain intact in the shared checkout.
- The required SDK metadata commit also returned `committed: false`, `reason: commit_failed`, with the same `.git/index.lock` permission denial. No raw Git fallback or second attempt was made.
- The requirements completion handler reported the four plan IDs as `not_found` because this repository's `REQUIREMENTS.md` is prose-only and contains neither completion checkboxes nor a traceability status table. No direct edit was made; the completed IDs remain recorded in this summary frontmatter and the Phase 5 roadmap mapping.
- Context7 MCP and CLI documentation lookup were unavailable. The implementation was checked against the installed audited SDK 1.29.0 type declarations and the official v1 server documentation before coding.

## TDD Gate Compliance

- Task 1: RED failed for the intended missing-module reason, but its RED commit was blocked by `.git/index.lock`; GREEN `1469332` contains both test and implementation.
- Task 2: RED `8218a16` precedes the implementation and failed for the intended unregistered-method reason. GREEN verification passes, but its commit was blocked by `.git/index.lock`.
- Functional coverage is complete; the missing commit gates are environmental exceptions, not behavioral gaps.

## Known Stubs

None - no 05-06-owned deferred test, placeholder, TODO, FIXME, empty rendered value, or mock production data path remains. Four catalog todos remain explicitly owned by Plans 05-07 and 05-08.

## Verification

- `npx vitest run tests/mcp/read-tools.test.ts tests/mcp/tool-catalog.test.ts` — PASS; 17 tests passed, 4 intentional later-plan todos.
- `npm test` — PASS; 56 files, 370 tests passed, 14 intentional later-plan todos.
- `npm run typecheck` — PASS.
- `git diff --check` — PASS.
- `rg -n 'it.todo\("05-06' tests/mcp/read-tools.test.ts tests/mcp/tool-catalog.test.ts` — PASS; no matches.
- Stub and forbidden-write scans — PASS; no 05-06 stub or read-side save/injection/access/strength/revival call.

## Privacy and Workspace-Isolation Review

- Only synthetic temporary SQLite fixtures, source code, ADRs, and planning artifacts were inspected. No live Codex, Claude Code, OpenClaw, Hermes, or other user history was opened.
- Tool schemas cannot select a database, profile, person, scope list, source path, or arbitrary filesystem location. Authority is captured once by the application closure.
- Person and complete dependency-scope authorization occur in the strict services before any DTO or disclosure is rendered. Mixed-scope proposal and memory identifiers never surface.
- Cursors, blocked labels, and errors were checked for raw restricted metadata leakage. Native histories, durable memory, access counters, strengths, revival state, injections, proposals, and source state remain unchanged by reads.
- The new MCP tool-call boundary is exactly the planned T-05-READ/T-05-ANNOT threat surface; no network endpoint, STDIO transport, mutation registration, external model call, database schema, or hidden write path was added.

## User Setup Required

None - no external services, credentials, host registrations, or live-history configuration are required.

## Next Phase Readiness

- Plan 05-07 can add explicit mutation registrations alongside this fixed six-read catalog without changing read authority or annotations.
- Plan 05-08 can compose the complete server and exercise the same tools over STDIO.
- A Git-writable executor must commit the intact Task 2 GREEN implementation/test/validation changes and this summary if the metadata commit also encounters the known index-lock limitation.
- The checkout was substantially dirty before execution and remains dirty with preserved prior-phase work plus the documented uncommitted Task 2 changes.

## Self-Check: PASSED

- All four planned implementation/test/validation files and this summary exist.
- Commits `1469332` and `8218a16` exist; the documented index-lock exception accounts for the unavailable Task 1 RED and Task 2 GREEN commits.
- Every 05-06 acceptance criterion, focused suite, full suite, typecheck, diff hygiene, stub scan, privacy boundary, and no-write check passed.

---
*Phase: 05-generic-mcp-interface*
*Completed: 2026-07-19*
