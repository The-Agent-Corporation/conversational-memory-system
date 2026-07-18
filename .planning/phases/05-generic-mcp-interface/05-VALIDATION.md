---
phase: 05
slug: generic-mcp-interface
status: draft
nyquist_compliant: false
wave_0_complete: true
final_sign_off: pending
created: 2026-07-18
---

# Phase 05 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 2.1.9 |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run tests/mcp` |
| **Full suite command** | `npm test && npm run typecheck` |
| **Estimated runtime** | Under 60 seconds for quick MCP tests; measure full-suite runtime during Wave 0 |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/mcp` plus the nearest changed subsystem test.
- **After every plan wave:** Run `npm test && npm run typecheck`.
- **Before `$gsd-verify-work`:** Full suite, synthetic SDK-client STDIO smoke, read-only database snapshot, and supported-host synthetic registrations must be green.
- **Max feedback latency:** 60 seconds for the focused MCP suite.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Green-status owner | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|--------------------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 05-01-02, 05-03-01, 05-03-02 | 05-01, 05-03 | 1, 3 | 05-03 Task 2 | REQ-023 | T-05-SCOPE / T-05-CURSOR | Expansion returns only authorized events, stays within budget, and resumes without gaps or duplicates. | unit + SQLite integration | `npx vitest run tests/mcp/subject-expansion.test.ts` | ✅ created | ⬜ pending |
| 05-01-02, 05-02-02, 05-03-01, 05-06-02 | 05-01, 05-02, 05-03, 05-06 | 1, 2, 3, 5 | 05-06 Task 2 | REQ-025 | T-05-DISCLOSURE / T-05-READ-WRITE | Structured and rendered reads preserve disclosure and provenance while causing zero semantic writes. | unit + snapshot | `npx vitest run tests/mcp/read-tools.test.ts` | ✅ created | ⬜ pending |
| 05-01-03, 05-08-02 | 05-01, 05-08 | 1, 7 | 05-08 Task 2 | REQ-027 | T-05-STDIO / T-05-PROFILE | A real child process completes initialize/list/call/shutdown, emits clean stdout, and rejects missing or unknown profiles. | protocol integration | `npx vitest run tests/mcp/stdio-server.test.ts` | ✅ created | ⬜ pending |
| 05-01-03, 05-02-02, 05-05-02, 05-05-03, 05-06-02, 05-07-02, 05-08-01 | 05-01, 05-02, 05-05, 05-06, 05-07, 05-08 | 1, 2, 4, 5, 6, 7 | 05-08 Task 1 | REQ-028 | T-05-ROUTING / T-05-OFFLINE | Every required capability is discoverable, explicitly routed, and remains usable with daemon status reported offline. | integration | `npx vitest run tests/mcp/tool-catalog.test.ts tests/mcp/mutation-tools.test.ts` | ✅ created | ⬜ pending |
| 05-01-03, 05-04-01, 05-04-02, 05-05-01, 05-07-02, 05-08-01, 05-08-02 | 05-01, 05-04, 05-05, 05-07, 05-08 | 1, 3, 4, 6, 7 | 05-08 Task 2 | REQ-029 | T-05-CONFIRM / T-05-ATOMIC | Tool annotations match behavior; confirmations reject missing, expired, replayed, cross-profile, changed-input, and drifted-state use. | protocol + adversarial | `npx vitest run tests/mcp/confirmation-service.test.ts tests/mcp/stdio-server.test.ts` | ✅ created | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Plan 05-01 Tasks 2 and 3 own creation and compilation of these contract modules. At the end of Task 3, the executor must change each `❌ W0` file marker above to `✅ created`, set `wave_0_complete: true`, retain `nyquist_compliant: false`, and leave behavior status `⬜ pending` until the named green-status owner activates every mapped contract and its complete automated command passes. Only 05-08 Task 2 may set final Nyquist/sign-off fields.

- [x] Install `@modelcontextprotocol/sdk@1.29.0` and upgrade `zod` to `3.25.76`.
- [x] `tests/mcp/profile-loader.test.ts` — explicit profile selection and fail-closed configuration fixtures.
- [x] `tests/mcp/read-tools.test.ts` — dual response, disclosure, provenance, scope, and zero-semantic-write proofs.
- [x] `tests/mcp/subject-expansion.test.ts` — strict subject expansion, budgets, deterministic ordering, and continuation.
- [x] `tests/mcp/confirmation-service.test.ts` — exact binding, expiry, replay, cross-profile, and state-drift cases.
- [x] `tests/mcp/mutation-tools.test.ts` — preview/execute atomicity, proposal decisions, imports, revocation, and deletion.
- [x] `tests/mcp/tool-catalog.test.ts` — complete capability catalog and safety annotations.
- [x] `tests/mcp/stdio-server.test.ts` — real synthetic child-process protocol lifecycle and clean stdout.
- [x] Synthetic fixture with two people, three scopes, mixed-scope derived objects, disclosure-safe aliases, and concurrent writers.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Codex and at least one second supported host can launch the STDIO server from an explicit synthetic profile | REQ-027, REQ-028 | Host registration UX and process ownership differ outside the repository test harness | Register a temporary MCP entry pointing at a synthetic config/database; call status, search, and recall; remove the entry afterward. Do not use live personal history. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s for focused MCP tests
- [ ] `nyquist_compliant: true` set in frontmatter
- [ ] All five requirement rows are `✅ green` with no pending/red/flaky state
- [ ] `status: complete` and `final_sign_off: approved` set by 05-08 Task 2

**Approval:** pending
