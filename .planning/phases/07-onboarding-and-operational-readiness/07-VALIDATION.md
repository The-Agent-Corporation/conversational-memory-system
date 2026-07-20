---
phase: 07
slug: onboarding-and-operational-readiness
status: approved
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-20
---

# Phase 07 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 2.0.5 (+ TypeScript, temporary SQLite DBs, deterministic synthetic fixtures; no live external services or models) |
| **Config file** | `vitest.config.ts` (`include: ["tests/**/*.test.ts"]`, `environment: "node"`) |
| **Quick run command** | `npx vitest run tests/storage/schema-migrations.test.ts` (or narrower per-module file for the task just touched) |
| **Full suite command** | `npm test && npm run typecheck` |
| **Privacy boundary** | Deterministic/local only. All fixtures are synthetic data; backup crypto is tested with synthetic passphrases/keys; no live Keychain, no live relay, no live model. No wall-clock timing assertions (fake clock for latency). |

---

## Sampling Rate

- **After every task commit:** Run the narrow per-module test file (the `<automated>` command for that task)
- **After every plan wave:** Run `npm test && npm run typecheck`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~30 seconds (narrow file); full suite is broad (Phases 1–6 coverage), run per wave

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 07-01-01 | 01 | 1 | REQ-040 (D-04) | — | RED gate: dispatcher contract fails before impl | unit | `npx vitest run tests/cli/bin.test.ts 2>&1 \| grep -Eq "fail\|No test files\|Cannot find module\|error" && echo RED-OK` | ❌ W0 | ⬜ pending |
| 07-01-02 | 01 | 1 | REQ-040 (D-04) | — | Mechanical `main(argv)` export across 20 command modules; no behavior change | unit | `npm run typecheck 2>&1 \| tail -3 && grep -Lc "export.*main\b\|export { main" $(find src -iname "*-command.ts") \| head` | ✅ | ⬜ pending |
| 07-01-03 | 01 | 1 | REQ-040 (D-04) | — | Dispatcher routes to correct command; unknown-subcommand handled | unit | `npx vitest run tests/cli/bin.test.ts && npm run typecheck 2>&1 \| tail -2` | ✅ / ❌ W0 | ⬜ pending |
| 07-02-01 | 02 | 2 | REQ-040 (D-05) | — | RED gate: init orchestration fails before impl | integration | `npx vitest run tests/bootstrap/init-command.test.ts 2>&1 \| grep -Eq "fail\|Cannot find module\|No test files" && echo RED-OK` | ❌ W0 | ⬜ pending |
| 07-02-02 | 02 | 2 | REQ-040 (D-05) | — | discover → consent → bootstrap → offer-daemon in order; skip unapproved | integration | `npx vitest run tests/bootstrap/init-command.test.ts && npm run typecheck 2>&1 \| tail -2` | ✅ / ❌ W0 | ⬜ pending |
| 07-03-01 | 03 | 3 | REQ-039, REQ-040 | — | RED gate: explain/audit + tool-count contracts fail before impl | unit | `npx vitest run tests/audit/ tests/mcp/tool-catalog.test.ts tests/mcp/read-tools.test.ts 2>&1 \| grep -Eq "fail\|Cannot find module\|No test files" && echo RED-OK` | ❌ W0 | ⬜ pending |
| 07-03-02 | 03 | 3 | REQ-039 | V4 (scope isolation) | `memory_explain` respects `personId`/`allowedScopeIds`; uniform non-distinguishing failure | integration | `npx vitest run tests/audit/explain-service.test.ts tests/audit/explain-command.test.ts tests/mcp/read-tools.test.ts tests/mcp/tool-catalog.test.ts tests/mcp/stdio-server.test.ts && npm run typecheck 2>&1 \| tail -2` | ✅ / ❌ W0 | ⬜ pending |
| 07-03-03 | 03 | 3 | REQ-039 | V4 (content leak) | Audit-log export is metadata-only; no verbatim message content | unit | `npx vitest run tests/audit/audit-log-command.test.ts && npm run typecheck 2>&1 \| tail -2` | ✅ / ❌ W0 | ⬜ pending |
| 07-04-01 | 04 | 2 | REQ-040 (D-08) | — | RED gate: migration + concurrency tests fail before impl | unit | `npx vitest run tests/storage/schema-migrations.test.ts tests/storage/schema-migrations-concurrency.test.ts 2>&1 \| grep -Eq "fail\|Cannot find module\|No test files" && echo RED-OK` | ❌ W0 | ⬜ pending |
| 07-04-02 | 04 | 2 | REQ-040 (D-08) | Tampering (transactional) | Fresh DB → latest; v1 → latest without loss; failed migration leaves `schema_migrations` unchanged; concurrent-open race safe | unit + integration | `npx vitest run tests/storage/schema-migrations.test.ts tests/storage/schema-migrations-concurrency.test.ts && npm run typecheck 2>&1 \| tail -2` | ✅ / ❌ W0 | ⬜ pending |
| 07-05-01 | 05 | 4 | REQ-040 (D-06, D-09) | — | RED gate: health + tuning tests fail before impl | unit | `npx vitest run tests/bootstrap/status-command.test.ts tests/operations/tune-command.test.ts 2>&1 \| grep -Eq "fail\|Cannot find module\|No test files" && echo RED-OK` | ❌ W0 | ⬜ pending |
| 07-05-02 | 05 | 4 | REQ-040 (D-06, D-09) | — | Health surface reports DB size, daemon state, sync lag, pending proposals, schema version, latency (fake clock) | unit | `npx vitest run tests/bootstrap/status-command.test.ts && npm run typecheck 2>&1 \| tail -2` | ✅ / ❌ W0 | ⬜ pending |
| 07-05-03 | 05 | 4 | REQ-040 (D-09) | — | Bounded tuning knobs (busy_timeout, retrieval defaults, REINDEX/ANALYZE) honored end-to-end | integration | `npx vitest run tests/operations/tune-command.test.ts && npm run typecheck 2>&1 \| tail -2` | ✅ / ❌ W0 | ⬜ pending |
| 07-06-01 | 06 | 5 | REQ-040 (D-07) | — | RED gate: backup/restore + plaintext-export tests fail before impl | unit | `npx vitest run tests/storage/backup/ 2>&1 \| grep -Eq "fail\|Cannot find module\|No test files" && echo RED-OK` | ❌ W0 | ⬜ pending |
| 07-06-02 | 06 | 5 | REQ-040 (D-07) | V6 (domain separation) | `cms.backup.v1` seal/open never uses sync `wrapWithPassphrase`; round-trip decrypts; wrong passphrase fails uniformly | unit | `npx vitest run tests/storage/backup/backup-restore.test.ts && npm run typecheck 2>&1 \| tail -2 && grep -Lq "wrapWithPassphrase" src/storage/backup/backup-crypto.ts src/storage/backup/backup-command.ts && echo DOMAIN-OK` | ✅ / ❌ W0 | ⬜ pending |
| 07-06-03 | 06 | 5 | REQ-040 (D-07, D-07b) | Tampering / info disclosure | Restore never overwrites live DB in place; plaintext export distinct in name/format | unit + integration | `npx vitest run tests/storage/backup/ && npm run typecheck 2>&1 \| tail -2` | ✅ / ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

