---
phase: 11-derivation-input-hygiene
plan: 16
subsystem: storage
tags: [sqlite, in-memory-store, zod, prune, deletion, gap-closure, classifier]

# Dependency graph
requires:
  - phase: 11-derivation-input-hygiene
    provides: "classifyEvent / HYGIENE_RULE_VERSION (Plan 11-01) — the single shared hygiene classifier reused unmodified"
  - phase: 11-derivation-input-hygiene
    provides: "commitSupersededSummaryPrune / listSupersededSummaryIds pattern (Plan 11-11) — the exact shape mirrored for anchors"
  - phase: 11-derivation-input-hygiene
    provides: "AnchorDetector.detectForTurn forward gate (4d17978) — stops new unhygienic anchors; this plan closes the backward half"
provides:
  - "commitUnhygienicAnchorPrune / listAnchorIds / summarizeAnchorDerivationClasses (REQ-052/053/054, GAP-11-D store-layer closure): in-transaction, classifier-authoritative anchor removal identical in SqliteStore and InMemoryStore"
  - "ADR 0051 recording the no-anchor-lifecycle decision, the gate-forward/prune-backward split, and the safety contract"
affects: ["11-17 (memory prune-unhygienic-anchors operator command wraps this plan's store methods)", "11-18 (owner-authorized live anchor prune)", "11-13/11-14 (SC7 sign-off needs 11-18's evidence)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Role/eventKind enrichment from the resolved canonical event before classification, falling back to content-only when canonicalEventId is absent or dangling — a strict superset of the forward gate's content+role-only inputs, so the prune can never retain an anchor the gate would have refused"
    - "Anchor prune has no reference-kind skip reasons (unlike summary prune's four): an anchor has zero inbound references anywhere in the domain schema, so eligibility precedence is just not_found -> person_unattributed -> person_mismatch -> retained_conversational"
    - "describe.each parity suite (mirrors Plan 11-11's superseded-prune.test.ts) enforces the CLAUDE.md both-stores rule by construction; a StoreUnderTest cast type kept the RED commit's typecheck clean while the store methods genuinely did not exist"

key-files:
  created:
    - tests/storage/anchor-hygiene-prune.test.ts
    - docs/adr/0051-anchor-derivation-hygiene.md
  modified:
    - src/storage/mcp-mutation-contracts.ts
    - src/storage/memory-store.ts
    - src/storage/sqlite-store.ts
    - src/storage/in-memory-store.ts

key-decisions:
  - "Anchors get no MemoryState lifecycle (ADR 0051): a pure derivation over one turn, reproducible by re-derivation, with zero inbound references anywhere in src/domain — a lifecycle would durably retain the exact tool-call text REQ-053 excludes while adding a second entity the retrieval boundary must be proven safe against forever."
  - "Classification is recomputed inside the prune transaction from the anchor's content enriched with its resolved canonical event's role/eventKind — a strict superset of the forward gate's inputs, so the live prune's real numbers may exceed GAP-11-D's 25,792-row content-only census; the census is a floor, not a target."
  - "listAnchorIds' person-scoped cursor uses the identical json_extract(payload,'$.personId') = ? plus id > ? predicate as listSupersededSummaryIds, with no schema migration — anchors has the same (id, payload) shape as summaries; unindexed, so a table scan per page, an accepted one-time-cleanup tradeoff."

requirements-completed: [REQ-052, REQ-053, REQ-054]

# Metrics
duration: ~25min
completed: 2026-07-27
---

# Phase 11 Plan 16: Anchor Hygiene Prune (GAP-11-D Store-Layer Closure) Summary

**Built `commitUnhygienicAnchorPrune`/`listAnchorIds`/`summarizeAnchorDerivationClasses` identically in `SqliteStore` and `InMemoryStore` — the store-layer removal path for the live corpus's 25,792+ anchors the forward-gated `AnchorDetector.detectForTurn` would never have created — plus ADR 0051 recording the no-lifecycle, gate-forward/prune-backward decision.**

## Performance

- **Duration:** ~25 min (three atomic task commits)
- **Tasks:** 3
- **Files modified:** 4 (2 created, 2 modified: `memory-store.ts` counted with `sqlite-store.ts`/`in-memory-store.ts` as one logical surface change across Task 2's commit — 3 files touched in Task 2, plus `mcp-mutation-contracts.ts` in Task 1 and the ADR in Task 3)
- **Test suite:** 986 passed, 4 skipped (110 files, 1 skipped) — full unmodified regression green
- **New tests:** 28, all green (one case per `<behavior>` bullet in the plan, run against both `SqliteStore` and `InMemoryStore`)

## Accomplishments

- `src/storage/mcp-mutation-contracts.ts` gained `CommitUnhygienicAnchorPruneInputSchema` (`operation`, `personId`, `anchorIds: IdListSchema.min(1).max(1000)`, `requestedAt`, `.strict()`), `UnhygienicAnchorPruneSkipReasonSchema` (exactly `not_found` / `person_mismatch` / `person_unattributed` / `retained_conversational`), and `UnhygienicAnchorPruneReceiptSchema` (`prunedAnchorIds`, `prunedByClass: { tool_activity, synthetic_injected }`, `freedPayloadBytes`, `skipped`, `ruleVersion`, `committedAt`), mirroring the superseded-summary-prune contract's shape exactly. Two new fault boundaries (`anchor_hygiene_prune_before_write`, `anchor_hygiene_prune_after_delete`) were added to `McpMutationFaultBoundary`.
- `tests/storage/anchor-hygiene-prune.test.ts` is a `describe.each` suite over a real `SqliteStore` (temp-file, `mkdtemp`) and `InMemoryStore`, covering: pruning `[Tool call: ...]` and `[SYSTEM: ...]` content, retaining ordinary conversational anchors (including when the caller explicitly names the id), role/eventKind enrichment (a prose anchor whose resolved canonical event has `role: "tool"` or `eventKind: "tool_call"` is pruned; the role-gated `silent-sentinel` rule fires only when the resolved event's role is `assistant`, never on content alone), fallback to content-only classification when `canonicalEventId` is absent or dangling, `person_mismatch`/`person_unattributed` refusal with the row surviving, before/after control-count equality across canonical events, turns, summaries, boxes, traces, proposals, and injections, idempotency, and fault-injected rollback safety (both stores unchanged after a mid-transaction throw).
- `src/storage/memory-store.ts` declares the three new methods on `MemoryStore` beside the existing anchor surface, documenting that eligibility is recomputed inside the implementation's own transaction and that the method never touches the seven other entity tables.
- `SqliteStore.commitUnhygienicAnchorPrune` (`src/storage/sqlite-store.ts`) runs `begin immediate`/`commit`/`rollback` by hand, resolves each candidate anchor's canonical event with `getCanonicalEvent` inside the same transaction, decides every skip before any write, and deletes through an inline `delete from anchors where id = ?` (never calls `deleteAnchors`, which would nest a transaction). `listAnchorIds` mirrors `listSupersededSummaryIds`'s `json_extract`-based person-filtered ascending-id cursor exactly, with no schema migration. `InMemoryStore`'s implementation mirrors the identical decision order and mutates `this.anchors` only after every eligibility decision is made.
- `docs/adr/0051-anchor-derivation-hygiene.md` records: (1) anchors get no `MemoryState` lifecycle, with the reference-asymmetry argument (an anchor has zero inbound references, unlike a summary) explaining why this is easier than the summary case, not harder; (2) gate forward / prune backward, and why GAP-11-A's machinery structurally cannot close this gap (`prepareInjection` loads anchors through a separate unfiltered `listAnchors()` call); (3) classification-enrichment and the census-is-a-floor consequence; (4) the five-part safety contract mirroring ADR 0050, plus a Recovery section that explicitly states no `rebuild-anchors` command exists today.

## Task Commits

1. **Task 1: RED contract + parity suite** - `344f247` (test)
2. **Task 2: Implement in both stores** - `6573cbd` (feat)
3. **Task 3: ADR 0051** - `a319360` (docs)

## Files Created/Modified

- `src/storage/mcp-mutation-contracts.ts` - Adds the `unhygienic_anchor_prune` contract (input/skip-reason/receipt schemas, inferred types) and two fault boundaries.
- `tests/storage/anchor-hygiene-prune.test.ts` (new) - 28-case `describe.each` suite over `SqliteStore` and `InMemoryStore`.
- `src/storage/memory-store.ts` - Declares `commitUnhygienicAnchorPrune`/`listAnchorIds`/`summarizeAnchorDerivationClasses` on `MemoryStore`.
- `src/storage/sqlite-store.ts` - Implements all three methods; imports `classifyEvent`/`HYGIENE_RULE_VERSION`.
- `src/storage/in-memory-store.ts` - Implements all three methods identically.
- `docs/adr/0051-anchor-derivation-hygiene.md` (new) - The lifecycle decision, gate-forward/prune-backward split, classification-enrichment consequence, safety contract, recovery story.

## Decisions Made

See `key-decisions` in frontmatter above.

## Deviations from Plan

None beyond one Rule 1 fixture correction discovered while getting the RED suite to fail for the right reason (see below) — no scope change, no architectural decision, no store-code change in Task 1's commit.

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test fixture `makeTrace`/`makeProposal` seeded invalid control rows**
- **Found during:** Task 1, first `npx vitest run` of the RED suite
- **Issue:** `MemoryTraceSchema.summaryIds` requires `min(2)` and the box-proposal payload's `sourceSummaryIds` requires `min(1)`; the test's control-row fixtures (borrowed from `superseded-prune.test.ts`'s defaults, which are only ever called with overrides in that file) used empty/undersized arrays, so `seedControls` threw a `ZodError` before any anchor-prune assertion ran — the wrong kind of failure for a RED commit (a fixture bug, not "method missing").
- **Fix:** Gave `makeTrace`'s default `summaryIds` two placeholder ids and `makeProposal`'s default `sourceSummaryIds`/payload `sourceSummaryIds` one placeholder id each, so `seedControls` succeeds and every case fails only on `store.commitUnhygienicAnchorPrune is not a function`.
- **Files modified:** `tests/storage/anchor-hygiene-prune.test.ts`
- **Verification:** `npx vitest run tests/storage/anchor-hygiene-prune.test.ts` — all 28 cases fail with `TypeError: store.commitUnhygienicAnchorPrune is not a function`, confirmed by `grep`.
- **Committed in:** `344f247` (Task 1's commit — the fixture was never committed in a broken state)

---

**Total deviations:** 1 auto-fixed (Rule 1 — a test-fixture defect caught before the RED commit, not a defect in production code).
**Impact on plan:** None. No store code, contract shape, or acceptance criterion changed.

## Issues Encountered

None beyond the fixture fix documented above. The plan's Task 1 verify step (`npx vitest run ... && npm run typecheck && echo RED_AS_EXPECTED`) requires the RED commit to typecheck clean even though the store methods do not exist yet — satisfied by declaring a local `StoreUnderTest = MemoryStore & { commitUnhygienicAnchorPrune(...): ... }` type in the test file and casting the constructed store instances to it (`as unknown as StoreUnderTest`), so the test file compiles against a method the real `MemoryStore` interface does not yet declare, while still failing at runtime for the correct reason.

## User Setup Required

None. No schema migration, no new configuration, no external service. This plan touches no live database — every test seeds and tears down its own temp-file `SqliteStore` or in-process `InMemoryStore`; nothing in this plan reads, writes, or connects to `~/.memory/aaron.db` or any path derived from `MEMORY_DB`.

## Next Phase Readiness

- `commitUnhygienicAnchorPrune`, `listAnchorIds`, and `summarizeAnchorDerivationClasses` are ready for Plan 11-17's `memory prune-unhygienic-anchors` operator command, which should wrap them the same way `memory prune-superseded` (Plan 11-12) wraps `commitSupersededSummaryPrune`: dry-run default via `summarizeAnchorDerivationClasses`, `--apply` gated on a verified `--confirm-backup` path, resumable batches via `listAnchorIds`.
- Plan 11-18 (owner-authorized live anchor prune against `~/.memory/aaron.db`) and Plan 11-13/11-14's SC7 sign-off remain blocked on Plan 11-17 landing first — this plan builds machinery only, no live data was touched.
- `npx vitest run` (110 files, 986 passed, 4 skipped) and `npm run typecheck` are both green with no pre-existing test modified (`git diff --stat` across Task 2's commit shows only `memory-store.ts`/`sqlite-store.ts`/`in-memory-store.ts`, no test file).
- No blockers for Plan 11-17.

## Self-Check: PASSED

All 6 claimed created/modified files found on disk (`src/storage/mcp-mutation-contracts.ts`, `tests/storage/anchor-hygiene-prune.test.ts`, `src/storage/memory-store.ts`, `src/storage/sqlite-store.ts`, `src/storage/in-memory-store.ts`, `docs/adr/0051-anchor-derivation-hygiene.md`); all 3 claimed commit hashes (`344f247`, `6573cbd`, `a319360`) found in `git log --oneline`.

---
*Phase: 11-derivation-input-hygiene*
*Completed: 2026-07-27*
