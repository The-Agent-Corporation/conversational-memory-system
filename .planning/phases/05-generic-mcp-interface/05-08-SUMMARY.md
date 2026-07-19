---
phase: 05-generic-mcp-interface
plan: "08"
subsystem: mcp
tags: [mcp, stdio, sqlite, codex, openclaw, protocol, signoff]

requires:
  - phase: 05-generic-mcp-interface
    provides: Profile authority, pure read services, exact confirmation tickets, atomic mutation applications, and explicit read/mutation tool groups from Plans 05-01 through 05-07
provides:
  - Complete sixteen-tool explicit-profile MCP application composition
  - Protocol-clean local STDIO command with pre-transport authority resolution
  - Real SDK initialize/list/read/preview/execute/shutdown proof for synthetic supported-host registrations
  - Fail-closed machine-readable Phase 5 validation and client registration guidance
affects: [phase-06-sync, phase-07-onboarding, local-agent-integrations]

tech-stack:
  added: []
  patterns: [one immutable profile per child, read-only long-lived store, short-lived atomic write connections, stdout-owned SDK transport, structural signoff parsing]

key-files:
  created:
    - src/mcp/tool-catalog.ts
    - src/mcp/server.ts
    - src/mcp/server-command.ts
    - scripts/verify-phase-05-signoff.mjs
    - docs/integrations/local-mcp-clients.md
  modified:
    - package.json
    - tests/mcp/tool-catalog.test.ts
    - tests/mcp/stdio-server.test.ts
    - .planning/phases/05-generic-mcp-interface/05-VALIDATION.md

key-decisions:
  - "Keep one read-only SQLite connection for the profile lifetime and open write-capable connections only around the four task-specific atomic commit methods."
  - "Resolve config and profile authority before constructing or connecting STDIO transport, with content-free startup failure diagnostics."
  - "Use the same npm command and explicit profile argument shape for Codex and OpenClaw while retaining a host-neutral SDK protocol contract."
  - "Accept Phase 5 signoff only from Vitest JSON structure plus exactly five green requirement rows, complete frontmatter, and non-pending approval."

patterns-established:
  - "MCP application closure: database, person, scopes, aliases, cursor secret, and confirmation service are fixed before any tool call."
  - "Transport purity: the official SDK exclusively owns stdout and application diagnostics expose content-free codes on stderr."
  - "Host-neutral registration: hosts differ only in registry shape; the command, profile authority, and tool catalog are identical."

requirements-completed: [REQ-027, REQ-028, REQ-029]

coverage:
  - id: D1
    description: Complete exact catalog and truthful annotations are exposed from one immutable profile with no umbrella or authority-changing inputs.
    requirement: REQ-028
    verification:
      - kind: integration
        ref: "tests/mcp/tool-catalog.test.ts#05-08 Task 1"
        status: pass
    human_judgment: false
  - id: D2
    description: Real child process initializes, lists, reads, previews, executes, and shuts down while every stdout frame remains valid MCP.
    requirement: REQ-027
    verification:
      - kind: protocol
        ref: "tests/mcp/stdio-server.test.ts#05-08 Task 2"
        status: pass
    human_judgment: false
  - id: D3
    description: Startup fails closed before transport for missing or unknown authority and mutations retain exact one-use server confirmation.
    requirement: REQ-029
    verification:
      - kind: adversarial
        ref: "tests/mcp/stdio-server.test.ts and tests/mcp/confirmation-service.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: Signoff rejects empty, failed, pending, todo, skipped, malformed, duplicate, non-green, or unsigned proof.
    requirement: REQ-029
    verification:
      - kind: unit
        ref: "node scripts/verify-phase-05-signoff.mjs --self-test"
        status: pass
    human_judgment: false

duration: 12min
completed: 2026-07-19
status: complete
---

# Phase 5 Plan 8: Complete Local MCP Server Summary

**A profile-bound sixteen-tool MCP server now serves protocol-clean local STDIO with offline reads, exact confirmed mutations, synthetic Codex/OpenClaw/Hermes-compatible proof, and fail-closed structural signoff**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-19T00:20:56Z
- **Completed:** 2026-07-19T00:32:56Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments

