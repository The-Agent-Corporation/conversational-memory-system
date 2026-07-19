---
phase: 04-continuous-local-daemon
plan: "15"
subsystem: daemon
tags: [daemon, zod, sqlite-migration, contraction, importer-fixtures]
requires:
  - phase: 04-continuous-local-daemon
    provides: staged generation, proposal cadence, processed-boundary metadata, and transactional legacy backfill from Plan 04-11
provides:
  - Strict required contraction generation, proposal baseline, and processed-boundary schemas
  - One explicit stable-job constructor shared by Codex, Claude Code, OpenClaw, and Hermes
  - Generation-stable contraction checkpoints with exact processed canonical tuple boundaries
  - Fully migrated synthetic daemon fixtures and green repository-wide TypeScript compilation
affects: [04-16, 04-17, 04-18, 04-19, daemon-verification]
tech-stack:
  added: []
  patterns: [strict-current-schema, sqlite-pre-parse-legacy-normalization, shared-importer-job-constructor, exact-canonical-processed-boundary]
key-files:
  created: []
  modified:
    - src/daemon/types.ts
    - src/imports/codex-importer.ts
    - src/daemon/contraction-runner.ts
    - src/storage/sqlite-store.ts
    - tests/daemon/daemon-store.test.ts
    - tests/daemon/contraction-runner.test.ts
    - tests/daemon/scheduler.test.ts
    - tests/daemon/daemon-loop.test.ts
key-decisions:
  - "Current runtime schemas reject missing generation, proposal baseline, and processed-boundary fields; compatibility exists only in the SQLite startup migration."
  - "A contraction checkpoint carries its durable job generation unchanged and records the last canonical tuple committed by that slice."
patterns-established:
  - "All four native import formats delegate stable contraction-job creation to commitStagedGrantBatch with generation 1 and a null proposal baseline."
  - "Legacy SQLite rows are normalized before strict parsing, while in-memory and direct schema boundaries accept only the current shape."
requirements-completed: [REQ-019, REQ-021, REQ-022]
coverage:
  - id: D1
    description: Every current producer and fixture supplies strict durable contraction metadata explicitly.
    requirement: REQ-019
    verification:
      - kind: integration
        ref: "npx vitest run tests/daemon tests/imports/codex-history.test.ts tests/imports/multi-source-history.test.ts tests/imports/universal-import-bootstrap.test.ts"
        status: pass
      - kind: other
        ref: "npm run typecheck"
        status: pass
    human_judgment: false
  - id: D2
    description: Legacy SQLite payloads normalize transactionally before entering the same strict parser used by current records.
    requirement: REQ-019
    verification:
      - kind: integration
        ref: "tests/daemon/daemon-store.test.ts#backfills legacy SQLite contraction payloads transactionally and byte-stably"
        status: pass
    human_judgment: false
  - id: D3
    description: Contraction checkpoints preserve the job generation and exact last processed canonical tuple across bounded slices.
    requirement: REQ-022
    verification:
      - kind: integration
        ref: "tests/daemon/contraction-runner.test.ts#yields at 250 events and resumes by stable canonical key instead of a count"
        status: pass
    human_judgment: false
duration: 5min
completed: 2026-07-18
status: complete
---

# Phase 4 Plan 15: Strict Durable Producer Migration Summary

**Strict contraction metadata now originates explicitly from every production producer and synthetic fixture, while legacy SQLite rows remain readable through a boundary-only transactional migration.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-07-18T16:03:00Z
- **Completed:** 2026-07-18T16:07:42Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments

- Restored strict required Zod fields for `generation`, `lastProposalRunAt`, and `processedThroughOrderKey`; direct current-shape parsing can no longer silently invent durable metadata.
- Updated the shared `commitStagedGrantBatch` job producer used by Codex, Claude Code, OpenClaw, and Hermes with explicit new-job generation and proposal cadence metadata.
- Updated `ContractionRunner` to retain the current durable job generation, preserve the explicit nullable proposal baseline, and checkpoint the exact last canonical tuple committed in each slice.
- Migrated all daemon job fixtures to explicit strict fields and retained the raw SQLite close/reopen test as the sole intentional missing-field input.
- Restored a green repository-wide TypeScript compilation after the complete producer/fixture migration.

## Task Commits

Git commits were intentionally not attempted. This shared execution environment exposes Git metadata read-only, and the parent explicitly required implementation and verification without retrying commits or claiming hashes.

1. **Task 1: Migrate every production durable-record producer** - unavailable (read-only Git metadata)
2. **Task 2: Migrate every daemon fixture and run post-migration typecheck** - unavailable (read-only Git metadata)

**Plan metadata:** unavailable (read-only Git metadata)

## Files Created/Modified

