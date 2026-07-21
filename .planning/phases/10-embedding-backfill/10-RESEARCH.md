# Phase 10: Embedding Backfill - Research

**Researched:** 2026-07-21
**Domain:** Resumable/idempotent batch backfill of a derived artifact (vector embeddings) over an existing SQLite-backed corpus, in a codebase with established checkpoint/resume and CLI-operator-surface conventions.
**Confidence:** HIGH (storage surface, embedder surface, and CLI conventions all read directly from shipped Phase 8/9 code; runtime/throughput estimate is MEDIUM — no direct benchmark run this session)

> No CONTEXT.md exists for this phase (user explicitly skipped `/gsd:discuss-phase`). This RESEARCH.md and REQUIREMENTS.md/ROADMAP.md are the full input to planning — there is no `## User Constraints` section to copy verbatim.

## Summary

Phase 10 is narrower than it looks: Phase 8 already shipped every storage primitive this phase needs
(`saveSummaryVector`, `listSummaryIdsMissingVector`, `findNearestSummaries`, `deleteSummaryVectors`,
write-time dimension/finite validation) and Phase 9 already shipped a resolvable, hard-erroring embedder
(`resolveEmbedder`, `DeterministicEmbedder` default / `TransformerEmbedder` opt-in, both exposing
`provider`/`model`/`dimensions`). Phase 10's job is to **wire a `memory backfill-embeddings` CLI command**
that drives `listSummaryIdsMissingVector(provider, model)` as its own checkpoint, embeds each missing
summary's `summaryText`, writes vectors in fixed-size batches, and surfaces progress through `memory status`
— nothing more. No new persisted checkpoint table, no worker-thread harness, and no new npm package are
required to satisfy REQ-042 or SC1–SC4 at this phase's scope.

The one genuinely new piece of storage surface this phase should add is a **batch write method**,
`saveSummaryVectors(records[])`, implemented as a single SQLite transaction in `SqliteStore` (mirroring the
existing `deleteSummaryVectors` transaction idiom) and a plain loop in `InMemoryStore`. Without it, each of
135,366 rows auto-commits individually — correct, but needlessly slow. With it, a crash mid-batch loses at
most one batch's uncommitted writes, and `listSummaryIdsMissingVector` on restart re-derives exactly what's
still missing — satisfying SC2 (resume without corruption) and SC3 (idempotent rerun) as a natural
consequence of the existing set-difference query, not through new checkpoint machinery.

**Primary recommendation:** Add `MemoryStore.saveSummaryVectors(records[])` (batch, transactional in
`SqliteStore`), then build `memory backfill-embeddings` as a thin loop over
`listSummaryIdsMissingVector(activeProvider, activeModel)`, batched at ~500 ids per transaction, with
per-batch stdout progress lines and a `memory status` extension that reports live backfill completeness by
re-querying the same missing-set query — no new checkpoint table, no worker threads, no new dependencies.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Determine what's missing (resume key) | Database / Storage | — | `listSummaryIdsMissingVector` is already an indexed `NOT EXISTS` query against `summaries`/`summary_vectors`; this is the checkpoint, not application state |
| Embed summary text | API / Backend (CLI process) | — | `resolveEmbedder` + `Embedder.embed()` run in-process; no browser/server-rendering tier involved |
| Persist vectors, batch atomicity | Database / Storage | API / Backend (CLI process) | Transaction boundary belongs in `SqliteStore`; batching cadence (size, loop) belongs in the CLI command |
| Progress visibility | API / Backend (CLI process) | Database / Storage | Live stdout lines come from the running command; point-in-time completeness comes from a `memory status` query against storage |
| Failure/hard-error propagation | API / Backend (CLI process) | — | `resolveEmbedder`'s D-05 hard-error and any mid-run `embed()` throw must propagate to a nonzero process exit, not be caught and silently downgraded |

## Standard Stack

### Core
No new libraries. This phase composes existing, already-installed modules:

| Module | Purpose | Why Standard (for this repo) |
|--------|---------|-------------------------------|
| `src/storage/memory-store.ts` (`MemoryStore` interface) | Vector persistence + missing-set query | Already the sole storage abstraction; every capability is a named interface method implemented in both `SqliteStore` and `InMemoryStore` |
| `src/storage/sqlite-store.ts` (`SqliteStore`) | Production backend | `node:sqlite`'s built-in `DatabaseSync`, zero native deps |
| `src/embeddings/embedder-resolver.ts` (`resolveEmbedder`, `probeEmbedderHealth`) | Resolves active embedder from persisted config | Already the only sanctioned way to obtain an `Embedder`; hard-errors on enabled-but-broken (D-05) — backfill must not bypass it |
| `src/embeddings/embedder.ts` (`DeterministicEmbedder`) | Default/fallback embedder | Always-on default per REQ-044; pure SHA-256 hash, trivially fast |
| `src/embeddings/transformer-embedder.ts` (`TransformerEmbedder`) | Opt-in ONNX embedder | Pinned CPU/single-thread/fp32 config from Phase 9; the throughput-relevant case for batching |
| `src/cli/command-registry.ts` | Static subcommand registry | New entry `backfill-embeddings` follows the exact existing pattern (dynamic import of a module exporting `main(argv)`) |

