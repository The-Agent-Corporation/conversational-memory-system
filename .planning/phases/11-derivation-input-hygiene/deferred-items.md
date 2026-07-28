# Deferred Items — Phase 11

## OPEN — `tests/mcp/mutation-tools.test.ts` "05-04 Task 2 rolls back every durable effect at
each injected transaction boundary" times out under full-suite load

- **Raised during:** Plan 11-17 execution, full `npx vitest run` gate after Task 2.
- **Symptom:** `Test timed out in 5000ms` in the full run (995 passed / 1 failed / 4 skipped),
  reproduced on two consecutive full-suite runs.
- **Isolated run is green:** `npx vitest run tests/mcp/mutation-tools.test.ts -t "05-04 Task 2 ..."`
  passes in 347ms on its own.
- **Out of scope for this plan:** `tests/mcp/mutation-tools.test.ts` was last touched by Plan 05-04
  (commit `e969499`, long before Phase 11); Plan 11-17 touches only
  `src/operations/prune-unhygienic-anchors-command.ts`, its test file, and
  `src/cli/command-registry.ts` — none of which the failing test exercises. This is a timing flake
  under full-parallel-suite CPU contention (111 files), not a regression introduced here (Rule 1
  scope boundary: fix only issues directly caused by the current task's changes).
- **Action required:** none from this plan. Worth a targeted look in a future plan if it recurs
  consistently outside full-suite contention.

_The other entry raised during execution is resolved below._

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

---

## REQ-052's text still encodes the pre-reversal SC1 carve-out (found by Plan 11-26, NOT fixed)

`.planning/REQUIREMENTS.md:86` still reads, verbatim:

> **REQ-052 — Tool-activity collapse:** … **An isolated tool call shall retain normal summarization.** …

That clause is the SC1 carve-out the owner **reversed** on 2026-07-27 (`11-REMEDIATION-DECISION.md`
Decision 1, "Revise SC1 so an isolated tool call is collapsed rather than kept verbatim"). Plan 11-24
amended ROADMAP SC1 in place with the original text preserved, added the ADR 0048 addendum, and marked
the `11-CONTEXT.md` entry superseded — but `REQUIREMENTS.md` was not amended, so the requirement now
contradicts both the roadmap criterion it maps to and the shipped `hygiene-rules/v3` behaviour
(measured: 0/33 packet items carry `[Tool call: ` text at `final-v2`).

REQ-052/053/054 are already marked `Complete` in the traceability table (`REQUIREMENTS.md:113-115`), so
this is a stale-text problem, not a status problem.

**Why Plan 11-26 did not fix it:** out of scope — `REQUIREMENTS.md` is not in 11-26's `files_modified`,
and silently rewording a requirement during a measurement plan is exactly the instrument-tampering
shape this phase's threat register (T-11-93) exists to prevent. Amending a requirement to match shipped
behaviour is a decision, not a cleanup.

**Suggested owner:** Plan 11-14, alongside the SC7 sign-off, applying the same amend-in-place-with-
original-text-preserved convention Plan 11-24 used for ROADMAP SC1.
