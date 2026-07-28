---
phase: 11-derivation-input-hygiene
plan: 30
subsystem: imports
tags: [security, redaction, gap-closure, adr]
requires: ["11-29"]
provides:
  - "escaped-JSON secret detection at the import boundary"
  - "credential-lead-in user/pass detection"
  - "recorded decision that derivation does not re-scan for secrets"
affects: ["src/imports/secret-redactor.ts"]
tech-stack:
  added: []
  patterns: ["measure candidate detection rules on the real corpus before shipping"]
key-files:
  created:
    - .planning/phases/11-derivation-input-hygiene/11-REDACTOR-AUDIT.md
  modified:
    - src/imports/secret-redactor.ts
    - tests/imports/secret-redactor.test.ts
    - docs/adr/0045-bounded-parser-quarantine-and-replay.md
decisions:
  - "Redaction stays authoritative at import; derivation does not re-scan for secrets, because the summarizer paraphrases rather than copies — a derivation re-scan would have caught 1 of 143 contaminated summaries"
  - "Reject a bare 64-hex secret rule: it catches ~1,080 content digests and object IDs against 8 real key rows"
  - "Reject the ungated user/pass rule at a measured 50% false-positive rate; gate the password side on shape instead of on quoting"
metrics:
  duration: ~2h
  completed: 2026-07-28
requirements: [REQ-053]
closes_gaps: ["GAP-11-F-detection"]
---

# Phase 11 Plan 30: Secret Redactor Detection Gap Summary

Closed GAP-11-F's detection half by finding three distinct predicate failures in `secret-redactor.ts` —
a missing credential lead-in, a value grammar that cannot express a `user / pass` pair, and an inability
to skip backslash-escaped quotes in JSON-embedded tool-call content — then shipping four rules whose
true- and false-positive counts were measured on the 449,718-row live corpus before any of them landed,
and rejecting two more on measured precision.

## What was done

**Task 1 — audit** (`7e2fb97`). Explained each shipped rule's non-firing by its actual predicate,
verified empirically by calling `redactKnownSecrets()` on synthetic reconstructions rather than by
reading regexes. Censused the corpus read-only (`readOnly: true`; the four backups untouched) and
measured six candidate rules for both TP and FP. Written up in `11-REDACTOR-AUDIT.md`.

A first census pass was discarded as invalid: it scanned whole payload JSON and so counted every row's
`contentHash` as a 64-hex secret, inflating one candidate to 292,988 hits. The corrected pass scans
content fields only. That artifact is recorded in the audit because it is exactly the measurement error
that would have justified a bad rule.

**Task 2 — implementation** (`8d2f8db`, TDD). Seven failing tests first with synthetic fixtures, then
four rules:

| Rule | New catches (canonical / summaries / anchors) | Measured FP |
|---|---|---|
| Escaped-quote keyword pair | 193 / 80 / 27 | 0 — reuses the shipped keyword set unchanged, so its FP profile is that of a rule already in production |
| Credential lead-in + `user / pass` | 1 / 1 / 1 | 0 across 292,407 canonical events |
| Spaced key phrase, narrowed | 4 / 5 / 0 | 0 |
| URI userinfo password | 33 / 18 / 0 | 0 |

Rejected with numbers: the ungated `user / pass` variant (**50%** FP — it redacted prose of the form
`Antipattern = "Note / NoteABC map"`), and a bare 64-hex rule (**~1,080** content digests and git object
IDs against 8 real key rows — a ~94% FP floor in the anchors table alone). Both rejections are pinned by
passing control tests, so re-adding either breaks the suite.

**Task 3 — propagation decision.** Dated addendum appended to ADR 0045. Nothing deleted.

## The propagation decision, in brief

**Derivation does not re-scan; redaction stays authoritative at import.** Both sides are argued in full
in the ADR addendum. The deciding evidence is empirical rather than architectural: of the 143
contaminated summaries GAP-11-F counts, the verbatim escaped rendering survives into exactly **one** —
the summarizer paraphrased the credential into the other 142. A derivation-time re-scan using
import-shaped rules would have caught roughly 0.7% of the contamination it appears to promise, at the
cost of a regex battery on a much hotter path. Catching paraphrased secrets is a semantic problem, not a
regex problem.

