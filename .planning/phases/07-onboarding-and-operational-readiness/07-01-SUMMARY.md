---
phase: 07-onboarding-and-operational-readiness
plan: 01
subsystem: cli
tags: [tsx, cli-dispatcher, node-esm, vitest]

# Dependency graph
requires:
  - phase: 05-mcp-and-daemon
    provides: existing *-command.ts modules (bootstrap, status, daemon, imports, hermes, mcp server) that this plan wraps
provides:
  - "src/cli/bin.ts and src/cli/command-registry.ts: in-process argv dispatcher for the unified memory CLI"
  - "bin/memory executable shim with package.json bin field"
  - "main(argv: string[]) exported from all 20 existing *-command.ts modules"
affects: [07-02, 07-03, 07-04, "any later-wave plan that adds a new memory subcommand (init, explain, audit-log, backup, restore, export, tune)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Closed static REGISTRY: Record<string, () => Promise<{ main(argv: string[]): Promise<void> }>> keyed by exact subcommand name; dispatcher rejects unknown names before any import runs"
    - "Command module contract: export async function main(argv: string[]): Promise<void>, guard calls main(process.argv.slice(2)) so memory:* npm scripts keep working standalone"
    - "bin/memory calls dispatch() directly (not via the import.meta.url guard) because it, not src/cli/bin.ts, is the real process entry point when invoked through package.json's bin field"

key-files:
  created:
    - src/cli/bin.ts
    - src/cli/command-registry.ts
    - bin/memory
    - tests/cli/bin.test.ts
  modified:
    - package.json
    - src/bootstrap/bootstrap-command.ts
    - src/bootstrap/status-command.ts
    - src/daemon/daemon-command.ts
    - src/daemon/macos/notification-smoke-command.ts
    - src/imports/codex-discover-command.ts
    - src/imports/codex-import-command.ts
    - src/imports/history-discover-command.ts
    - src/imports/history-import-command.ts
    - src/imports/quarantine-command.ts
    - src/imports/source-delete-command.ts
    - src/imports/source-revoke-command.ts
    - src/integrations/hermes/ingest-command.ts
    - src/integrations/hermes/inject-command.ts
    - src/integrations/hermes/proposals-approve-command.ts
    - src/integrations/hermes/proposals-list-command.ts
    - src/integrations/hermes/proposals-reject-command.ts
    - src/integrations/hermes/resume-command.ts
    - src/integrations/hermes/roscoe-env-command.ts
    - src/integrations/hermes/sleep-command.ts
    - src/mcp/server-command.ts

key-decisions:
  - "bin/memory is plain JavaScript with a #!/usr/bin/env -S npx tsx shebang, not TypeScript: tsx's CLI does not apply its TS transform to extension-less entry scripts, only to files it resolves via .ts/.tsx/.mts/.cts (directly or through imports). A TS-syntax entry file at 'bin/memory' failed with a raw SyntaxError under both direct execution and npx tsx bin/memory."
  - "bin/memory calls dispatch(process.argv.slice(2)) explicitly instead of relying on src/cli/bin.ts's import.meta.url guard, because when memory is invoked as the package.json bin, bin/memory (not src/cli/bin.ts) is process.argv[1], so bin.ts's own guard never matches and dispatch would silently never run."
  - "src/mcp/server-command.ts had no separate main() function (it called runMemoryMcpServerCommand directly from the guard); exported the existing function as `export const main = runMemoryMcpServerCommand` and updated the guard to call main(...) for consistency with the other 19 modules, rather than introducing a redundant wrapper."
  - "REGISTRY subcommand names follow the existing memory:* / hermes:* npm-script naming convention (codex:discover, source:revoke, hermes:proposals:approve, etc.) so the CLI vocabulary matches what's already documented in package.json scripts."

requirements-completed: [REQ-040]

# Metrics
duration: 35min
completed: 2026-07-20
---

# Phase 7 Plan 1: Unified memory CLI Dispatcher Summary

**In-process `memory <subcommand>` dispatcher (src/cli/bin.ts + command-registry.ts) wrapping all 20 existing command modules via a mechanical `main(argv)` export refactor, with a tsx-shebang `bin/memory` shim and no new runtime dependencies.**

## Performance

- **Duration:** 35 min
- **Started:** 2026-07-20T19:44:00Z
- **Completed:** 2026-07-20T19:52:26Z
- **Tasks:** 3
- **Files modified:** 24 (20 command modules + package.json + 3 new CLI files)

## Accomplishments
- All 20 `*-command.ts` modules now export `main(argv: string[]): Promise<void>` while remaining standalone-executable via their existing `memory:*`/`hermes:*` npm scripts (verified: `npm run memory:status` still runs correctly)
- `src/cli/command-registry.ts` provides a closed static allow-list of 20 subcommands (`bootstrap`, `status`, `daemon`, `daemon:notification-smoke`, `codex:discover`, `codex:import`, `discover`, `import`, `quarantine`, `source:delete`, `source:revoke`, `mcp`, `hermes:ingest`, `hermes:inject`, `hermes:proposals:approve`, `hermes:proposals:list`, `hermes:proposals:reject`, `hermes:resume`, `hermes:roscoe-env`, `hermes:sleep`)
- `src/cli/bin.ts` dispatches in-process via dynamic `import()`, with unknown/missing subcommands writing the sorted available list to stderr and setting `process.exitCode = 1` (never throwing, never calling `process.exit`)
- `bin/memory` shim manually verified end-to-end: `./bin/memory status --db <path> --person <id>` succeeds, `./bin/memory bogus` and `./bin/memory` (no args) both exit non-zero with the subcommand list on stderr
- `package.json` gained a `"bin": { "memory": "./bin/memory" }` field
- Full suite (`npm test`): 78 files / 676 tests pass; `npm run typecheck` clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Wave 0 — failing dispatcher contract test** - `1e6efd0` (test)
2. **Task 2: Mechanical main(argv) export refactor across all 20 command modules** - `e03a937` (feat)
3. **Task 3: bin dispatcher, command registry, bin shim, and package.json bin field** - `a3ca008` (feat)

**Plan metadata:** (this commit, see below)

## Files Created/Modified
- `src/cli/command-registry.ts` - closed static subcommand -> dynamic import() map for the 20 existing command modules
- `src/cli/bin.ts` - argv dispatcher (`dispatch(argv)`); unknown/missing subcommand -> stderr list + non-zero exit
- `bin/memory` - plain-JS tsx-shebang executable shim; calls `dispatch()` directly (process entry point, not `src/cli/bin.ts`)
- `tests/cli/bin.test.ts` - dispatcher contract test: known-subcommand routing, unknown/missing-subcommand error shape, every REGISTRY module exports callable `main`
- `package.json` - added `"bin": { "memory": "./bin/memory" }`
- 20 `src/**/*-command.ts` files - `main()` -> exported `main(argv: string[])`, guard unchanged except now calling `main(process.argv.slice(2))`; no `run*Command`/`parseArgs` body touched

## Decisions Made
- `bin/memory` is plain JavaScript (no TS syntax) because tsx's CLI transform does not apply to extension-less entry scripts — confirmed by reproducing a raw `SyntaxError: Unexpected token ':'` with a TS-syntax version, both via direct shebang execution and `npx tsx bin/memory`. Kept `.ts`-syntax code entirely inside `src/cli/bin.ts` (which tsx does transform, being imported by name) and made the shim itself trivial JS.
- `bin/memory` calls `dispatch()` explicitly rather than relying on `src/cli/bin.ts`'s own `import.meta.url` guard, because `bin/memory` — not `src/cli/bin.ts` — is `process.argv[1]` when invoked via the package.json `bin` field; the guard's self-comparison would never match and the CLI would silently no-op. Verified with an end-to-end manual run before and after the fix.
- `src/mcp/server-command.ts` exports its existing `runMemoryMcpServerCommand` as `main` (`export const main = runMemoryMcpServerCommand`) rather than adding a wrapper function, since its signature (`(args: readonly string[]) => Promise<void>`) already matches the required contract.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] bin/memory silently no-op'd because import.meta.url guard never matched**
- **Found during:** Task 3 manual verification (`./bin/memory status ...` produced no output, `./bin/memory bogus` exited 0 instead of 1)
- **Issue:** Initial `bin/memory` implementation just `import`ed `src/cli/bin.ts`, relying on that file's `import.meta.url === pathToFileURL(process.argv[1]).href` guard to auto-run `dispatch`. Since `bin/memory` is the real entry point, `process.argv[1]` points at `bin/memory`, not `src/cli/bin.ts`, so the guard's own self-check never matched and `dispatch` never ran.
- **Fix:** `bin/memory` now imports `{ dispatch }` from `../src/cli/bin.js` and calls `dispatch(process.argv.slice(2))` directly, with its own top-level `.catch` mirroring the standard stderr + `process.exitCode = 1` shape.
- **Files modified:** `bin/memory`
- **Verification:** `./bin/memory status --db <tmp> --person p` prints the expected JSON result and exits 0; `./bin/memory bogus` and `./bin/memory` (no args) both print the sorted subcommand list to stderr and exit 1.
- **Committed in:** `a3ca008` (Task 3 commit)

