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

## D-12-2 — `gsd-sdk` invocation path

`npx gsd-sdk` 404s in this repo; the working binary is `/Users/aaronwhaley/.local/bin/gsd-sdk`. Found by
the planner 2026-07-28. Executors should use the absolute path. Unrelated to the separately-known bug
where `state.advance-plan`, `state.update-progress`, and `record-session` corrupt STATE.md.