6 plans across 5 waves. Each plan's first task is its Wave 0 (RED) failing-test scaffold:

- [ ] `tests/cli/bin.test.ts` — dispatcher routing, unknown-subcommand handling (07-01, wave 1)
- [ ] `tests/bootstrap/init-command.test.ts` — guided onboarding orchestration (07-02, wave 2)
- [ ] `tests/storage/schema-migrations.test.ts`, `tests/storage/schema-migrations-concurrency.test.ts` — fresh/v1/failed-rollback/concurrent-open (07-04, wave 2)
- [ ] `tests/audit/explain-command.test.ts`, `tests/audit/explain-service.test.ts`, `tests/audit/audit-log-command.test.ts` + `tests/mcp/tool-catalog.test.ts` / `read-tools.test.ts` / `stdio-server.test.ts` tool-count contract updates (07-03, wave 3)
- [ ] `tests/bootstrap/status-command.test.ts`, `tests/operations/tune-command.test.ts` — health surface + tuning knobs (07-05, wave 4)
- [ ] `tests/storage/backup/backup-restore.test.ts`, `tests/storage/backup/export-plaintext.test.ts` — round-trip, wrong-passphrase, plaintext-vs-encrypted distinction (07-06, wave 5)

Framework install: none — Vitest already configured project-wide.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| — | — | — | All phase behaviors have automated verification. |

*All phase behaviors have automated verification.*

---

## Requirement / Decision Coverage

| ID | Covered By |
|----|------------|
| REQ-039 | 07-03 (explain CLI + `memory_explain` MCP tool + append-only audit log) |
| REQ-040 | all plans (07-01 … 07-06) |
| D-01 (explain: CLI + MCP) | 07-03 |
| D-02 (exportable append-only audit log) | 07-03 |
| D-03 (read existing provenance, no re-instrumentation) | 07-03 |
| D-04 (unified `memory` bin dispatcher) | 07-01 |
| D-05 (guided `memory init`) | 07-02 |
| D-06 (health/status surface) | 07-05 |
| D-07 (encrypted backup/restore) | 07-06 |
| D-07b (plaintext export escape hatch) | 07-06 |
| D-08 (versioned schema migration) | 07-04 |
| D-09 (performance reporting + tuning knobs) | 07-05 |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency acceptable (narrow file ~30s; full suite per wave)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-07-20
