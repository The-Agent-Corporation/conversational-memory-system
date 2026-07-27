# Phase 11 — Post-Implementation Measurement Against the Live Corpus

**Run date:** 2026-07-26
**Database:** `~/.memory/aaron.db` (4.6 GB, `user_version: 1`)
**Corpus:** 292,407 canonical events / 135,366 existing summaries
**Hygiene rule version:** `hygiene-rules/v1`
**Command:** `MEMORY_DB=$HOME/.memory/aaron.db MEMORY_PERSON=aaron npx tsx .planning/phases/11-derivation-input-hygiene/11-hygiene-sim.ts`
**Mutations to live data:** none. The sim opens the database via `node:sqlite` with `{ readOnly: true }`
and does not go through `SqliteStore`, so no schema migration or derivation write occurred.

---

## Fidelity gate — PASSED

The sim's baseline pass must still reproduce the persisted corpus exactly, or the comparison is invalid.

| | Expected (11-MEASUREMENT.md, 2026-07-26) | Measured now | Verdict |
|---|---|---|---|
| Baseline summaries | 135,366 | **135,366** | exact match |
| Baseline volume | 228.9 MB | **228.9 MB** | exact match |
| Baseline containing `[Tool call:` | 51,266 (37.9%) | **51,266 (37.9%)** | exact match |

The baseline pass now runs through the **production** classifier (`src/topic/derivation-hygiene.ts`), not a
parallel copy — Plan 01 Task 3 rewired it. Reproducing the persisted corpus byte-for-byte through shipped
code is therefore direct evidence that the implementation matches the measurement, closing 11-CONTEXT's
"silent divergence between simulation and implementation" risk.

> **Defect found and fixed during this run.** The sim could not execute at all: it imported
> `./src/topic/topic-monitor.js`, which ESM resolves relative to the sim's own directory
> (`.planning/phases/11-derivation-input-hygiene/`), not the repo root. The bad prefix originates in the
> original measurement commit `2f0f2a7`, not in Plan 01 — Plan 01's instruction told its executor to
> "mirror whatever prefix that uses," so it faithfully propagated a pre-existing bug. `tsc --noEmit`
> resolves these paths differently and never caught it. Fixed to `../../../src/topic/...`.
> **Implication:** 11-MEASUREMENT.md's original numbers were produced with the sim run from a different
> location. They still reproduce exactly, so the measurement stands.

---

## Corpus composition

| Class | Events | Share | Share at 2026-07-26 | Delta |
|---|---:|---:|---:|---|
| `tool_activity` | 186,548 | 63.8% | 63.8% | unchanged |
| `conversational` | 80,528 | 27.5% | 29.5% | −2.0 pts |
| `synthetic_injected` | 25,331 | 8.7% | 6.7% | +2.0 pts |

The 2-point shift is entirely the two assistant-side rules added after the original measurement.

### Synthetic rule hits

| Rule | Hits | In original measurement? |
|---|---:|---|
| `cron-session-tag` | 7,909 | yes (7,909 — exact) |
| `harness-system` | 5,561 | yes (5,561 — exact) |
| **`structured-json-emission`** | **3,017** | **no — new** |
| **`silent-sentinel`** | **2,784** | **no — new** |
| `automated-followup` | 2,210 | yes (2,210 — exact) |
| `system-reminder-only` | 1,786 | yes (1,786 — exact) |
| `skill-invocation` | 1,038 | yes (1,038 — exact) |
| `city-harness-preamble` | 274 | yes (274 — exact) |
| `context-compaction` | 262 | yes (262 — exact) |
| `automated-task-block` | 168 | yes (168 — exact) |
| `skill-body-injection` | 127 | yes (127 — exact) |
| `local-command-stdout` | 109 | yes (109 — exact) |
| `session-continuation` | 86 | yes (86 — exact) |

