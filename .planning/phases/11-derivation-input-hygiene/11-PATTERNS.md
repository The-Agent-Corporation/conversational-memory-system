# Phase 11: Derivation Input Hygiene - Pattern Map

**Mapped:** 2026-07-26
**Files analyzed:** 8 (2 new, 6 modified/extended) + 2 new test files
**Analogs found:** 8 / 8

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `src/topic/derivation-hygiene.ts` (NEW) | utility (pure classification/transform) | transform | `src/imports/secret-redactor.ts` (pure content-rule module) + `.planning/phases/11-derivation-input-hygiene/11-hygiene-sim.ts` (already-measured prototype) | exact (prototype exists) |
| `src/daemon/contraction-runner.ts` (MODIFIED — `drainSlice` loop, `summaryForSpan`) | controller/orchestrator | event-driven / CRUD | itself (existing file, in-place extension) | exact — no external analog needed |
| `src/integrations/hermes/adapter.ts` (MODIFIED — `processTimelineRow`) | service (live bridge) | event-driven | `src/daemon/contraction-runner.ts`'s `drainSlice` loop (parallel structure: `monitor.observe` then completed-span summarization) | role-match (parallel seam, not identical shape) |
| `src/compaction/pre-compactor.ts` (MODIFIED — `compactCompletedTopic`) | service | event-driven / CRUD | `src/daemon/contraction-runner.ts`'s `summaryForSpan` (same positional-turn-reconstruction problem, smaller scale) | role-match |
| `src/daemon/types.ts` (MODIFIED — `ContractionCheckpoint` schema) | config/schema (Zod) | CRUD (persisted checkpoint) | itself — extend `ContractionCheckpointSchema` the same way `activeTopic` was added, mirroring `RollingTopicCheckpointSchema` in `src/bootstrap/types.ts` | exact |
| `src/audit/explain-service.ts` (MODIFIED — report rule id/version) | service (audit/read) | request-response | itself — extend `explainMemoryItem`'s `summarized` event `detail` block | exact |
| `src/operations/rebuild-derivations-command.ts` (NEW) | service / CLI command | batch (resumable, checkpointed) | `src/operations/backfill-embeddings-command.ts` | exact |
| `tests/topic/derivation-hygiene.test.ts` (NEW) | test | unit | `tests/topic/topic-monitor.test.ts` (structure) + `11-hygiene-sim.ts` (fixture data/expected outputs) | role-match |
| `tests/operations/rebuild-derivations-command.test.ts` (NEW) | test | integration | `tests/operations/backfill-embeddings-command.test.ts` | exact |

## Pattern Assignments

### `src/topic/derivation-hygiene.ts` (NEW — pure module)

**Analogs:** `src/imports/secret-redactor.ts` (pure content-rule function shape), `.planning/phases/11-derivation-input-hygiene/11-hygiene-sim.ts` (already-measured classify/collapse prototype — promote almost verbatim), `src/imports/tool-call-record.ts` (the `eventKind: "tool_call"` discriminator this module reads).

**Versioning pattern to imitate** (`src/daemon/contraction-runner.ts:17`):
```typescript
const PROCESSOR_VERSION = "continuous-contraction/v1";
```
Declare analogously:
```typescript
export const HYGIENE_RULE_VERSION = "hygiene-rules/v1";
```

**Pure predicate module shape** (`src/imports/secret-redactor.ts:1-18`, full file):
```typescript
const REDACTION = "[REDACTED]";

export const redactKnownSecrets = (content: string): string => {
  let redacted = content.replace(/-----BEGIN...PRIVATE KEY-----[\s\S]*?-----END...PRIVATE KEY-----/gu, REDACTION);
  redacted = redacted.replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/gu, REDACTION);
  // ... more rules, in sequence, over a plain string ...
  return redacted;
};
```
`derivation-hygiene.ts` should follow the same "exported pure function(s) over plain data, no store/IO" shape, but as a rule-table + classifier rather than a chain of `.replace` calls (see the promoted rule table below).

**Classification table to promote (measured, not just designed)** — source: `11-hygiene-sim.ts:40-61` (already read into RESEARCH.md verbatim):
```typescript
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
  // ADD (per 11-CONTEXT.md, confirmed 2026-07-26, NOT yet in this array):
  //   { id: "silent-sentinel", test: (c) => c.startsWith("[SILENT]") }               (assistant role)
  //   { id: "structured-json-emission", test: (c) => /* bare-JSON assistant message */ }
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

**Run-collapse accumulator to promote** — source: `11-hygiene-sim.ts:151-171`:
```typescript
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

