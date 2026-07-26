---
phase: 11-derivation-input-hygiene
plan: 06
subsystem: verification
tags: [hygiene, ratio-test, blast-radius, retrieval, adr]

# Dependency graph
requires:
  - "11-01: src/topic/derivation-hygiene.ts (classifyEvent, derivationContents, HYGIENE_RULE_VERSION)"
  - "11-02: hygiene-aware ContractionRunner.drainSlice"
  - "11-03: hygiene-aware Hermes adapter / pre-compactor"
  - "11-04: memory explain hygiene rationale"
  - "11-05: memory rebuild-derivations command"
provides:
  - "tests/fixtures/hygiene-corpus.ts — deterministic proportional corpus generator (buildHygieneCorpus)"
  - "tests/topic/hygiene-corpus-ratio.test.ts — CI-safe count-AND-volume reduction guard (T-11-19)"
  - "tests/retrieval/memory-retriever.test.ts — SC7 forward cross-session recall assertion"
  - "docs/adr/0048-derivation-input-hygiene.md — the phase's ADR"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Fair-share interleave (interleaveByCount) for deterministically composing a proportional synthetic corpus from independent count-driven unit groups, without randomness in the merge order itself."
    - "Topic-label-safe conversational fixture text: leads with the six vocabulary keywords the label extractor will actually select, and avoids every 'explicit topic' trigger phrase (let's talk / discuss / switch to / resume) that would otherwise capture a long free-text span full of shared connector words and defeat isTopicChange's zero-overlap rule."
    - "Pre-hygiene reference built by relabeling, not reimplementing: strip a leading `[...]` bracket marker and change eventKind to \"message\" — the exact bracket-strip regex works uniformly for [Tool call: ...], [SYSTEM: ...], and [cron:N] ... because all three synthetic/tool templates wrap their entire content in one non-nested top-level bracket."

key-files:
  created:
    - tests/fixtures/hygiene-corpus.ts
    - tests/topic/hygiene-corpus-ratio.test.ts
    - docs/adr/0048-derivation-input-hygiene.md
  modified:
    - tests/retrieval/memory-retriever.test.ts

key-decisions:
  - "Ratio test fixture uses eventCount=2000 with tool events split ~half runs/~half isolated singles (per the plan's explicit Task 1 instruction), which differs from the live corpus's actual ~90.5% run / ~9.5% singles split — chosen because the plan's action text mandates this shape and it still exercises the residual-singles assertion robustly."
  - "Conservative reduction floors (40% count / 45% volume) are fixed constants, independent of both the corpus-specific 59%/66% measured targets and this run's own numbers, so the test cannot become a tautology."
  - "SC7 retrieval test measures scoreText's keyword-overlap fraction via the real MemoryRetriever.prepareInjection's returned confidence, using a query whose vocabulary spans both interrupted sessions — this makes the fragmentation-vs-merge difference observable as a real score gap (0 -> found), not just a tie."

requirements-completed: [REQ-052, REQ-053, REQ-054]

# Metrics
duration: ~55min
completed: 2026-07-26
---

# Phase 11 Plan 06: CI-Safe Hygiene Proof, Blast-Radius Sweep, and ADR 0048 Summary

**Built a deterministic ~2,000-event proportional corpus fixture that reproduces the measured 63.8%/29.5%/6.7% tool/conversational/synthetic class shares without the 5 GB personal database, used it to prove — through the real `ContractionRunner`, not a reimplementation — that hygiene delivers BOTH a large summary-count reduction (88.5%) AND a large volume reduction (78.8%) rather than the volume-only variant 11-MEASUREMENT.md warned an implementation could accidentally ship; confirmed the full suite is green with zero downstream fallout across boxes/traces/retrieval (861 passed / 4 skipped, up from the 785/858 baselines); added a forward-looking SC7 retrieval assertion proving a topic discussed across two tool-interrupted sessions scores strictly higher after hygiene than before it; and wrote ADR 0048 recording the hygiene contract and the `pendingToolRun` decision.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-07-26 (session)
- **Completed:** 2026-07-26
- **Tasks:** 3
- **Files modified:** 4 (3 created, 1 modified)

## Accomplishments

