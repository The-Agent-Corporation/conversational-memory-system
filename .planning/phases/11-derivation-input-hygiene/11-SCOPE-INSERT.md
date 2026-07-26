# Scope Insert: Derivation Input Hygiene

**Proposed:** 2026-07-26
**Inserts as:** Phase 11 of milestone v1.1 (renumbering former Phases 11–14 to 12–15)
**Blocks:** Phase 12 (Daemon Incremental Embedding), Phase 13 (Forward-Only Vector Trace Discovery)
**New requirements:** REQ-052, REQ-053, REQ-054

## Why this exists

v1.1 was scoped entirely around replacing the trace *algorithm* — shared-term all-pairs → nearest-neighbor over embeddings. Research (`SUMMARY.md`, `PITFALLS.md`, `ARCHITECTURE.md`) never examined the *input* to that algorithm.

Measured against the live corpus (`~/.memory/aaron.db`, 292,407 canonical events, 2026-07-26), the input is overwhelmingly machine-generated text that no one wrote and no one would ask to recall.

### Evidence: tool calls

| Metric | Value | Share |
|---|---|---|
| `eventKind: "tool_call"` events | 186,548 | **64%** of all canonical events |
| tool_call content | 92 MB | 34% of 273 MB total content |
| Summaries containing `[Tool call:` | 51,266 | **38%** of all 135,366 summaries |

No stage of the pipeline filters on `eventKind`. `createToolCallEvent` (`src/imports/tool-call-record.ts:25`) emits `[Tool call: <name>] <args JSON, ≤2000 chars>`; the contraction runner, summarizer, retriever, and injector all treat that identically to a sentence the user typed. The deterministic summarizer concatenates rather than compresses, producing summaries like:

```
Tool Call Terminal Command Curl Http (2 turns, seq 721-722):
[Tool call: terminal] {"command":"curl -s \"http://127.0.0.1:3100/api/companies/…/issues?assigneeAgentId=…\" | python3 -c …"}
[Tool call: terminal] {"command":"curl -s \"http://127.0.0.1:3100/api/companies/…/issues\" 2>&1 | head -200"}
```

Tool *results* are not imported at all — OpenClaw's 23,878 `tool.result` records sit unreplayed in quarantine — so the corpus carries the less informative half of each pair.

### Evidence: synthetic content recorded as user turns

Of 39,617 events with `role: "user"` (128 MB of content):

| Class | Prefix / marker | Events | Content |
|---|---|---|---|
| Skill invocation preamble | `[IMPORTANT: The user has invoked…` | 1,038 | 41 MB |
| Cron harness wrapper | `[SYSTEM: …` | 5,567 | 18 MB |
| Cron session tag | `[cron:<uuid> …` | 7,909 | 16 MB |
| Automated follow-up generation | `### Task:\nSuggest 3-5 relevant follow-up questions…` | 2,378 | 12 MB |
| Harness context injection | `<system-reminder>` | 1,788 | 1 MB |
| Skill body injection | `Base directory for this skill: …` | 127 | 2 MB |
| Multi-agent harness preamble | `[<name>-city] <agent> • <timestamp>` | 274 | 2 MB |
| Compaction / continuation artifacts | `[CONTEXT COMPACTION`, `This session is being continued`, `<local-command-stdout>` | 275 | 2 MB |
| **Total synthetic** | | **~19,356 (49% of user turns)** | **~94 MB (73% of user-message bytes)** |

`<system-reminder>` is matched by containment rather than prefix, so a small amount of overlap with other classes is possible; the prefix-anchored classes are mutually exclusive.

**Net effect: roughly 20,000 of 292,407 canonical events — about 7% — are text a human actually wrote.**

### Why it blocks the vector work