**Installation:** None required — no `npm install` for this phase.

### Package Legitimacy Audit

Not applicable. Phase 10 introduces zero new external packages. All work is composition of existing
Phase 7–9 modules (`SqliteStore`, `InMemoryStore`, `resolveEmbedder`, CLI registry).

## Architecture Patterns

### System Architecture Diagram

```
memory backfill-embeddings --db <path>
        │
        ▼
resolveEmbedder(databasePath)  ── hard-errors (D-05) if enabled-but-broken ──▶ process exits nonzero, no writes
        │  (returns Embedder: provider, model, dimensions)
        ▼
store.listSummaryIdsMissingVector(provider, model)   ← THE checkpoint (stable id-ascending order)
        │  (ids sorted ascending — same list on every rerun, shrinks as vectors are saved)
        ▼
store.listSummaries()  ── one-time O(n) load, build id→Summary map (matches contraction-runner's
        │                   existing precedent of loading the full per-person event list)
        ▼
for each batch of ~500 missing ids:
        │
        ├─▶ for each id in batch: embedder.embed(summary.summaryText)  → Embedding{provider,model,dims,vector,createdAt}
        │
        ├─▶ store.saveSummaryVectors(batchRecords)   ← single SQLite transaction (NEW batch method)
        │        (SqliteStore: begin immediate / insert.../commit — mirrors deleteSummaryVectors)
        │
        └─▶ stdout progress line: {processed, totalMissingAtStart, provider, model}
        │
        ▼ (SIGKILL here loses at most this uncommitted batch — already-committed batches persist)
loop ends when missing ids exhausted
        │
        ▼
process exits 0; store.listSummaryIdsMissingVector(provider, model) now returns []

Independently, at any time:
memory status --db <path> --person <id>
        │
        ▼
resolveEmbedder + store.listSummaries().length + store.listSummaryIdsMissingVector(...).length
        │
        ▼
embeddingBackfill: { provider, model, totalSummaries, missingVectors, completedFraction }
```

### Recommended Project Structure

No new directories. New/modified files:
```
src/
├── storage/
│   ├── memory-store.ts          # + saveSummaryVectors(records[]) on MemoryStore interface
│   ├── sqlite-store.ts          # + saveSummaryVectors: single begin immediate/commit transaction
│   └── in-memory-store.ts       # + saveSummaryVectors: loop calling existing saveSummaryVector
├── operations/
│   └── backfill-embeddings-command.ts   # NEW — CLI command, mirrors embeddings-command.ts shape
├── bootstrap/
│   └── status-command.ts        # + embeddingBackfill field on MemoryStatusCommandResult
└── cli/
    └── command-registry.ts      # + "backfill-embeddings": () => import("../operations/backfill-embeddings-command.js")
```

### Pattern 1: Missing-set-as-checkpoint (no separate checkpoint table)

**What:** `listSummaryIdsMissingVector(provider, model)` is queried at the start of every run (and, for a
long-running process, does not need to be re-queried mid-run — see below). Its result **is** the resume
state: whatever ids are not yet in `summary_vectors` for the active `(provider, model)` pair are exactly
the work remaining, regardless of how many prior runs were interrupted.

**When to use:** Any backfill/reindex job where the destination table's own contents unambiguously define
"done" — this is exactly that case, because `summary_vectors` is keyed `(summary_id, provider, model)` and
the query is already an indexed `NOT EXISTS`.

**Why this beats a separate checkpoint row (`daemon_contraction_checkpoint`-style):** `ContractionCheckpoint`
needs a separate row because contraction resumes mid-*ordered scan* of an ever-growing canonical event
stream — the "next place to resume" isn't recoverable from output alone. Backfill has no such ordering
requirement: any missing id can be processed in any order, so the destination table's own absence-of-a-row
already answers "what's left" with no auxiliary state. This is explicitly the conclusion Phase 8's own
research reached: *"functionally this job is a pure set-difference retry loop, simpler than contraction's
ordered-canonical-timeline resume logic"* (`.planning/research/ARCHITECTURE.md`).

```typescript
// Source: src/storage/sqlite-store.ts:1298 (already shipped, Phase 8)
async listSummaryIdsMissingVector(provider: string, model: string): Promise<string[]> {
  const rows = this.database
    .prepare(
      `select id from summaries
       where not exists (
         select 1 from summary_vectors sv
         where sv.summary_id = summaries.id and sv.provider = ? and sv.model = ?
       )
       order by id asc`
    )
    .all(provider, model) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}
```

### Pattern 2: Batch-transactional writes, mirroring `deleteSummaryVectors`

**What:** Group writes into fixed-size batches (recommend 500), each wrapped in one `begin immediate` /
`commit` SQLite transaction, so a batch either fully lands or fully rolls back on crash — never a
half-written batch that could leave `summary_vectors` in an inconsistent intra-batch state (though even a
partially-committed batch would still be corrected by the next `listSummaryIdsMissingVector` call, since
each row's presence/absence is independently checked — batching is for I/O efficiency and clean progress
accounting, not correctness).

