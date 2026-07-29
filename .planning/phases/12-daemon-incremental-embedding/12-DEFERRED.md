# Phase 12 — Deferred Items

## D-12-1 — Stale-vector detection needs a write-marker on `SummarySchema`

**Raised:** 2026-07-28 (plan-check F5, adjudicated in the re-check)
**Disposition for Phase 12:** accepted limitation, recorded in ADR 0052 decision 6
**Target:** the phase that adds the field — Phase 13/14 vector-native trace work
**Owner:** unassigned (see note below)

The embedding repair pass heals **missing** vectors but can never detect a **stale** one — a vector whose
summary text changed after it was embedded.

**Verified root cause, 2026-07-28.** `SummarySchema` (`src/domain/types.ts:104-129`) carries `createdAt`,
`version`, and `lastAccessedAt` but **no `updatedAt`**, and `src/daemon/contraction-runner.ts:447` sets
`version: 1` unconditionally on every emit. `lastAccessedAt` is a read-time field, not a write marker.
There is therefore no monotonic field to compare a vector's `createdAt` against.

**Why it matters:** the failure is silent. `memory status` reports `missingVectors: 0` while a vector no
longer matches its summary text. A failed upsert on a re-emitted active span becomes permanent once the
topic closes.

**Why it is not fixed here:** the remedy is a one-field schema change — a content hash or `updatedAt` on
`SummarySchema` — which belongs with the vector-native work, not with daemon wiring. A heuristic
substitute would be worse than the gap, and ADR 0052 forbids inventing one.

**Tracking note.** The plan-checker recommended filing this in `bd` so it has a named owner rather than
only being discoverable in an ADR. **This repo has no beads database** (`bd create` → "no beads database
found"), and initializing one is not a Phase 12 decision. Raised to the owner instead; recorded here and
in ADR 0052 decision 6 in the meantime.

## D-12-3 — `memory status` costs 50 s on the live corpus, and it is not the vector query

**Raised:** 2026-07-29 by the Plan 12-05 executor, measured on the live corpus
**Disposition for Phase 12:** out of scope — pre-existing, unrelated to any Phase 12 change
**Target:** unassigned

`memory status --db ~/.memory/aaron.db --person aaron` takes **50 s** wall clock and self-reports
`performance.queryLatencyMs: 49047`. That figure is **not** `listSummaryIdsMissingVector`, which measures
**22 ms** on the same corpus with the v4 covering index.

**Root cause:** `queryLatencyMs` (`status-command.ts:178-218`) spans the entire `Promise.all` at lines
179-195, which fully materializes `listCanonicalEvents` (292,407 rows), `listSummaries` (138,373) and
`listSyncOutboxOperations` (301,132 pending) into JS arrays purely to take their `.length`. Count queries
would answer the same questions in milliseconds.

**Why not fixed here:** it is a `MemoryStore` interface question (count-only methods on both
`SqliteStore` and `InMemoryStore`), pre-dates Phase 12, and is outside Plan 12-05's scope boundary.

**Why it matters to 12-07:** a backfill progress display must not poll `memory status` in a loop — each
poll costs ~50 s and reads the whole corpus. Query `listSummaryIdsMissingVector` (or a count of
`summary_vectors`) directly instead.

## D-12-2 — `gsd-sdk` invocation path

`npx gsd-sdk` 404s in this repo; the working binary is `/Users/aaronwhaley/.local/bin/gsd-sdk`. Found by
the planner 2026-07-28. Executors should use the absolute path. Unrelated to the separately-known bug
where `state.advance-plan`, `state.update-progress`, and `record-session` corrupt STATE.md.
