# Phase 11: Derivation Input Hygiene - Research

**Researched:** 2026-07-26
**Domain:** Internal — contraction/summarization pipeline hygiene (no new external dependencies)
**Confidence:** HIGH (all findings are direct code reads with file:line citations; no third-party unknowns)

## Summary

This is a pure internal-refactor phase. The seam is small and well-defined: `ContractionRunner.drainSlice` (`src/daemon/contraction-runner.ts:142-171`) is the ONLY place that both (a) feeds `TopicMonitor.observe` and (b) later reconstructs summary text from the same event slice via `summaryForSpan`. Classification and tool-run collapse must happen as a pre-pass over the slice's events, upstream of both the `monitor.observe` loop and `summaryForSpan`'s positional event slicing — not inside `TopicMonitor` itself (which has no concept of "event," only content/role/sequence) and not as a post-hoc summary-text edit (which would still let tool activity poison topic labels, reproducing the measured "collapse fixes volume, not count" trap).

The dangerous part of this phase is not classification (a straightforward table of anchored string tests, already prototyped and measured in `11-hygiene-sim.ts`) — it is `summaryForSpan`'s positional invariant: `sourceEvents[k]` is assumed to sit at `startSequence + k`. Collapsing N events to 1 derived line, or excluding synthetic events from the slice, breaks that invariant unless sequence numbers, `sourceTurnRange`, and `sourceCanonicalEventIds` are deliberately re-derived rather than assumed positional. `TopicMonitor.RollingTopicState.sourceTurnRange` (`src/topic/topic-monitor.ts:4-14`) and its `turnCount`/`startSequence`/`endSequence` bookkeeping is itself sequence-based and must keep tracking the ORIGINAL canonical sequence numbers of all underlying events (for provenance/audit and for `resumeIndex`/`affectedStartIndex` resumability), even when those events collapse to one line of summary text or contribute zero label input.

The rebuild path should copy Phase 10's `backfill-embeddings-command.ts` shape almost exactly (missing/stale-set as the checkpoint, batch-and-commit loop, `onBatchComplete` test hook) but the "missing set" here is "generation is stale" rather than "vector is null" — `ContractionJob.generation` plus `PROCESSOR_VERSION`-style version bump is the natural mechanism, reusing `DerivationInvalidator.invalidateDependencies` (already fully general over summary/anchor/box/proposal/trace) for the actual invalidation.

A second, unlisted integration point exists: `src/integrations/hermes/adapter.ts` and `src/integrations/hermes/ingest-command.ts` construct their OWN `TopicMonitor` instances and feed `PreCompactor` directly, entirely independent of `ContractionRunner`. This is the live Hermes real-time path, not the daemon/bootstrap batch path. `11-CONTEXT.md`'s canonical_refs do not mention it. This must be flagged to the planner as an open question — if Hermes live sessions include `role: "tool"` content, that path will keep producing un-hygienic summaries indefinitely regardless of what Phase 11 does to `contraction-runner.ts`.

**Primary recommendation:** Introduce a single new pure module (e.g. `src/topic/derivation-hygiene.ts`) that (1) classifies a `CanonicalEvent` into `conversational | tool_activity | synthetic_injected` plus rule ID, (2) detects and collapses consecutive `tool_activity` runs within an already-loaded event slice into synthetic "activity" pseudo-turns, and (3) exposes a `contentForTopicLabel` vs `contentForSummary` split. Call it once at the top of `drainSlice`'s per-slice event list (before both the `monitor.observe` loop and `summaryForSpan`'s reconstruction), producing a transformed event/turn view that both consumers share — never duplicate the classification logic between the label path and the summary path.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Event classification (rule matching) | Derivation / contraction (`src/daemon`, new `src/topic` module) | — | Pure function of `(content, eventKind, ruleVersion)`; no storage, no I/O |
| Tool-run collapse (grouping consecutive tool_activity) | Derivation / contraction | — | Slice-local, deterministic, operates on the same event array `drainSlice` already holds |
| Topic-label exclusion (activity/synthetic never feed `extractTopicLabel`) | Derivation / contraction (feeds into `TopicMonitor`) | Topic monitor itself (label/observe contract) | `TopicMonitor` stays content-agnostic; the caller decides what content string to pass for label purposes |
| Rule versioning / staleness marking | Derivation layer (`ContractionJob.generation`, new hygiene rule version) | Storage (`daemon/types.ts` schemas) | Mirrors `PROCESSOR_VERSION` / `parserVersion` — existing pattern, not a new one |
| Rebuild orchestration | Operations (`src/operations/`) | Daemon (job/checkpoint machinery) | Mirrors `backfill-embeddings-command.ts`: a CLI-invokable command that drives existing store/invalidator primitives |
| Audit / "why excluded" | Audit (`src/audit/explain-service.ts`) | — | Recomputes classification on demand per the locked decision; no new persisted per-event field |
| Canonical event storage | Storage (`memory-store.ts`, both implementations) | — | MUST NOT change — D-1/scope fence: no schema/column changes for classification |

## Standard Stack

Not applicable — this phase introduces no new dependencies, frameworks, or libraries. All work is pure TypeScript logic against existing internal types (`CanonicalEvent`, `Turn`, `Summary`, `CompletedTopicSpan`).

**Version verification:** N/A — no packages installed.

## Package Legitimacy Audit

**Not applicable.** This phase installs no external packages. No legitimacy audit required.

## Architecture Patterns

### System Architecture Diagram