```typescript
// Pattern to add — mirrors the existing deleteSummaryVectors transaction idiom exactly
// Source: src/storage/sqlite-store.ts:1342 (existing shipped method, same shape)
async saveSummaryVectors(records: SummaryVectorRecord[]): Promise<void> {
  if (records.length === 0) return;
  this.database.exec("begin immediate");
  try {
    for (const record of records) {
      // reuse saveSummaryVector's exact validation + insert body per record
    }
    this.database.exec("commit");
  } catch (error) {
    this.database.exec("rollback");
    throw error;
  }
}
```

**When to use:** Any bulk-write path over `summary_vectors`. `InMemoryStore`'s implementation is a plain
loop calling its existing single-record `saveSummaryVector` — no transaction semantics needed for the map
backend, keeping store parity simple.

### Pattern 3: CLI command shape (mirror `embeddings-command.ts`)

**What:** `backfill-embeddings-command.ts` follows the exact shape of Phase 9's `embeddings-command.ts`:
a zod-validated `OptionsSchema`, a `run*Command` function returning a typed result, a `parseArgs` helper,
and a `main(argv)` export registered in `command-registry.ts`. The one addition relative to
`embeddings-command.ts` is periodic stdout progress output during the (potentially long) run, since
`embeddings-command.ts`'s `enable`/`disable`/`show` actions are all fast and only print a final JSON blob.

