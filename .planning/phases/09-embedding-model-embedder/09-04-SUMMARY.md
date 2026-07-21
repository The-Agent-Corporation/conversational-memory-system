---
phase: 09-embedding-model-embedder
plan: 04
subsystem: embeddings
tags: [embeddings, config, resolver, cli, zod, opt-in]

# Dependency graph
requires:
  - phase: 09-embedding-model-embedder
    provides: "plan 01's config/resolver skeletons and Embedder/AsymmetricEmbedder contracts; plan 03's real TransformerEmbedder + vendorModel implementations"
provides:
  - "Persisted embeddings config sidecar (${dbPath}.embeddings.json), disabled by default (SC1)"
  - "resolveEmbedder(databasePath): default/enabled/broken resolution per D-04/D-05, never silently falling back to the hash embedder when enabled-but-broken"
  - "probeEmbedderHealth(databasePath): non-throwing health probe for daemon/memory health surface (D-06)"
  - "memory embeddings enable|disable|show CLI command, registered in command-registry"
affects: [09-embedding-model-embedder plan 05, plan 06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "zod-strict sidecar config mirroring tune-command.ts's ${dbPath}.tune.json pattern, disabled-by-default schema"
    - "resolver never catches init() failures in the enabled branch — propagates to caller (D-05); a separate non-throwing probe function serves health-surface consumers (D-06)"
    - "enable command sequences vendor-then-persist: config is only flipped to enabled:true after vendorModel resolves, so a failed/partial install never corrupts the resolver's default"

key-files:
  created:
    - src/operations/embeddings-command.ts
  modified:
    - src/embeddings/embeddings-config.ts
    - src/embeddings/embedder-resolver.ts
    - src/cli/command-registry.ts

key-decisions:
  - "The embedder-resolver.test.ts 'enabled with a present, healthy model' test remains RED in this environment: it requires a real vendored model on disk, and no network/model artifact is available here. This mirrors plan 03's precedent (golden-vector and network-dependent vendoring tests) and is explicitly the phase's stated scope for plan 05 ('remaining RED confined to real-model-dependent tests')."

patterns-established: []

requirements-completed: [REQ-044]

# Metrics
duration: 25min
completed: 2026-07-21
---

# Phase 9 Plan 04: Config Sidecar + Embedder Resolver + CLI Command Summary

**Wired the opt-in surface end to end: a disabled-by-default config sidecar, a resolver that hard-errors on enabled-but-broken (never silently falling back to the hash embedder) with a companion non-throwing health probe, and the `memory embeddings enable/disable/show` CLI command that vendors the model before ever flipping the config on.**

## Performance

- **Duration:** 25 min
- **Started:** 2026-07-21T20:00:00Z
- **Completed:** 2026-07-21T20:25:00Z
- **Tasks:** 3
- **Files modified:** 4 (1 created, 3 modified)

## Accomplishments
- `embeddings-config.ts` implements a zod-strict `EmbeddingsConfigSchema` (`enabled` default `false`) with `readEmbeddingsConfig`/`writeEmbeddingsConfig` round-tripping at `${dbPath}.embeddings.json`, mirroring `tune-command.ts`'s sidecar pattern
- `embedder-resolver.ts`'s `resolveEmbedder` returns `DeterministicEmbedder` when disabled, constructs+inits a `TransformerEmbedder` when enabled, and propagates `init()` rejections rather than catching them — a broken enabled model hard-errors (D-05), never silently returning the hash embedder
- `probeEmbedderHealth` is the non-throwing companion: disabled returns `{ healthy: true, reason: null }`; enabled+broken catches the init() error and returns `{ healthy: false, reason: <message> }` for daemon/`memory health` consumption (D-06)
- `embeddings-command.ts` exports `runEmbeddingsCommand`/`main`; `enable` calls `vendorModel` first and only writes `enabled: true` after it resolves (a failed vendor leaves the config untouched, so the resolver keeps returning the hash embedder); `disable` reverts `enabled: false`; `show` prints current/default config as JSON
- Registered `embeddings: () => import("../operations/embeddings-command.js")` in `src/cli/command-registry.ts`
- `npm run typecheck` exits 0; `npm test` shows 747/767 passing — the 20 remaining failures are all confined to real-model-dependent tests (golden-vector hashes, network vendoring, and the resolver's "enabled+healthy" branch), matching plan 03's precedent and the phase's stated plan-05 scope

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement embeddings config sidecar** - `56ad9ca` (feat)
2. **Task 2: Implement embedder-resolver (default / enabled / broken)** - `ba532e5` (feat)
3. **Task 3: `memory embeddings` CLI command (enable/disable/show) + registry** - `82a3895` (feat)

## Files Created/Modified
- `src/embeddings/embeddings-config.ts` - filled the plan-01 skeleton: zod-strict schema, `embeddingsConfigPath`, `readEmbeddingsConfig`, `writeEmbeddingsConfig`
- `src/embeddings/embedder-resolver.ts` - filled the plan-01 skeleton: `resolveEmbedder` (default/enabled/broken hard-error), `probeEmbedderHealth` (non-throwing probe)
- `src/operations/embeddings-command.ts` - new: `runEmbeddingsCommand`/`main`/`parseArgs`, vendor-then-persist `enable`, `disable`, `show`
- `src/cli/command-registry.ts` - added the `embeddings` REGISTRY entry

## Decisions Made
- Kept `resolveEmbedder`'s enabled branch free of any try/catch around `init()` — the `DeterministicEmbedder` construction only appears in the `!config.enabled` branch, satisfying the plan's grep-based acceptance criterion and D-05's hard-error intent by construction, not by convention.
- `probeEmbedderHealth` duplicates the `TransformerEmbedder` construction+init rather than calling `resolveEmbedder` and catching — this keeps the two functions' error-handling contracts (throw vs. never-throw) structurally distinct and independently readable, per D-05/D-06's explicit separation.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- `node_modules` was empty at session start; ran `npm ci` first per the parallel-execution notice. No packages were added or modified.
- As anticipated by the plan's own success criteria, the `embedder-resolver.test.ts` "enabled with a present, healthy model" test cannot pass in this environment (no real vendored model / no network access) — this is a real-model-dependent test in the same class as plan 03's golden-vector and vendoring-network tests, and remains RED pending plan 05's live vendoring capture. All 20 remaining `npm test` failures are confined to this class (1 in `embedder-resolver.test.ts`, 2 in `model-vendor.test.ts`, 17 in `transformer-embedder.golden.test.ts`).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `resolveEmbedder`/`probeEmbedderHealth`/`memory embeddings enable|disable|show` are fully implemented, typecheck-clean, and structurally satisfy D-04/D-05/D-06; plan 05 can run the real vendoring flow (network access), capture the real HF revision + sha256 hashes, and turn the golden-vector, vendoring-network, and resolver "enabled-healthy" tests GREEN without further changes to this plan's files.
- Plan 06 (daemon/health integration) can consume `probeEmbedderHealth` directly for the `memory health`/daemon-status surface.

---
*Phase: 09-embedding-model-embedder*
*Completed: 2026-07-21*

## Self-Check: PASSED

All created/modified files verified present on disk; all three task commit hashes (56ad9ca, ba532e5, 82a3895) verified present in git log.
