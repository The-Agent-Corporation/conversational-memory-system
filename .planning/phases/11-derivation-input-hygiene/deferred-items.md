# Deferred Items — Phase 11

## tests/mcp/stdio-server.test.ts flakiness (found during Plan 03 full-suite check)

- **Found during:** Plan 03, post-implementation `npx vitest run` (full suite)
- **Symptom:** `MCP SDK-driven STDIO lifecycle contract > 05-08 Task 2 ...` fails with a stderr
  mismatch (`MEMORY_MCP_STARTUP_FAILED` vs actual) and a companion test times out at 5000ms
  waiting on subprocess stdin EOF.
- **Scope:** `tests/mcp/stdio-server.test.ts` spawns a real subprocess to exercise MCP STDIO
  server startup/shutdown. Plan 03 touches only `src/integrations/hermes/adapter.ts` and
  `src/compaction/pre-compactor.ts` — no relation to the MCP stdio server, its startup path, or
  process lifecycle.
- **Action taken:** None (out of scope per executor scope-boundary rule). Not fixed, not
  investigated further.
- **Suspected cause (unverified):** subprocess-spawn timing sensitivity in this worktree's
  environment; likely pre-existing/flaky rather than caused by this plan's changes.
- **Recommendation:** Re-run `npx vitest run tests/mcp/stdio-server.test.ts` in isolation on
  `main` (pre-Plan-03) to confirm this is not a regression before the next phase touches
  `src/mcp/`.
