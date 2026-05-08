# ADR 0039: Roscoe Integration Readiness

## Status

Accepted

## Context

Roscoe-Hermes already contains optional bridge hooks for unified timeline ingestion, memory context injection, and resume. The standalone memory system now supports the full command surface needed for the accordion memory loop.

The remaining risk is operational: Roscoe needs a clear environment contract and smoke verification against one shared SQLite database.

## Decision

Add `hermes:roscoe-env` to render Roscoe-ready environment variables and command strings. Extend the smoke harness so it covers ingest, compaction, injection, resume, sleep review, and proposal listing.

Document the integration at `docs/integrations/roscoe-hermes.md`.

Do not edit Roscoe-Hermes in this phase. Its existing bridge hooks are present, and its current local worktree contains unrelated changes.

## Consequences

- Roscoe can be configured by sourcing generated environment exports.
- The standalone repo can verify the runtime contract without requiring Roscoe changes.
- The next Roscoe-side task is narrow: expose trace and box resume arguments in `conversational_memory_resume`.
