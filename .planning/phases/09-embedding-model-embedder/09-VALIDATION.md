---
phase: 09
slug: embedding-model-embedder
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-07-21
---

# Phase 09 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing) |
| **Config file** | vitest.config.ts (existing) |
| **Quick run command** | `npx vitest run tests/embeddings/` |
| **Full suite command** | `npm run typecheck && npx vitest run` |
| **Estimated runtime** | ~5s quick / ~90s full |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/embeddings/`
- **After every plan wave:** Run `npm run typecheck && npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

> Filled by the planner/executors as plans are created and executed.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| — | — | — | REQ-044 | — | model files verified against committed sha256 manifest before load | unit | `npx vitest run tests/embeddings/` | ❌ W0 | ⬜ pending |
| — | — | — | REQ-051 | — | golden quantized-hash + same-machine byte-hash determinism tests | unit | `npx vitest run tests/embeddings/` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Golden-set fixture texts committed (both embed modes: bare passage + prefixed query)
- [ ] Tests for the new embedder land alongside implementation (existing vitest infrastructure covers the phase; no new framework install)

*Existing infrastructure covers all phase requirements.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| One-time model vendoring download + sha256 manifest capture | REQ-044 | Requires a real network fetch of the pinned HF revision; CI/runtime are offline-by-design | Run the enable/install CLI command once on the dev machine; verify manifest hashes are recorded and a second run is a no-op |
| Real-model golden run in CI with cached artifact | REQ-051 | First CI run must populate the model cache | Trigger CI once after vendoring; confirm golden job passes and cache is hit on re-run |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-07-21
