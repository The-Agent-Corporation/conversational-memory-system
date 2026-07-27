# GAP-11-E finding — why tool-call and harness text still reach injection packets

**Plan:** 11-22 (wave 20, gap-closure investigation, no fix applied)
**Status:** finding complete. This document authorizes nothing; the remediation decision belongs
to the owner in Plan 11-23.
**Script:** `.planning/phases/11-derivation-input-hygiene/11-leak-attribution.ts` (read-only, run
against a `cp -c` clone; never opened `~/.memory/aaron.db` or a `.pre-*` backup directly).
**Raw output:** `.planning/phases/11-derivation-input-hygiene/probe-v2/leak-attribution-current-v2.json`
and `.md`.

## Summary answer

There is **not one root cause. There are three, and they need different remediations:**

| Hypothesis | Count (formal) | Count (doc-cited) | What it means | Does `rebuild-derivations` fix it? |
|---|---|---|---|---|
| **H-0** — by-design isolated tool call | 0 | 5 | Not a defect. Exactly the locked 11-CONTEXT decision. | N/A — nothing to fix |
| **H-i** — anchored rules cannot see mid-body scaffolding | 2 | 0 | Real rule limitation. `SYNTHETIC_RULES` are all `startsWith` and only run against the derivation module's per-event content; a marker embedded inside a longer message is invisible to them. | **No — reproduces the leak** |
| **H-iii** — stale derivation, never reprocessed under hygiene-rules/v2 | 4 | 1 | The corpus's own contraction checkpoint is pinned to `hygiene-rules/v1`; `task-notification`/`local-command-caveat` (added in Plan 11-20, now part of v2) have never been applied to this tail of the corpus. | **Yes** |
| **H-ii** — unfiltered summarizer input path | 0 | 0 | Not found. Both derivation seams (`ContractionRunner.summaryForSpan`, `PreCompactor.compactCompactedTopic`) call `derivationContents` unconditionally. | N/A |
| **H-iv** — non-summary path | 0 | 0 | All twelve offenders across both offender-identification passes are `kind: summary`. | N/A |

