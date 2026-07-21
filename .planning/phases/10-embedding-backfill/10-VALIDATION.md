---
phase: 10
slug: embedding-backfill
status: draft
nyquist_compliant: false
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
| — | — | — | REQ-042 | — | kill+restart resumes via missing-set; second run performs zero writes | unit/integration | quick command | ❌ W0 | ⬜ pending |

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
