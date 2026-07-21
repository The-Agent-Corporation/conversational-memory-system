---
status: partial
phase: 10-embedding-backfill
source: [10-VERIFICATION.md]
started: 2026-07-21T21:45:00Z
updated: 2026-07-21T21:45:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Full-corpus backfill completes with zero missing vectors
expected: Running `memory backfill-embeddings` against the real dogfooding database (~3.5GB, 292,407 events / 135,366 summaries) completes, and `memory status` afterward reports zero summaries missing a vector for the active (provider, model).
result: [pending]

### 2. Kill/restart resumes without re-embedding or corruption
expected: SIGKILL-ing the real running backfill process mid-run and restarting it resumes from where it left off — no re-embedding of already-completed summaries, no corrupted saved vectors.
result: [pending]

### 3. Idempotent second run performs zero additional writes
expected: Re-running `memory backfill-embeddings` to completion a second time after it already finished performs zero additional writes, confirmed via an independent check (e.g. row-count/mtime comparison), not the test spy.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