"Formal" and "doc-cited" are two different, non-identical offender lists (see "A measurement
discrepancy worth fixing" below) that happen to overlap on exactly one item. The union is **11
distinct offenders**, all `kind: summary`: **5× H-0, 2× H-i, 4× H-iii**.

**The rebuild question, answered directly: a rebuild is necessary but not sufficient.** Running
`memory rebuild-derivations` today would fix every H-iii offender (4 of 11, plus — per the
checkpoint evidence below — an unknown but likely larger number of similarly-shaped summaries
across the untouched tail of the corpus). It would **reproduce** every H-i offender unchanged,
because H-i is a code-level limitation in `SYNTHETIC_RULES`' matching strategy that hygiene-rules/v2
did not touch. Running the rebuild without first fixing the H-i limitation wastes none of the H-iii
work, but the owner should not expect it to reach 0/12 unhygienic queries on its own.

## The three hypotheses, each with its own worked evidence

### H-0 — by-design isolated tool call (not a defect)

Doc-cited offenders (`11-RECALL-PROBE-V2.md`'s tool-call-text table): Q1 rank 1, Q1 rank 2, Q3
rank 0, Q4 rank 0, Q10 rank 1 — ids `historical_summary_015a8c01…`, `…069babea…`,
`…0719251073…`, `…67d56fcbf7…`, `…a42dfe862b…`.

Traced end-to-end. Example — `historical_summary_015a8c0126ac90404eb9fb32c7211761fb2959708e8d4150b33067789321c730`
(Q1 rank 1):

- `sourceCanonicalEventIds`: 2 — `event_fb7b7dfa…` (`occurredAt: 2026-07-19T19:42:28.456Z`,
  `eventKind: message`, `role: assistant`, content: `"Both blockers are confirmed by direct code
  tracing…"`) and `event_f1adc083…` (`occurredAt: 2026-07-19T19:42:30.110Z`, `eventKind: tool_call`,
  content: `"[Tool call: Bash] {…}"`).
- Re-running the SHIPPED `derivationContents` over these two events (in canonical order) produces
  exactly two entries: the conversational text verbatim, then the tool-call text verbatim — because
  `computeSegments` (`derivation-hygiene.ts:180-204`) sees a tool run of length 1 and
  `derivationContents` (`derivation-hygiene.ts:216`) returns `segment.entries[0]` unmodified for any
  segment of length 1. This is the locked 11-CONTEXT decision: *"a single isolated tool call keeps
  its existing text."*
- The re-derived text is a verbatim match for the stored `summaryText`'s derivable portion (the
  `DeterministicSummarizer`'s `buildSummaryText` joins derived contents with `" "` and prepends the
  topic label — confirmed against the stored text byte-for-byte for the two entries).
- `classifyEvent` on the FULL summary text (as the recall probe applies it) reports `conversational`
  — correctly, since the first characters of the summary are conversational prose. This is exactly
  why `11-RECALL-PROBE-V2.md` observed "every one classifies conversational while carrying tool-call
  text": the classifier is doing its job on the text it's given; the text just legitimately contains
  a verbatim tool call by design.

`historical_summary_67d56fcbf796b6df1b9d0fbfd3c24a867c19f9d8c8c0b163141f9315f3b5b142` (Q4 rank 0)
is the one case in this group worth a caveat: its window has 4 raw events (conversational, isolated
tool call, conversational, isolated tool call), so `derivationContents` returns 4 entries, but
`DeterministicSummarizer.buildSummaryText` only joins the first 3 (`.slice(0, 3)` in
`summarizer.ts:55`) — the trailing `[Tool call: Bash] {"command":"npx tsc…"}` entry is silently
dropped from the stored summary. This is the summarizer's own top-3 truncation, unrelated to hygiene
rules; it does not change the H-0 classification (nothing was collapsed or should-have-been-dropped
under any hygiene rule version), but it does mean "reproduces the text" for this one item means
"reproduces the first 3 of 4 entries," not a full match. Worth a separate follow-up note if the
truncation itself is ever considered undesirable — out of scope for GAP-11-E.

**Conclusion for H-0:** compliant with REQ-052 and ROADMAP SC1/SC3 as written (see "the SC3 tension"
below). Not a code defect. A rebuild reproduces this exact text either way.

### H-i — anchored rules cannot see mid-body scaffolding (real defect, rebuild does not fix)

Formal offenders (probe's own `unhygienicRanks`, i.e. `derivationClass === "synthetic_injected" ||
markersFound.length > 0`): Q2 rank 1, Q2 rank 2 — ids `historical_summary_72ee7793…`,
`…b8edf3787d…`.

Traced end-to-end. `historical_summary_72ee7793622ebfaa449be2143d76e0b421765ac510fb73e9fdf7b7022facf913`
(Q2 rank 1):

- `sourceCanonicalEventIds`: **1** — `event_236ff37d9133…`, `eventKind: message`, `role: assistant`,
  `occurredAt: 2026-06-28T19:07:42.673Z`. There is no tool call in this window at all.
- The event's content begins `"Now I have everything needed. I'll emit the integration artifact…"`
  (conversational) and, ~2,900 characters in, contains a markdown table cell: `"~40/79 spans were
  silent `[SILENT]` cron noise; a recurrence=1 thread can be highly memory-worthy."` — the assistant
  is **discussing** the `[SILENT]` marker as a design topic, not emitting one.
- `classifyEvent` on this single event correctly returns `conversational` (`silent-sentinel`'s test
  is `c.startsWith("[SILENT]")`, `derivation-hygiene.ts:113`, and the event doesn't start with it).
  `derivationContents` therefore keeps the whole event verbatim — correctly, by the rule as written.
- The recall probe's `markersFound` check (`SYNTHETIC_MARKERS.filter((m) =>
  memory.text.includes(m.marker))`, `11-recall-probe.ts:236`) flags it anyway, because it scans for
  the marker **anywhere in the text**, not just at the start.

This is the mechanical point `11-RECALL-PROBE-V2.md` already surfaced for the `task-notification`
case ("every `SYNTHETIC_RULE` is an anchored `startsWith`… the marker is not at the start of the
text") generalized: it is a structural property of every rule in `SYNTHETIC_RULES`, not specific to
one rule id. Re-deriving this item under the CURRENT (v2) rules reproduces the exact same
"leak" — the anchoring, not the rule table's contents, is what's missing a case.

**A caveat this finding will not paper over:** this specific example is arguably not a hygiene
"leak" at all in the sense GAP-11-E means. The assistant's text is legitimately conversational
prose *about* the `[SILENT]` marker concept; stripping it would delete real content to satisfy a
detector that cannot distinguish "this event started with scaffolding" from "this event mentions
scaffolding syntax." Whether Q2 rank 1/2 represent a genuine hygiene defect (mid-body real
scaffolding the rule should reach) or a false positive of whole-text substring scanning depends on
what's at the OTHER end of a mid-body match — this document does not have a second, cleaner
mid-body example to generalize from, and neither of Q2's two items is one. **Listed separately per
the plan's "genuinely mixed evidence" instruction rather than forced into a clean verdict.** What is
NOT ambiguous: the `task-notification` cases below (H-iii) prove mid-body-vs-start-of-event is a
real, reproducible discriminator problem independent of this specific false-positive question,
because in those cases the marker genuinely IS the entire content of its own dedicated event (see
next section) — so the anchoring limitation is real even if this particular Q2 example isn't the
cleanest illustration of it.

**Conclusion for H-i:** a genuine rule-table/matching-strategy limitation. `rebuild-derivations`
reproduces it. Fixing it requires a code change to how `SYNTHETIC_RULES` match (e.g., matching
anywhere in an event's content rather than only at the start, or splitting/redacting only the
matched span rather than accept/reject the whole event) — and that code change needs its own design
decision (redacting a substring changes what "the event's own text" means for REQ-053's anchor
gating), which is exactly why this finding does not propose one.

### H-iii — stale derivation, never reprocessed under hygiene-rules/v2 (rebuild fixes it)

Offenders in both lists: Q3 rank 2 (`historical_summary_e189f4cde7f7ba30fcfee772d1fbe4935b26c41ed2f23def7ca65441568c3fdc`,
appears in both the doc-cited table and the formal `unhygienicRanks` list — the one point of
overlap), plus Q4 rank 2, Q12 rank 0, Q12 rank 1 (formal list only) — ids `…4e529820…`,
`…0a0805a4…`, `…0cba644e…`.

Traced end-to-end. `historical_summary_e189f4cde7f7ba30fcfee772d1fbe4935b26c41ed2f23def7ca65441568c3fdc`
(Q3 rank 2):

- `sourceCanonicalEventIds`: 2 — `event_23a36e2e…` (`occurredAt: 2026-07-20T17:04:50.508Z`,
  `eventKind: message`, `role: user`, content starting `"<task-notification>\n<task-id>…"` — the
  ENTIRE event is the task-notification block, nothing else) and `event_b5ba38a3…`
  (`occurredAt: 2026-07-20T17:04:54.640Z`, `eventKind: tool_call`, `"[Tool call: Edit] {…}"`,
  isolated).
- Re-running `derivationContents` under the CURRENT rule set (`hygiene-rules/v2`, which includes
  `task-notification` — added in Plan 11-20, `derivation-hygiene.ts:82,117`): `classifyEvent` on
  `event_23a36e2e` returns `synthetic_injected` / `ruleId: "task-notification"` (the event's own
  content STARTS with the marker — the anchoring works fine here, unlike the H-i case, because
  there is no surrounding conversational text in the same event). `derivationContents` correctly
  drops it. The re-derived output is exactly one entry: the isolated `[Tool call: Edit]` text.
- The STORED `summaryText` contains BOTH the full task-notification block AND the tool-call text.
  Since current rules would drop the task-notification block and the stored text still has it, the
  stored summary was **not** computed under the rules that are live today.

**Why:** the corpus's shared contraction checkpoint (`daemon_contraction_checkpoint`, id
`contraction_checkpoint_contraction_181c43105fe44dcaabe292e0b1332d0b3859f3ab43fa01fbb20f634258fb793e`)
records `processorVersion: "continuous-contraction/v1+hygiene-rules/v1"` — **not v2**. `hygiene-rules/v2`
(the `task-notification` and `local-command-caveat` rules) was added in Plan 11-20, which shipped
after this checkpoint was last written. `rebuild-derivations`' own staleness gate
(`rebuild-derivations-command.ts:99`, `checkpoint.processorVersion !== PROCESSOR_VERSION`) would see
this mismatch and force a full corpus rewind-and-reprocess the next time it runs — meaning **it has
not been run since Plan 11-20 shipped**, and doing so now would apply v2's rules, including
`task-notification`, to every span in the corpus for the first time.

One data point worth flagging rather than asserting as proven: `bootstrap_checkpoints` (a *separate*,
legacy-compatibility checkpoint written by `HistoricalBootstrapper.bootstrap()`,
`historical-bootstrapper.ts:287-303`) shows `processedEventCount: 292407` — the full corpus — under
its own static `processorVersion: "historical-bootstrap/v1"` (a constant that does **not** embed
`HYGIENE_RULE_VERSION`, unlike `ContractionRunner.PROCESSOR_VERSION`). `buildCompatibilityCheckpoint`
computes `processedEventCount` from `events.length` at call time regardless of how much work the
underlying `drainSlice` loop actually did that call — including a no-op call. **This checkpoint
cannot be read as proof the corpus was fully (re)derived**; it proves only that `bootstrap()` was
invoked at some point after the corpus reached 292,407 events. The authoritative progress record for
what was actually (re)computed, and under which hygiene rule version, is
`daemon_contraction_checkpoint` — the one showing `hygiene-rules/v1`. This distinction matters for
Plan 11-23: don't let the bootstrap checkpoint's "292407/292407" reading be mistaken for "the v2
rebuild already happened."

**Conclusion for H-iii:** genuinely stale. `rebuild-derivations` is the correct, sufficient remedy
for this class, and per the checkpoint version mismatch, it will force a full reprocess (not a
partial one) the next time it's invoked.

## Is a rebuild sufficient? (GAP-11-E open question 2, direct answer)

**No, not alone.** A rebuild fixes 100% of the H-iii offenders (4 of 11 traced here, and by the
same mechanism, presumably others across the corpus tail this investigation didn't individually
enumerate — see "what's not covered" below). It fixes 0% of the H-i offenders, because H-i is a
code-level limitation in how `SYNTHETIC_RULES` match text, untouched by the v1→v2 rule-table bump.
Running the rebuild without addressing H-i first will not reproduce new damage — it's harmless to
run now — but the owner should expect the recall probe to still show non-zero unhygienic items
afterward, specifically wherever a marker sits mid-event rather than at an event's own start.

## Are all offenders hitting the same root cause? (GAP-11-E open question 3, direct answer)

**No — three distinct causes, not one:**

1. **H-0 (5 of 11):** not a cause at all — compliant by-design behavior.
2. **H-i (2 of 11):** a rule-matching-strategy defect (anchoring), independent of when the summary
   was computed.
3. **H-iii (4 of 11):** a staleness defect (checkpoint pinned to a rule version predating the rules
   that would have caught it), independent of rule-matching strategy.

These interact but do not share a fix: fixing H-i's anchoring does nothing for H-iii's staleness,
and running the H-iii-fixing rebuild does nothing for H-i's offenders.

## Refuting/confirming GAP-11-E's "all summary-derived" claim

**Confirmed, not refuted.** All 11 distinct offenders traced (5 doc-cited + 6 formal, with 1
overlap) are `kind: summary`. Zero `anchor`, `trace`, or `box_context` offenders appeared in either
offender-identification pass over `current-v2`. GAP-11-E's premise — that the surviving
contamination in `current-v2` is entirely summary-derived — holds for every item this investigation
traced.

## A measurement discrepancy worth fixing before Plan 11-23 (not a hygiene defect, but a data-quality issue)

`11-RECALL-PROBE-V2.md`'s "Attribution of the residue in current-v2" table (the "evidence you start
from" for this plan) and the SAME probe artifact's own `unhygienicItemCount`/`unhygienicRanks`
fields (used to compute the "6/33 unhygienic items" figure in that document's own Totals table) are
built from **two different predicates** and name **different items**:

- The doc's table: items where `containsToolCallText` is true (i.e. `text.includes("[Tool call:
  ")`) — Q1 rank 1/2, Q3 rank 0/2, Q4 rank 0, Q10 rank 1.
- The `unhygienicItemCount`/`unhygienicRanks` fields actually stored in `current-v2.json`: items
  where `classification.derivationClass === "synthetic_injected" || markersFound.length > 0` — Q2
  rank 1/2, Q3 rank 2, Q4 rank 2, Q12 rank 0/1.

Both sets happen to total 6 items in `current-v2`, which is almost certainly why the coincidence
went unnoticed — but they are not the same 6 items, and they overlap on exactly one (`Q3 rank 2`).
This investigation's Task 1 (offender inventory) was scoped to the probe's own `unhygienicItemCount`
definition per the plan's acceptance criteria ("the row count equals the sum of `unhygienicItemCount`
across queries"); this finding additionally traced the doc-cited tool-call-text table by hand to
honor the evidence block this plan was launched from. Recommend Plan 11-23 (or a future plan)
reconcile which of these two predicates — or their union — is what SC7/SC3 sign-off should measure
against, since they currently produce different numerator counts for the same corpus state.

## What's not covered by this finding

- This investigation traced 11 specific offenders (the union of two offender lists over
  `current-v2`'s 12-query probe), not every summary in the corpus. H-iii's mechanism (stale
  checkpoint pinned to `hygiene-rules/v1`) is a corpus-wide condition — every summary whose span
  falls after the checkpoint's `processedThroughOrderKey` and whose content matches a v2-only rule
  is presumptively affected, not just the 4 traced here. The exact count is unknown without a
  corpus-wide census (out of scope for this plan; `11-SCAFFOLD-AUDIT.md`'s census methodology from
  Plan 11-20 would be the right tool for that, if the owner wants a number before authorizing the
  rebuild).
- H-i's scope is similarly unknown corpus-wide: this finding traced 2 offenders from one rule
  (`silent-sentinel`) triggering on a false-positive mid-body match; whether other
  `SYNTHETIC_RULES` have genuine (non-false-positive) mid-body misses elsewhere in the corpus was
  not surveyed.
- `origin` was NOT usable as a provenance discriminator, contrary to the plan's own interfaces
  section, which is itself worth recording: `ContractionRunner.summaryForSpan`
  (`contraction-runner.ts:422`) hardcodes `origin: "historical_bootstrap"` on every summary it
  produces, regardless of whether the span was processed by a live daemon slice or a bulk
  bootstrap/rebuild — `origin: "host_session"` is declared in the `Summary` schema
  (`domain/types.ts:108`) but is never assigned anywhere in `src/`. Likewise `createdAt` on a
  Summary is `span.completedAt` (the underlying conversation's timestamp), not a write timestamp —
  it says nothing about when the summary record was last (re)computed. Neither field can be used to
  tell a fresh rebuild's output from a years-old one; only the shared contraction checkpoint's
  `processorVersion` can.

## What evidence would overturn this finding

- **H-0 offenders being misclassified:** if a future audit finds an H-0-labeled offender whose
  window actually contains a run of ≥2 tool-activity events (not 1), that offender is H-i, not H-0
  — re-run `11-leak-attribution.ts` against it; `isolatedToolSegment: false` would surface it
  immediately.
- **H-i being fixable by a rebuild after all:** if hygiene-rules/v2 (or a future version) changes
  the matching strategy from `startsWith` to a substring/regex scan, H-i's offenders would become
  re-testable — re-running the script after such a change and observing `reproduces: true` flip to
  `false` would confirm the fix.
- **H-iii's "rebuild fixes it" claim being wrong:** if `memory rebuild-derivations` is run and a
  Q3-rank-2-shaped offender (task-notification, or any v2-only marker, embedded in its own
  dedicated event) still survives afterward, that would mean either the rebuild did not actually
  reach that span (a resumability/checkpoint bug, contradicting SC5) or the rule still isn't firing
  for a reason this investigation didn't find. The frozen 12-query recall probe
  (`11-recall-probe.ts`) is the reusable acceptance test for exactly this: re-run it against the
  post-rebuild corpus and diff against `current-v2.json`.
- **The `bootstrap_checkpoints` reading:** if someone can show `HistoricalBootstrapper.bootstrap()`
  and `rebuild-derivations` are NOT sharing the same `daemon_contraction_checkpoint`/
  `daemon_contraction_job` rows (this finding traced the code path and believes they are, via the
  shared `historicalContractionJobId(personId)`), the staleness argument for H-iii would need
  re-examination.

## Resolving the SC3 / isolated-tool-call / 11-13-must_have tension (recommendation, not a decision)

Three documents disagree, and this finding's evidence lets that disagreement be stated precisely
rather than argued:

- **ROADMAP.md, Phase 11 Success Criteria, SC1** (`.planning/ROADMAP.md:317`): *"A contraction pass
  over a slice containing a run of consecutive tool calls produces exactly one derived activity line
  naming the distinct tools and their counts, containing no invocation arguments; **a slice
  containing a single isolated tool call summarizes it in its existing form.**"* — explicitly locks
  in H-0's behavior as correct.
- **ROADMAP.md SC3** (`.planning/ROADMAP.md:319`): *"Summaries built under the new rules contain no
  verbatim harness-injected content and no `[Tool call:` argument text **from collapsed runs**."* —
  the qualifier "from collapsed runs" means SC3 does not forbid `[Tool call:` text from an isolated
  (non-collapsed) segment; SC1 and SC3 are mutually consistent on this point.
- **Plan 11-13's self-authored must_have** (`11-13-PLAN.md:20`): *"After the prune, no injection
  packet for any probe query contains tool-call or harness-injected text"* — no carve-out for
  isolated tool calls. This is strictly stricter than SC1+SC3 combined, and it is the must_have
  Plan 11-13's own summary recorded as unsatisfiable (`11-13-SUMMARY.md:30,68`).

**Recommendation:** the H-0 offenders (5 of 11) violate Plan 11-13's must_have but violate nothing
ROADMAP.md or REQ-052/053 actually commit to. SC1 was written and locked in with the isolated-call
carve-out deliberately (11-CONTEXT.md's decision, referenced in this plan's own interfaces section).
Recommend the owner amend or retire Plan 11-13's must_have to match SC1/SC3 as ratified, rather than
treat H-0 offenders as bugs to fix — a code change that stripped isolated tool-call text would
directly contradict SC1's explicit text. This is a recommendation for Plan 11-23, not a decision;
the owner may instead choose to tighten SC1 itself, which is equally available and not for this
document to pre-empt.

## Files

- `.planning/phases/11-derivation-input-hygiene/11-leak-attribution.ts` — read-only discriminator
  script (Tasks 1+2).
- `.planning/phases/11-derivation-input-hygiene/probe-v2/leak-attribution-current-v2.json` /
  `.md` — full offender inventory with hypothesis labels, reasons, stored/re-derived text, and the
  tally (`{"H-i":2,"H-iii":4}` for the formal 6; the doc-cited 5 H-0 examples were traced by the same
  logic ad hoc and are reported inline above, not in this JSON, since the formal script's offender
  predicate does not select them — see "A measurement discrepancy" above).
- `.planning/phases/11-derivation-input-hygiene/probe-v2/doc-cited-toolcall-6.json` — the doc-cited
  6-item subset artifact built for cross-checking (not independently re-run through the full
  script's `collectOffenders` predicate, since it does not select these items; the underlying
  per-offender trace was done directly against the same `derivationContents`/`classifyEvent`
  functions, evidence reported above).

## Corpus safety

- Only `~/.memory/aaron.db` was `cp -c`'d once, to
  `/private/tmp/claude-501/…/scratchpad/aaron-clone-11-22.db`; the clone `stat` was recorded
  unchanged (`size`/`mtime`) before and after every script run (`cloneStatBefore`/`cloneStatAfter`
  in the JSON output; both runs reported `Clone unchanged: true`).
- Neither `~/.memory/aaron.db` nor `aaron.db.pre-phase11` nor `aaron.db.pre-anchor-prune` was opened
  by this plan's script at any point — all reads went through the clone.
- `git diff --stat src/` is empty for this plan; no product code was modified.