**Collapse-text format to promote** — source: `11-hygiene-sim.ts:67-74`:
```typescript
const collapseText = (names: string[]): string => {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${n} ${name}`);
  return `[Activity] ran ${names.length} tool calls: ${parts.join(", ")}`;
};
```
This is the exact wording measured against the 55,930/77.6MB targets — the plan must pick this wording explicitly (Assumption A1 in RESEARCH.md) rather than the CONTEXT.md category-grouped prose example, unless the plan deliberately re-runs the sim with a new wording.

**Tool-call discriminator this module reads (do not re-derive)** — `src/imports/tool-call-record.ts:36`:
```typescript
eventKind: "tool_call",
```
Already a first-class field on `CanonicalEvent`/`HostEvent` (`src/domain/canonical.ts:38`, `src/domain/events.ts:22`: `z.enum(["message", "tool_call"]).optional()`). `tool_activity` classification is `event.eventKind === "tool_call"`, no string matching.

**Exported surface expected by both call sites and by `explain-service.ts`:**
```typescript
export type DerivationClass = "conversational" | "tool_activity" | "synthetic_injected";
export const HYGIENE_RULE_VERSION = "hygiene-rules/v1";
export function classify(row: { eventKind?: string; content: string }): { klass: DerivationClass; rule: string | null };
export function collapseToolRuns(events: CanonicalEvent[]): /* per-position label/summary content view */ ...;
```
Must be a SINGLE shared module imported by `contraction-runner.ts`, `hermes/adapter.ts`/`pre-compactor.ts`, `explain-service.ts`, and the rebuild command — per the anti-pattern in RESEARCH.md ("Re-deriving classification differently in `explain-service.ts` than in `contraction-runner.ts`").

---

### `src/daemon/contraction-runner.ts` (MODIFIED)

**Analog:** itself. The exact integration points, read in full:

**The `drainSlice` per-event loop to wrap** (lines 142-163):
```typescript
for (let index = startIndex; index < allEvents.length && processed.length < maxEvents; index += 1) {
  const event = allEvents[index];
  const turn = turnFromEvent(event, threadId, index + 1);
  turns.push(turn);
  anchors.push(...anchorsForTurn(turn));
  const observed = monitor.observe({
    id: event.id,
    host: "unknown",
    profileId: personId,
    hostSessionId: threadId,
    sequence: index + 1,
    type: "conversation_turn",
    role: event.role,
    content: event.content,
    createdAt: event.occurredAt,
    metadata: turn.metadata
  });
  if (observed.completed) completedSpans.push(observed.completed);
  processed.push(event);
  await this.options.afterEvent?.(event);
  if (this.clock.monotonicNow() - startedAt >= maxMonotonicMs) break;
}
```
The hygiene pre-pass must run BEFORE this loop over `allEvents.slice(startIndex, startIndex + maxEvents)` (per RESEARCH.md's architecture diagram), producing a per-position `labelContent` used in place of `event.content` in the `monitor.observe({...})` call above (never mutate `event.content` itself — `Turn.content`/canonical content stay untouched, per Pitfall 2).

**`summaryForSpan`'s positional reconstruction to extend, not replace** (lines 298-339):
```typescript
private async summaryForSpan(
  personId: string,
  span: CompletedTopicSpan,
  events: CanonicalEvent[]
): Promise<Summary> {
  const sourceEvents = events.slice(span.sourceTurnRange.startSequence - 1, span.sourceTurnRange.endSequence);
  const first = sourceEvents[0];
  if (!first) throw new Error("Cannot contract an empty topic span");
  const sourceTurns = sourceEvents.map((event, offset) =>
    turnFromEvent(event, span.hostSessionId, span.sourceTurnRange.startSequence + offset));
  const draft = await this.summarizer.summarize({ span, sourceTurns });
  return {
    id: summaryId(personId, first.id, span.topicLabel),
    ...
    sourceCanonicalEventIds: sourceEvents.map((event) => event.id),   // MUST stay the FULL raw list (Pitfall 3)
    ...
  };
}
```
Per Pitfall 2, keep `sourceCanonicalEventIds`/`sourceTurnRanges` unchanged (full raw event range) — only the CONTENT fed to `this.summarizer.summarize({ span, sourceTurns })` changes (pass a hygiene-transformed content string per turn, e.g. via a parallel `hygieneContent` field or an ephemeral pseudo-turn array used only for summarizer input).

**Existing "generation bump marks stale" mechanism to reuse for `HYGIENE_RULE_VERSION`** (lines 105-108):
```typescript
const checkpointCanResume = previous !== null &&
  previous.generation === job.generation &&
  (previous.processedThroughOrderKey === null ||
    compareKeys(job.earliestAffected, previous.processedThroughOrderKey) >= 0);