```typescript
// Source: src/operations/embeddings-command.ts (existing shape to mirror)
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

For progress, write one JSON line to stdout after every batch (not just a final summary):
```typescript
process.stdout.write(`${JSON.stringify({ event: "progress", processed, total, provider, model })}\n`);
```
This satisfies SC4 ("visible through the operator surface, not a silent black box") for anyone watching
the running process's stdout, independent of the `memory status` point-in-time query (see Pattern 4) which
answers the same question for anyone *not* watching the live process.

### Pattern 4: `memory status` reports backfill completeness live (no sidecar state)

**What:** Extend `MemoryStatusCommandResult` (in `src/bootstrap/status-command.ts`, already the
established "operator surface" per Phase 7 — see `EmbedderHealth` on the same result object) with:

```typescript
interface EmbeddingBackfillSnapshot {
  provider: string;
  model: string;
  totalSummaries: number;
  missingVectors: number;
  completedFraction: number; // 1 when missingVectors === 0 (including totalSummaries === 0)
}
```

Computed by calling `resolveEmbedder` (or `probeEmbedderHealth` if avoiding a hard-error inside `status`
matters more than exactness — recommend `probeEmbedderHealth` here since `memory status` must never throw
just because the embedder is unhealthy) plus `store.listSummaries().length` and
`store.listSummaryIdsMissingVector(provider, model).length`. This requires **no new persisted state** —
it is a live query against the same table the backfill command itself drives off of, so it can never drift
from ground truth the way a cached/sidecar progress file could.

**When to use:** Any time the "is this job caught up" question can be answered by a cheap query against
authoritative storage rather than a separately-maintained progress cache — prefer this over inventing new
persisted state, consistent with Phase 8 research's explicit recommendation against a separate checkpoint
row for this job.

### Anti-Patterns to Avoid

- **A separate `embedding_backfill_checkpoint` table tracking "last processed id."** Unnecessary — the
  missing-set query already answers this, and a separate cursor risks drifting from the actual table
  contents (e.g. if a vector is deleted out-of-band by Phase 14's future deletion-invalidation work, a
  cursor-based checkpoint would incorrectly skip re-embedding it; the missing-set query self-corrects).
- **Loading `Embedding` output straight into `saveSummaryVector` without the `provider`/`model` matching
  what `listSummaryIdsMissingVector` was queried with.** `TransformerEmbedder.embed()` returns
  `model: "Xenova/bge-small-en-v1.5@{revision}"` — always use the *embedder instance's own*
  `provider`/`model`, not a hardcoded string, so a revision bump automatically changes the active
  `(provider, model)` pair and `listSummaryIdsMissingVector` correctly reports the new revision's rows as
  missing until backfilled.
- **Re-querying `listSummaryIdsMissingVector` after every single batch to "check for new work."** Not
  needed for this phase — new summaries arriving mid-backfill-run is Phase 11's daemon-incremental concern,
  not this one-shot job's. Query it once at start; if the operator wants to catch newly-arrived summaries,
  rerun the command (which is exactly SC3's idempotent-rerun case).
- **A worker-thread harness (`parallel-embedding-backfill.ts` + `.mjs` worker) for this phase.** The
  milestone's Phase 8 architecture research proposed this pattern for a future ONNX throughput need, but at
  135,366 summaries with either embedder (see Batching Strategy below), single-threaded in-process embedding
  completes in well under the multi-hour range that would justify the added complexity of a worker-thread
  harness, a serialized-input tmp file, and cross-process error propagation. Build it later if dogfooding
  shows the single-threaded run is unacceptably slow — not preemptively in this phase.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Determining what's already embedded | A custom `WHERE id NOT IN (...)` scan or a Set diff in JS over `listSummaries()` | `store.listSummaryIdsMissingVector(provider, model)` | Already an indexed SQL `NOT EXISTS`; a JS-side diff would require loading both full summary and full vector-table id lists into memory, an O(n) allocation this phase doesn't need |
| Resolving which embedder is active | Reading the embeddings config sidecar file directly, or constructing `TransformerEmbedder`/`DeterministicEmbedder` inline | `resolveEmbedder(databasePath)` | Already encodes the D-05 hard-error contract (enabled-but-broken must reject, never silently fall back) — reimplementing this logic risks silently writing vectors under the wrong provider/model when the model is actually broken |
| Progress/checkpoint persistence | A new SQLite table or JSON sidecar file tracking backfill progress | Live re-query of `listSummaryIdsMissingVector` + `listSummaries().length` from `memory status` | Table 8's own research explicitly reasoned through and rejected a separate checkpoint row for this exact job; a live query can't drift from ground truth |
| Vector validation (NaN, dimension mismatch, out-of-range) | Re-implementing dimension/finite checks in the backfill command | `SqliteStore.saveSummaryVector`'s existing guard (`dimensions !== vector.length`, `Number.isFinite` check) | Already shipped in Phase 8; duplicating it in the CLI command risks the two checks drifting out of sync |

**Key insight:** Every piece of "hard infrastructure" this phase might be tempted to build (checkpoint
table, custom diffing, embedder resolution, vector validation) was already built and shipped in Phase 8/9.
Phase 10's actual net-new surface is small: one batch-write method and one CLI command that loops over an
existing query.

## Common Pitfalls

### Pitfall 1: Treating `listSummaryIdsMissingVector`'s ordering as a cross-backend determinism guarantee it doesn't have (IN-03, carried forward from 08-REVIEW.md)

**What goes wrong:** `08-REVIEW.md` flags (IN-03, still open, not claimed by 08-05) that
`listSummaryIdsMissingVector`'s ordering can diverge between `SqliteStore` (SQLite `BINARY` collation —
UTF-8 byte order) and `InMemoryStore` (JS default sort — UTF-16 code-unit order) for summary ids mixing
characters in the U+E000–U+FFFF range with supplementary-plane characters. The review explicitly calls
this out as mattering "if the Phase 10 backfill resume key ever sees non-ASCII ids."

**Why it happens:** Summary ids in this codebase are internally generated (ASCII, e.g. slug/hash-derived),
so this has never surfaced in practice — but the divergence is real and would only be caught by a test
using non-ASCII ids, which is unlikely to occur by accident.

**How to avoid:** For *production correctness* this is low risk (ids are ASCII in practice) — the resume
key is stable and correct *within* `SqliteStore` on every rerun (BINARY collation is itself deterministic
across runs), which is what SC2/SC3 actually require. It only matters for **cross-backend test parity**: if
Phase 10's contract tests assert identical missing-id-list ordering between `SqliteStore` and
`InMemoryStore` fixtures, avoid non-ASCII summary ids in those fixtures, or explicitly sort both results the
same way before comparing (e.g. compare as sets, not ordered lists, unless ordering itself is under test).
Do not treat this as blocking — it is a known, pre-existing, carried-forward Info-level gap from Phase 8,
not a new Phase 10 defect, and REQ-042's success criteria do not require cross-backend id-ordering parity.

**Warning signs:** A contract test comparing `SqliteStore` and `InMemoryStore` missing-id lists fails only
when fixture ids include non-ASCII characters.

### Pitfall 2: Backfill pushes unvalidated-range embedder output through a known-open quantization gap (from 08-REVIEW.md)

**What goes wrong:** `08-REVIEW.md` documents an open (not-yet-fixed) gap: `saveSummaryVector`'s finite-value
guard checks the float64 input, but `packFloat32Vector` then quantizes to Float32 via `writeFloatLE`
*without range-checking* — a finite float64 magnitude above ~3.4028e38 passes the guard, is stored as
`Infinity` in the BLOB, and produces `NaN`/`Infinity` cosine scores in `SqliteStore` while `InMemoryStore`
(which keeps the float64 verbatim) would score it correctly — a live SC3/D-07 parity divergence. The review
explicitly notes: *"Phase 10's backfill pushes provider output through this API unchecked, and this is
precisely the class of hole the gap closure was scoped to close."*

**Why it happens:** Real embedding output (L2-normalized, both `DeterministicEmbedder` and
`TransformerEmbedder` normalize their output vectors) is always in `[-1, 1]` in practice, so this gap has
never been exercised by real data — only by adversarial test input.

**How to avoid:** For Phase 10 specifically, the practical risk is low (both shipped embedders normalize
their output), so this does not need to be fixed *in* Phase 10 to satisfy REQ-042/SC1–SC4. Flag it
explicitly for the planner as a known, still-open Phase 8 gap that Phase 10's backfill will exercise at full
corpus scale for the first time — if it hasn't been fixed as a Phase 8 gap-closure item by the time Phase
10 executes, consider a cheap defensive assertion in the backfill command (`Number.isFinite(Math.fround(v))`
already covers this correctly if applied *after* the Float32 round-trip, not before) as an optional
hardening step, not a hard requirement.

**Warning signs:** A backfilled vector's cosine score against itself (`findNearestSummaries` self-query)
returns `NaN` or a score outside `[-1, 1]`.

### Pitfall 3: Loading all 135,366 `Summary` payloads into memory at once looks wasteful but matches existing precedent — don't over-engineer a streaming alternative

**What goes wrong:** It's tempting to avoid `listSummaries()`'s full-table load by adding a new
`getSummariesByIds(ids)` batch-fetch method to avoid holding the whole corpus in memory. This is real
engineering effort for a benefit that doesn't materialize at this corpus size: 135,366 summary JSON payloads
(text + metadata, no vectors) is on the order of tens to low hundreds of MB, well within what a one-shot
CLI process can hold, and `ContractionRunner.drainSlice` already establishes the precedent of loading a
full per-person `listCanonicalEvents(personId)` list into memory for its own O(n²)-avoidance work.

**Why it happens:** Pattern-matching to "backfill = big data = must stream" without checking the actual
corpus size against available memory.

**How to avoid:** Call `listSummaries()` once at the start of the run, build an in-memory `Map<id, Summary>`,
and iterate `listSummaryIdsMissingVector`'s result against that map. Do not add a new batch-fetch-by-id
store method for this phase unless dogfooding at the real 135k corpus shows a real memory problem — this
would be premature optimization against a scale where the existing precedent (`listCanonicalEvents`) already
proves the pattern is acceptable in this codebase.

**Warning signs:** None expected at 135k scale; revisit only if RSS during backfill measurably exceeds
what `listSummaries()` alone should cost (i.e., a leak elsewhere, not this pattern).

### Pitfall 4: Assuming `resolveEmbedder`'s hard-error only matters at startup

**What goes wrong:** `resolveEmbedder` calls `TransformerEmbedder.init()` which awaits pipeline
construction once — if that succeeds, the backfill loop assumes the embedder stays healthy for the rest of
the (potentially hour-plus) run. In practice this is safe: `init()` failing is the only realistic hard-error
path (D-05), and once the pipeline is resident, per-call `embed()` failures are not part of the documented
contract. But if `embed()` *does* throw mid-run (e.g. a pathological input), the command must let it
propagate uncaught — never catch-and-silently-skip a summary, and never catch-and-silently-fall-back to
`DeterministicEmbedder` mid-run (that would violate D-05's "never silently write a mixed-provider vector
store" guarantee, since the caller explicitly resolved one embedder for this run).

**Why it happens:** Long-running loops often grow defensive `try/catch`-and-continue logic to "not lose
progress on one bad item," which directly contradicts this codebase's D-05 design intent.

**How to avoid:** Let a mid-run `embed()` throw propagate all the way to the CLI's top-level
`.catch(...) { process.exitCode = 1 }` handler, exactly like `embeddings-command.ts`'s existing pattern.
Already-committed batches remain committed (Pattern 2); the next run resumes from the true missing set,
including the summary that caused the failure — which is correct: if it was a systemic issue (broken model),
the operator sees the error and fixes the model before rerunning; if it was transient, a rerun simply
retries it.

**Warning signs:** A backfill run "completes" but `listSummaryIdsMissingVector` still returns ids
afterward — indicates a swallowed error somewhere in the batch loop rather than a clean propagate-and-exit.

## Code Examples

### Determining active (provider, model) and the resume set

```typescript
// Source: src/embeddings/embedder-resolver.ts (existing, Phase 9) +
//         src/storage/sqlite-store.ts:1298 (existing, Phase 8)
const embedder = await resolveEmbedder(databasePath); // hard-errors (D-05) if enabled-but-broken
const missingIds = await store.listSummaryIdsMissingVector(embedder.provider, embedder.model);
```

### Batch loop with progress reporting

```typescript
const BATCH_SIZE = 500;
const allSummaries = await store.listSummaries();
const summaryById = new Map(allSummaries.map((s) => [s.id, s]));