- `tests/fixtures/hygiene-corpus.ts`: a pure, seeded-LCG-only `buildHygieneCorpus({ eventCount, seed })` generator producing a `CanonicalEvent[]` at the measured class proportions — tool-activity events split between collapse-eligible runs (length 2-6, via a fair-share `interleaveByCount` merge) and isolated singles, conversational content rotating through 10 disjoint vocabulary buckets specifically shaped to drive `extractTopicLabel`'s six-keyword extraction (and avoid its "explicit topic" trigger phrases), and synthetic content drawn from two of the real `SYNTHETIC_RULES` templates (`harness-system`, `cron-session-tag`). Verified byte-identical across two calls with the same seed.
- `tests/topic/hygiene-corpus-ratio.test.ts`: contracts the SAME 2,000-event corpus twice through the real `ContractionRunner` — once with tool/synthetic events relabeled to ordinary `eventKind: "message"` conversational events with their bracket marker stripped (reproducing exactly how pre-Phase-11 code would have treated them), and once unchanged — and asserts count reduction >= 40% AND volume reduction >= 45% as **independent** floors, plus that isolated `[Tool call:` singles survive in hygiene summaries while no synthetic marker (`[SYSTEM:`, `[cron:`) ever leaks into one. Measured actuals (logged to CI via `console.log`, per the plan): **88.5% count reduction, 78.8% volume reduction**, both comfortably above the conservative floors and consistent in direction with the live corpus's measured 59%/66%. Runs in ~650ms.
- Full blast-radius sweep (`npm run typecheck && npx vitest run`): **861 passed / 4 skipped**, zero failures, zero expectation changes required in `tests/boxes/`, `tests/traces/`, or `tests/retrieval/` — Plans 02-05 already left every downstream consumer of `summary.summaryText` green. No assertion was weakened at any point.
- New SC7 assertion added to `tests/retrieval/memory-retriever.test.ts`: builds a small real corpus (one message opening a budget-forecast topic, 15 unrelated tool calls, one message continuing the same topic), derives summaries through the real `ContractionRunner` for both a hygiene and a relabeled pre-hygiene variant, and feeds both into the real `MemoryRetriever.prepareInjection`. Hygiene keeps the topic in **one** merged summary (asserted `toHaveLength(1)`); pre-hygiene fragments it into more than one summary (asserted `.length > 1`, none of which alone holds both sessions' vocabulary). The hygiene variant's top-match confidence score is asserted `>=` the pre-hygiene variant's, and in this scenario is asserted strictly `>` (a genuine improvement, not a tie).
- `docs/adr/0048-derivation-input-hygiene.md`: written following the `docs/adr/0046-*.md` Status/Context/Decision/Consequences structure (0047 has an atypically large, deployment-specific threat-model shape that does not fit a derivation-layer decision of this scope). Records the problem, the layering decision (D-1/D-4), classification and collapse (REQ-052/053), the two shared seams, provenance invariance, the `pendingToolRun` decision and its 2026-07-26 owner rationale, the rebuild path (REQ-054), the quarantine contract cross-reference to ADR 0045, the audit surface, an explicit "what was NOT done" section, consequences, and a requirement-traceability table for REQ-052/053/054.

## Task Commits

1. **Task 1: CI-safe proportional corpus fixture + count-and-volume ratio test** - `ea48e67` (test)
2. **Task 2: Blast-radius sweep — boxes, traces, retrieval** - `0893b90` (test)
3. **Task 3: ADR 0048 — Derivation Input Hygiene** - `cc2be09` (docs)

## Files Created/Modified

- `tests/fixtures/hygiene-corpus.ts` - New deterministic corpus generator (`buildHygieneCorpus`), fair-share `interleaveByCount` merge, 10 disjoint conversational vocabulary buckets, tool/synthetic content templates.
- `tests/topic/hygiene-corpus-ratio.test.ts` - New count-AND-volume ratio test driving the real `ContractionRunner` twice; determinism assertion; residual/leak assertions.
- `tests/retrieval/memory-retriever.test.ts` - Added the SC7 cross-session forward-recall test plus its supporting corpus builder, pre-hygiene relabeler, `deriveSummaries`, and `topMatchScore` helpers; added `ContractionRunner` and `CanonicalEvent` imports.
- `docs/adr/0048-derivation-input-hygiene.md` - New ADR.

## Decisions Made

See `key-decisions` in frontmatter above. All three followed directly from the plan's explicit instructions and 11-CONTEXT.md's locked decisions; none required new user input during execution.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixture personId mismatch produced an empty corpus (0 events loaded, 0 summaries)**
- **Found during:** Task 1, first ratio-test run
- **Issue:** `buildHygieneCorpus` defaults `personId` to `"person_hygiene_corpus"` when no override is passed; the ratio test's own `PERSON_ID` constant (`"person_hygiene_ratio"`) differed, so every generated event's `personId` field didn't match the person the job/store queries were scoped to. `ContractionRunner.drainSlice` silently found zero events for that person and returned `complete: true` with zero summaries on the very first call.
- **Fix:** Passed `personId: PERSON_ID, scopeId: SCOPE_ID` explicitly into `buildHygieneCorpus(...)` at the ratio test's call site.
- **Files modified:** `tests/topic/hygiene-corpus-ratio.test.ts`
- **Commit:** `ea48e67` (fixed before the commit; not a separate commit)

**2. [Rule 1 - Bug] Conversational fixture content never triggered a topic change (0 spans, 1 giant summary)**
- **Found during:** Task 1, debugging why the hygiene run produced only 1 summary for 2,000 events
- **Issue:** The conversational template originally began with `"Discussing ..."` followed by connector text (`"today: message N continues... with more detail about..."`). `extractTopicLabel`'s "explicit topic" regex path matches `discuss(?:ing)?` and captures up to 90 characters of free text following it — which included the shared connector words (`"today"`, `"continues"`, `"thread"`, `"detail"`) in every bucket's label, giving every group's topic label nonzero word overlap with every other group's label and permanently defeating `isTopicChange`'s zero-overlap rule.
- **Fix:** Rewrote the template to lead with exactly the six bucket keywords (so `extractTopicLabel`'s six-keyword fallback path is used instead of the explicit-topic regex path) and to avoid every explicit-topic trigger phrase (`let's talk`, `discuss`, `switch to`, `resume`) anywhere in the content.
- **Files modified:** `tests/fixtures/hygiene-corpus.ts`
- **Commit:** `ea48e67` (fixed before the commit; not a separate commit)

**3. [Rule 1 - Bug] SC7 test's `topMatchScore` returned 0 for both variants (scope mismatch)**
- **Found during:** Task 2, first run of the new retrieval test
- **Issue:** The SC7 corpus builder set every event's `scopeId` to `"scope_hygiene_sc7"`, giving each derived summary `scopeIds: ["scope_hygiene_sc7"]` (per `summaryForSpan`'s `event.scopeId ?? "personal"` derivation), but the retrieval request passed `allowedScopeIds: ["personal"]` — a strict-retrieval scope mismatch (ADR 0046) silently excluded every summary from ranking, so both variants scored 0 and the comparison was meaningless.
- **Fix:** Changed the retrieval request's `allowedScopeIds` to `[CROSS_SESSION_SCOPE_ID]` to match the corpus's actual scope.
- **Files modified:** `tests/retrieval/memory-retriever.test.ts`
- **Commit:** `0893b90` (fixed before the commit; not a separate commit)

No other deviations. No assertion was weakened at any point (T-11-20); every discovered issue above was a bug in this plan's own new test/fixture code, fixed before its first commit, not a change to an existing pre-Phase-11 test's expectations.

## Issues Encountered

None blocking, and no downstream test in `tests/boxes/`, `tests/traces/`, or pre-existing `tests/retrieval/` cases required any expectation change — Plans 02-05's hygiene-aware implementation was already fully compatible with every existing consumer of `summary.summaryText`.

## Fixture Independence Statement (T-11-19)

`tests/fixtures/hygiene-corpus.ts` is a from-scratch generator with its own seeded LCG, vocabulary buckets, tool-name cycling, and synthetic templates; it does not import `src/topic/derivation-hygiene.ts` or call `classifyEvent`/`derivationContents` to decide its own composition — its shape is fixed independently of the code under test. The ratio test's `relabelForPreHygiene` step does call the real `classifyEvent` (deliberately: to build an honest "how would pre-Phase-11 code have treated this event" reference, not to influence the corpus's composition), and the hygiene run drives the completely unmodified real `ContractionRunner`/`TopicMonitor`/`DeterministicSummarizer` pipeline end to end. The 40%/45% thresholds are fixed conservative constants, not derived from this run's own numbers — the test could fail if a future change regresses either metric, which is exactly its purpose.

## User Setup Required

None.

## Next Phase Readiness

- Phase 11 (REQ-052, REQ-053, REQ-054) is now fully verified: implementation (Plans 01-05), audit surface (Plan 04), rebuild path (Plan 05), and this plan's CI-safe proof + blast-radius sweep + ADR (Plan 06).
- `memory rebuild-derivations` (Plan 05) is ready to run against the live 292k-event corpus before Phase 12 (incremental embedding) begins, per ADR 0048's ordering consequence (D-6): embedding compute should not be spent on content already excluded from derivation.
- Trace thresholds and top-K (Phase 13) must be recalibrated against the post-hygiene ~56k-summary corpus shape, not the pre-hygiene 135k shape, per ADR 0048's consequences.

---
*Phase: 11-derivation-input-hygiene*
*Completed: 2026-07-26*

## Self-Check: PASSED

- `tests/fixtures/hygiene-corpus.ts` FOUND
- `tests/topic/hygiene-corpus-ratio.test.ts` FOUND
- `docs/adr/0048-derivation-input-hygiene.md` FOUND
- `tests/retrieval/memory-retriever.test.ts` FOUND
- Commit `ea48e67` FOUND in `git log`
- Commit `0893b90` FOUND in `git log`
- Commit `cc2be09` FOUND in `git log`
