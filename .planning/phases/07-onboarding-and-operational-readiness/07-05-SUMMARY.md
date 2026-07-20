---
phase: 07-onboarding-and-operational-readiness
plan: 05
subsystem: database
tags: [sqlite, cli, health-status, performance-tuning, node:sqlite]

# Dependency graph
requires:
  - phase: 07-onboarding-and-operational-readiness
    provides: "07-04 SqliteStore.getSchemaVersion()/dbFileSizeBytes() + versioned schema-migrations runner"
  - phase: 07-onboarding-and-operational-readiness
    provides: "07-03/07-01 unified memory CLI dispatcher and command-registry.ts"
provides:
  - "src/bootstrap/status-command.ts: extended health surface (db size, schema version + migration applied_at, sync lag, pending proposals, deterministic latency, index-stats-available)"
  - "src/operations/tune-command.ts: runTuneCommand/main exposing a bounded, low-risk tuning knob set (busy_timeout, retrieval default limit/token-budget, REINDEX/ANALYZE)"
  - "SqliteStore.getLatestSchemaMigrationAppliedAt()/getBusyTimeoutMs()/hasIndexStatistics()/reindexAndAnalyze() helpers"
  - "tune subcommand registered in src/cli/command-registry.ts"
affects: [07-06-backup-and-restore]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Tune config persisted as a per-database sidecar JSON file (<db-path>.tune.json), read back by readTuneConfig() — avoids adding a new DB table/schema-migrations entry for a small, low-risk config surface"
    - "Health surface accepts an optional injectable clock ({ now(): number }) so latency reporting is deterministic under test (REQ-040), defaulting to Date.now() in production"

key-files:
  created:
    - src/operations/tune-command.ts
    - tests/bootstrap/status-command.test.ts
    - tests/operations/tune-command.test.ts
  modified:
    - src/bootstrap/status-command.ts
    - src/storage/sqlite-store.ts
    - src/cli/command-registry.ts

key-decisions:
  - "Tuning knobs persist to a JSON sidecar file next to the database file rather than a new SQLite table, to avoid an unplanned schema-migrations entry for what is explicitly a low-risk, closed knob set; SqliteStore.getBusyTimeoutMs()/reindexAndAnalyze() apply the persisted values directly against the live connection"
  - "Sync lag is reported as pending (unsealed) local sync_outbox operations for the person plus the oldest pending operation's createdAt, since sync_frontiers itself carries no timestamp — this reflects how far a device's local writes are from being sealed, which is the actionable lag signal for an operator"
  - "Index health is reported as a boolean (hasIndexStatistics(), i.e. whether ANALYZE has ever run / sqlite_stat1 exists) rather than fabricating synthetic query-plan metrics, since no existing index-stats API exists in the codebase"

patterns-established:
  - "runMemoryStatusCommand(options) accepts an optional clock for deterministic latency assertions; OptionsSchema.parse only validates the serializable databasePath/personId fields, the clock is destructured separately"

requirements-completed: [REQ-040]

# Metrics
duration: 35min
completed: 2026-07-20
---

# Phase 07 Plan 05: Health/Status Surface + Bounded Tuning Knobs Summary

**Extended the existing `memory status` command into a full health surface (DB size, schema version + migration timestamp, sync lag, pending proposals, deterministic query latency, index-stats availability) and added a `memory tune` command exposing three low-risk performance knobs (busy_timeout, retrieval defaults, manual REINDEX/ANALYZE) persisted per-database and registered in the CLI dispatcher.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-07-20T19:59:50Z (approx, immediately after 07-04)
- **Completed:** 2026-07-20T20:22:33Z
- **Tasks:** 3
- **Files modified:** 6 (1 new command file, 2 new test files, 3 modified source files)

## Accomplishments
- `runMemoryStatusCommand`/`MemoryStatusCommandResult` now report `dbFileSizeBytes`, `schemaVersion`, `schemaMigrationAppliedAt`, `syncLag` (pending outbox count + oldest pending `createdAt`), `pendingProposalCount`, and a `performance` block (`queryLatencyMs` via an injectable clock, `indexStatsAvailable`) — all existing fields (`daemon`, counts, `bootstrapCheckpoint`, etc.) retained unchanged.
- `src/operations/tune-command.ts`: `runTuneCommand`/`main` implement `set`/`show`/`reindex` actions over the closed knob set (`busy_timeout`, `retrieval_default_limit`, `retrieval_default_token_budget`), validated by a `.strict()` Zod schema with the same numeric bounds already enforced elsewhere (`SqliteStoreOptions.busyTimeoutMs` 1-30000, `read-tools.ts` limit/token-budget bounds).
- `tune` registered in `src/cli/command-registry.ts`; `tests/cli/bin.test.ts`'s dynamic-import contract test already covers it (all registry entries export a callable `main`).
- RED→GREEN TDD: `tests/bootstrap/status-command.test.ts` (2 tests) and `tests/operations/tune-command.test.ts` (5 tests) written first and confirmed failing before implementation.