The decision carries two recorded obligations: changes to the redaction boundary are corpus-affecting
(nothing downstream will catch what import misses), and new rules must be measured before shipping,
because an over-broad rule at an authoritative boundary has no downstream check either.

## Verification

- Pre-fix failure recorded: 7 failed / 8 passed on the new test file before implementation
- Post-fix: `npx vitest run tests/imports/secret-redactor.test.ts` — 15/15 pass
- Full suite: `npx vitest run` — **110 files passed, 1 skipped; 1038 tests passed, 4 skipped**. The
  known-flaky `tests/mcp/mutation-tools.test.ts` and `tests/mcp/stdio-server.test.ts` both passed.
- `npm run typecheck` — clean
- **Corpus-scale regression check:** ran old and new redactors over all 449,718 content rows. 321 rows
  changed (0.071%), 406 redaction spans added, **0 existing redaction spans lost**. All 45 sampled
  divergences were DSN passwords or real vendor tokens; no prose over-redaction.

## Deviations from Plan

**1. [Rule 3 - Blocking] ADR filename differs from the plan's path**
- **Found during:** Task 3
- **Issue:** The plan names `docs/adr/0045-import-quarantine.md`; the file on disk is
  `docs/adr/0045-bounded-parser-quarantine-and-replay.md`. No file exists at the planned path.
- **Fix:** Amended the real ADR 0045. Same ADR number, same subject.
- **Commit:** this plan's Task 3 commit

**2. [Rule 1 - Bug] A false-positive control asserted a change to pre-existing behavior**
- **Found during:** Task 2 RED
- **Issue:** The control `api_key: "${ANTHROPIC_API_KEY}"` asserted the value is left alone, but the
  shipped keyword rule has always redacted it. Keeping the assertion would have forced a regression of
  existing behavior to make a new test pass.
- **Fix:** Narrowed the control to placeholder values in the positions the *new* rules cover, with a
  comment recording why the pre-existing behavior is deliberately unchanged.
- **Files modified:** `tests/imports/secret-redactor.test.ts`

**3. [Rule 2 - Missing critical functionality] Shipped one more rule than the strict gap required**
- **Found during:** Task 1 census
- **Issue:** The escaped-quote defect was found by the census, not by the incident. It is not the class
  that escaped in GAP-11-F, but it is the class with 10× the corpus volume and it is a plain hole in
  the boundary CLAUDE.md calls authoritative.
- **Fix:** Included it, with measured precision and the keyword set left unwidened.

**4. [Rule 3 - Blocking] STATE.md updated by hand**
- **Issue:** As briefed, `gsd-sdk` `state.advance-plan` / `state.update-progress` error in this repo and
  `record-session` corrupts `current_plan`. Those verbs were not run.
- **Fix:** Hand-edited STATE.md. `roadmap.update-plan-progress` and `requirements.mark-complete` were
  run normally.

## Known Stubs

None.

## Threat Flags

None. This plan reduces attack surface at an existing trust boundary and adds no new endpoints, auth
paths, file access patterns, or schema changes.

## Security notes

- No live credential value appears in any file created or modified by this plan. All test fixtures are
  synthetic; all census output was character-class masked before being written.
- The corpus was opened `readOnly: true` throughout. `~/.memory/aaron.db` was never opened for writing.
  None of the four backups (`pre-v4`, `pre-rebuild-v3`, `pre-anchor-prune`, `pre-phase11`) were touched.
- Census scripts remain in the session scratchpad and are deliberately **not** committed — they embed
  corpus-shaped output.

## Self-Check: PASSED

All five created/modified files present on disk; both task commits (`7e2fb97`, `8d2f8db`) present in
`git log`.

## Out of scope, explicitly

- **Corpus remediation** of the 151 contaminated rows — the owner did not choose it; GAP-11-F records it.
- **Git history rewrite** — that is Plan 11-31, after SC7 sign-off.
- **Implementing a derivation re-scan** — Task 3 records the decision *not* to, and implementing either
  answer was out of scope by the plan's own terms.
- **No SC7 claim is made.** That is Plan 11-14 and the owner's call.