```
`ContractionJob.generation` is the existing staleness gate (`src/daemon/types.ts:84`, `z.number().int().positive()`); bumping it is how a hygiene rule-version change should mark derivations stale, matching the "Don't Hand-Roll" table entry in RESEARCH.md rather than inventing a parallel flag.

---

### `src/daemon/types.ts` (MODIFIED — `ContractionCheckpoint` schema)

**Analog:** itself — `ContractionCheckpointSchema` (lines 98-112), and the sibling pattern `RollingTopicCheckpointSchema` in `src/bootstrap/types.ts:4-14` which shows how an existing "carry state across slices" field (`activeTopic`) is already Zod-shaped and optional/nullable for backward compatibility.

**Current schema to extend (add optional field, do not remove/rename anything)**:
```typescript
export const ContractionCheckpointSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1),
  jobId: z.string().min(1),
  processorVersion: z.string().min(1),
  generation: z.number().int().positive(),
  processedThroughOrderKey: CanonicalOrderKeySchema.nullable(),
  nextOrderKey: CanonicalOrderKeySchema.nullable(),
  nextEventId: z.string().min(1).nullable(),
  activeTopic: RollingTopicCheckpointSchema.nullable(),
  sliceCount: z.number().int().nonnegative(),
  immediateStage: z.enum(["pending", "running", "complete"]),
  proposalStage: z.enum(["pending", "running", "complete"]),
  updatedAt: IsoDateTimeSchema
}).strict();
```
Backward-compatible extension pattern (per CLAUDE.md's requirement that `MemoryStore` schema changes land in BOTH store implementations): add a new field as `.nullable()` (matching `activeTopic`'s own nullable shape) so existing persisted checkpoints without it still parse — e.g. `pendingToolRun: PendingToolRunSchema.nullable()`. Because the object uses `.strict()`, BOTH `sqlite-store.ts` and `in-memory-store.ts` read/write paths for `ContractionCheckpoint` must be updated to round-trip the new field (grep `ContractionCheckpointSchema`/`getContractionCheckpoint`/`commitContractionSlice` in both files) — this is the "must touch both stores" cost flagged in RESEARCH.md Open Question 2.

---

### `src/audit/explain-service.ts` (MODIFIED — report rule id/version)

**Analog:** itself — `explainMemoryItem`'s existing `summarized` event (lines 183-192):
```typescript
if (item.kind === "summary" && item.summary) {
  events.push({
    verb: "summarized",
    occurredAt: item.summary.createdAt,
    detail: {
      sourceCanonicalEventCount: (item.summary.sourceCanonicalEventIds ?? []).length,
      sourceSummaryCount: item.summary.sourceSummaryIds.length
    }
  });
}
```
Extend the `detail` object with hygiene rule id/version fields (all `DetailValueSchema`-compatible: `z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()])`, so a rule ID string and version string fit directly). Per the locked decision, classification is RECOMPUTED here (not read from a persisted field) using the SAME shared `classify()` from `derivation-hygiene.ts` — call it per excluded/collapsed source event and surface the rule id(s) that fired, using `sanitizeAuditDetail` (lines 76-84) if any raw content needs truncation.

---

### `src/operations/rebuild-derivations-command.ts` (NEW)

**Analog:** `src/operations/backfill-embeddings-command.ts` (full file, 173 lines) — copy this shape almost exactly per RESEARCH.md's explicit recommendation.

**Options/Deps/Result interface shape to copy** (lines 21-46):
```typescript
const OptionsSchema = z.object({
  databasePath: z.string().min(1),
  batchSize: z.number().int().positive().optional()
}).strict();

export interface BackfillEmbeddingsCommandOptions {
  databasePath: string;
  batchSize?: number;
}

export interface BackfillEmbeddingsCommandDeps {
  onBatchComplete?: (processed: number) => void | Promise<void>;
  progressSink?: (line: string) => void;
}

