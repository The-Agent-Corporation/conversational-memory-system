---
phase: 04
slug: continuous-local-daemon
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-17
---

# Phase 04 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. All history fixtures are synthetic; tests must not open real Codex, Claude Code, OpenClaw, or Hermes histories or invoke live LaunchAgent/notification behavior.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 2 |
| **Config file** | `package.json` scripts plus existing Vitest discovery |
| **Quick run command** | `npx vitest run tests/daemon` |
| **Regression command** | `npx vitest run tests/daemon tests/imports/codex-history.test.ts tests/imports/multi-source-history.test.ts tests/imports/universal-import-bootstrap.test.ts tests/bootstrap/historical-bootstrapper.test.ts tests/service/source-lifecycle-service.test.ts tests/storage/sqlite-store.test.ts` |
| **Full suite command** | `npm test && npm run typecheck && npm run hermes:smoke && git diff --check` |
| **Estimated quick runtime** | Under 30 seconds; no wall-clock waits |

---

## Sampling Rate

- **After every implementation task:** Run the narrowest changed `tests/daemon/*.test.ts` file.
- **After every plan:** Run `npx vitest run tests/daemon`.
- **After every wave:** Run the regression command above plus `npm run typecheck`.
- **Before `$gsd-verify-work`:** The full suite command must be green.
- **Max feedback latency:** 30 seconds for the focused daemon loop.

---

## Per-Task Verification Map

| Validation ID | Expected Plan | Requirement | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------------|---------------|-------------|-----------------|-----------|-------------------|-------------|--------|
| 04-V01 | Durable daemon state | REQ-019, REQ-021 | Lease, health, jobs, and stage checkpoints survive restart and commit atomically | SQLite integration | `npx vitest run tests/daemon/daemon-store.test.ts` | ❌ Wave 0 | ⬜ pending |
| 04-V02 | Scheduling and source execution | REQ-017, REQ-018 | Only approved grants are read; one failed source cannot block others | unit/integration | `npx vitest run tests/daemon/scheduler.test.ts tests/daemon/source-runner.test.ts` | ❌ Wave 0 | ⬜ pending |
| 04-V03 | Incremental contraction | REQ-019, REQ-022 | Restart is idempotent; late events rewind only affected spans; proposals remain review-only | unit/integration | `npx vitest run tests/daemon/contraction-runner.test.ts` | ❌ Wave 0 | ⬜ pending |
| 04-V04 | Daemon loop and lifecycle | REQ-017, REQ-020, REQ-021 | One database writer, graceful stop, offline operation, durable reconstruction | integration | `npx vitest run tests/daemon/daemon-loop.test.ts` | ❌ Wave 0 | ⬜ pending |
| 04-V05 | CLI and macOS adapters | REQ-017, REQ-020 | Autostart requires explicit enablement; tests make no real OS mutation or notification | unit | `npx vitest run tests/daemon/daemon-commands.test.ts tests/daemon/macos-adapters.test.ts` | ❌ Wave 0 | ⬜ pending |
| 04-V06 | Cross-phase regression | REQ-017–REQ-022 | Import, lifecycle, isolation, and bootstrap guarantees remain intact | regression | `npx vitest run tests/daemon tests/imports/codex-history.test.ts tests/imports/multi-source-history.test.ts tests/imports/universal-import-bootstrap.test.ts tests/bootstrap/historical-bootstrapper.test.ts tests/service/source-lifecycle-service.test.ts tests/storage/sqlite-store.test.ts` | Partial | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/daemon/fixtures.ts` — fake clock/timers, watcher, power source, notifier, process runner, and synthetic approved-source builders.
- [ ] `tests/daemon/daemon-store.test.ts` — lease compare-and-set, atomic import/job commit, grant-at-commit rejection, atomic contraction slice, and SQLite restart.
- [ ] `tests/daemon/scheduler.test.ts` — debounce, powered/battery cadence, priority/fairness, backoff, and source isolation.
- [ ] `tests/daemon/source-runner.test.ts` — four-source dispatch without reapproval; append, partial write, rotation, absence, high-water mark, and revocation.
- [ ] `tests/daemon/contraction-runner.test.ts` — append-only increment, bounded late-event rewind, unchanged-prefix preservation, yielding, restart, and proposal tiers.
- [ ] `tests/daemon/daemon-loop.test.ts` — reconstruction, one writer, multi-person scheduling, missed watcher recovery, graceful stop, stale lease, and once mode.
- [ ] `tests/daemon/daemon-commands.test.ts` — lifecycle parsing, output, explicit enablement, and status.
- [ ] `tests/daemon/macos-adapters.test.ts` — plist generation and mocked launchctl, power, and notification behavior without live mutation.

Existing Vitest infrastructure and synthetic importer fixtures are reused; no new test framework or external service is required.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Optional macOS LaunchAgent smoke | REQ-017 | Unit tests must not modify the user's live LaunchAgent domain | In a disposable temporary configuration, inspect generated plist and run an explicitly approved start/status/stop cycle; never enable it implicitly. |
| Optional notification appearance | D-10 | Real Notification Center presentation is outside deterministic tests | With explicit approval, trigger the adapter against a synthetic degraded event and confirm no conversation content appears. |

All correctness behavior, including LaunchAgent command construction and notification deduplication, remains automated with mocked adapters.

---

## Validation Sign-Off

- [ ] Every plan task has an automated verification command or explicit Wave 0 dependency.
- [ ] No three consecutive implementation tasks lack an automated test.
- [ ] Wave 0 creates every missing daemon test seam before dependent behavior.
- [ ] No watch-mode flags or real-time sleeps occur in CI commands.
- [ ] Focused feedback latency remains below 30 seconds.
- [ ] Synthetic fixtures cover partial writes, rotation, revocation, restart, late events, fairness, battery cadence, and proposal review state.
- [ ] `nyquist_compliant: true` and `wave_0_complete: true` are set only after the planned test files exist and execute.

**Approval:** pending plan verification
