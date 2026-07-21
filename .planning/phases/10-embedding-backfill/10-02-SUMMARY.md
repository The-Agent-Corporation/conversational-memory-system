---
phase: 10-embedding-backfill
plan: 02
subsystem: bootstrap-status
tags: [embedding-backfill, status-command, operator-surface, REQ-042]
requires:
  - src/embeddings/embedder-resolver.ts (probeEmbedderHealth, EmbedderHealth)
  - src/storage/memory-store.ts (listSummaryIdsMissingVector, listSummaries)
provides:
  - EmbeddingBackfillSnapshot interface
  - embeddingBackfill field on MemoryStatusCommandResult
affects:
  - src/bootstrap/status-command.ts
tech-stack:
  added: []
  patterns:
    - "Live re-query snapshot (no persisted sidecar state) for point-in-time completeness reporting"
key-files:
  created: []
  modified:
    - src/bootstrap/status-command.ts
    - tests/bootstrap/status-command.test.ts
decisions:
  - "Derive active (provider, model) identity from EmbedderHealth.enabled rather than trusting probeEmbedderHealth's aspirational config echo: disabled -> deterministic/keyword-hash-v1 (matches what resolveEmbedder actually returns and what backfill actually writes), enabled -> health.provider/health.model."
  - "completedFraction is 1 for an empty corpus (0/0), not NaN or 0, since there is nothing left to backfill."
  - "missingVectors query runs after the initial Promise.all (not inside it) because it depends on the embedder result gathered within that same Promise.all."
metrics:
  duration: "~15min"
  completed: 2026-07-21
---

# Phase 10 Plan 02: Live embeddingBackfill Status Snapshot Summary

Added a live, ground-truth `embeddingBackfill` completeness snapshot to `memory status`, computed by re-querying `listSummaryIdsMissingVector`/`listSummaries` on demand rather than tracking any persisted backfill progress state.

## What Was Built

- `EmbeddingBackfillSnapshot` interface: `{ provider, model, totalSummaries, missingVectors, completedFraction }`.
- `embeddingBackfill` field added to `MemoryStatusCommandResult`, wired into `runMemoryStatusCommand`.
- Identity derivation: when the embedder is disabled (default), the snapshot reports `provider: "deterministic"`, `model: "keyword-hash-v1"` — matching what `resolveEmbedder`/backfill actually write, not `probeEmbedderHealth`'s aspirational config defaults. When enabled, uses `embedder.provider`/`embedder.model` from the already-gathered (non-throwing) `probeEmbedderHealth` result.
- `totalSummaries` reuses the already-gathered `summaries` array (no duplicate `listSummaries()` call); `missingVectors` comes from a single `listSummaryIdsMissingVector(activeProvider, activeModel)` call issued after the embedder identity is known.
- `completedFraction` is `1` for a zero-summary corpus, else `(totalSummaries - missingVectors) / totalSummaries`.
- Only `probeEmbedderHealth` is used (never `resolveEmbedder`), so `memory status` never throws on an enabled-but-broken embedder — it reports `healthy: false` with a reason and still returns a valid completeness snapshot.

## Tasks Completed

1. **RED**: Added three failing assertions to `tests/bootstrap/status-command.test.ts` — disabled-default corpus (K summaries, 0 vectors), partially-populated corpus (K summaries, J vectors), and empty corpus (0 summaries) — all failing because `embeddingBackfill` did not exist yet. Commit `58efb3f`.
2. **GREEN**: Implemented `EmbeddingBackfillSnapshot` + `embeddingBackfill` field in `src/bootstrap/status-command.ts`. All new and existing status tests pass; `npm run typecheck` clean; no `resolveEmbedder` import present. Commit `eae0a06`.

## Deviations from Plan

None — plan executed exactly as written.

## Verification

- `npx vitest run tests/bootstrap/status-command.test.ts` — 5/5 passed (2 pre-existing + 3 new).
- `npx vitest run tests/bootstrap/status-embedder-health.test.ts` — 2/2 passed (no regression to embedder health surface).
- `npm run typecheck` — clean.
- `grep -n "resolveEmbedder" src/bootstrap/status-command.ts` — no matches (only `probeEmbedderHealth` used).

## Known Stubs

None. The snapshot is fully wired to live queries; no placeholder or hardcoded values.

## Threat Flags

None. This plan extends an existing read-only operator surface (`memory status`) with a corpus-wide count that has the same scope as the pre-existing `historicalSummaryCount` field (T-10-07, disposition: accept, already covered by the plan's threat model). No new endpoint, auth path, or trust boundary is introduced.

## Self-Check: PASSED

- FOUND: src/bootstrap/status-command.ts
- FOUND: tests/bootstrap/status-command.test.ts
- FOUND: 58efb3f (test commit)
- FOUND: eae0a06 (feat commit)