Phase 13's success criterion 4 ("no nightly churn, no collapse into an unbounded mega-trace") is fighting this input directly. Thousands of near-identical `terminal`/`curl` summaries and 7,909 identically-shaped cron wrappers are trivially similar to one another — under shared terms *and* under cosine similarity, since near-identical text yields near-identical vectors. Swapping the algorithm does not fix a corpus whose dominant mode is boilerplate; it re-derives the same dense clusters through a more expensive path. This is a plausible root cause of the ~526k-candidates-from-8k-summaries explosion that motivated the milestone.

Doing hygiene first also shrinks every downstream cost: fewer summaries to embed in Phase 12, smaller ANN index, cheaper trace cycles, and a materially smaller corpus to re-import and re-contract.

## Goal

Derivations are built from conversational content. Machine-generated tool invocations are collapsed into compact activity descriptions rather than reproduced verbatim, and harness-injected scaffolding is excluded from derivation input — while the canonical event timeline remains complete, immutable, and fully auditable.

## Design decisions

**D-1 — Hygiene is a derivation-layer filter, never an import-time drop.**
Canonical events are the durable record (Phase 1 premise); summaries, boxes, and traces are rebuildable derivations, and `src/service/derivation-invalidator.ts` already exists to rebuild them. Dropping at parse time would be irreversible without re-importing 1.1 GB of source history, and would break the `explain`/audit surface (REQ-039) and "what did I actually do on the 9th" queries. Every event keeps being imported and stays queryable; only what feeds summarization changes.

**D-2 — Tool calls collapse by run, and never drive topic labels.** *(amended 2026-07-26 after measurement — see `11-MEASUREMENT.md`)*
A consecutive run of ≥2 tool-call events within a contraction slice collapses into a single derived activity line — `ran 12 terminal commands, 3 file edits, 2 web fetches` — naming distinct tools and counts, not arguments. A single isolated tool call is summarized normally, in its existing form: one deliberate action between two messages is usually the point of the exchange, and losing it loses the "why." Run boundaries are determined by canonical order within the slice, so the rule stays deterministic and slice-local.

Additionally, neither form feeds topic-label extraction or topic-change detection. Simulation showed collapse alone cuts summary volume by 61% but summary count by only 14%, because `TopicMonitor.isTopicChange` ends a span whenever consecutive labels share zero significant words — and an activity line shares no vocabulary with the surrounding conversation, so it still opens its own span. The same mechanism means tool calls have been fragmenting real conversations all along. Making tool activity contribute span *content* but not span *labels* yields 55,930 summaries (41% of baseline) at 77.6 MB (34% of baseline).

**D-3 — Synthetic classification is deterministic, versioned, and recorded.**
Classification runs on deterministic anchored patterns (no model), emitting a `derivationClass` of `conversational` | `tool_activity` | `synthetic_injected` plus the matched rule ID. The rule set carries a version string; a version bump marks affected derivations stale so they can be rebuilt, exactly as `parserVersion` already works for importers. Classification results are persisted, not recomputed ad hoc, so `memory explain` can answer "why isn't this in my memory?" with a specific rule.

**D-4 — Conservative by default; excluded ≠ deleted.**
A rule fires only on unambiguous harness markers (anchored prefixes, structural wrappers). Anything unmatched stays `conversational`. Excluded content remains in the canonical timeline and remains reachable through direct event queries and audit — it is withheld from summarization, embedding, trace discovery, and injection, not erased.

**D-5 — Retroactive rebuild is part of the phase, not a follow-up.**
The existing 135,366 summaries were built without hygiene; 51,266 contain verbatim tool-call text. The phase ships a re-derivation path that invalidates and rebuilds affected summaries under the new rules, reusing the Phase 10 checkpointed/resumable pattern. Without this the live corpus keeps its noise and Phase 12 embeds it anyway.

**D-6 — Ordering: hygiene precedes vectors.**
This phase lands before daemon incremental embedding and before vector trace discovery, so embedding compute is never spent on content the system has already decided is not recallable.

## New requirements