```
canonical_events (immutable, all 292,407 kept)
        │
        ▼
ContractionRunner.drainSlice(personId, jobId, limits)
        │
        │  allEvents = store.listCanonicalEvents(personId)   [already loaded once per slice]
        │  slice = allEvents[startIndex .. startIndex+maxEvents]
        │
        ▼
   ┌─────────────────────────────────────────────┐
   │  NEW: classify + collapse pre-pass           │
   │  (per event in slice, in canonical order)    │
   │    classify(event) -> conversational |       │
   │       tool_activity | synthetic_injected     │
   │    group consecutive tool_activity runs      │
   │    produce: labelContent(event) for          │
   │       TopicMonitor.observe                   │
   │       (synthetic_injected -> skip entirely;  │
   │        tool_activity run/single -> "" or     │
   │        neutral label input, never drives     │
   │        extractTopicLabel/isTopicChange)       │
   │    produce: summaryContent(event) for        │
   │       summaryForSpan / buildSummaryText       │
   │       (collapsed run -> 1 activity line;      │
   │        isolated single -> verbatim;           │
   │        synthetic -> excluded from summary)    │
   └─────────────────────────────────────────────┘
        │                              │
        ▼                              ▼
  monitor.observe(...)          summaryForSpan(span, allEvents)
  (labelContent only)           (summaryContent only, positional
        │                        remap — see Pitfall 2)
        ▼                              │
  completedSpans / activeTopic ────────┘
        │
        ▼
  summaries[] ── commitContractionSlice ── canonical_events UNCHANGED,
                                            summaries/anchors/turns written,
                                            old summaries superseded via
                                            DerivationInvalidator
        │
        ▼
  boxes / traces / retrieval / injection / MCP read tools
  (all consume summary.summaryText — see Blast Radius)
```

### Recommended Project Structure

No new directories needed. Suggested new files:
```
src/topic/
├── topic-monitor.ts              # UNCHANGED — stays content-agnostic
├── derivation-hygiene.ts         # NEW — classify(), collapseToolRuns(), rule table, rule version const
src/daemon/
├── contraction-runner.ts         # MODIFIED — calls derivation-hygiene before observe() and summaryForSpan()
src/operations/
├── rebuild-derivations-command.ts  # NEW — mirrors backfill-embeddings-command.ts shape
src/audit/
├── explain-service.ts             # MODIFIED — reports rule id/version for excluded/collapsed events
tests/topic/
├── derivation-hygiene.test.ts     # NEW
tests/daemon/
├── contraction-runner.test.ts     # MODIFIED — hygiene assertions added
```

### Pattern 1: Versioned rule mirrors `parserVersion` / `PROCESSOR_VERSION`
**What:** A module-level `const HYGIENE_RULE_VERSION = "hygiene-rules/v1"` string, checked the same way `PARSER_VERSION` is checked in every importer's resume logic (`src/imports/hermes-importer.ts:101`, `:122` etc.) and the same way `PROCESSOR_VERSION` (`src/daemon/contraction-runner.ts:17`) is stamped onto every `ContractionCheckpoint`.
**When to use:** Any time the rule table (synthetic patterns, collapse threshold) changes — bump the version, and everything keyed to the old version is treated as stale.
**Example:**
```typescript
// Source: src/daemon/contraction-runner.ts:17,207 (existing pattern to imitate)
const PROCESSOR_VERSION = "continuous-contraction/v1";
// ...
const nextCheckpoint: ContractionCheckpoint = {
  ...
  processorVersion: PROCESSOR_VERSION,
  ...
};
```
The importer pattern (`src/imports/hermes-importer.ts:101`) additionally uses the version as a resume/cache-invalidation gate:
```typescript
const canResume = previous !== null &&
  previous.fileIdentity === identity &&
  previous.parserVersion === PARSER_VERSION &&
  Number(previous.rowHighWaterMark ?? previous.recordIndex) <= maximum.maximum;
```
The hygiene rule version should gate rebuild-needed the same way: a persisted "last hygiene version this derivation was built under" compared against the current constant.

### Pattern 2: Classification as a pure function computed at contraction time, not persisted per event
**What:** Per the locked decision in `11-CONTEXT.md` (resolved 2026-07-26): `derivationClass` is `f(content, eventKind, ruleVersion)` — recomputed on demand, never a new `canonical_events` column. `eventKind` already exists on `CanonicalEvent`/`HostEvent` (`src/domain/canonical.ts:38`, `src/domain/events.ts:22`: `z.enum(["message", "tool_call"]).optional()`), so `tool_activity` classification is a direct eventKind check — no string matching needed for that class. `synthetic_injected` classification needs the anchored-prefix rule table already prototyped in `11-hygiene-sim.ts:40-51`.
**When to use:** Everywhere classification is needed: contraction pre-pass, rebuild command, `explain` audit surface, quarantine-replay guard test.
**Example (prototype to promote into `src/topic/derivation-hygiene.ts`):**
```typescript
// Source: .planning/phases/11-derivation-input-hygiene/11-hygiene-sim.ts:40-61 (measured, not just designed)
const SYNTHETIC_RULES: ReadonlyArray<{ id: string; test: (c: string) => boolean }> = [
  { id: "skill-invocation", test: (c) => c.startsWith("[IMPORTANT: The user has invoked") },
  { id: "harness-system", test: (c) => c.startsWith("[SYSTEM:") },
  { id: "cron-session-tag", test: (c) => c.startsWith("[cron:") },
  { id: "automated-followup", test: (c) => c.startsWith("### Task:") && c.includes("follow-up questions") },
  { id: "automated-task-block", test: (c) => c.startsWith("### Task:") },
  { id: "skill-body-injection", test: (c) => c.startsWith("Base directory for this skill:") },
  { id: "context-compaction", test: (c) => c.startsWith("[CONTEXT COMPACTION") },
  { id: "session-continuation", test: (c) => c.startsWith("This session is being continued from a previous conversation") },
  { id: "local-command-stdout", test: (c) => c.startsWith("<local-command-stdout>") },
  { id: "system-reminder-only", test: (c) => c.startsWith("<system-reminder>") },
  { id: "city-harness-preamble", test: (c) => /^\[[a-z0-9-]+-city\]\s+\S+\s+•\s+20\d\d-/.test(c) }
  // Assistant-side rules per CONTEXT.md ("silent-sentinel" `[SILENT]`,
  // "structured-json-emission" bare-JSON assistant messages) must be ADDED —
  // the sim only measured these on 2026-07-26 after the initial write-up and
  // are listed in CONTEXT.md but not yet in this exact test array.
];

const classify = (row: { eventKind?: string; content: string }): { klass: Klass; rule: string | null } => {
  if (row.eventKind === "tool_call") return { klass: "tool_activity", rule: null };
  const c = row.content.trimStart();
  for (const rule of SYNTHETIC_RULES) {
    if (rule.test(c)) return { klass: "synthetic_injected", rule: rule.id };
  }
  return { klass: "conversational", rule: null };
};
```
**IMPORTANT gap:** the sim's rule array is the `user`-role-only evidence table from `11-SCOPE-INSERT.md`. The assistant-side rules (`silent-sentinel` `[SILENT]` 2,784 hits, `structured-json-emission` bare-JSON assistant messages 3,023 hits — both confirmed 2026-07-26 per `11-CONTEXT.md:40`) are NOT in the `11-hygiene-sim.ts` array shown above. The plan must add these two rules to the promoted module; the measured 55,930/77.6MB targets in `11-MEASUREMENT.md` may or may not already include them — re-run `11-hygiene-sim.ts` after adding them to confirm the target numbers still hold, per the "Silent divergence" risk in `11-CONTEXT.md`.

