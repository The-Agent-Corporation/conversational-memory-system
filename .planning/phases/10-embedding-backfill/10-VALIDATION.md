---
phase: 10
slug: embedding-backfill
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-21
---

# Phase 10 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing) |
| **Config file** | vitest.config.ts (existing) |
| **Quick run command** | `npx vitest run tests/embeddings/ tests/operations/` |
| **Full suite command** | `npm run typecheck && npx vitest run` |
| **Estimated runtime** | ~10s quick / ~90s full |

---

## Sampling Rate

- **After every task commit:** Run the quick command
- **After every plan wave:** Run the full suite command
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

> Filled by the planner/executors as plans are created and executed.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 10-01/T1 | 10-01 | 1 | REQ-042 (SC2) | T-10-01 | batch write is atomic; mid-batch throw rolls back whole batch | unit | `npx vitest run tests/storage/summary-vectors.test.ts` | ❌ W0 | ⬜ pending |
| 10-01/T2 | 10-01 | 1 | REQ-042 (SC2) | T-10-02 | batch reuses per-record dimension/finite guard (no drift) | unit | `npx vitest run tests/storage/summary-vectors.test.ts` | ❌ W0 | ⬜ pending |
| 10-02/T1 | 10-02 | 1 | REQ-042 (SC4) | T-10-06 | status reports identity backfill actually writes under | unit | `npx vitest run tests/bootstrap/status-command.test.ts` | ❌ W0 | ⬜ pending |
| 10-02/T2 | 10-02 | 1 | REQ-042 (SC4) | T-10-04 | status never throws on enabled-but-broken embedder | unit | `npx vitest run tests/bootstrap/status-command.test.ts` | ❌ W0 | ⬜ pending |
| 10-03/T1 | 10-03 | 2 | REQ-042 (SC1-SC4) | T-10-05,T-10-09,T-10-10 | kill+restart resumes via missing-set; zero-write rerun; per-person scope tag; fail-loud on missing personId | integration | `npx vitest run tests/operations/backfill-embeddings-command.test.ts` | ❌ W0 | ⬜ pending |
| 10-03/T2 | 10-03 | 2 | REQ-042 (SC1-SC4) | T-10-08,T-10-09 | resolve embedder once; D-05/embed() throw propagates to nonzero exit; no silent provider mixing | integration | `npx vitest run tests/operations/backfill-embeddings-command.test.ts` | ❌ W0 | ⬜ pending |
| 10-03/T3 | 10-03 | 2 | REQ-042 | — | backfill-embeddings dispatchable via unified CLI | unit | `npm run typecheck` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Backfill tests use the hash `DeterministicEmbedder` over a few hundred seeded summaries (fast, offline) — never the ONNX model
- [ ] Existing vitest infrastructure covers the phase; no new framework install

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Full-corpus backfill against the live ~3.5GB DB (135,366 summaries) | REQ-042 | Requires the real DB and (optionally) the vendored ONNX model; multi-minute-to-hours runtime | Run `memory embeddings backfill` (name per plans) on the dev machine; observe progress lines; kill mid-run and restart to confirm resume; re-run after completion to confirm zero writes |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