export interface BackfillEmbeddingsCommandResult {
  ok: true;
  provider: string;
  model: string;
  processed: number;
  totalMissingAtStart: number;
}
```
Rename to `RebuildDerivationsCommandOptions`/`...Deps`/`...Result`; swap `provider`/`model` for `hygieneRuleVersion` (or similar), and `totalMissingAtStart` stays conceptually "count of stale-generation summaries at start."

**Batch loop + store lifecycle + resumability to copy** (lines 56-137):
```typescript
const store = new SqliteStore(databasePath);
try {
  const missingIds = await store.listSummaryIdsMissingVector(embedder.provider, embedder.model);
  const totalMissingAtStart = missingIds.length;
  const allSummaries = await store.listSummaries();
  const summaryById = new Map<string, Summary>();
  for (const summary of allSummaries) summaryById.set(summary.id, summary);

  let processed = 0;
  for (let start = 0; start < missingIds.length; start += batchSize) {
    const idsSlice = missingIds.slice(start, start + batchSize);
    // ... per-id work, batched writes via a single store.save*(records) call ...
    if (records.length > 0) {
      await store.saveSummaryVectors(records);
      processed += records.length;
      progressSink(JSON.stringify({ event: "progress", processed, total: totalMissingAtStart, ... }));
    }
    await deps.onBatchComplete?.(processed);   // <-- test hook for kill-and-resume tests
  }
  return { ok: true, ..., processed, totalMissingAtStart };
} finally {
  store.close();
}
```
For the rebuild command, the "missing set" analog is "summaries whose hygiene generation predates `HYGIENE_RULE_VERSION`" (RESEARCH.md's Don't-Hand-Roll table) rather than "vector is null." Each batch should call `DerivationInvalidator.invalidateDependencies` (see below) then re-run contraction/summarization for the affected event range — reusing `ContractionRunner`-equivalent machinery rather than hand-rolling summary regeneration.

**CLI arg-parsing + entrypoint shape to copy** (lines 140-172):
```typescript
function parseArgs(args: string[]): BackfillEmbeddingsCommandOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--") && arg.includes("=")) {
      const separator = arg.indexOf("=");
      values.set(arg.slice(0, separator), arg.slice(separator + 1));
    } else if (arg.startsWith("--") && args[index + 1]) {
      values.set(arg, args[index + 1]);
      index += 1;
    }
  }
  const databasePath = values.get("--db");
  if (!databasePath) throw new Error("Missing memory database path. Pass --db <path>.");
  ...
}