- **REQ-052 — Tool-activity collapse:** Consecutive tool-call events shall be contracted into a compact derived activity description naming tools and counts rather than reproducing invocation arguments verbatim. An isolated tool call shall retain normal summarization. Tool-call events shall remain intact in the canonical timeline.
- **REQ-053 — Synthetic content classification:** Harness-injected content recorded under a user or assistant role — skill preambles, scheduler wrappers, context-injection blocks, compaction artifacts, and automated task prompts — shall be deterministically classified and excluded from summarization, embedding, trace discovery, and injection, while remaining present and queryable in the canonical timeline. Classification shall be versioned and its rationale recoverable through the audit surface.
- **REQ-054 — Derivation rebuild on rule change:** A change to the hygiene rule version shall mark affected derivations stale, and the system shall provide a resumable, idempotent, checkpointed path to rebuild them without duplicating or corrupting summaries, vectors, or trace assignments.

## Measured impact

Simulated against the live corpus with the real `TopicMonitor` and summarizer (`11-MEASUREMENT.md`); the baseline pass reproduces the persisted 135,366 summaries exactly, so the projection is trustworthy.

| | Summaries | Volume |
|---|---|---|
| Today | 135,366 | 228.9 MB |
| After Phase 11 | **55,930 (−59%)** | **77.6 MB (−66%)** |

## Success criteria

1. A contraction pass over a slice containing a run of consecutive tool calls produces exactly one derived activity line naming the distinct tools and their counts, containing no invocation arguments; a slice containing a single isolated tool call summarizes it in its existing form.
2. Deterministic classification assigns every canonical event exactly one `derivationClass`, is stable across repeated runs on identical input, and requires no model or network.
3. Summaries built under the new rules contain no verbatim harness-injected content from the classes enumerated in the evidence table, and no `[Tool call:` argument text from collapsed runs.
4. Every event excluded from derivation remains retrievable through direct canonical-event queries and reports, through the audit surface, the specific rule ID and rule version that excluded it.
5. Rebuilding derivations for the existing corpus is resumable and idempotent: interrupting and restarting produces the same result as an uninterrupted run, with no duplicated or orphaned summaries, vectors, or trace assignments.
6. Measured against the live corpus, the summary count and total summary text volume both fall materially, and no summary derived purely from a collapsed tool-call run survives as an independently recallable memory.
7. Recall quality does not regress: a fixed set of known conversational queries returns the same or better summaries after hygiene than before.

## Open questions for planning

1. **Storage of `derivationClass`** — new column on `canonical_events` (migration + backfill across 292k rows), a sidecar classification table, or computed at contraction time from a persisted rule version? Affects the Phase 8 migration surface and both store implementations.
2. **Assistant-side synthetic content** — the evidence above quantifies the `user` role only. Assistant-role harness output (thinking-only blocks, which are currently quarantined rather than imported, and structured status emissions) needs the same measurement before rules are written.
3. ~~**Rebuild scope on the live corpus**~~ — **answered:** full rebuild. 59% of summaries disappear under the recommended design and survivors' text changes, so a selective predicate buys nothing.
4. **Quarantine replay interaction** — 290,107 pending quarantine records include 23,878 OpenClaw `tool.result` entries. If tool results are ever replayed in, they must enter as `tool_activity`, not as conversational content. Decide whether this phase sets that contract or defers it.
5. ~~**Threshold for run collapse**~~ — **answered:** 2 is correct. With tool activity no longer driving labels, the threshold affects only text density inside a span, not fragmentation.

## Roadmap and requirements changes

- Insert as **Phase 11 — Derivation Input Hygiene**; renumber former Phases 11→12, 12→13, 13→14, 14→15.
- Add REQ-052, REQ-053, REQ-054 to `REQUIREMENTS.md` under a new "Derivation Hygiene (v1.1)" grouping; extend the traceability table; coverage becomes 14/14.
- Phase 13 (formerly 12) gains a dependency note: trace discovery is calibrated against the post-hygiene corpus, so any threshold/top-K tuning done before this phase must be re-validated after it.
