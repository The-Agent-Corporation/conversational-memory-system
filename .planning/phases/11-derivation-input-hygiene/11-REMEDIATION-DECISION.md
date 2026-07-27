# Plan 11-23 — Owner remediation decision for GAP-11-E

**Decided:** 2026-07-27 by the owner, against the Plan 11-22 finding
(`11-GAP-11-E-FINDING.md`) and the corrected baseline (`11-RECALL-PROBE-V2.md`).

## What the owner was shown

GAP-11-E resolves into three independent causes across 11 offenders:

| cause | offenders | mechanism | rebuild fixes it? |
|---|---|---|---|
| **H-0** | 5 | `derivationContents` returns a single-entry tool segment unmodified (`derivation-hygiene.ts:216`, `segment.entries.length === 1`). This is ROADMAP **SC1**'s locked decision: "a slice containing a single isolated tool call summarizes it in its existing form." | N/A — working as specified |
| **H-i** | 2 | Every `SYNTHETIC_RULES` entry is an anchored `startsWith`, so a marker embedded mid-event is invisible to `classifyEvent`. | **No** — reproduces unchanged |
| **H-iii** | 4 | The live `daemon_contraction_checkpoint` is pinned at `continuous-contraction/v1+hygiene-rules/v1`; Plan 11-20's v2 rules have never been applied to the corpus. | **Yes** |

Verified independently by the orchestrator: `entries.length === 1` does return the entry unmodified,
and the live checkpoint really is at `hygiene-rules/v1` while `HYGIENE_RULE_VERSION` is `hygiene-rules/v2`.

Also corrected before the decision: the contamination rate in `current-v2` is **6/12 queries**, not
4/12. `toolCallItemCount > 0` names Q1/Q3/Q4/Q10 and `unhygienicItemCount > 0` names Q2/Q3/Q4/Q12;
they overlap only on Q3 and Q4 and coincidentally share a total of 4.

## Decision 1 — fix scope: rebuild + anchored-rule fix + **revise SC1**

**Chosen: all three.** Plan 11-24 will:

1. Run/enable `rebuild-derivations` remediation for the H-iii offenders (the live application itself
   is Plan 11-25, owner-gated).
2. Change the rule-matching strategy so scaffolding markers embedded mid-event are detected, not only
   leading ones — closing H-i.
3. **Revise SC1 so an isolated tool call is collapsed rather than kept verbatim**, closing H-0.

**This overrides a locked decision and the owner was told so.** SC1's carve-out was chosen
deliberately during Phase 11 planning; the orchestrator recommended keeping it and amending Plan
11-13's over-strict must_have instead. The owner chose to revisit SC1 itself. Recorded here as an
explicit, informed override rather than an oversight.

Consequences that follow and must be handled by Plan 11-24, not discovered later:

- **ROADMAP SC1 must be amended in place**, with the original text and the reason for the change
  preserved. A locked decision that silently changes is worse than one that changes loudly.
- **ADR 0048 needs an addendum** recording the reversal and its rationale, alongside the
  `hygiene-rules/v2` addendum already there.
- **`11-CONTEXT.md`'s corresponding decision entry** is now superseded and must say so.
- **The measured simulation targets are invalidated.** Phase 11's planning cited 135,366 → 55,930
  summaries and 228.9 MB → 77.6 MB from `11-hygiene-sim.ts`, computed with SC1's verbatim-isolated-call
  behavior. Collapsing isolated calls changes those numbers. The old targets must not be quoted as
  expectations after this change; either re-run the simulation or explicitly retire the figures.
- **Blast radius is larger than H-0's five offenders.** Those five are what the 12 frozen queries
  happened to surface. Every isolated tool call in the entire corpus is affected. Plan 11-24 must
  measure and state that count before Plan 11-25 applies anything.

## Decision 2 — `[phase:X]` events stay conversational

**Chosen: leave them.** Plan 11-20 deferred ~1,676 events beginning `[phase:draft]`,
`[phase:evaluation]`, `[phase:review]`, `[phase:integration]`, `[phase:validation]`, `[phase:response]`
to the owner, classifying them `needs-owner` rather than `add-rule`.

Rationale, as put to the owner: a `[phase:X]` line is the literal instruction that drove real agent
work, so excluding it changes what the memory records about *why* an agent acted. That is substance,
not scaffolding. No rule is to be added for these; the conservative default holds.

This also settles the two cases Plan 11-20 declined outright — `[Mission Control task comment relay]`
(128 events) and `System: [...] Slack message` (90 events) — which wrap genuine human content and
remain conversational for the same reason.

## Still open, and deliberately not decided here

- **GAP-11-F** (live credential in the corpus and in 16 commits of git history) is a separate,
  higher-severity issue with its own owner actions: credential rotation, git history rewrite, and
  remediation of 151 affected rows. It is not folded into this decision and must not be folded into
  Plan 11-24's scope.
- **Plan 11-13 Tasks 2/3** (the superseded-summary prune) remain withheld and unrelated to SC7.
- **Which predicate SC7 is judged against** — tool-call, synthetic-marker, or their union — must be
  stated explicitly at sign-off (Plan 11-14). The union (6/12 today) is the honest default.
