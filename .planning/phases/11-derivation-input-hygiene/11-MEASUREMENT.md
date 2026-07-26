# Phase 11 Measurement: Hygiene Simulation Against the Live Corpus

**Run:** 2026-07-26 · `~/.memory/aaron.db` · 292,407 canonical events · person `aaron`
**Harness:** `11-hygiene-sim.ts` (replays the timeline through the real `TopicMonitor` and the real `DeterministicSummarizer` text builder)

## Fidelity check

The baseline pass reproduces the persisted corpus exactly — **135,366 summaries** and **51,266 containing `[Tool call:`**, matching the database row-for-row. The simulation is therefore a trustworthy predictor of what re-derivation would produce.

## Classification of the corpus

| Class | Events | Share |
|---|---|---|
| `tool_activity` | 186,548 | 63.8% |
| `conversational` | 86,329 | 29.5% |
| `synthetic_injected` | 19,530 | 6.7% |

Synthetic rule hits: `cron-session-tag` 7,909 · `harness-system` 5,561 · `automated-followup` 2,210 · `system-reminder-only` 1,786 · `skill-invocation` 1,038 · `city-harness-preamble` 274 · `context-compaction` 262 · `automated-task-block` 168 · `skill-body-injection` 127 · `local-command-stdout` 109 · `session-continuation` 86.

Tool structure: **33,176 runs of ≥2 consecutive tool calls covering 168,852 events**, plus **17,696 isolated single tool calls**.

## Variants measured

| Variant | Summaries | Volume | Summaries with `[Tool call:` |
|---|---|---|---|
| Baseline (today) | 135,366 | 228.9 MB | 51,266 (37.9%) |
| Collapse runs, keep singles verbatim, drop synthetic | 116,550 (−14%) | 89.6 MB (−61%) | 16,834 (14.4%) |
| Tool activity excluded entirely | 55,930 (−59%) | 71.0 MB (−69%) | 0 |
| **Recommended** (below) | **55,930 (−59%)** | **77.6 MB (−66%)** | 11,571 |

## Key finding: collapse fixes volume, not count

The first variant — exactly what D-2 originally specified — cuts summary *volume* by 61% but summary *count* by only 14%.

The reason is `TopicMonitor.isTopicChange` (`src/topic/topic-monitor.ts:177`): a span ends whenever the next event's topic label shares **zero** significant words with the current label. Topic labels come from the first six keywords of event content. A collapsed activity line (`[Activity] ran 12 tool calls: 8 terminal, 4 read`) shares no vocabulary with the surrounding conversation, so it still opens its own span — the collapse replaces a long noisy summary with a short noisy summary, but the fragmentation stays.

This also means tool calls have been **fragmenting real conversations all along**: every tool interruption splits a topic in two, which is why the corpus has 135k summaries over ~86k conversational events.

## Recommended design (amends D-2)

Tool activity becomes span **content** but never span **label input**:

1. A run of ≥2 consecutive tool calls collapses to one activity line naming distinct tools and counts, no arguments.
2. An isolated single tool call keeps its existing text (per the original D-2 intent — one deliberate action between two messages carries the "why").
3. Neither form is passed to topic-label extraction or topic-change detection. Both attach to the surrounding conversational span.
4. `synthetic_injected` events are excluded from derivation entirely.

Result: **55,930 summaries (41.3% of baseline) and 77.6 MB (33.9% of baseline)** — a 59% reduction in things to embed, and a 66% reduction in text volume, while every tool action a human took remains visible inside the summary of the conversation it belonged to.

The 11,571 remaining summaries containing `[Tool call:` are isolated singles appearing inside conversational spans, which is the intended outcome, not residual noise.

## Consequences for later phases

- Phase 12 (incremental embedding) and Phase 13 (vector traces) operate on ~56k vectors instead of ~135k — less than half the ANN index, and far less near-duplicate mass.
- Trace thresholds and top-K must be calibrated *after* this phase; any tuning against the 135k corpus will not transfer.
- Retrieval quality should improve independently of vectors: conversations stop being split mid-topic by tool use.

## Open questions now answered

- **Q3 (rebuild scope)** — full rebuild. 59% of summaries disappear and the survivors' text changes, so a selective predicate has no advantage; a full re-derivation is simpler and idempotent by construction.
- **Q5 (collapse threshold)** — 2 is correct, given tool activity no longer drives labels. The threshold now only affects text density inside a span, not fragmentation.

## Still open

- **Q2 (assistant-side synthetic content)** — unmeasured; thinking-only blocks are currently quarantined rather than imported, so they do not affect these numbers.
- **Q1 (where `derivationClass` lives)** — unaffected by this measurement; still a planning decision.
- **Q4 (quarantine replay contract)** — unaffected.