### Pattern 3: Slice-local run detection, not cross-slice
**What:** `11-CONTEXT.md` locks "run boundaries follow canonical order within the slice, so the rule is deterministic and slice-local." `drainSlice` processes at most `DEFAULT_CONTRACTION_LIMITS.maxEvents = 250` events per call (`src/daemon/contraction-runner.ts:18`). A tool run does NOT know about events before `startIndex` or after `nextIndex` in the same pass — this bounds the collapse logic to a simple forward scan over `allEvents[startIndex..startIndex+maxEvents)`, matching the simulation's `pendingTools` accumulator pattern (`11-hygiene-sim.ts:151-171`, `flushTools`).
**When to use:** Building the run-collapse function; do not try to look ahead/behind the slice boundary — see Pitfall 1 below for the boundary-straddle case this creates.

### Anti-Patterns to Avoid
- **Persisting `derivationClass` on `canonical_events`:** explicitly rejected by the locked decision and the scope fence ("Add columns to `canonical_events` or migrate the schema for classification" — do not do this). Also would require a 292k-row backfill and a new sync surface, both explicitly out of scope.
- **Doing collapse but still feeding the collapsed line into `extractTopicLabel`:** this was measured to fail — see `11-MEASUREMENT.md`'s "Key finding: collapse fixes volume, not count." The plan MUST verify both the count metric and the volume metric, not just the volume metric, or it will silently ship the wrong variant.
- **Filtering at import time:** explicitly D-1/scope-fence forbidden. Do not touch `src/imports/*` for this phase.
- **Re-deriving classification differently in `explain-service.ts` than in `contraction-runner.ts`:** must share the exact same `classify()`/rule-version function — two independently-written classifiers would silently drift and violate REQ-053's "rationale recoverable through the audit surface" (the rationale must be the SAME rule that actually fired at derivation time, not a re-guess).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Marking derivations stale after a rule change | A new "dirty" flag/table | `ContractionJob.generation` bump + existing `job.generation !== checkpoint.generation` staleness check already wired into `drainSlice`'s `checkpointCanResume` logic (`src/daemon/contraction-runner.ts:105-108`) | The generation-mismatch invalidation path already exists and is exercised by tests; reuse it rather than inventing a parallel staleness signal |
| Rebuild resumability/idempotency | A bespoke checkpoint table for hygiene rebuild | Copy `backfill-embeddings-command.ts`'s "missing/stale set as resume key, batch-and-commit, `onBatchComplete` test hook" shape (`src/operations/backfill-embeddings-command.ts:48-138`) | Already proven pattern for exactly this shape of problem (SC1 zero-missing, SC2 kill+resume, SC3 idempotent rerun) — Phase 10 built and tested it |
| Cascading invalidation to boxes/proposals/traces when summaries change | A new dependency-walk | `DerivationInvalidator.invalidateDependencies` (`src/service/derivation-invalidator.ts`) — already walks summary → anchor/box/proposal/trace dependencies and is called by `drainSlice` today for the rewind path (`src/daemon/contraction-runner.ts:184-198`) | Fully general already; extending it is unnecessary — the rebuild command just needs to call it with the full affected summary/event ID set |
| Detecting "this event is a tool call" | A new heuristic/regex on content | `event.eventKind === "tool_call"` — already a first-class discriminated field set by every importer via `createToolCallEvent` (`src/imports/tool-call-record.ts:36`) | The field already exists and is 100% reliable; no string-sniffing needed for this class (only `synthetic_injected` needs content-based rules) |

**Key insight:** Nearly everything this phase needs (versioning, staleness detection, dependency invalidation, resumable batch rebuild, a first-class tool-call discriminator) already exists in the codebase from earlier phases. The actual new code is small: a classify/collapse module and its two call sites (the label-input skip and the summary-content build), plus a thin rebuild-command wrapper around existing primitives.

## Runtime State Inventory

Not applicable in the strict "rename/refactor" sense (Step 2.5 trigger), but the rebuild-on-corpus-scale question is materially similar so it is answered here for planning safety:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | 135,366 existing `Summary` rows (SQLite `summaries` table via `SqliteStore`), 51,266 containing verbatim `[Tool call:` text; embeddings (Phase 8/9/10 vector rows) if backfill has been run — NOT yet run against the live `~/.memory/aaron.db` per `.planning/STATE.md` ("still at schema version 1, no vector table") | Full rebuild (already the locked decision — D-5/Q3): invalidate + regenerate all summaries via `DerivationInvalidator` + new rebuild command; because the live DB has no vector table yet, there is currently nothing to re-embed on the live corpus, but the rebuild path must still correctly invalidate any vectors that DO exist (e.g. in test/dev DBs that have run Phase 10) |
| Live service config | None found — this phase touches no external service config (no n8n, no cron registration, etc.) | None |
| OS-registered state | None — daemon lease/checkpoint state lives in the same SQLite DB, not OS-level registration | None |
| Secrets/env vars | None — no new env vars; `OPENROUTER_API_KEY`/`MEMORY_MODEL_PATH` etc. unaffected | None |
| Build artifacts | None — no build step in this repo (`tsx` runtime, per CLAUDE.md) | None |

## Common Pitfalls