**2. [Rule 1 - Bug] TypeScript syntax in the `bin/memory` shim caused a raw SyntaxError under tsx**
- **Found during:** Task 3 manual verification, immediately after fixing deviation 1
- **Issue:** The corrected `bin/memory` still used a TS type annotation (`(error: unknown) =>`). Running it via `./bin/memory ...` or `npx tsx bin/memory ...` failed with `SyntaxError: Unexpected token ':'` — tsx's CLI only applies its TypeScript transform to files with a `.ts`/`.tsx`/`.mts`/`.cts` extension (directly or via import resolution), not to extension-less entry scripts, even under the `npx tsx <file>` invocation form.
- **Fix:** Rewrote `bin/memory` as plain JavaScript (dropped the `: unknown` annotation), keeping all TypeScript-typed logic inside `src/cli/bin.ts`, which the shim imports by name and which tsx does transform correctly.
- **Files modified:** `bin/memory`
- **Verification:** `./bin/memory status --db <tmp> --person p` and `npm run memory:status -- --db <tmp> --person p2` both succeed; `npm run typecheck` and `npm test` (78 files / 676 tests) pass.
- **Committed in:** `a3ca008` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 - bugs discovered during required manual verification of the `bin/memory` shim, not covered by the plan's automated vitest assertions since those exercise `dispatch()` directly rather than the shim process)
**Impact on plan:** Both fixes were required for the plan's own must-haves ("A user can run `memory <subcommand>` from a single executable") to actually hold when invoked as a real process, not just via direct function calls in tests. No scope creep — no command logic was touched.

## Issues Encountered
None beyond the two auto-fixed issues above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The `REGISTRY` in `src/cli/command-registry.ts` is the attachment point for every later-wave plan in this phase (`init`, `explain`, `audit-log`, `backup`, `restore`, `export`, `tune`) — each adds its own entry once its module exists on disk.
- All 20 existing command modules are now callable in-process via `main(argv)`, unblocking any future orchestration code (e.g. a guided `memory init`) that needs to call multiple existing commands sequentially without spawning subprocesses.
- No blockers for subsequent Wave 1+ plans in phase 07.

---
*Phase: 07-onboarding-and-operational-readiness*
*Completed: 2026-07-20*