let processed = 0;
for (let i = 0; i < missingIds.length; i += BATCH_SIZE) {
  const batchIds = missingIds.slice(i, i + BATCH_SIZE);
  const records: SummaryVectorRecord[] = [];
  for (const id of batchIds) {
    const summary = summaryById.get(id);
    if (!summary) continue; // defensive: summary removed between query and processing
    const embedding = await embedder.embed(summary.summaryText);
    records.push({
      summaryId: id,
      provider: embedding.provider,
      model: embedding.model,
      dimensions: embedding.dimensions,
      vector: embedding.vector,
      personId: summary.personId ?? "unscoped",
      scopeIds: summary.scopeIds ?? [],
      createdAt: embedding.createdAt
    });
  }
  await store.saveSummaryVectors(records); // NEW batch method — one transaction per batch
  processed += records.length;
  process.stdout.write(
    `${JSON.stringify({ event: "progress", processed, total: missingIds.length, provider: embedder.provider, model: embedder.model })}\n`
  );
}
```

### `memory status` extension (live completeness, no new persisted state)

```typescript
// Extends src/bootstrap/status-command.ts's existing MemoryStatusCommandResult
const embedderHealth = await probeEmbedderHealth(databasePath);
const totalSummaries = (await store.listSummaries()).length;
const missingVectors = embedderHealth.enabled
  ? (await store.listSummaryIdsMissingVector(embedderHealth.provider, embedderHealth.model)).length
  : (await store.listSummaryIdsMissingVector("deterministic", "keyword-hash-v1")).length;