Every previously-measured rule reproduces its hit count **exactly**. No rule drifted, over-fired, or
under-fired — which also discharges 11-CONTEXT's "over-aggressive rules eating real conversation" risk at
the rule-by-rule level.

New assistant-side rules contribute **5,801 additional exclusions** (3,017 + 2,784).

---

## Result vs. target

| | Baseline | Target (simulated 2026-07-26) | **Measured now** | Delta vs target |
|---|---:|---:|---:|---|
| Summaries | 135,366 | 55,930 | **50,551** | −5,379 (9.6% below) |
| Volume | 228.9 MB | 77.6 MB | **74.0 MB** | −3.6 MB (4.6% below) |
| Containing `[Tool call:` | 51,266 | ~11,571 | **10,860** | −711 |

**Reduction achieved — both targets exceeded:**

| Metric | Target reduction | **Measured reduction** |
|---|---:|---:|
| Summary count | −59% | **−62.7%** |
| Summary volume | −66% | **−67.7%** |

### Delta explanation

Each delta lands *below* target — i.e. more reduction than projected — and is attributable to one cause.

- **−5,379 summaries vs target.** The two assistant-side rules exclude **5,801** events that the original
  measurement still treated as conversational. The ratio 5,379 / 5,801 = **92.7%**, meaning ~93% of those
  newly-excluded events were previously opening a span of their own. That is the expected relationship:
  `[SILENT]` sentinels and bare-JSON agent reports share little vocabulary with surrounding prose, so under
  `TopicMonitor`'s zero-word-overlap rule they reliably forced a topic change. This was predicted in the
  plan and is now quantified rather than assumed.
- **−3.6 MB vs target.** Follows from the same 5,379 fewer summaries, at a lower-than-average per-summary
  size because the excluded content is short (sentinels and compact JSON).
- **−711 residual `[Tool call:` summaries.** Slightly fewer isolated singles survive because some sat in
  spans that no longer exist.

### Mechanism check (11-CONTEXT's key warning)

11-CONTEXT warns that collapse alone moves volume but not count, and that an implementation which collapses
while still letting activity lines open their own span would hit the volume target and miss the count
target. The passes separate cleanly and confirm the label gate — not collapse — is doing the count work:

| Pass | Summaries | Volume |
|---|---:|---:|
| baseline | 135,366 | 228.9 MB |
| hygiene (collapse only, activity still labels) | 108,426 | 85.8 MB |
| conv-only (labels gated, no singles kept) | 50,551 | 68.4 MB |
| **RECOMMENDED (labels gated + singles kept as content)** | **50,551** | **74.0 MB** |

Collapse alone: −20% count, −62% volume. Adding the label gate: −62.7% count. The count reduction lives in
the gate exactly as designed.

Tool structure: **31,648 runs of ≥2 collapsed, covering 170,275 events; 16,273 isolated singles kept
verbatim.**

---

## Status

- **SC6 (material reduction) — measured and met on the real corpus**, exceeding both targets, with the
  divergence from the simulated projection fully explained.
- **SC7 (recall quality) — NOT closed by this document.** It requires the human query spot-check in
  Task 2, which has not been performed.
- **No live data was mutated.** The rebuild has not been run.

---

# Part 2 — Live Rebuild Executed (2026-07-26)

Owner authorized the destructive step in-session. Backup taken first:
`~/.memory/aaron.db.pre-phase11` (4.6 GB, `pragma quick_check: ok`, 292,407 events / 135,366 summaries).

Schema migrated on first open: `user_version` 1 -> 2, `summary_vectors` created.

**Command:** `npx tsx src/operations/rebuild-derivations-command.ts --db ~/.memory/aaron.db --person aaron`
**Runtime:** 4m13s, 1,170 slices, exit 0.

```json
{ "ok": true, "rebuilt": true, "hygieneRuleVersion": "hygiene-rules/v1",
  "processorVersion": "continuous-contraction/v1+hygiene-rules/v1",
  "slices": 1170, "processedEvents": 292407,
  "summariesWritten": 51720, "supersededSummaries": 135250 }
```