- Composed all six read tools and ten fixed-purpose mutation tools into one SDK `McpServer` with stable assistive-memory and preview-confirm instructions.
- Bound each child to one explicit profile before transport startup, retained one read-only connection, and limited write authority to short-lived SQLite connections around atomic commit methods.
- Added `npm run memory:mcp -- --config <absolute-path> --profile <name>` with no default discovery, no HTTP listener, no daemon lease, SDK-owned stdout, content-free startup failures, and idempotent EOF/signal/EPIPE cleanup.
- Proved initialize, exact `tools/list`, offline status, pure search, proposal preview/confirmed execute, concurrent daemon-like SQLite access, raw frame parsing, and clean EOF shutdown over real spawned child processes.
- Added explicit synthetic Codex and OpenClaw registration shapes, Hermes-compatible raw SDK framing, and local client configuration/safety documentation without altering any real host configuration.
- Added three-mode signoff validation whose embedded negative fixtures fail closed against schema drift, non-passed tests, duplicate/missing/non-green rows, malformed frontmatter, and pending approval.
- Marked REQ-027, REQ-028, and REQ-029 green and completed the five-row Phase 5 validation signoff.

## Task Commits

1. **Task 1 RED: complete catalog and offline application contracts** - Not committed because the single required attempt failed with `.git/index.lock` permission denial.
2. **Task 1 GREEN: explicit-profile application composition** - Not committed because the single required attempt failed with `.git/index.lock` permission denial.
3. **Task 2 RED: real STDIO lifecycle contracts** - `2cbf5d6` (test)
4. **Task 2 GREEN: command, host shapes, signoff gate, and documentation** - Not committed because the single required attempt failed with `.git/index.lock` permission denial.

No hook bypass, force-stage, Git metadata change, stash, reset, clean, or commit retry workaround was used.

## Files Created/Modified

- `src/mcp/tool-catalog.ts` - Finite composition of the six read and ten mutation registrations.
- `src/mcp/server.ts` - Immutable-profile application, SDK server instructions, read-only lifecycle, and short-lived atomic write proxy.
- `src/mcp/server-command.ts` - Required-flag parsing, pre-transport profile resolution, STDIO connection, sanitized failure, and deterministic cleanup.
- `scripts/verify-phase-05-signoff.mjs` - Self-test, Vitest JSON, and structural validation modes.
- `docs/integrations/local-mcp-clients.md` - Codex/OpenClaw command/argument examples, profile rules, safety notes, and signoff commands.
- `package.json` - `memory:mcp` local STDIO script.
- `tests/mcp/tool-catalog.test.ts` - Complete catalog, annotation, offline read, and confirmed mutation application proof.
- `tests/mcp/stdio-server.test.ts` - Real SDK/raw-frame lifecycle, host registration, authority failure, concurrency, clean-channel, and shutdown proof.
- `.planning/phases/05-generic-mcp-interface/05-VALIDATION.md` - All five requirement rows green with complete approved final signoff.

## Decisions Made

- A proxy over the read-only store exposes all preview reads but intercepts only the four atomic commit methods to open and immediately close a write-capable connection. This prevents the interactive facade from holding broad write authority or using daemon operations.
- Cursor and confirmation secrets are process-local. The startup profile, person, complete scope allow-list, source aliases, and database path never enter tool input.
- Startup exceptions collapse to `MEMORY_MCP_STARTUP_FAILED`; they do not disclose the config path, profile, database, person, source, or fixture content.
- Codex and OpenClaw examples use the same `npm --silent --prefix ... run memory:mcp -- ...` child command. Host brand never changes memory authority.
- The signoff parser ignores legend, prose, and checklist status words and evaluates only the named table columns, exact requirement rows, frontmatter, and standalone approval.

## Deviations from Plan

None - plan behavior and scope were implemented exactly as specified. The client-registration document makes the requested Codex/OpenClaw configuration and signoff guidance explicit without touching real host state.

## Issues Encountered

