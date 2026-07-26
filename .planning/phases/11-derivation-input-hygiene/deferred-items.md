# Deferred Items — Phase 11

_No open deferred items. The one entry raised during execution is resolved below._

---

## RESOLVED — `tests/mcp/stdio-server.test.ts` failure was a worktree artifact, not a regression or a flake

- **Raised during:** Plan 03 full-suite check (and independently by Plan 02, which attributed it to a
  missing `node_modules/tsx` inside its worktree).
- **Symptom as reported:** `MCP SDK-driven STDIO lifecycle contract` fails with a stderr mismatch
  (`MEMORY_MCP_STARTUP_FAILED`) plus a companion 5000ms timeout waiting on subprocess stdin EOF.
- **Both executors characterised it as "pre-existing" — that was wrong**, and direct measurement
  contradicts it:

  | Check | HEAD | Result |
  |---|---|---|
  | Full suite, immediately before Wave 1 | `73d0fb2` | 785 passed / 4 skipped — **green** |
  | `stdio-server.test.ts` alone, on the exact worktree base | `9d3f813` | 5 passed — **green** |
  | Full suite, after merging Wave 2 | `7e54fb7` | 846 passed / 4 skipped — **green** |
  | `stdio-server.test.ts` alone, post-merge | `7e54fb7` | 5 passed — **green** |

- **Actual cause:** the test spawns a real subprocess through `tsx`, which resolves from
  `node_modules/`. Agent worktrees do not carry `node_modules/`, so the subprocess failed to start
  inside the worktree only. Plan 02 diagnosed this correctly; Plan 03 did not, and both then
  mislabelled it "pre-existing".
- **Corroborating signal:** the worktree runs also reported **21 skipped** vs the repo baseline of **4
  skipped** — the same missing-dependency artifact, and further evidence that worktree suite numbers
  are not comparable to the repo baseline.
- **Standing lesson for later waves:** a full-suite run *inside an agent worktree* is not a valid
  regression signal for anything that shells out or spawns a subprocess. The post-merge gate in the
  main checkout is the authoritative result. Executors should judge their own work by targeted suites
  while running in a worktree.
- **Action required:** none. No `src/mcp/` investigation is needed before the next phase.