## Implementation vs. simulation — exact agreement

| Metric | Simulated | **Live actual** | Match |
|---|---:|---:|---|
| Active summaries | 50,551 | **50,551** | exact |
| Volume | 74.0 MB | **74.1 MB** | exact (rounding) |
| Residual `[Tool call:` | 10,860 | **10,860** | exact |
| Canonical events | 292,407 | **292,407** | unchanged (D-1 held) |

`[Activity]` lines present in 19,216 active summaries. The real pipeline landing exactly on the
simulation — which now runs the production classifier — closes 11-CONTEXT's "silent divergence" risk.

`summariesWritten` (51,720) exceeds the 50,551 final count by 1,169: those are active-span provisional
summaries re-emitted under the same deterministic id as their span extended across a slice boundary
(upserts, not duplicates). Reconciliation: 138,278 total rows = 50,551 active + 87,727 superseded;
of the original 135,366, 47,639 ids were reused and 2,912 are new.

## Criteria status

| SC | Result |
|---|---|
| SC6 material reduction | **PASS** — -62.7% count / -67.7% volume, exceeding -59% / -66% |
| SC5 idempotency (live) | **PASS** — second run `rebuilt: false, processed: 0` in 13s |
| SC4 explain rationale | **PASS** — reports `synthetic_injected` / `harness-system` / `hygiene-rules/v1` |
| No duplicates/orphans | **PASS** — 0 duplicate active ids, 0 orphaned vectors |
| **SC7 recall quality** | **FAIL — see gap below** |

---

## GAP-11-A (blocking): superseded summaries remain retrievable and injectable

**REQ-053 requires excluded content be kept out of "summarization, embedding, trace discovery, and
injection." The injection path does not hold after rebuild.**

Supersession flips `state`; it does not remove rows. The rebuild produced **87,727 superseded summaries
still carrying the pre-hygiene fragmented, tool-call-laden text**. Retrieval does not filter them:

- `applyRetrievalBoundary` (`src/retrieval/memory-retriever.ts:142`) filters candidates on `personId` and
  `scopeIds` **only** — `state` is never consulted.
- `rankMemories` passes every supplied summary through `rankSummary` and filters only on `score > 0`.

Reproduced in isolation (one active + one superseded summary on the same topic):

```json
{ "returnedSummaryIds": ["s_new", "s_old"],
  "supersededWasRetrieved": true,
  "injectedTextContainsToolCall": true }
```

The injected packet contained the superseded summary's `[Tool call: Bash] {"cmd":"make"}` text.

**Severity.** The defect predates Phase 11 — superseded summaries were always retrievable — but it was
latent because the live corpus had ~0 superseded rows. The rebuild creates 87,727 of them holding exactly
the content this phase exists to remove, converting a dormant bug into an active one. Every headline
metric above is real, yet the user-visible recall benefit is blunted until this is fixed.

**Not fixed here** — out of scope for Plan 07, which is a measurement and sign-off plan. Routed to gap
closure.

**Suggested fix direction (for the gap plan, not a decision):** filter non-retrievable states in
`applyRetrievalBoundary` rather than at each call site, so anchors/traces/boxes inherit the same rule;
confirm which states are legitimately retrievable (`compacted`, `active`, `revived`) versus excluded
(`superseded`, and possibly `stale` pre-revival); and add a regression test asserting a superseded summary
is never returned. Consider whether 87,727 superseded rows should also be pruned or archived, since they
are ~155 MB of the database.

## Not verified

- **Human recall sign-off on known queries** was NOT performed. The orchestrator ran mechanical probes,
  not semantic judgement — it cannot assess whether returned memories are *correct* for this corpus.
  Full-corpus probes via `prepareInjection` were also impractical: it calls `listSummaries()` per query,
  loading all rows each time (>10 min for 8 queries pre-rebuild). That cost is itself worth a look.