const embeddingBackfill = {
  provider: embedderHealth.provider,
  model: embedderHealth.model,
  totalSummaries,
  missingVectors,
  completedFraction: totalSummaries === 0 ? 1 : (totalSummaries - missingVectors) / totalSummaries
};
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| N/A — `summary_vectors` table and its query surface did not exist before Phase 8 | `listSummaryIdsMissingVector` as both the population-detection query and the resumability checkpoint | Phase 8 (2026-07-21) | Phase 10 needs zero new checkpoint infrastructure — this is the load-bearing design decision that makes Phase 10 small |

**Deprecated/outdated:** None — this phase builds directly on the most recently shipped storage/embedder
surface, no legacy path to migrate away from.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `TransformerEmbedder` (bge-small, CPU, single-threaded, fp32) throughput is roughly in the tens-of-ms-per-summary range, making a full 135,366-summary run land somewhere between ~1 and a few hours when the ONNX embedder is the active one | Batching Strategy / runtime estimate below | If materially slower (e.g. seconds/item due to longer summaries or model load overhead), the single-threaded in-process design (Pitfall/Anti-Pattern: "don't build the worker harness yet") should be revisited before shipping — no direct benchmark was run this session; this is training-knowledge-plus-Phase-9-config extrapolation, not measured |
| A2 | `Summary.personId`/`Summary.scopeIds` are always populated (non-`undefined`) for every real summary in the live 3.5GB corpus, because `ContractionRunner.summaryForSpan` always sets them, even though the schema marks both `.optional()` | Code Examples (`personId ?? "unscoped"`) | If any real summary genuinely lacks `personId` (e.g. a pre-Phase-1 migration artifact), the fallback `"unscoped"` value is a Phase-10-invented sentinel not validated against `findNearestSummaries`' `personId` filter semantics — verify against the live corpus before relying on the fallback, or make the backfill command fail loudly on a summary with a missing `personId` instead of silently substituting a sentinel |

## Open Questions (RESOLVED)

