---
phase: 8
slug: vector-storage-foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-21
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts (existing) |
| **Quick run command** | `npx vitest run tests/storage` |
| **Full suite command** | `npm test` (vitest run) + `npm run typecheck` |
| **Estimated runtime** | ~15s full suite |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/storage`
- **After every plan wave:** Run `npm test` + `npm run typecheck`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| _(filled during planning — one row per task)_ | | | REQ-041 | | | unit | `npx vitest run tests/storage` | | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Validation Architecture (from RESEARCH.md)

Success criteria → how each is proven (see `08-RESEARCH.md` §"Validation Architecture" for detail):

- **SC1 — save/get by summary ID, tagged (provider,model,dims):** unit round-trip test per store; assert `getSummaryVector` returns byte-identical vector + tags after `saveSummaryVector`.
- **SC2 — `listSummaryIdsMissingVector(provider,model)` exact + stable order:** fixture with mixed present/absent vectors across two (provider,model) pairs; assert exact set + deterministic ordering.
- **SC3 — EXACT cross-store nearest-neighbor parity:** the load-bearing test. Feed identical query vector + identical corpus to `SqliteStore` and `InMemoryStore`; assert identical `(summary_id, score)` sequence (ranking, scores, tie-break). Both stores reuse `cosineSimilarity` (`src/embeddings/embedder.ts:48`) and the `rankMemories` comparator `right.score - left.score || left.id.localeCompare(right.id)` (`src/retrieval/memory-retriever.ts:354`). Run via the existing `backends`-array parity harness idiom (`tests/storage/sync-store.test.ts`, `tests/daemon/daemon-store.test.ts`).
- **SC4 — scope-partitioned lookups + tombstone capability:** cross-scope fixture asserting `findNearestSummaries` never returns out-of-scope vectors (filter-before-score, D-06); tombstone/delete test asserting a removed vector is unreachable — capability exercised even though nothing wires deletion until Phase 14.
- **SC5 — additive, safe migration:** idempotent-migration test (run twice, no error, no data change); assert `summaries`/existing tables untouched and store open/startup unaffected. Follows `src/storage/schema-migrations.ts` versioned mechanism, not the frozen base DDL.

---

## Wave 0 Requirements

- [ ] `tests/storage/summary-vectors.test.ts` — parity + round-trip + missing-list + scope + tombstone stubs for REQ-041 (extends the existing `backends`-array harness idiom)

*Existing vitest infrastructure otherwise covers all phase requirements — no framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| _(none)_ | REQ-041 | — | All Phase 8 behaviors have automated verification. |

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