- `src/daemon/types.ts` - Removes compatibility preprocess defaults so all three durable fields are required at current runtime/type boundaries.
- `src/imports/codex-importer.ts` - Adds generation 1 and a null proposal baseline to the one stable job constructor shared by all four importers.
- `src/daemon/contraction-runner.ts` - Carries the job generation and proposal baseline forward and records the last processed canonical tuple.
- `src/storage/sqlite-store.ts` - Normalizes missing legacy job metadata before strict parsing, alongside the existing canonical processed-boundary reconstruction.
- `tests/daemon/daemon-store.test.ts` - Proves direct strict parsing rejects missing current fields while the raw SQLite reopen migration remains compatible.
- `tests/daemon/contraction-runner.test.ts` - Migrates the shared job fixture and asserts exact generation/processed-boundary output at the 250-event slice.
- `tests/daemon/scheduler.test.ts` - Migrates the direct scheduler contraction-job fixture.
- `tests/daemon/daemon-loop.test.ts` - Migrates the durable daemon-loop work fixture; its other job fixture was already strict.

## Decisions Made

- Compatibility defaults do not belong in reusable runtime schemas after the migration. Only the SQLite constructor migration may synthesize legacy defaults, and it immediately validates the normalized record through the strict schema.
- Checkpoint generation describes the durable work-range epoch, not the number of slices. Each slice therefore carries `job.generation` rather than incrementing it.
- `processedThroughOrderKey` is derived from the last event actually included in the committed slice and is null when that slice contains no canonical event.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Preserved legacy SQLite readability after strict schema restoration**
- **Found during:** Task 1 strict-schema hardening
- **Issue:** Plan 04-11's SQLite migration parsed legacy job payloads through the temporary schema defaults. Removing those defaults without moving normalization to the database boundary would make existing databases fail to reopen.
- **Fix:** Added explicit missing-field normalization for `generation=1` and `lastProposalRunAt=null` inside the existing transactional SQLite migration before invoking `ContractionJobSchema.parse`.
- **Files modified:** `src/storage/sqlite-store.ts`
- **Verification:** The legacy close/reopen and byte-stability test passes within the 98-test focused suite.
- **Commit:** unavailable because Git metadata is read-only

---

**Total deviations:** 1 auto-fixed (1 Rule 2 missing critical functionality)
**Impact on plan:** This is the required implementation of the plan's legacy-boundary guarantee and introduces no new storage or trust surface.

## Issues Encountered

- The working tree was already substantially dirty with completed Phase 4 work and unrelated tracked changes. Only the eight plan-owned implementation/test files and this summary were changed for Plan 04-15; nothing was cleaned or reverted.
- The pre-migration typecheck reproduced only the five expected staged-shape diagnostics documented by Plans 04-11 and 04-14. After the producer and fixture migration, typecheck exits successfully.

## TDD Gate Compliance

- Existing strict-schema, importer, runner, scheduler, daemon-loop, and SQLite migration tests supplied the RED signal through the expected pre-migration TypeScript failures.
- Final GREEN: 24/24 task-focused tests and 98/98 complete daemon/import tests pass; repository-wide typecheck is green.
- RED/GREEN commits are unavailable because Git metadata is read-only.

## Verification

- `npx vitest run tests/imports/codex-history.test.ts tests/imports/multi-source-history.test.ts tests/imports/universal-import-bootstrap.test.ts tests/daemon/contraction-runner.test.ts` - 24 passed across 4 files.
- `npx vitest run tests/daemon tests/imports/codex-history.test.ts tests/imports/multi-source-history.test.ts tests/imports/universal-import-bootstrap.test.ts` - 98 passed across 10 files (82 daemon tests plus 16 focused importer tests).
- `npm run typecheck` - passed with no diagnostics.
- `git diff --check` - passed.

## Privacy and Isolation Review

- All changed metadata remains content-free: person/job IDs, canonical tuple keys, generation counters, timestamps, and nullable proposal cadence state only. No transcript, source body, tool result, raw error, native path, credential, or client/case material was added.
- The shared importer job constructor preserves the grant's exact `personId`; Claude Code, OpenClaw, and Hermes continue to delegate to that audited seam without hidden job literals.
- Contraction processing still reads canonical events by exact person, validates source ownership and scope dependencies, and preserves provenance on turns, summaries, and anchors.
- Tests use synthetic people, events, locators, and temporary SQLite databases only. No real native history, external model, network service, or live OS integration was accessed.
- Proposal metadata remains scheduling state only. Box and trace changes remain proposed and require human review; nothing was auto-approved.

## Known Stubs

None.

## Threat Flags

No unplanned threat surface was introduced. The current-schema/legacy-payload trust boundary and the shared four-importer constructor boundary are both explicitly covered by the plan threat model and passing synthetic tests.

## Next Phase Readiness

- Plans 04-16 through 04-19 can now rely on strict, explicit generation/proposal/boundary fields across all current producers and fixtures.
- Global typecheck is restored, so subsequent lease-token propagation work will surface only newly introduced shape regressions.
- The parent orchestrator retains ownership of phase-level STATE/ROADMAP/requirements updates and any later Git commits from a metadata-writable environment.

## Self-Check: PASSED

- All eight declared implementation/test files exist, and `04-15-SUMMARY.md` exists with `status: complete`.
- The one shared stable-job constructor is reached by all four importers; no separate Claude Code, OpenClaw, or Hermes contraction-job literal exists.
- Strict direct parsing rejects missing fields, while the raw legacy SQLite reopen test normalizes and validates old payloads transactionally and byte-stably.
- Focused tests, full daemon/import regression, global typecheck, and diff hygiene all pass.
- Commit verification is intentionally unavailable and accurately documented without claiming a hash.

---
*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-18*