1. **Is `listSummaryIdsMissingVector` alone sufficient as the resumability/idempotency checkpoint, or is a
   separate checkpoint table needed?**
   - **Resolved:** Sufficient alone. No separate checkpoint table. `listSummaryIdsMissingVector(provider,
     model)` is an indexed `NOT EXISTS` query whose result set *is* the correct "work remaining" answer on
     every invocation, regardless of how many prior runs were interrupted — because SC2/SC3 only require
     "no duplicate/corrupted work" and "zero writes on a second complete run," both of which the set-difference
     query satisfies by construction once writes are batch-transactional (Pattern 2). The IN-03 ordering
     concern flagged in `08-REVIEW.md` is real but only affects cross-backend (`SqliteStore` vs
     `InMemoryStore`) test-fixture ordering comparisons with non-ASCII ids — it does not threaten
     production correctness (real ids are ASCII; `SqliteStore`'s own ordering is stable across runs) and does
     not require a separate checkpoint table to work around.

2. **What batching/throughput strategy fits 135,366 summaries against the live 3.5GB DB?**
   - **Resolved:** Single-threaded, in-process, batch size ~500 ids per transaction via a new
     `saveSummaryVectors(records[])` batch method. No worker-thread harness for this phase (see Anti-Patterns).
     With `DeterministicEmbedder` (the always-on default), runtime is trivially fast (sub-minute for the full
     corpus — pure SHA-256 hashing). With `TransformerEmbedder` (opt-in ONNX), runtime is estimated at roughly
     1–3 hours for the full corpus at this single-threaded, CPU-only, thread-count-pinned configuration
     (A1, MEDIUM confidence — not directly benchmarked this session; validate empirically during
     implementation/dogfooding and revisit the worker-thread anti-pattern recommendation only if the real
     number is materially worse than this estimate). Memory ceiling: one `listSummaries()` load (tens to low
     hundreds of MB of text) plus one resident ONNX pipeline (bounded, loaded once) — no unbounded growth.

3. **How should progress be surfaced?**
   - **Resolved:** Two complementary surfaces, both reusing existing conventions, no new persisted state:
     (a) the running command writes one JSON progress line to stdout per batch (mirrors
     `embeddings-command.ts`'s existing JSON-to-stdout convention, extended to periodic rather than
     one-shot output), and (b) `memory status` (the established Phase 7 operator surface, already reporting
     `embedder: EmbedderHealth`) gains a live-queried `embeddingBackfill` field computed from
     `listSummaries().length` and `listSummaryIdsMissingVector(...).length` — answerable at any time,
     whether or not a backfill process is currently running.

4. **What are the failure semantics on SIGKILL mid-batch, and how does this interact with D-05?**
   - **Resolved:** A batch (default 500 records) is one SQLite transaction (`begin immediate`/`commit`,
     mirroring `deleteSummaryVectors`'s existing idiom); SIGKILL mid-batch loses at most that one
     uncommitted batch, never a partially-written row (all-or-nothing per batch). All prior batches remain
     committed. On restart, `listSummaryIdsMissingVector` re-derives the exact remaining set including the
     lost batch's ids — no explicit recovery logic needed. D-05 interaction: `resolveEmbedder` hard-errors
     before any batch loop starts if the configured embedder is enabled-but-broken; a hypothetical mid-run
     `embed()` failure must propagate uncaught to a nonzero exit (never silently skip-or-fallback), and the
     next invocation's `listSummaryIdsMissingVector` naturally includes whatever wasn't yet committed.

5. **How is idempotency of a second full run asserted in a test (SC3)?**
   - **Resolved:** Run the backfill command to completion against a fixture corpus; spy on
     `store.saveSummaryVectors` (or `saveSummaryVector` if the batch method isn't used in a given test path);
     rerun the command; assert the spy was called zero additional times on the second run, and additionally
     assert `listSummaryIdsMissingVector(provider, model)` returns `[]` both before and after the second run
     (unchanged, confirming no state mutation occurred). This is a call-count assertion, not a byte-level
     database diff — cleaner and immune to incidental WAL/journal file changes that don't reflect logical
     writes.

6. **What does NOT belong in this phase, and is the backfill re-runnable for a future model swap?**
   - **Resolved:** Out of scope: daemon incremental embedding of newly-contracted summaries (Phase 11);
     stale-model-vs-current-model skew detection and deletion-triggered vector invalidation (Phase 14, which
     also owns wiring `deleteSummaryVectors` into `commitSourceDeletion`). Yes, re-runnable for a future model
     swap with zero new code: because `listSummaryIdsMissingVector` and `saveSummaryVector`/
     `saveSummaryVectors` are already parameterized by `(provider, model)`, running the same
     `memory backfill-embeddings` command again after flipping the active embedder (e.g. enabling
     `TransformerEmbedder` after previously running only `DeterministicEmbedder`) automatically treats every
     summary as "missing" under the new `(provider, model)` pair and backfills it — no special "reindex" mode
     needed, it is the same command. Old vectors under the prior `(provider, model)` pair are left in place
     (not deleted) — cleaning those up is explicitly Phase 14's stale-model-skew scope, not this phase's.

7. **Test strategy at realistic-but-fast scale.**
   - **Resolved:** Use `DeterministicEmbedder` (already the always-on default, pure/fast/no I/O) against a
     synthetic fixture of hundreds to low thousands of summaries through **`SqliteStore`**, not
     `InMemoryStore` alone — Pitfall 11 from `.planning/research/PITFALLS.md` (store divergence) specifically
     warns that persistence/transaction-boundary bugs only reproduce against the real backend. Simulate
     "kill mid-run" deterministically (not via actual process signals) by exposing the batch loop's core
     function with an injectable `onBatchComplete` hook that a test can use to throw after N batches,
     then invoke the command again with the same store/database and assert: (a) no duplicate rows for any
     summary id (primary-key-per-`(summary_id, provider, model)` already enforces this at the schema level via
     the existing `on conflict` upsert), (b) `listSummaryIdsMissingVector` reaches `[]` after the second
     invocation, (c) the total `saveSummaryVector`(s) call count across both invocations equals exactly the
     fixture's summary count (no re-embedding of already-committed ids). Reserve the real 135,366-summary,
     ONNX-embedder run for manual dogfooding/smoke validation — not the CI/unit test suite, consistent with
     how the rest of this project treats real-corpus-scale validation (e.g. the 292k-event dogfooding
     mentioned in prior-phase memory) as a separate gate from unit tests.

## Environment Availability

No external dependencies beyond what Phase 7–9 already established (`node:sqlite`, optionally the vendored
ONNX model files if the embedder is enabled). No new environment probes needed for this phase.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 2.0.5 |
| Config file | `vitest.config.ts` (repo root — inherited, not modified by this phase) |
| Quick run command | `npx vitest run tests/operations/backfill-embeddings-command.test.ts` |
| Full suite command | `npm test` (`vitest run`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|--------------------|-------------|
| REQ-042 (SC1) | Full-corpus backfill leaves zero summaries missing a vector for the active `(provider, model)` | integration | `npx vitest run tests/operations/backfill-embeddings-command.test.ts -t "completes full corpus"` | ❌ Wave 0 |
| REQ-042 (SC2) | Kill-mid-batch + restart resumes without re-embedding completed work or corrupting saved vectors | integration | `npx vitest run tests/operations/backfill-embeddings-command.test.ts -t "resumes after interruption"` | ❌ Wave 0 |
| REQ-042 (SC3) | Second full run after completion performs zero additional writes | integration | `npx vitest run tests/operations/backfill-embeddings-command.test.ts -t "idempotent rerun"` | ❌ Wave 0 |
| REQ-042 (SC4) | Progress visible through operator surface (`memory status` + stdout progress lines) | unit + integration | `npx vitest run tests/operations/backfill-embeddings-command.test.ts -t "progress"` and `npx vitest run tests/bootstrap/status-command.test.ts -t "embeddingBackfill"` | ❌ Wave 0 (both) |
| — | `saveSummaryVectors` batch method: transactional in `SqliteStore`, loop-equivalent in `InMemoryStore`, identical parity to per-record `saveSummaryVector` | unit | `npx vitest run tests/storage/summary-vectors.test.ts` (extend existing file) | ✅ file exists, extend with new cases |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/operations/backfill-embeddings-command.test.ts`
- **Per wave merge:** `npm test` (full suite)
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/operations/backfill-embeddings-command.test.ts` — covers REQ-042 SC1–SC4 (new file)
- [ ] Extend `tests/storage/summary-vectors.test.ts` with `saveSummaryVectors` batch-transaction cases (both stores)
- [ ] Extend `tests/bootstrap/status-command.test.ts` (or equivalent) with `embeddingBackfill` field assertions

## Security Domain

`security_enforcement` is absent from `.planning/config.json` → treated as enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No | Backfill is a local operator CLI command, no new auth surface |
| V3 Session Management | No | N/A |
| V4 Access Control | Yes (already enforced upstream) | `saveSummaryVector`/`saveSummaryVectors` persist `personId`/`scopeIds` denormalized from the source `Summary`; `findNearestSummaries`' existing person/scope filtering (shipped Phase 8) is the actual enforcement point — Phase 10 must pass through the summary's own `personId`/`scopeIds` unchanged, never invent or widen scope |
| V5 Input Validation | Yes (already enforced upstream) | `SqliteStore.saveSummaryVector`'s existing dimension/finite guard (Phase 8) validates every write; Phase 10 must not bypass it by calling lower-level insert logic directly |
| V6 Cryptography | No | No new crypto surface; vectors are not synced (per Phase 8/9 architecture research — sync interaction is settled, not reopened here) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|-----------------------|
| Cross-scope vector leakage via a backfill that mis-tags `personId`/`scopeIds` | Information Disclosure | Always source `personId`/`scopeIds` from the `Summary` record being embedded, never a caller-supplied override; add a fixture test asserting a multi-person corpus backfill tags each vector with its own summary's `personId` |
| Silent write under wrong `(provider, model)` after a config change mid-run | Tampering (data integrity) | `resolveEmbedder` is called once per invocation and its returned instance's `provider`/`model` used for every write in that run — never re-resolve mid-loop, so a config change during a run cannot silently split one run's output across two `(provider, model)` pairs |

## Sources

### Primary (HIGH confidence — direct source read, this repo)
- `src/storage/memory-store.ts` — `MemoryStore` interface, `SummaryVectorRecord`, `FindNearestSummariesQuery` shapes
- `src/storage/sqlite-store.ts:1254-1360` — `saveSummaryVector`, `getSummaryVector`, `listSummaryIdsMissingVector`, `findNearestSummaries`, `deleteSummaryVectors` implementations
- `src/embeddings/embedder-resolver.ts` — `resolveEmbedder`, `probeEmbedderHealth`
- `src/embeddings/transformer-embedder.ts` — `TransformerEmbedder` (pinned config, `provider`/`model`/`dimensions`)
- `src/embeddings/embedder.ts` — `DeterministicEmbedder` (`provider = "deterministic"`, `model = "keyword-hash-v1"`)
- `src/operations/embeddings-command.ts` — CLI command shape to mirror
- `src/cli/command-registry.ts` — subcommand registration pattern
- `src/bootstrap/status-command.ts` — `MemoryStatusCommandResult`, existing `embedder: EmbedderHealth` field precedent
- `src/domain/types.ts` — `SummarySchema` (`summaryText`, optional `personId`/`scopeIds`, `embedding` field)
- `src/daemon/contraction-runner.ts` — precedent for loading a full per-person list into memory
- `tests/storage/summary-vectors.test.ts` — existing store-parity test fixture shape to extend
- `.planning/phases/08-vector-storage-foundation/08-REVIEW.md` — IN-03 (ordering divergence) and the open Float32-quantization gap, both directly relevant to Phase 10
- `.planning/research/ARCHITECTURE.md`, `.planning/research/PITFALLS.md` — milestone-level backfill design and pitfalls (Pitfall 4 in particular)
- `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md` — Phase 10 goal, REQ-042, success criteria

### Secondary (MEDIUM confidence)
- Estimated ONNX single-threaded CPU throughput for bge-small-en-v1.5 (tens of ms/summary) — extrapolated
  from Phase 9's pinned single-thread/CPU/fp32 configuration and general training knowledge of
  sentence-transformer-class model inference latency; not directly benchmarked this session (see Assumption A1)

### Tertiary (LOW confidence)
- None used as load-bearing claims in this document.

## Metadata

**Confidence breakdown:**
- Standard stack / architecture: HIGH — every referenced method/module was read directly from shipped code
- Pitfalls: HIGH for the two carried-forward Phase 8 review items (IN-03, Float32 quantization); MEDIUM for
  throughput estimate (A1)
- Validation architecture: HIGH — framework and existing test-file conventions confirmed directly

**Research date:** 2026-07-21
**Valid until:** Stable until Phase 8/9 storage or embedder surfaces change; no external dependency drift risk since no new packages are introduced
