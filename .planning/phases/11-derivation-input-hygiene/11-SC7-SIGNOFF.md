# Phase 11 — SC7 Owner Sign-Off

**Criterion (ROADMAP SC7):** "Recall quality does not regress: a fixed set of known conversational
queries returns the same or better summaries after hygiene than before."

**Verdict: PASS**, with the Q6 observation recorded below.
**Signed:** 2026-07-28 by the owner (Aaron Whaley), against the evidence in this document.
**Judged on:** `before-v2` (pre-hygiene) vs `post-v4` (fully remediated), both produced by the same
byte-unchanged v2 harness over the byte-unchanged frozen 12-query set.

## Which predicates this was judged against

Per `11-REMEDIATION-DECISION.md`'s addendum, SC7 is judged on **tool-call + product-unhygienic**.
`probe-suspicious` is advisory and each hit was inspected individually.

| predicate | `before-v2` | `post-v4` |
|---|---|---|
| tool-call (`containsToolCallText`) | 19/36 items · 9/12 queries | **0/33 items · 0/12 queries** |
| product-unhygienic (`synthetic_injected`) | 0 | **0/33 items · 0/12 queries** |
| *probe-suspicious (advisory)* | *6 items · 4/12* | *2 items · 1/12 (Q2)* |

The two advisory hits were inspected: six `[SILENT]` occurrences, **none at a line start**, all
backtick-quoted design prose *about* noise suppression. Correctly `conversational`; not counted against
the criterion. Closing them would require the over-matching rule this phase deliberately rejected.

## The semantic judgement — what actually changed in the packets

Zero contamination is necessary but not sufficient for SC7, which is a *quality* criterion. The top
memory for each query was compared before and after:

| | queries | what changed |
|---|---|---|
| **clearly improved** | 9 | top item went from raw `[Tool call: …] {json}` — unusable as memory — to substantive prose |
| **identical** | 2 | Q2, Q11 — already clean, byte-identical packets |
| **changed, relevance arguably lower** | 1 | Q6 — see below |

Representative improvement, Q1 ("zero-knowledge sync relay design decision", answer shape
decision/rationale):

- before: `[Tool call: Write] {"file_path":"…/06-zero-knowledge-multi-device-sync/…"}`
- after: `<verification_context> **Phase:** 06 (gap-closure replan) **Phase Goal:** Synchronize memory
  without giving the relay decryption capability.`

## Recorded observation 1 — Q6

Query: *"Hermes agent bridge integration and control commands"* (answer shape: event).

- `before-v2` top item: a Hermes heartbeat report ("📋 Heartbeat Report — Apr 5 … BUILD: ✅ FIXED")
- `post-v4` top item: "Done. All OpenClaw projects are now GSD workspaces with Mission Control tracking…"

Both are clean conversational memories. The earlier one is more on-topic for the Hermes bridge; the
current one is about Mission Control. **The owner judged this not a hygiene defect**: no scaffolding was
introduced, no content was destroyed by the hygiene rules, and the shift is between two legitimate
memories competing under a keyword-similarity ranker. Recorded as an input to Phase 12 (semantic recall)
rather than as an SC7 failure.

## Recorded observation 2 — Q12 returns content for a control query

Q12 (*"quantum-encrypted recipe database for an interstellar spacecraft galley"*) is the deliberate
expected-nothing control. It returns "Spine Recipe Task Referral Package Organize" — a keyword match on
"recipe". It also returned content in `before-v2`, so this is **not a regression**, but it is a standing
false positive and belongs to the same Phase 12 concern.

## The standing caveat both observations share

The corpus runs the **deterministic hash embedder** (`deterministic/keyword-hash-v1`), not semantic
embeddings — `enabled: false` is the deliberate default (ADR-recorded, never a silent fallback). Relevance
is keyword-shaped by construction, and several queries return off-topic material in BOTH arms for that
reason. That is the subject of the v1.1 milestone's semantic-recall work, not a derivation-hygiene defect.

## Comparability caveat carried forward

The probe classifies with product code **as it runs**. `before-v2` ran at `hygiene-rules/v2`, `post-v4` at
`v4`. `tool-call` and `probe-suspicious` are fully comparable across arms (the marker list did not change,
only the matching strategy); `product-unhygienic` is not strictly comparable. It does not affect this
verdict: the tool-call column, which is fully comparable, went 9/12 → 0/12.

## Corpus state at sign-off

canonical events 292,407 · turns 584,814 · active summaries 49,314 · superseded 89,059 · anchors 18,938 ·
**unhygienic anchors 0** · checkpoint `continuous-contraction/v1+hygiene-rules/v4` gen 4 · `user_version` 3.
Suite 1,038 passed / 4 skipped; typecheck clean. Four backups retained at distinct inodes.

## What this sign-off does NOT cover

- **GAP-11-F corpus remediation.** The Mission Control credential remains in the corpus. The owner
  declined rotation as stale (2026-07-28) and did not select corpus redaction. The detection gap is closed
  by Plan 11-30; the git history rewrite is Plan 11-31.
- **Plan 11-13 Tasks 2/3** (superseded-summary prune) — closed as unneeded by owner decision 2026-07-28:
  superseded rows are already excluded from retrieval, and the file does not shrink without a `VACUUM`.