### Pitfall 1: Tool run straddling a 250-event slice boundary
**What goes wrong:** `drainSlice` processes at most `maxEvents = 250` events per call (`src/daemon/contraction-runner.ts:18,129-130`). If a run of consecutive tool-call events is, say, 40 events long and starts at slice-local index 240, the slice ends mid-run. The next `drainSlice` call resumes at `resumeIndex` (`:348-361`), which is computed from `checkpoint.activeTopic.lastEventId` or `checkpoint.nextOrderKey` — neither of which currently has any concept of "mid-collapse." A naive implementation would either (a) collapse the visible partial run into one activity line in slice N, then treat the remaining tail as a NEW run in slice N+1 (producing 2 activity lines for what should be 1 — a measurable deviation from the simulation's single-pass numbers, which processed the WHOLE corpus in one unbounded loop with no slice boundary), or (b) hold the partial run in memory across the `drainSlice` call boundary, which requires new checkpoint state (an extension to `ContractionCheckpoint`, currently `activeTopic: RollingTopicState | null` only — see `src/daemon/types.ts:107`).
**Why it happens:** `11-hygiene-sim.ts` measured the target numbers with an UNBOUNDED single pass (`PAGE = 20_000` rows per DB query, no `maxEvents` cap, `pendingTools` is a single in-process variable that never resets except at end-of-run or on a non-tool event). Production `drainSlice` is explicitly NOT unbounded — bounding it to 250 events / 2000ms is precisely what fixed the O(n²) bootstrap-scale hotspot fixed in the perf work referenced in `.planning/STATE.md` (memory: "perf-fixes-and-vector-trace-direction.md"). The measured targets and the production execution model have different slicing assumptions.
**How to avoid:** Either (a) extend `ContractionCheckpoint` (both Zod schema in `daemon/types.ts` AND both `MemoryStore` implementations) with a small "pending tool run" carry-over field (names + start sequence), mirroring how `activeTopic` already carries `RollingTopicState` across slices, or (b) accept the boundary artifact as a documented, bounded edge case (a run split into 2 activity lines instead of 1, only at slice boundaries — 250-event slices mean this is rare relative to 292k events) and note it explicitly as NOT matching the simulation exactly for boundary-straddling runs. Either choice must be a documented decision in the plan, not a silent gap — and the plan must re-run `11-hygiene-sim.ts` in "sliced" mode (respecting `maxEvents`) if exactness against the measured target matters for the acceptance test, OR relax the acceptance test to "materially" match rather than exactly match at the slice level.
**Warning signs:** Test that constructs a >250-event tool run and drives it through TWO `drainSlice` calls; assert either "still 1 activity line" (requires checkpoint extension) or "documented as 2, both correctly excluding arguments" (requires an explicit assertion in the test naming this as expected, not accidental).

### Pitfall 2: `summaryForSpan`'s positional invariant breaks under both collapse and exclusion
**What goes wrong:** `summaryForSpan` (`src/daemon/contraction-runner.ts:298-311`) does:
```typescript
const sourceEvents = events.slice(span.sourceTurnRange.startSequence - 1, span.sourceTurnRange.endSequence);
const sourceTurns = sourceEvents.map((event, offset) =>
  turnFromEvent(event, span.hostSessionId, span.sourceTurnRange.startSequence + offset));
```
This assumes `sourceEvents[k]` sits at global sequence `startSequence + k` — true today because EVERY event in `allEvents` gets its own turn/sequence number 1:1 (`turnFromEvent(event, threadId, index + 1)` at `:144`, called once per raw event with no skipping). Once synthetic events are excluded from label/summary input, or a tool run of N events collapses to 1 derived line, sequence numbers inside a span are no longer contiguous 1:1 with "things that appear in the summary." If `span.sourceTurnRange` continues to describe raw canonical sequence numbers (as it must, for provenance and for `resumeIndex`'s `lastEventId` lookup to keep working), then `summaryForSpan`'s `events.slice(...)` + positional turn reconstruction is still correct for WHICH RAW EVENTS underlie the span (`sourceCanonicalEventIds` should legitimately list every raw event, synthetic or not, since D-1/D-4 require excluded content to remain in the canonical timeline and provenance-linked) — but the TEXT BUILT FROM those events (via `summarizer.summarize({ span, sourceTurns })` → `DeterministicSummarizer.buildSummaryText`, `src/summarization/summarizer.ts:51-63`, which takes "first 3 non-empty contents") must use the HYGIENE-TRANSFORMED content (collapsed activity line / excluded-as-empty), not the raw `turn.content`, or hygiene has no effect on summary text at all.
**Why it happens:** `sourceTurns.map((turn) => turn.content)` is currently the raw canonical content, unconditionally. The summarizer input needs a hygiene-transformed content string per turn, while `sourceCanonicalEventIds`/`sourceTurnRanges` (used for audit, invalidation-matching in `DerivationInvalidator`, and `resumeIndex`) must keep referencing the REAL positional event range — decoupling "what text feeds the summarizer" from "what event range the summary is provenance-linked to" is the crux of this pitfall.
**How to avoid:** Keep `Turn.content` as the untouched canonical content (never mutate canonical fidelity), and instead pass a SEPARATE `hygieneContent` (or equivalent) alongside each turn into the summarizer, OR pre-transform `sourceTurns` into an ephemeral hygiene-view array (collapsed tool runs represented as a single synthetic pseudo-turn positioned at the run's start sequence, synthetic events mapped to empty-string content) that is used ONLY for `summarizer.summarize()`'s input, while `sourceCanonicalEventIds = sourceEvents.map((event) => event.id)` (unchanged — every raw event, still linked). Verify `DeterministicSummarizer.buildSummaryText`'s "first 3 non-empty contents" still behaves sanely when many of those contents are now empty strings (synthetic exclusion) — a span that is ENTIRELY synthetic/tool-activity would previously never occur as a distinct topic-label group under the recommended design (D-2 amended: activity/synthetic content doesn't drive `isTopicChange`, so it always attaches to a SURROUNDING conversational span) — confirm this in tests: a span with ZERO conversational turns should not occur under the recommended design, but write a defensive test for it anyway (what does `buildSummaryText` produce if `sourcePreview` is empty — it falls back to `span.currentTopicSummary` alone, which is itself derived from `topicLabel`, itself derived from `extractTopicLabel` on... the first event's content. If the very first event of a span happens to be tool/synthetic, what topic label does it get? Check `createTopicState`/`extendTopicState` call order in `TopicMonitor.observe` — `extractTopicLabel(event)` runs BEFORE the caller has a chance to substitute label-input content, so the caller must pass an ALREADY-substituted `content` field into the `HostEvent` given to `monitor.observe`, not filter after the fact).
**Warning signs:** A test where the first event of a would-be span is a tool call or synthetic-injected event — assert the resulting `topicLabel` reflects the surrounding conversational content, not the tool/synthetic content, and that it does not read `"general conversation"` as a silent fallback artifact where a real label existed nearby.

### Pitfall 3: `affectedStartIndex`/`resumeIndex`/`DerivationInvalidator` all key off `sourceCanonicalEventIds` — must NOT shrink
**What goes wrong:** `affectedStartIndex` (`contraction-runner.ts:264-285`) and `summaryIntersectsAtOrAfter` (`:363-372`) both scan `summary.sourceCanonicalEventIds` to find which OLD summaries a rewind/invalidation touches. If the hygiene change causes `sourceCanonicalEventIds` to be written as ONLY the conversational events (dropping tool/synthetic event IDs from the list) to "look cleaner," a later rewind or invalidation pass would fail to find/invalidate that summary when one of the OMITTED tool/synthetic events is what changed (e.g., if the rule version bumps and a previously-excluded event should now show up differently) — the invalidation dependency graph would have a silent hole.
**Why it happens:** It's tempting to make `sourceCanonicalEventIds` "only the events that contributed text" for cleanliness, but the codebase's dependency-closure design (`DerivationInvalidator`) assumes this ID list is the COMPLETE provenance set for the summary, full stop — that's also required by the scope fence's audit guarantee ("every event excluded from derivation remains... reports, through the audit surface, the specific rule ID").
**How to avoid:** `sourceCanonicalEventIds` must always be the full raw event ID list for the span (every event in `events.slice(startSequence-1, endSequence)`), regardless of classification. Hygiene changes ONLY the derived TEXT and the LABEL INPUT, never the provenance/dependency linkage.
**Warning signs:** A test asserting `summary.sourceCanonicalEventIds` includes IDs of collapsed tool-call events and excluded synthetic events, not just the "visible" conversational ones.

### Pitfall 4: The live Hermes real-time path is a second, unlisted integration point
**What goes wrong:** `src/integrations/hermes/adapter.ts:54` and `src/integrations/hermes/ingest-command.ts:76,137` each construct their own `TopicMonitor()` and feed it directly (`HermesMemoryAdapter.processTimelineRow`, `:76`), then hand completed spans to `PreCompactor.compactCompletedTopic` (`src/compaction/pre-compactor.ts:27-35`), which ALSO reconstructs source turns positionally (`store.listTurns(...).filter(turn => turn.sequence >= ... && <= ...)`) and calls the same `Summarizer.summarize`. This is structurally parallel to `ContractionRunner` but is an entirely separate code path used by the live Hermes/Roscoe agent bridge, not the daemon's batch contraction of already-imported canonical events. `11-CONTEXT.md`'s canonical_refs list only `contraction-runner.ts` and `topic-monitor.ts` — `pre-compactor.ts` and `hermes/adapter.ts` are not mentioned.
**Why it happens:** The measured evidence in `11-SCOPE-INSERT.md`/`11-MEASUREMENT.md` is against the LIVE CORPUS via canonical events (i.e., the batch/bootstrap path), which is why it wasn't surfaced there — but if Hermes ingests `role: "tool"` content in real time (its contract schema explicitly has a `"tool"` role enum value not present in the canonical `role` enum used elsewhere — `src/integrations/hermes/contract.ts:15`), the live path would keep producing un-hygienic, topic-fragmenting summaries going forward even after Phase 11 ships, unless it also gets the classify/collapse treatment.
**How to avoid:** This must be an explicit planning decision, not silently skipped. Options: (a) extract the classify/label-input logic into the shared `derivation-hygiene.ts` module and call it from BOTH `ContractionRunner` and `HermesMemoryAdapter`/`PreCompactor`, or (b) explicitly descope the live Hermes path with a documented rationale (e.g., "Hermes tool role mapping is out of scope; Hermes live ingestion does not currently map `role: tool` to `eventKind: tool_call`, confirm via `mapHermesTimelineRowToHostEvent`"). Do not let this gap go unaddressed in the plan.
**Warning signs:** Grep `git log`/PR review for `pre-compactor.ts` or `hermes/adapter.ts` being untouched by the phase's diff while `contraction-runner.ts` changes — signals the gap was not resolved either way.

### Pitfall 5: Rebuild idempotency across `commitContractionSlice`'s supersession dedupe logic
**What goes wrong:** The rebuild command will call something equivalent to a rewind-and-reprocess through `drainSlice` (setting `checkpointCanResume = false` so the full `DerivationInvalidator` path runs, `:184-198`). `add()` inside `DerivationInvalidator.invalidateDependencies` already dedupes by `(kind, id)` (`src/service/derivation-invalidator.ts:43-46`) and `preserve.has(id)` protects newly-produced summaries/anchors from being immediately superseded (`contraction-runner.ts:195`: `preserveIds: [...summaries.map(...), ...anchors.map(...)]`) — this existing mechanism is exactly what "no duplicated or orphaned summaries" (SC5) needs, but ONLY if the rebuild command re-derives summary IDs deterministically the same way `summaryId(personId, firstEventId, topicLabel)` does (`contraction-runner.ts:430-433`, a hash of `[personId, firstEventId, topicLabel.toLowerCase()]`). If the hygiene change alters `topicLabel` for a span (which it will, by design — that's the whole point), the summary's deterministic ID CHANGES too, meaning old summaries become orphaned (correctly superseded) and NEW summaries get NEW ids — verify the invalidator's dependency scan (via `sourceCanonicalEventIds` intersection, not old-id equality) is what actually finds and supersedes the OLD summary, since ID equality won't hold across a label change. This is already how it works (`invalidateDependencies` finds summaries by scanning `sourceCanonicalEventIds`, not by ID matching against new output) — confirm this explicitly in a test rather than assuming it.
**Why it happens:** Easy to assume "same summary ID = same summary" holds across a rebuild; it does not once topic labels change, and the id-generation hash bakes in `topicLabel`.
**How to avoid:** Test: rebuild a range whose topic labels change under hygiene; assert the OLD summary is superseded (not just orphaned/still-active) and exactly one NEW summary covers the same canonical event range, with no leftover "state: compacted" old summary and no duplicate.
**Warning signs:** A summary count mismatch after rebuild (extra summaries lingering with `state !== "superseded"`), or `DerivationInvalidator` throwing "missing or cross-person ownership" if IDs are mismatched between passes.

## Code Examples

### Existing slice-local run accumulation (to promote, not reinvent)
```typescript
// Source: .planning/phases/11-derivation-input-hygiene/11-hygiene-sim.ts:151-171
let pendingTools: { names: string[]; occurredAt: string; role: string; id: string; content: string } | null = null;

const flushTools = (): void => {
  if (!pendingTools) return;
  if (pendingTools.names.length === 1) {
    isolatedSingles += 1;
    hygiene.observe(pendingTools.content, pendingTools.role, pendingTools.occurredAt, pendingTools.id);
  } else {
    collapsedRuns += 1;
    collapsedEvents += pendingTools.names.length;
    hygiene.observe(collapseText(pendingTools.names), "assistant", pendingTools.occurredAt, pendingTools.id);
  }
  pendingTools = null;
};
```
This is the pattern to port into `derivation-hygiene.ts`, adapted to operate over `allEvents.slice(startIndex, startIndex + maxEvents)` inside `drainSlice`, producing label-input content and summary-input content per position rather than driving a standalone `TopicMonitor` pass directly (the sim drives its OWN monitor instances; production must feed the SAME monitor instance `drainSlice` already owns).

### Existing collapse text format (naming tools/counts, never arguments)
```typescript
// Source: .planning/phases/11-derivation-input-hygiene/11-hygiene-sim.ts:67-74
const collapseText = (names: string[]): string => {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${n} ${name}`);
  return `[Activity] ran ${names.length} tool calls: ${parts.join(", ")}`;
};
```
This exact format matches the CONTEXT.md example (`"ran 12 terminal commands, 3 file edits"`) closely enough to reuse directly, but confirm the plan settles on ONE canonical wording (the sim's is generic `"ran N tool calls: ..."`; CONTEXT.md's example groups by tool CATEGORY like "terminal commands"/"file edits" rather than raw tool NAME — check whether `toolNameOf` needs a name→category mapping or whether raw tool names, e.g. `terminal`, `Read`, `Edit`, are acceptable as-is; this is a wording decision for the plan, not yet resolved by either document verbatim).

### Existing rebuild-command shape to imitate
```typescript
// Source: src/operations/backfill-embeddings-command.ts:48-138 (structure only, adapt "missing vector"
// resume-key concept to "stale hygiene generation")
const store = new SqliteStore(databasePath);
try {
  const staleIds = /* analogous to listSummaryIdsMissingVector: query summaries whose
                       hygiene-generation/processorVersion predates HYGIENE_RULE_VERSION */;
  for (let start = 0; start < staleIds.length; start += batchSize) {
    const slice = staleIds.slice(start, start + batchSize);
    // invalidate + re-derive this batch via DerivationInvalidator + ContractionRunner-equivalent
    await deps.onBatchComplete?.(processed);  // test hook for kill-and-resume tests
  }
} finally {
  store.close();
}
```

## State of the Art

Not applicable in the "old framework vs new framework" sense — this is entirely internal, and the relevant "state of the art" is simply "what does this codebase already do," which is documented above (Don't Hand-Roll table).

**Deprecated/outdated:** N/A.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The collapse-text wording should mirror `11-hygiene-sim.ts`'s `"[Activity] ran N tool calls: ..."` format rather than CONTEXT.md's category-grouped example (`"ran 12 terminal commands, 3 file edits"`) | Code Examples | Low — cosmetic; either format satisfies REQ-052's "naming tools and counts, never arguments," but the plan should pick one explicitly rather than leave it ambiguous across two source documents |
| A2 | The live Hermes real-time path (`hermes/adapter.ts`, `pre-compactor.ts`) is NOT in scope for this phase and can be explicitly descoped, contingent on confirming Hermes does not map `role: "tool"` to `eventKind: "tool_call"` today | Pitfall 4 | Medium — if Hermes DOES ingest live tool-call content through this path, hygiene silently does not apply to newly-created live summaries even after this phase ships, undermining REQ-052/053's intent going forward |
| A3 | A tool run straddling a 250-event slice boundary producing 2 activity lines instead of 1 is an acceptable, documented edge case rather than requiring a `ContractionCheckpoint` schema extension | Pitfall 1 | Medium — if the acceptance test demands EXACT parity with `11-hygiene-sim.ts`'s unbounded-pass numbers (55,930/77.6MB), boundary artifacts could cause a measurable (if small) miscount; needs an explicit decision recorded in the plan |
| A4 | The assistant-side rules (`silent-sentinel`, `structured-json-emission`) already-confirmed in `11-CONTEXT.md` are compatible with (already reflected in) the 55,930/77.6MB targets in `11-MEASUREMENT.md`, even though they are absent from the `11-hygiene-sim.ts` rule array shown in this research | Pattern 2 | Medium — if the sim was NOT re-run with these two rules added, the measured targets may shift once they're included; the plan must re-run the sim after adding them and treat the current numbers as provisional until confirmed |

**If this table is empty:** N/A — see entries above; all four should be confirmed or explicitly resolved during planning/discuss-phase before being treated as locked.

## Open Questions

1. **Does the live Hermes path need hygiene too?**
   - What we know: `hermes/adapter.ts`/`ingest-command.ts` run their own `TopicMonitor` + `PreCompactor`, structurally parallel to `ContractionRunner`, and are NOT named in `11-CONTEXT.md`'s canonical_refs.
   - What's unclear: whether Hermes' live ingestion path ever produces `eventKind: "tool_call"` events or synthetic-pattern content, and therefore whether it needs the same treatment.
   - Recommendation: planner should either extend the shared `derivation-hygiene.ts` module to both call sites, or add an explicit descope note with the reason (e.g., "Hermes's `role: tool` maps only to X, never `eventKind: tool_call`, confirmed via `mapHermesTimelineRowToHostEvent`").

2. **Slice-boundary tool-run handling: extend checkpoint state, or accept documented boundary artifacts?**
   - What we know: `maxEvents = 250` bounds every `drainSlice` call; the simulation that produced the 55,930/77.6MB targets ran unbounded.
   - What's unclear: whether the acceptance test (SC6, "measured against the live corpus...") demands exact parity with the sim's numbers, in which case boundary-straddling runs must not be allowed to double-count, or whether "materially" (as SC6's own wording says) tolerates a small, documented discrepancy.
   - Recommendation: pick one explicitly in the plan; if exactness is required, extend `ContractionCheckpoint` (`daemon/types.ts` schema — BOTH `sqlite-store.ts` and `in-memory-store.ts` implement `getContractionCheckpoint`/`commitContractionSlice`, so this is a real "must touch both stores" cost) to carry a pending-run remainder across slices.

3. **Exact collapse-text wording (tool name granularity vs. category grouping)**
   - What we know: REQ-052 requires "naming tools and counts... never arguments"; two slightly different renderings exist across `11-CONTEXT.md` (category-grouped) and `11-hygiene-sim.ts` (raw tool-name-grouped).
   - What's unclear: whether "terminal commands" / "file edits" is a semantic grouping the plan must implement (a name→category map) or just illustrative prose.
   - Recommendation: confirm with the human during discuss-phase or default to the simpler raw-tool-name grouping already prototyped and measured, since it requires no new mapping table and already produced the target numbers.

## Environment Availability

Skipped — this phase has no external dependencies (no new tools, services, runtimes, or CLIs). All work is against the existing `node:sqlite`/TypeScript/`tsx` stack already verified working in this repo (per `CLAUDE.md`: "Requires Node 22+... via `createRequire`, not a native addon").

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (existing repo standard — `npm test` = `vitest run`, 96 test files per `CLAUDE.md`) |
| Config file | `vitest.config.ts` (repo root, not modified by this research) |
| Quick run command | `npx vitest run tests/topic/derivation-hygiene.test.ts` (new) / `npx vitest run tests/daemon/contraction-runner.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-052 | A run of ≥2 consecutive tool-call events collapses to one derived activity line naming tools/counts, no arguments; isolated single stays verbatim | unit | `npx vitest run tests/topic/derivation-hygiene.test.ts -t "collapse"` | ❌ Wave 0 (new file) |
| REQ-052 | Tool activity never drives `extractTopicLabel`/`isTopicChange` | unit | `npx vitest run tests/topic/topic-monitor.test.ts` (existing) + new assertions in `tests/daemon/contraction-runner.test.ts` | ✅ existing file, ❌ new assertions |
| REQ-053 | Deterministic classification, stable across repeated runs, no model/network | unit | `npx vitest run tests/topic/derivation-hygiene.test.ts -t "classify"` | ❌ Wave 0 (new file) |
| REQ-053 | Synthetic content excluded from summarization/embedding/trace discovery/injection | integration | `npx vitest run tests/daemon/contraction-runner.test.ts` (extended) + `npx vitest run tests/boxes/`, `tests/traces/`, `tests/retrieval/` regression pass | ✅ existing files, extend assertions |
| REQ-053 | Rule ID + version recoverable through audit surface | unit | `npx vitest run tests/audit/explain-service.test.ts` (extend, if exists — verify path) | Check: `ls tests/audit/` |
| REQ-054 | Rule version bump marks derivations stale; resumable/idempotent/checkpointed rebuild | integration | new `tests/operations/rebuild-derivations-command.test.ts`, modeled on `tests/operations/backfill-embeddings-command.test.ts` interrupt/resume pattern | ❌ Wave 0 (new file; verify `tests/operations/backfill-embeddings-command.test.ts` exists as the template) |
| Measured targets (55,930 summaries / 77.6 MB) | Re-derivation matches simulation | manual/smoke | Re-run `11-hygiene-sim.ts` against a real (or synthetic large) corpus; NOT feasible in CI against the 5GB personal DB | Manual gate, not CI |

### Sampling Rate
- **Per task commit:** targeted `npx vitest run tests/topic/derivation-hygiene.test.ts tests/daemon/contraction-runner.test.ts`
- **Per wave merge:** `npm test` (full suite — regression-checks boxes/traces/retrieval/summarization, all of which consume `summaryText`)
- **Phase gate:** Full suite green before `/gsd:verify-work`; additionally, re-run `11-hygiene-sim.ts` (or a scaled-down synthetic-corpus variant built for CI, see Testing Strategy below) to sanity-check the measured targets without requiring the 5GB personal DB.

### Wave 0 Gaps
- [ ] `tests/topic/derivation-hygiene.test.ts` — covers REQ-052 (collapse), REQ-053 (classify)
- [ ] `tests/operations/rebuild-derivations-command.test.ts` — covers REQ-054; verify `tests/operations/backfill-embeddings-command.test.ts` exists first as the template (not directly confirmed in this research pass — grep it before planning)
- [ ] Verify `tests/audit/` directory exists and has an `explain-service.test.ts` to extend (not directly confirmed in this research pass)
- [ ] A CI-safe synthetic fixture representing the corpus's structural shape (tool-call runs, synthetic-role turns, conversational turns) at small scale (dozens to hundreds of events, not 292k) so the count/volume assertions can run without the personal DB — see Testing Strategy below

## Testing Strategy for Verifying Measured Targets Without the Personal DB

`tests/daemon/contraction-runner.test.ts` and `tests/daemon/fixtures.ts` already build synthetic `CanonicalEvent`/`Turn` fixtures and drive `ContractionRunner` against an `InMemoryStore` (confirmed: fixtures.ts exists with `FakeDaemonClock` and DB helpers; contraction-runner.test.ts is the established shape for testing a contraction change — extend it, do not create a parallel harness). `11-hygiene-sim.ts` itself is a re-runnable, standalone script that can be pointed at ANY SQLite DB via `MEMORY_DB`/`MEMORY_PERSON` env vars (`11-hygiene-sim.ts:24-25`) — it is not hardcoded to the personal DB. For CI-safe verification without the 5GB personal database:
1. Unit-level: extend `tests/topic/topic-monitor.test.ts` and `tests/daemon/contraction-runner.test.ts` with small synthetic fixtures (a handful of tool-call runs, isolated singles, synthetic-prefixed turns, and conversational turns) asserting the SHAPE of the transformation (collapse count, label exclusion, exclusion from summary text) — this validates correctness, not scale.
2. Ratio-level: build a small synthetic SQLite fixture DB (a few hundred to few thousand events, hand-constructed or generated to match the corpus's measured CLASS PROPORTIONS from `11-MEASUREMENT.md` — 63.8% tool_activity / 29.5% conversational / 6.7% synthetic_injected) and run `11-hygiene-sim.ts` against it via `MEMORY_DB=<fixture path>` in CI, asserting the RATIO of summary-count reduction and volume reduction roughly matches the corpus-measured percentages (−59% count, −66% volume), rather than asserting the exact absolute numbers (55,930 / 77.6MB), which are corpus-specific.
3. Full-scale validation (55,930/77.6MB exactly) remains a manual/local gate against the real `~/.memory/aaron.db`, run by a human with the personal DB present, documented as an out-of-CI verification step in the plan's final acceptance criteria — matching the phase's own "Silent divergence" risk mitigation ("re-run `11-hygiene-sim.ts` after implementation").

## Security Domain

Not applicable — `security_enforcement` config not checked in this pass, but this phase touches no authentication, authorization, cryptography, or external-input trust boundary beyond what already exists (canonical event content is already trusted-but-redacted per existing `secret-redactor.ts`; classification adds no new attack surface — it only reads already-imported content). No ASVS categories are newly implicated.

## Blast Radius (Phase Requirement Support Detail)

Summary count and content changes ripple through every consumer of `summaryText`:

| Consumer | File | Effect | Existing Tests Likely Affected |
|----------|------|--------|------------------------------|
| Box term assignment | `src/boxes/box-assigner.ts:26` (`significantTokens(summary.summaryText)`), `:41` (`appendSummaryText`) | Fewer/changed summaries → different box term overlap and box content | `tests/boxes/*` |
| Trace candidate generation | `src/traces/trace-candidate-core.ts:48` (`significantTerms(summary.summaryText)`) | Directly implicated by the SCOPE-INSERT's stated motivation — boilerplate tool summaries currently inflate shared-term similarity; removing them should shrink trace candidate explosion | `tests/traces/*` |
| Retrieval scoring | `src/retrieval/memory-retriever.ts:277,370,386-387,451,462` (`scoreText(topicWords, summary.summaryText)`, anchor text matching) | Fewer summaries, different text → different retrieval ranking; SC7 ("recall quality does not regress") must be tested here | `tests/retrieval/*` |
| Query service subject text | `src/retrieval/memory-query-service.ts:236` | Subject field sourced from `summary.summaryText` | `tests/retrieval/*` |
| Injection packets | via retrieval above (no direct additional file found beyond retriever/query-service) | Downstream of retrieval scoring | `tests/retrieval/*`, integration tests exercising `prepareInjection` |
| MCP read tools | `src/mcp/tools/read-tools.ts` (not directly grepped for `summaryText` in this pass, but it wraps `memory-query-service`/`memory-retriever` output) | Indirect — surfaces retrieval output verbatim | Check `tests/mcp/` if present |
| Explain/audit | `src/audit/explain-service.ts` | Needs REQ-053 extension (rule id/version reporting); "summarized" event detail (`sourceCanonicalEventCount`) unaffected by hygiene since it already counts `sourceCanonicalEventIds`, which per Pitfall 3 must stay unchanged | needs new/extended test |

Directly confirmed touching contraction/topic/summarization in `tests/`: `tests/daemon/contraction-runner.test.ts`, `tests/bootstrap/historical-bootstrapper.test.ts`, `tests/compaction/pre-compactor.test.ts`, `tests/summarization/openrouter-summarizer.test.ts`, `tests/summarization/summarizer.test.ts`, `tests/topic/topic-monitor.test.ts`, plus contract/fixture files (`tests/integrations/hermes-contract.test.ts`, `tests/relay/metadata-contract.test.ts`, `tests/storage/summary-vectors.test.ts`, `tests/sync/protocol-contracts.test.ts`) that may assert summary shapes incidentally. That is 11 files with a direct grep hit on `contraction-runner`/`topic-monitor` imports or summarization test paths; the true blast radius (any test asserting a specific summary COUNT or exact summary TEXT against a fixture corpus) is likely broader and should be discovered by running `npm test` once early implementation lands, watching for count/text-equality assertion failures in `tests/boxes/`, `tests/traces/`, `tests/retrieval/` as well.

## Sources

### Primary (HIGH confidence — direct code reads this session)
- `src/daemon/contraction-runner.ts` — full file read, lines cited throughout
- `src/topic/topic-monitor.ts` — full file read, lines cited throughout
- `src/summarization/summarizer.ts` — full file read
- `src/imports/tool-call-record.ts` — full file read
- `src/service/derivation-invalidator.ts` — full file read
- `src/daemon/types.ts` — full file read
- `src/audit/explain-service.ts` — full file read
- `src/operations/backfill-embeddings-command.ts` — full file read
- `src/integrations/hermes/adapter.ts` — full file read
- `src/compaction/pre-compactor.ts` — partial read (lines 1-60)
- `src/imports/hermes-importer.ts` — partial read (`parserVersion` pattern, lines 80-170)
- `.planning/phases/11-derivation-input-hygiene/11-CONTEXT.md`, `11-SCOPE-INSERT.md`, `11-MEASUREMENT.md`, `11-hygiene-sim.ts` — full reads
- `.planning/REQUIREMENTS.md` (REQ-040, 052-054), `.planning/STATE.md` — grepped/tailed
- `CLAUDE.md`, `AGENTS.md` — full/partial reads
- Directory/grep investigation of `tests/daemon/`, `tests/compaction/`, `src/boxes/`, `src/traces/`, `src/retrieval/`, `src/mcp/tools/` for blast-radius mapping

### Secondary (MEDIUM confidence)
- None — no web/external sources consulted; this is a pure internal-codebase phase with no third-party unknowns.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: N/A — no new stack introduced
- Architecture (integration seam location): HIGH — direct code read of the exact loop and function boundaries
- Pitfalls: HIGH for Pitfalls 1-3, 5 (directly derived from reading the actual positional/invalidation logic); MEDIUM for Pitfall 4 (the Hermes gap is confirmed to exist structurally, but whether it matters in practice depends on an unverified fact about Hermes's live tool-role mapping — flagged as Assumption A2)
- Testing strategy: HIGH for existing fixture/harness identification; MEDIUM for the CI-safe synthetic-corpus proposal (a reasonable extrapolation from existing patterns, not itself verified against a built fixture)

**Research date:** 2026-07-26
**Valid until:** Effectively indefinite for the architectural findings (internal code, not subject to external API drift) — but re-verify against `11-hygiene-sim.ts`'s numbers if the assistant-side rule set (Assumption A4) changes before planning is finalized.
</content>
