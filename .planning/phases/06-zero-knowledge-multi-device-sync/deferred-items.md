# Deferred Items

## 06-03: Pre-existing `tests/mcp/stdio-server.test.ts` failures (out of scope)

- **Found during:** Plan 06-03 full-suite sanity run (`npx vitest run`).
- **Symptom:** 2 failures in `tests/mcp/stdio-server.test.ts` — a `MODULE_NOT_FOUND` for
  `node_modules/tsx/dist/cli.mjs` (the `tsx` package is not present in
  `node_modules` at all in this worktree) and a related 5s timeout in the same file.
- **Scope:** This file belongs to Phase 5 (`05-08 Task 2`) STDIO lifecycle contracts, not
  to any file touched by plan 06-03 (`src/sync/secrets/**`, `tests/sync/**`). Not caused by
  this plan's changes.
- **Action taken:** None (out of scope per executor scope-boundary rule). Confirmed the
  failure is a missing `tsx` dependency in `node_modules`, not a code regression.
- **Suggested follow-up:** Reinstall dependencies (`npm install`) in this worktree/environment
  before relying on `tests/mcp/stdio-server.test.ts`, or investigate why `tsx` is absent from
  `node_modules` despite being used by multiple `npm run memory:*` scripts.
