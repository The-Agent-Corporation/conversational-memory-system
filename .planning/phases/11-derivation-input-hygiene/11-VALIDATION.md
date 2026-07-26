---
phase: 11
slug: derivation-input-hygiene
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-26
---

# Phase 11 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing) |
| **Config file** | vitest.config.ts (existing) |
| **Quick run command** | `npx vitest run tests/topic/ tests/daemon/contraction-runner.test.ts tests/compaction/` |
| **Full suite command** | `npm run typecheck && npx vitest run` |
| **Estimated runtime** | ~5s quick / ~15s full |

**Measured baseline (2026-07-26, before any Phase 11 change):** 96 test files, 785 passed / 4 skipped, 12.84s. Any red test after a Phase 11 task is a regression introduced by this phase, not pre-existing.

---

## Sampling Rate

- **After every task commit:** Run the quick command
- **After every plan wave:** Run the full suite command
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

> Filled by the planner/executors as plans are created and executed. Requirement-level coverage below is binding regardless of how tasks are split.

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| TBD | TBD | 0 | REQ-052 — run of ≥2 collapses to one activity line, tools+counts, no arguments | unit | `npx vitest run tests/topic/derivation-hygiene.test.ts -t "collapse"` | ❌ W0 | ⬜ pending |
| TBD | TBD | 0 | REQ-052 — isolated single tool call keeps existing text | unit | `npx vitest run tests/topic/derivation-hygiene.test.ts -t "isolated"` | ❌ W0 | ⬜ pending |
| TBD | TBD | 1 | REQ-052 — tool activity never drives `extractTopicLabel` / `isTopicChange` | unit | `npx vitest run tests/daemon/contraction-runner.test.ts` | ✅ extend | ⬜ pending |
| TBD | TBD | 0 | REQ-053 — classification deterministic, stable on repeat, no model/network | unit | `npx vitest run tests/topic/derivation-hygiene.test.ts -t "classify"` | ❌ W0 | ⬜ pending |
| TBD | TBD | 1 | REQ-053 — synthetic excluded from summary text | integration | `npx vitest run tests/daemon/contraction-runner.test.ts` | ✅ extend | ⬜ pending |
| TBD | TBD | 1 | REQ-053 — hygiene applies on the live Hermes path too | integration | `npx vitest run tests/compaction/pre-compactor.test.ts tests/integrations/` | ✅ extend | ⬜ pending |
| TBD | TBD | 2 | REQ-053 — rule ID + version recoverable via audit surface | unit | `npx vitest run tests/audit/explain-service.test.ts` | ✅ extend | ⬜ pending |
| TBD | TBD | 2 | REQ-054 — rule version bump marks derivations stale | unit | `npx vitest run tests/service/` | ✅ extend | ⬜ pending |
| TBD | TBD | 2 | REQ-054 — rebuild resumable/idempotent; interrupt+resume == uninterrupted | integration | `npx vitest run tests/operations/rebuild-derivations-command.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | 1 | Tool run straddling a slice boundary still collapses to one line | integration | `npx vitest run tests/daemon/contraction-runner.test.ts -t "slice boundary"` | ✅ extend | ⬜ pending |
| TBD | TBD | 1 | No persisted summary ever carries a growable tool count — asserted after EVERY slice, not only at the end | integration | `npx vitest run tests/daemon/contraction-runner.test.ts -t "slice boundary"` | ✅ extend | ⬜ pending |
| TBD | TBD | 1 | `pendingToolRun` drift guard — a late insert inside a withheld run forces the rewind path, never a second activity line | integration | `npx vitest run tests/daemon/contraction-runner.test.ts -t "drift guard"` | ✅ extend | ⬜ pending |
| TBD | TBD | 1 | Anchor set is identical under any slice size (withheld runs re-emit on close) | integration | `npx vitest run tests/daemon/contraction-runner.test.ts` | ✅ extend | ⬜ pending |
| TBD | TBD | 1 | Checkpoint payloads written before `pendingToolRun` still parse, defaulted to null | unit | `npx vitest run tests/storage/sqlite-store.test.ts` | ✅ extend | ⬜ pending |
| TBD | TBD | 1 | `sourceCanonicalEventIds` remains the FULL raw event list after collapse | unit | `npx vitest run tests/daemon/contraction-runner.test.ts -t "provenance"` | ✅ extend | ⬜ pending |
| TBD | TBD | 2 | Quarantine contract — replayed `tool.result` enters as `tool_activity` | unit | `npx vitest run tests/imports/` | ✅ extend | ⬜ pending |
| TBD | TBD | 3 | SC7 — recall does not regress (boxes/traces/retrieval consume summaryText) | regression | `npx vitest run tests/boxes/ tests/traces/ tests/retrieval/` | ✅ existing | ⬜ pending |
| TBD | TBD | 3 | Ratio check — count −59% / volume −66% on a proportional synthetic corpus | integration | `MEMORY_DB=<fixture> npx tsx .planning/phases/11-derivation-input-hygiene/11-hygiene-sim.ts` | ❌ W0 fixture | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/topic/derivation-hygiene.test.ts` — new; covers REQ-052 (collapse, isolated single) and REQ-053 (classification determinism)
- [ ] `tests/operations/rebuild-derivations-command.test.ts` — new; covers REQ-054. Model on `tests/operations/backfill-embeddings-command.test.ts` (**verified present**) for the interrupt/resume shape
- [ ] CI-safe synthetic fixture DB matching the corpus's measured class proportions (63.8% tool_activity / 29.5% conversational / 6.7% synthetic_injected) at small scale — a few hundred to a few thousand events, so ratio assertions run without the 5 GB personal database

**Verified present, extend rather than create:** `tests/daemon/contraction-runner.test.ts`, `tests/daemon/fixtures.ts`, `tests/topic/topic-monitor.test.ts`, `tests/audit/explain-service.test.ts`, `tests/audit/explain-command.test.ts`, `tests/operations/backfill-embeddings-command.test.ts`, `tests/compaction/pre-compactor.test.ts`, `tests/boxes/`, `tests/traces/`, `tests/retrieval/`.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Full-scale target: 135,366 → **55,930** summaries and 228.9 MB → **77.6 MB** | SC6, D-2 | Requires the 5 GB personal corpus at `~/.memory/aaron.db`, which cannot live in CI | After implementation, re-run `npx tsx .planning/phases/11-derivation-input-hygiene/11-hygiene-sim.ts` and confirm the real pipeline lands on the same numbers. Divergence means implementation and simulation disagree — investigate before closing the phase. |
| Recall spot-check on real memories | SC7 | Judging "same or better summaries" for known conversational queries needs a human | Pick a fixed set of queries with known-good answers before rebuild; compare retrieved summaries after. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
