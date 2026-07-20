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

## 06-13: Pre-existing full-suite timeouts (out of scope)

- **Found during:** Plan 06-13 full-suite sanity run (`npx vitest run`), after `npm install
  --no-audit --no-fund` populated `node_modules` fresh in this worktree.
- **Symptom:** `tests/mcp/stdio-server.test.ts` (3 of 4 tests) and
  `tests/sync/device-secret-store.test.ts` ("WR-05: Keychain read framing does not deadlock on
  a large secret payload") time out (5s/10s) when run as part of the full suite; both pass
  reliably when their own file is run in isolation (confirmed for
  `tests/sync/device-secret-store.test.ts` via a targeted `npx vitest run` in this same
  session). Consistent with process-spawn/IPC contention under full-suite parallelism in this
  sandboxed environment, not a regression in the files this plan touched.
- **Scope:** Neither file is in plan 06-13's `files_modified` list (relay stores, opaque-relay-
  service, sync-control-service, libsodium-crypto-provider, recovery/revocation tests). Not
  caused by this plan's changes; `npx tsc --noEmit` is clean and every file this plan touched
  (`tests/sync/recovery.test.ts`, `tests/sync/revocation.test.ts`,
  `tests/relay/membership-cas.test.ts`) passes in both isolated and full-suite runs.
- **Action taken:** None (out of scope per executor scope-boundary rule).
- **Suggested follow-up:** Investigate STDIO child-process spawn timing and the Keychain-helper
  IPC framing test under full-suite parallel load; consider raising their `testTimeout` or
  isolating them into a serial project if this proves to be a recurring flake rather than a
  one-off sandbox artifact.