## Task Commits

Each task was committed atomically:

1. **Task 1: Wave 0 — failing health + tuning tests** - `0025c28` (test)
2. **Task 2: Extend status into the health/reporting surface** - `d93e35e` (feat)
3. **Task 3: Bounded tuning knobs command** - `b723d61` (feat)

**Plan metadata:** (this commit, see below)

## Files Created/Modified
- `src/bootstrap/status-command.ts` - extended `MemoryStatusCommandOptions`/`MemoryStatusCommandResult` with health fields; `runMemoryStatusCommand` now aggregates db size, schema version/migration timestamp, sync lag, pending proposals, and deterministic latency + index-stats-available
- `src/storage/sqlite-store.ts` - added `getLatestSchemaMigrationAppliedAt()`, `getBusyTimeoutMs()`, `hasIndexStatistics()`, `reindexAndAnalyze()` helpers consumed by the health surface and tune command
- `src/operations/tune-command.ts` (new) - `runTuneCommand`/`readTuneConfig`/`main`, bounded knob set, per-database JSON sidecar persistence
- `src/cli/command-registry.ts` - registered `tune -> operations/tune-command.js`
- `tests/bootstrap/status-command.test.ts` (new) - health-surface RED→GREEN coverage against synthetic fixtures + injected clock
- `tests/operations/tune-command.test.ts` (new) - knob set-and-apply, bounds rejection, and REINDEX/ANALYZE coverage

## Decisions Made
- Tuning config persists to `<db-path>.tune.json` rather than a new SQLite table/schema-migrations entry — keeps the knob set's storage mechanism proportional to its low-risk, closed scope and avoids expanding this plan's `files_modified` beyond what was declared.
- Sync lag is defined as pending (`status === "pending"`) `sync_outbox` rows plus the oldest one's `createdAt`, since `sync_frontiers` carries no timestamp column; this is the closest available "how far behind is this device" signal without inventing new sync state.
- Index health is a boolean (`hasIndexStatistics()`) rather than synthetic latency/plan numbers, since no query-plan introspection exists elsewhere in the codebase to build on.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added SqliteStore helper methods not listed in files_modified**
- **Found during:** Task 2/3 (health surface + tune command implementation)
- **Issue:** The plan's `files_modified` for 07-05 lists only `status-command.ts`, `tune-command.ts`, `command-registry.ts`, and their tests — but fulfilling the plan's own must-have truths (schema version + migration `applied_at`, index health reporting, `busy_timeout` read-back, manual REINDEX/ANALYZE) required raw SQL access (`pragma busy_timeout`, `schema_migrations` table, `sqlite_stat1` presence, `REINDEX`/`ANALYZE`) that only `SqliteStore`'s private `database` handle can perform.
- **Fix:** Added four small, single-purpose public methods to `SqliteStore` (`getLatestSchemaMigrationAppliedAt()`, `getBusyTimeoutMs()`, `hasIndexStatistics()`, `reindexAndAnalyze()`), mirroring the exact style/precedent of 07-04's `getSchemaVersion()`/`dbFileSizeBytes()` additions to the same class.
- **Files modified:** `src/storage/sqlite-store.ts`
- **Verification:** `npx vitest run tests/storage/sqlite-store.test.ts tests/storage/schema-migrations.test.ts tests/storage/schema-migrations-concurrency.test.ts` — 16/16 passed; full `npm test` — 707/707 passed; `npm run typecheck` clean.
- **Committed in:** `d93e35e` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical)
**Impact on plan:** Necessary to deliver the plan's own must-have truths (schema version/applied_at, index health, busy_timeout verification, REINDEX/ANALYZE) without reaching into `SqliteStore`'s private internals from another module. No scope creep beyond what D-06/D-09 require; no data-semantics change.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Health surface (`memory status`) and tuning (`memory tune`) are both complete and registered in the CLI dispatcher, satisfying D-06 and D-09.
- `SqliteStore.reindexAndAnalyze()`, `getBusyTimeoutMs()`, `hasIndexStatistics()`, `getLatestSchemaMigrationAppliedAt()` are available for 07-06 (backup/restore) or any future operational-readiness plan that needs the same introspection.
- `npm test` is fully green (86 files, 707 tests) — the `tsx`-missing gap flagged in 07-04's summary was resolved by this plan's `npm install --no-audit --no-fund`, so `tests/mcp/stdio-server.test.ts` now passes as well.

---
*Phase: 07-onboarding-and-operational-readiness*
*Completed: 2026-07-20*

## Self-Check: PASSED

All created/modified files verified present on disk; all three task commit hashes (`0025c28`, `d93e35e`, `b723d61`) verified present in git log.