- Task 1 RED, Task 1 GREEN, and Task 2 GREEN each made exactly one required staging/commit attempt and hit `fatal: Unable to create .../.git/index.lock: Operation not permitted`. The Task 2 RED commit succeeded as `2cbf5d6`. Verified remaining changes are intact in the shared checkout.
- Node 24 emits an experimental SQLite warning on stderr. It is content-free; synthetic protocol tests suppress it in spawned host registrations to make application-owned diagnostic assertions exact. Production code emits no data-bearing diagnostic.

## TDD Gate Compliance

- Task 1 RED failed for the intended missing `src/mcp/server.ts` module, but its RED and GREEN commits were blocked by the documented Git index restriction.
- Task 2 RED committed as `2cbf5d6` after failing for the intended missing `server-command.ts`; the GREEN implementation passes but its commit was blocked by the same restriction.
- Functional RED/GREEN behavior is proven; unavailable commit gates are environmental exceptions.

## Known Stubs

None - no Plan 05-08 todo, placeholder, fake production data path, empty UI-bound value, TODO, or FIXME remains. Empty arrays in the signoff script and tests are bounded local accumulators, not product stubs.

## Verification

- `node scripts/verify-phase-05-signoff.mjs --self-test` — PASS.
- MCP JSON reporter plus `--vitest-json` gate — PASS; 68 passed assertions, zero failed/pending/todo/non-passed.
- `node scripts/verify-phase-05-signoff.mjs --validation .../05-VALIDATION.md` — PASS; exactly five green rows, complete frontmatter, approved standalone signoff.
- `npx vitest run tests/mcp` — PASS; 7 files, 68 tests.
- `npm test` — PASS; 56 files, 380 tests.
- `npm run typecheck` — PASS.
- `npm run hermes:smoke` — PASS with temporary synthetic SQLite state.
- `git diff --check` — PASS.
- Raw child STDIO lifecycle — PASS; initialize and tools/list frames parsed as JSON-RPC and EOF exited zero.
- Semantic read snapshots — PASS in the complete read and catalog suites; reads remain byte-equivalent while the daemon reports offline.

## Privacy and Workspace-Isolation Review

- Only synthetic temporary profiles, databases, source roots, source code, ADRs, and planning artifacts were used. No real Codex, Claude Code, OpenClaw, Hermes, legal/client, or other user history was inspected or imported.
- The command requires an explicit config and named profile before transport connects. Tools cannot change database, person, scopes, source roots, or disclosure aliases.
- Mixed-scope and cross-person filtering stays inside strict read/review services; confirmation binding and task-specific atomic store commits remain server-enforced.
- No stdout logging, secret storage, raw content diagnostics, native-source mutation, external model call, HTTP endpoint, remote authentication path, synchronization loop, or daemon lease was introduced.

## Threat Flags

None - the new STDIO and SQLite trust surfaces are exactly T-05-STDIO, T-05-OFFLINE, T-05-CATALOG, and T-05-SC from the plan threat model; no unplanned network, auth, filesystem discovery, or schema boundary was added.

## User Setup Required

Optional only: register the documented local command in a supported host using an absolute config path and explicitly chosen profile. Automated acceptance altered no real host configuration.

## Next Phase Readiness

- Phase 5 is machine-approved with all five requirement rows green and no deferred/skipped MCP contract.
- Phase 6 may add synchronization without changing the STDIO facade's profile authority or allowing the facade to acquire daemon synchronization ownership.
- Phase 7 may add onboarding/profile UI while preserving explicit named-profile startup and fail-closed configuration.
- A Git-writable environment must commit the intact Task 1 and Task 2 GREEN files, this summary, and state metadata.

## Self-Check: PASSED

- Every created production, test-support, documentation, validation, and summary artifact exists.
- Commit `2cbf5d6` exists; the documented index-lock failures account for the unavailable Task 1 and Task 2 GREEN commits.
- No `05-08` todo remains, structural validation still passes, and every plan-level automated, full-suite, typecheck, Hermes smoke, diff, privacy, and protocol check is green.

---
*Phase: 05-generic-mcp-interface*
*Completed: 2026-07-19*