export async function main(argv: string[]): Promise<void> {
  const result = await runBackfillEmbeddingsCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
```
This is also the pattern to register in `src/cli/command-registry.ts` per CLAUDE.md ("Adding a `memory <cmd>` subcommand means adding an entry here plus a module exporting `main(argv)`").

**Invalidation primitive to call, not reinvent** — `src/service/derivation-invalidator.ts` (full file, 87 lines), the `invalidateDependencies` entry point:
```typescript
export class DerivationInvalidator {
  constructor(private readonly store: MemoryStore) {}
  async invalidateDependencies(input: InvalidateDependenciesInput): Promise<DerivationSupersession[]> {
    // dedupes by (kind,id), walks summary -> anchor/box/proposal/trace by
    // sourceCanonicalEventIds intersection (not ID equality) -- this is why
    // a topicLabel change (which changes the deterministic summary id) still
    // gets found and superseded correctly (Pitfall 5).
  }
}
```
Already called by `contraction-runner.ts:191` (`new DerivationInvalidator(this.store).invalidateDependencies({...})`) — the rebuild command should call this exact class the same way, with `canonicalEventIds` set to the affected batch's raw event IDs and `preserveIds` set to newly-produced summary/anchor ids (mirroring `contraction-runner.ts:195`).

---

### `tests/operations/rebuild-derivations-command.test.ts` (NEW)

**Analog:** `tests/operations/backfill-embeddings-command.test.ts` (full file, 201 lines) — copy structure directly:
- `beforeEach`/`afterEach`: `mkdtemp` + `SqliteStore` + `rm` temp dir (lines 39-52).
- SC1 "completes full corpus" test shape (lines 54-72): seed N stale summaries, run command, assert stale-set empty after.
- SC2 "resumes after interruption" test shape (lines 74-113): `onBatchComplete` throws on the Nth batch to simulate a kill, assert partial progress, rerun, assert convergence to zero-stale with no duplicates.
- SC3 "idempotent rerun" test shape (lines 115-135): run twice, assert second run's `processed === 0` and zero additional store writes via `vi.spyOn`.
- Progress-emission test shape (lines 137-167): assert monotonically increasing `processed` in progress-sink JSON lines.
- Ownership/fail-loud test shape (lines 191-200): assert the command throws rather than silently substituting a sentinel when required data (e.g. `personId`) is missing.

Test data builder pattern to copy (lines 12-36, `summaryRecord` factory with `Partial<Summary>` overrides) — build an analogous `summaryRecord`/`canonicalEventRecord` factory seeding a mix of `tool_call`/`synthetic`/`conversational` events for the rebuild fixtures.

---

### `tests/topic/derivation-hygiene.test.ts` (NEW)

**Analog:** `tests/topic/topic-monitor.test.ts` (existing test structure for `TopicMonitor`, to imitate for suite shape) plus `11-hygiene-sim.ts`'s already-measured fixtures/expected outputs (rule IDs, hit-count expectations, collapse-text format) as the source of truth for expected values — assert against the SAME rule table and collapse format the sim measured, per the "Silent divergence between simulation and implementation" risk in `11-CONTEXT.md`.

---

## Shared Patterns

### Versioned rule mirrors `parserVersion` / `PROCESSOR_VERSION`
**Source:** `src/daemon/contraction-runner.ts:17` (`PROCESSOR_VERSION`), `src/imports/hermes-importer.ts:101,122` (`parserVersion` resume/cache-invalidation gate)
**Apply to:** `derivation-hygiene.ts` (`HYGIENE_RULE_VERSION` const), `contraction-runner.ts` (stamp/check on checkpoint or via `job.generation`), `rebuild-derivations-command.ts` (the staleness query), `explain-service.ts` (report the version alongside the rule id).
```typescript
const PROCESSOR_VERSION = "continuous-contraction/v1";
// ...
const canResume = previous !== null &&
  previous.fileIdentity === identity &&
  previous.parserVersion === PARSER_VERSION &&
  Number(previous.rowHighWaterMark ?? previous.recordIndex) <= maximum.maximum;
```

### Single shared pure classifier, never re-derived
**Source:** anti-pattern documented in RESEARCH.md; enforced by requiring `contraction-runner.ts`, `hermes/adapter.ts`/`pre-compactor.ts`, `explain-service.ts`, and `rebuild-derivations-command.ts` to all `import { classify, HYGIENE_RULE_VERSION } from "../topic/derivation-hygiene.js"` — no independent reimplementation anywhere.

### Provenance/dependency IDs never shrink under transformation
**Source:** `src/daemon/contraction-runner.ts:320` (`sourceCanonicalEventIds: sourceEvents.map((event) => event.id)`), `src/service/derivation-invalidator.ts:29` (dependency scan keys off this exact array)
**Apply to:** Any file that builds or reads a `Summary`'s `sourceCanonicalEventIds` — never filter this list down to "only visible/conversational" events, per Pitfall 3.

### Resumable/idempotent/checkpointed batch command
**Source:** `src/operations/backfill-embeddings-command.ts:48-138` (missing-set-as-checkpoint, batch-and-commit, `onBatchComplete` test hook, `finally { store.close() }`)
**Apply to:** `rebuild-derivations-command.ts` in full, plus its test file's kill/resume/idempotent-rerun structure.

### Dependency-closure invalidation, reused not reinvented
**Source:** `src/service/derivation-invalidator.ts` (full file), already called from `src/daemon/contraction-runner.ts:191-197`
**Apply to:** `rebuild-derivations-command.ts`'s per-batch invalidation step.

### Zod schema backward-compatible extension
**Source:** `src/daemon/types.ts:98-112` (`ContractionCheckpointSchema`, `.strict()` object with `activeTopic: RollingTopicCheckpointSchema.nullable()` as the existing "carry state across slices" precedent)
**Apply to:** Adding the pending-tool-run field to `ContractionCheckpoint` — add as `.nullable()`, and update BOTH `sqlite-store.ts` and `in-memory-store.ts` (CLAUDE.md hard constraint: "any interface change means editing both").

## No Analog Found

None — every file in this phase's scope has at least a role-match analog already read above. The one true novelty (the classify/collapse rule table itself) is not "no analog" but "already prototyped and measured" in `.planning/phases/11-derivation-input-hygiene/11-hygiene-sim.ts`, which is the strongest possible analog (it produced the exact target numbers this phase must reproduce).

## Metadata

**Analog search scope:** `src/daemon/`, `src/topic/`, `src/imports/`, `src/operations/`, `src/audit/`, `src/service/`, `src/summarization/`, `src/compaction/`, `src/integrations/hermes/`, `src/bootstrap/`, `src/domain/`, `tests/operations/`, `tests/topic/`
**Files scanned:** 15 source files fully read, 2 test files fully read, plus targeted greps on `src/domain/canonical.ts` and `src/domain/events.ts`
**Pattern extraction date:** 2026-07-26
</content>
