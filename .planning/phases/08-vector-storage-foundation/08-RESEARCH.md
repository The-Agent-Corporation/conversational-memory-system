# Phase 8: Vector Storage Foundation - Research

**Researched:** 2026-07-21
**Domain:** SQLite storage layer extension (typed table + BLOB vectors) in a dual-store (`SqliteStore` / `InMemoryStore`) TypeScript memory system
**Confidence:** HIGH — every claim below is grounded in direct reads of the actual files this phase touches, plus one live `node:sqlite` BLOB round-trip check run in this session.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Store vectors in a **dedicated `summary_vectors` table**, not in the existing nullable `Summary.embedding` payload field. Rationale: neighbor search scans a narrow table instead of deserializing 135k full-summary JSON payloads; enables clean multi-version rows and per-vector tombstoning.
- **D-02:** **Pure-JS cosine** search — both `SqliteStore` and `InMemoryStore` compute similarity in JavaScript using the existing `cosineSimilarity` util. No native extension. This makes the exact-parity success criterion (SC3) trivial: identical math in both stores. `sqlite-vec` was explicitly rejected for this phase — it needs `DatabaseSync({allowExtension:true})` at construction (changes how the DB is opened everywhere), ships a native binary, and its C float32 distances could rank ties differently from a JS InMemoryStore, jeopardizing exact parity. True ANN / sqlite-vec remain deferred until measured latency pain at ~500k-1M.
- **D-03:** Vector payload encoded as a **packed Float32 BLOB** (little-endian), with `dimensions` stored per row and validated against the decoded length on read.
- **D-04:** A summary may hold **multiple vector rows, one per `(provider, model)`** — primary key `(summary_id, provider, model)`. Lets Phase 9 add ONNX vectors alongside hash vectors non-destructively, and lets Phase 14 see model-skew directly (rows under a stale provider/model). Searches target a specified/active `(provider, model)`.
- **D-05:** `listSummaryIdsMissingVector(provider, model)` returns, in stable order, summary IDs that lack a vector **for that specific `(provider, model)`** — this is the idempotency/resume key for Phase 10 backfill.
- **D-06:** **Filter before scoring.** `findNearestSummaries` denormalizes `person_id` and `scope_ids` onto each vector row and restricts candidates by the caller's authorized person/scope **before** computing cosine — never score-then-filter (per PITFALLS.md; a flat global index that filters post-query leaks across boundaries). The denormalized scope columns are written from the summary's `personId`/`scopeIds` at `saveSummaryVector` time.
- **D-07:** Similarity metric is **cosine**; top-K results are ordered by score descending, ties broken by **`summary_id` ascending**, so `SqliteStore` and `InMemoryStore` return byte-identical rankings, scores, and tie-order for identical input (SC3). No RNG, no insertion-order sensitivity.
- **D-08:** Schema change is **additive** — `create table if not exists summary_vectors` plus supporting indexes, following the existing inline-DDL / `schema-migrations` pattern. It must not touch or rewrite the `summaries` table or any existing payloads, must be safe against the live ~3.5GB DB, and must leave daemon startup and all existing tests unaffected (SC5). The existing nullable `Summary.embedding` field is left as-is for backward-compatible scoring; it is **not** populated in this phase.
- **D-09:** Add four methods to the `MemoryStore` interface, implemented in **both** `SqliteStore` and `InMemoryStore`: `saveSummaryVector`, `getSummaryVector`, `listSummaryIdsMissingVector`, and `findNearestSummaries`. Plus a tombstone/delete-by-summary capability (built + tested, unused until Phase 14). Contract/parity tests must assert identical behavior across both stores.

### Claude's Discretion

- Exact method signatures, index column order, BLOB pack/unpack helper placement, and whether the tombstone capability is a distinct `deleteSummaryVectors(summaryId)` method or a flag — planner's call, as long as D-01 through D-09 hold and the parity tests pass.

### Deferred Ideas (OUT OF SCOPE)

- **Native `sqlite-vec` / true ANN (HNSW/usearch):** deferred to a future performance milestone (~500k-1M summaries with measured latency pain) — would be the codebase's only determinism regression.
- **Populating the legacy `Summary.embedding` field / anchor embeddings:** out of scope; the dedicated table is the search source of truth. Anchor vectors are a near-term follow-up, not v1.1.
- **Actually invoking tombstoning on source deletion:** Phase 14 (REQ-050) — this phase only builds and tests the capability.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-041 | Each summary shall have a locally computed vector embedding persisted in a dedicated vector store, tagged with the embedder provider, model, and dimensionality that produced it. | `## Storage Design` (schema + migration idiom), `## MemoryStore Interface Additions` (typed method signatures + `EmbeddingSchema` reuse for provider/model/dimensions tagging). |
</phase_requirements>

## Summary

This phase is a pure storage/query addition to an already well-established dual-store pattern; nothing downstream calls the new surface yet. The codebase already has every idiom needed: (1) a real, versioned, transactional schema-migration mechanism (`src/storage/schema-migrations.ts` + `SqliteStore.migrate()`) distinct from the base-block `create table if not exists` DDL that ships baseline tables; (2) an established typed-column table pattern (`daemon_contraction_job`, `turns`, `injections`) to follow instead of the generic `(id, payload)` blob idiom that `summaries`/`boxes`/`anchors` use; (3) a proven backend-parameterized contract-test harness (`tests/storage/sync-store.test.ts`, `tests/daemon/daemon-store.test.ts`) that runs identical test bodies against both `InMemoryStore` and `SqliteStore`, which this phase must extend rather than invent; (4) a working, already-imported `cosineSimilarity` function and an exact tie-break convention (`right.score - left.score || left.id.localeCompare(right.id)`) already used by `rankMemories` in `src/retrieval/memory-retriever.ts` — reusing this literal expression for `findNearestSummaries` satisfies D-07's exact-parity requirement by construction, not by coincidence; (5) a verified-in-this-session `node:sqlite` BLOB round-trip (Buffer in, `Uint8Array` out, exact byte fidelity) confirming D-03's packed-Float32-BLOB approach works with zero new dependencies.

The one genuinely new piece of engineering is the BLOB pack/unpack helpers themselves (`Float32Array` <-> `Buffer`/`Uint8Array`) — nothing in the codebase does this today; it is a small, self-contained addition (10-20 lines) that should live in a new shared module (e.g. `src/embeddings/vector-codec.ts`) importable by both `SqliteStore` and `InMemoryStore`'s test/parity harness, or directly in `sqlite-store.ts` if `InMemoryStore` never needs the byte form (it doesn't — D-02 says `InMemoryStore` holds vectors as plain `number[]`, only `SqliteStore` needs the codec).

**Primary recommendation:** Add `summary_vectors` as schema-migrations version 2 (not the base block) with typed columns (`summary_id`, `provider`, `model`, `dimensions`, `vector blob`, `person_id`, `scope_ids_json`, `created_at`) and a composite primary key `(summary_id, provider, model)`; implement the four `MemoryStore` methods plus a `deleteSummaryVectors(summaryIds: string[])` tombstone method in both stores; share the exact `cosineSimilarity` + `right.score - left.score || left.id.localeCompare(right.id)` tie-break already living in `memory-retriever.ts`; extend the existing backend-parameterized contract-test pattern (`tests/storage/sync-store.test.ts`'s `backends` array idiom) with a new test file asserting byte-identical `findNearestSummaries` results between the two stores.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Vector persistence (`summary_vectors` table + BLOB codec) | Database / Storage | — | New typed SQLite table; no other tier touches raw bytes. |
| `MemoryStore` interface surface (4 methods + tombstone) | API / Backend (storage abstraction layer) | Database / Storage | `MemoryStore` is the storage-facing contract consumed by daemon/retrieval/CLI layers; this phase only adds to the contract and its two implementations. |
| Cosine scoring math | API / Backend (in-process, both stores) | — | Pure-JS function shared by both stores per D-02; not a DB-native operation, not a client-tier concern. |
| Scope/person filtering (denormalized columns) | Database / Storage (candidate scan) | API / Backend (caller supplies authorized scope) | D-06 requires filtering happen in the SQL/candidate-scan layer, before scoring — the storage tier owns boundary enforcement for this query, not a downstream caller. |
| Schema migration mechanism | Database / Storage | — | Existing `schema-migrations.ts` versioned-migration runner; this phase adds one entry, doesn't touch the mechanism. |

## Standard Stack

No new external packages. This phase is 100% additive TypeScript against existing infrastructure:

| Component | Source | Purpose |
|-----------|--------|---------|
| `node:sqlite` `DatabaseSync` | Node.js 24 built-in (already used exclusively; no `better-sqlite3`) | BLOB column storage, verified in this session to round-trip `Buffer` -> `Uint8Array` with exact byte fidelity. |
| `cosineSimilarity` | `src/embeddings/embedder.ts:48` (existing) | The exact scoring function both stores must call — do not reimplement. |
| `schema-migrations.ts` | `src/storage/schema-migrations.ts` (existing) | Versioned, transactional, additive migration runner — append a `version: 2` entry. |
| `zod` | Already a project dependency, used throughout `domain/types.ts` | Define a `SummaryVectorRow`-equivalent schema/type if the planner wants runtime validation parity with `SummarySchema`/`EmbeddingSchema`. |

**Installation:** None required — zero new packages.

## Package Legitimacy Audit

**Not applicable.** This phase installs no external packages (D-02 explicitly rejects the one library that would have required a new dependency, `sqlite-vec`). The Package Legitimacy Gate protocol is skipped per its own scope ("whenever this phase installs external packages").

## Architecture Patterns

### System Architecture Diagram

```
Caller (unused this phase — Phase 9-14 will be the callers)
   |
   v
MemoryStore interface  (src/storage/memory-store.ts)
   |-- saveSummaryVector(vector)              -----> write path
   |-- getSummaryVector(summaryId, provider, model) -> point lookup
   |-- listSummaryIdsMissingVector(provider, model) -> backfill idempotency key
   |-- findNearestSummaries(queryVector, opts) -> scoped top-K query
   |-- deleteSummaryVectors(summaryIds)        -> tombstone (unused until Phase 14)
   |
   +--> SqliteStore implementation
   |      1. SELECT summary_id, vector, dimensions
   |           FROM summary_vectors
   |          WHERE provider = ? AND model = ?
   |            AND person_id = ?                    <-- D-06: filter BEFORE scoring
   |            AND (scope match against scope_ids_json)
   |      2. decode each BLOB -> Float32Array (vector-codec.ts)
   |      3. cosineSimilarity(query, decoded) per row  <-- same fn as InMemoryStore
   |      4. sort: score desc, then summary_id asc     <-- same tie-break as InMemoryStore
   |      5. slice to topK, apply minimumScore filter
   |
   +--> InMemoryStore implementation
          1. filter this.summaryVectors array by (provider, model, personId, scopeIds)  <-- same filter-first order
          2. cosineSimilarity(query, row.vector) per row  <-- number[], no BLOB codec needed
          3. sort: score desc, then summary_id asc         <-- IDENTICAL comparator function
          4. slice to topK, apply minimumScore filter

Contract/parity test harness (extends tests/storage/sync-store.test.ts's `backends` idiom)
   asserts SqliteStore and InMemoryStore produce byte-identical (summaryId, score) arrays
   for the same input vectors, options, and scope.
```

### Recommended Project Structure

No new directories needed. New files:
```
src/
├── storage/
│   ├── memory-store.ts          # +4 methods, +1 tombstone method on MemoryStore interface
│   ├── sqlite-store.ts          # +summary_vectors migration entry, +implementations, +vector-codec import
│   ├── in-memory-store.ts       # +summaryVectors: SummaryVectorRow[] field, +implementations
│   └── schema-migrations.ts     # +version:2 entry appended to MIGRATIONS (existing file, edited not replaced)
├── embeddings/
│   └── vector-codec.ts          # NEW: packFloat32Vector(number[]) -> Buffer, unpackFloat32Vector(Uint8Array, dimensions) -> number[]
tests/
└── storage/
    └── summary-vectors.test.ts  # NEW: backend-parameterized parity tests (mirrors sync-store.test.ts's `backends` array)
```

### Pattern 1: Typed-column table instead of `(id, payload)` blob

**What:** Every domain object table today (`summaries`, `boxes`, `anchors`, `proposals`, `traces`) is `(id text primary key, payload text not null)` — a JSON blob per row, written via the shared `upsertPayload`/`getPayload`/`listPayloads` helpers (`sqlite-store.ts:2059-2093`). `summary_vectors` deliberately breaks this mold: it needs typed columns because the whole point is querying/filtering a narrow table without deserializing JSON, matching the precedent already set by `daemon_contraction_job` (`sqlite-store.ts:1754-1772`, typed columns + two indexes) and `turns` (`sqlite-store.ts:1858-1866`, typed `thread_id`/`sequence` columns + index).

**When to use:** Any table where the primary access pattern is a filtered range/equality scan on non-`id` columns, not "fetch by id and deserialize everything."

**Example (recommended DDL, as a new `schema-migrations.ts` entry, not the base block):**
```ts
// Source: pattern derived from sqlite-store.ts:1754-1772 (daemon_contraction_job) and
// the migration mechanism in schema-migrations.ts:23-31
{
  version: 2,
  description: "add summary_vectors table for per-summary embeddings (REQ-041)",
  apply: (database) => {
    database.exec(`
      create table if not exists summary_vectors (
        summary_id text not null,
        provider text not null,
        model text not null,
        dimensions integer not null,
        vector blob not null,
        person_id text not null,
        scope_ids_json text not null,
        created_at text not null,
        primary key (summary_id, provider, model)
      );

      create index if not exists idx_summary_vectors_provider_model_person
        on summary_vectors (provider, model, person_id, summary_id);
    `);
  }
}
```

**Why version 2, not the base block:** `schema-migrations.ts`'s own doc comment (lines 16-21) states the base `migrate()` block is frozen as "version 1" and "New migrations must be appended with a strictly increasing `version`." `tests/storage/schema-migrations.test.ts` already asserts (a) a fresh DB lands on `latestVersion`, (b) a pre-versioning DB migrates forward without data loss, (c) a throwing migration leaves `schema_migrations`/`pragma user_version` untouched, (d) re-running migrations is idempotent. Adding `summary_vectors` as version 2 gets all four of these correctness guarantees for free and is directly exercised by the existing test suite (`latestVersion` and `MIGRATIONS.map(...)` assertions will automatically pick up the new entry) — this is the actual "additive, safe against the live 3.5GB DB" mechanism D-08 asks for, not a bespoke one.

### Pattern 2: Backend-parameterized contract-test harness (extend, don't invent)

**What:** `tests/storage/sync-store.test.ts:142-170` defines a `backends: Array<{ name; create }>` with one entry constructing `InMemoryStore` and one constructing a temp-directory-backed `SqliteStore`, then `for (const backend of backends) describe(...)` runs identical test bodies against both. `tests/daemon/daemon-store.test.ts:105-106` uses the same idiom via a `createHarness(backend)` helper and `for (const backend of ["memory", "sqlite"] as const)`.

**When to use:** This is the project's answer to Pitfall 11 (InMemoryStore/SqliteStore divergence) and is exactly what SC3 (exact parity) requires. There is no separate "generic contract test" file to import from — each test file that needs backend parity defines its own local `backends` array following this shape.

**Example:**
```ts
// Source: tests/storage/sync-store.test.ts:142-170 (pattern to replicate, not import)
const backends: Array<{ name: string; create: () => Promise<{ store: MemoryStore; cleanup(): Promise<void> }> }> = [
  { name: "InMemoryStore", create: async () => ({ store: new InMemoryStore(), cleanup: async () => {} }) },
  {
    name: "SqliteStore",
    create: async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "summary-vectors-"));
      const store = new SqliteStore(join(tempDir, "memory.db"));
      return { store, cleanup: async () => { store.close(); await rm(tempDir, { force: true, recursive: true }); } };
    }
  }
];

for (const backend of backends) {
  describe(`${backend.name} summary_vectors`, () => {
    it("returns byte-identical top-K ordering for identical input vectors", async () => {
      // ... save N vectors, call findNearestSummaries with the same query on both backends
      // outside this loop, compare arrays with expect(sqliteResult).toEqual(memoryResult)
    });
  });
}
```

### Pattern 3: Reuse the existing tie-break comparator verbatim

**What:** `rankMemories` in `src/retrieval/memory-retriever.ts:354` sorts with `ranked.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))`. This is D-07's "cosine descending, tie-break summary_id ascending" requirement, already implemented and already proven in production code.

**When to use:** `findNearestSummaries` in both stores. Do not write a new comparator — import or literally copy this exact expression so there is zero chance of a subtle ordering divergence (e.g. `<` vs `localeCompare`, which can disagree on non-ASCII IDs) between the two store implementations.

```ts
// Source: src/retrieval/memory-retriever.ts:354 — the tie-break to replicate exactly
matches.sort((left, right) => right.score - left.score || left.summaryId.localeCompare(right.summaryId));
```

### Pattern 4: BLOB pack/unpack (new — no existing precedent, verified working)

**What:** No file in this codebase currently binds or reads a BLOB column. This session verified directly against `node:sqlite` (Node v24.7.0) that `DatabaseSync` accepts a Node `Buffer` (a `Uint8Array` subclass) for a `blob not null` column and returns a plain `Uint8Array` on read, with exact byte fidelity — confirmed via a live round-trip: wrote 3 packed `Float32` values via `Buffer.writeFloatLE`, read them back, reconstructed a `Float32Array` view over the returned `Uint8Array`'s buffer, and got the original values back exactly (`[1.5, -2.25, 3]`).

**Example:**
```ts
// NEW module — no existing file to cite; verified live in this research session against node:sqlite v24.7.0
export function packFloat32Vector(vector: number[]): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) buffer.writeFloatLE(vector[index], index * 4);
  return buffer;
}

export function unpackFloat32Vector(bytes: Uint8Array, dimensions: number): number[] {
  if (bytes.byteLength !== dimensions * 4) {
    throw new Error(`Vector BLOB length ${bytes.byteLength} does not match dimensions ${dimensions} (expected ${dimensions * 4} bytes)`);
  }
  const view = new Float32Array(bytes.buffer, bytes.byteOffset, dimensions);
  return Array.from(view);
}
```

The `StatementSync` interface already declared in `sqlite-store.ts:121-125` (`run(...anonymousParameters: unknown[])`) places no type restriction on bound parameters, so passing a `Buffer` requires no interface change.

### Anti-Patterns to Avoid

- **Storing the vector as JSON text instead of BLOB:** violates D-03 and wastes ~5x space at scale (ARCHITECTURE.md's own estimate: ~207MB packed vs ~1GB+ as JSON text at 135k rows x 384 dims).
- **Filtering scope/person after scoring:** violates D-06 and PITFALLS.md Pitfall 8a (cross-scope leakage) — the `WHERE person_id = ? AND ...` clause (or equivalent `Array.filter` in `InMemoryStore`) must run before the cosine loop, not after.
- **Adding `summary_vectors` to the base `migrate()` block instead of `MIGRATIONS`:** works functionally (still `create table if not exists`) but bypasses the versioned-migration audit trail (`schema_migrations` table, `pragma user_version`) that the existing migration test suite specifically checks, and contradicts the doc comment in `schema-migrations.ts` describing the base block as closed/frozen at version 1.
- **Writing a bespoke cosine loop instead of importing `cosineSimilarity`:** risks exactly the float-op-ordering divergence D-02 is designed to eliminate. Both stores must call the same function.
- **`InMemoryStore` "just doing something simpler" for filtering or scoring:** PITFALLS.md Pitfall 11 documents this exact failure mode for this codebase's dual-store pattern — the in-memory implementation must do the identical filter-then-score-then-tie-break sequence, not a simplified stand-in.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cosine similarity math | A new dot-product/magnitude loop | `cosineSimilarity` from `src/embeddings/embedder.ts:48` | Already correct, already tested, and re-deriving it risks tiny floating-point differences between the two store implementations that would break SC3's exact-parity requirement. |
| Schema versioning/migration tracking | A custom "has this table been created" flag or ad-hoc `create table if not exists` sprinkled in `migrate()`'s base block | `schema-migrations.ts`'s `MIGRATIONS` array + `runSchemaMigrations` | Already provides transactional apply, `schema_migrations` audit trail, `pragma user_version` sync, and idempotency — reinventing any part of this is strictly worse and untested. |
| Score sorting with tie-break | A custom comparator | The exact `right.score - left.score \|\| left.id.localeCompare(right.id)` expression from `memory-retriever.ts:354` | Guarantees byte-identical ordering with the rest of the codebase's ranking logic and removes any risk of an off-by-one difference between the two stores' comparators. |
| Store-parity testing | A one-off assertion in a single test file | The `backends: Array<{name, create}>` + `for...describe` idiom from `sync-store.test.ts`/`daemon-store.test.ts` | This is the established, already-proven pattern for catching InMemoryStore/SqliteStore divergence (PITFALLS.md Pitfall 11) in this codebase; a new one-off approach would be inconsistent and might miss cases the existing pattern already guards against. |

**Key insight:** Every piece of infrastructure this phase needs except the BLOB codec itself already exists in the codebase in a proven, tested form. The discipline required is reuse, not invention — the biggest risk to SC3 (exact parity) is accidentally writing two subtly different implementations of cosine scoring or tie-breaking instead of sharing one.

## Common Pitfalls

### Pitfall 1: Filtering scope/person after scoring instead of before (D-06 violation)
**What goes wrong:** `SqliteStore.findNearestSummaries` loads all rows for `(provider, model)` across every person/scope, scores everything, then filters the ranked list down to the caller's authorized person/scope. This still runs unauthorized-scope vectors through the similarity computation and — if `topK` is applied before filtering — can silently return fewer than `topK` authorized results (or zero) because higher-scoring unauthorized rows displaced them.
**Why it happens:** It's the more natural order to write in a straight-line query-then-filter mental model, and it "looks correct" in tests that only use a single person/scope.
**How to avoid:** Put `person_id = ?` and the scope match directly in the `WHERE` clause (SQLite) / as the first `.filter()` step (InMemoryStore), before any cosine computation runs. Structure the query so `topK` is applied to the already-filtered candidate set, not the global set.
**Warning signs:** A cross-scope fixture test (two people, semantically similar summaries) returns results from the wrong person.

### Pitfall 2: `summary_vectors` composite PK ordering breaks `listSummaryIdsMissingVector`'s "stable order" requirement (D-05)
**What goes wrong:** D-05 requires `listSummaryIdsMissingVector(provider, model)` to return ids "in stable order" — this is the resume/idempotency key for Phase 10's backfill. If the underlying query has no explicit `ORDER BY`, SQLite's row order for a `LEFT JOIN ... WHERE ... IS NULL`-style missing-vector query is not guaranteed stable across runs/versions.
**Why it happens:** SQLite often does return the same order for the same query plan in practice, so this can pass tests without an explicit `ORDER BY` and only surface non-determinism after a SQLite version bump or index change.
**How to avoid:** Add an explicit `ORDER BY summary_id ASC` (or whatever key is chosen) to the missing-vector query, and add a test that runs it twice and asserts identical output, plus a test that adds a new summary and re-checks ordering is still ascending.
**Warning signs:** Backfill resume tests are flaky or non-reproducible across runs.

### Pitfall 3: BLOB length/dimensions mismatch silently corrupts vectors
**What goes wrong:** D-03 requires `dimensions` to be "validated against the decoded length on read." If `unpackFloat32Vector` doesn't check `bytes.byteLength === dimensions * 4`, a corrupted row (e.g. from a future model migration writing the wrong dimension count) decodes into a truncated or garbage-length array instead of failing loudly.
**Why it happens:** `Float32Array` construction over a mismatched buffer silently produces a shorter/longer array rather than throwing.
**How to avoid:** Always assert byte length before constructing the `Float32Array` view (see Pattern 4's `unpackFloat32Vector` example) and throw a clear error, not a silent truncation.
**Warning signs:** A `findNearestSummaries` result contains vectors whose length doesn't match the requested `dimensions`, causing `cosineSimilarity`'s `left.length !== right.length` early-return (silently scoring as 0 instead of failing).

### Pitfall 4: Reusing `getPayload`'s generic table-name union type incorrectly
**What goes wrong:** `getPayload<T>`'s `tableName` parameter (`sqlite-store.ts:2083-2093`) is a hardcoded string-literal union that does not include `summary_vectors`. Since `summary_vectors` is a typed-column table (not a `(id, payload)` blob table), it must NOT be routed through `getPayload`/`upsertPayload`/`listPayloads` at all — those helpers assume a `payload text not null` JSON-blob shape that `summary_vectors` does not have.
**Why it happens:** Copy-pasting an existing `getX`/`saveX` method as a starting point naturally reaches for the shared payload helpers, which won't compile (missing from the union) or, if the union is loosely widened, will silently break because there's no `payload` column to select.
**How to avoid:** Write `saveSummaryVector`/`getSummaryVector`/etc. with direct `this.database.prepare(...)` calls using named typed columns, following `daemon_contraction_job`'s pattern (`sqlite-store.ts:1754-1772` DDL, and its corresponding `saveContractionJob`/`getContractionJob` methods — search for their bodies to see the typed-column insert/select idiom) rather than the blob-table helpers.
**Warning signs:** TypeScript compile error on `getPayload("summary_vectors", ...)`, or (if the union were loosened) a runtime `no such column: payload` SQLite error.

## Runtime State Inventory

Not applicable — this is a greenfield additive-schema phase (new table, new interface methods), not a rename/refactor/migration phase. No existing runtime state changes identity or location.

## Code Examples

### Point lookup pattern to follow (typed-column table)
```ts
// Source: sqlite-store.ts:1664-1669, getContractionCheckpointForJob — the idiom for a
// typed-column table point lookup to replicate for getSummaryVector
private getContractionCheckpointForJob(personId: string, jobId: string): ContractionCheckpoint | null {
  const row = this.database.prepare(
    "select payload from daemon_contraction_checkpoint where person_id = ? and job_id = ? order by id asc limit 1"
  ).get(personId, jobId) as PayloadRow | undefined;
  return row ? ContractionCheckpointSchema.parse(JSON.parse(row.payload)) : null;
}
// summary_vectors' getSummaryVector should follow this shape but select typed columns
// (summary_id, provider, model, dimensions, vector, created_at) instead of a payload blob,
// and unpack the vector blob via unpackFloat32Vector before returning.
```

### Delete-by-id pattern to follow (tombstone capability, D-09)
```ts
// Source: sqlite-store.ts:2104-2110, deleteIds — the exact idiom deleteSummaryVectors should
// mirror. Note deleteIds' tableName union does not include summary_vectors and would need
// summary_id-based (not primary-key-based) deletion since a summary can have multiple
// (provider, model) vector rows — a raw `delete from summary_vectors where summary_id = ?`
// prepared statement, not a reuse of deleteIds itself, given the composite key.
private deleteIds(
  tableName: "memory_sources" | "canonical_events" | "import_checkpoints" | "bootstrap_checkpoints" | "quarantine_records" | "turns" | "anchors" | "injections",
  ids: string[]
): void {
  const statement = this.database.prepare(`delete from ${tableName} where id = ?`);
  for (const id of ids) statement.run(id);
}
```

### `commitSourceDeletion`'s effects-list idiom (what Phase 14 will extend this phase's tombstone into)
```ts
// Source: sqlite-store.ts:555-592, commitSourceDeletion — Phase 8 does NOT wire into this;
// shown here so the planner designs deleteSummaryVectors with a signature Phase 14 can drop
// straight into this same sequence (a new `this.deleteSummaryVectors(parsed.effects.???)` line
// alongside the existing deleteIds calls, once SourceDeletionEffectsSchema gains a field for it).
async commitSourceDeletion(input: CommitSourceDeletionInput): Promise<MutationCommitReceipt> {
  // ...
  this.deleteIds("injections", parsed.effects.injectionIds);
  this.deleteIds("anchors", parsed.effects.anchorIds);
  this.deleteIds("turns", parsed.effects.turnIds);
  // Phase 14 will add: this.deleteSummaryVectors(parsed.effects.supersededSummaryIds) here,
  // reusing the already-tracked supersededSummaryIds list (mcp-mutation-contracts.ts:89) since
  // vectors are keyed 1:1 by summary_id already.
  // ...
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| N/A — this is new capability, not a replacement | `summary_vectors` typed table + pure-JS brute-force cosine | This phase | Establishes the storage substrate; no existing behavior changes (nothing calls the new methods yet). |

**Deprecated/outdated:** Nothing in this phase deprecates existing behavior. `Summary.embedding` (the JSON field) remains untouched and unpopulated, per D-08.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|----------------|
| A1 | `person_id`/`scope_ids_json` as denormalized TEXT/JSON columns is the right shape for D-06's scope filter (vs. e.g. a normalized join table for scope IDs) | Pattern 1, DDL example | Low — this is explicitly "Claude's Discretion" per CONTEXT.md; if a normalized shape is preferred, the filtering-before-scoring requirement (D-06) still holds either way, only the DDL/query text changes. |
| A2 | A new `src/embeddings/vector-codec.ts` module (rather than inlining pack/unpack directly in `sqlite-store.ts`) is the right home for the BLOB codec | Project Structure, Pattern 4 | Low — purely organizational; `InMemoryStore` never needs the codec (D-02: it holds `number[]` directly), so only `SqliteStore` and its tests import it either way. |
| A3 | `deleteSummaryVectors(summaryIds: string[])` (plural, array) rather than `deleteSummaryVectors(summaryId: string)` (singular) is the right tombstone signature, to match `deleteIds`'/`deleteAnchors`'/`deleteTurns`'s existing plural-array convention | Code Examples, Don't Hand-Roll | Low — explicitly "Claude's Discretion" per CONTEXT.md; either signature satisfies D-09, this is just a convention-consistency recommendation. |

**If this table is empty:** N/A — see above; all three assumptions are explicitly within the CONTEXT.md-granted discretion zone, not disputed facts.

## Open Questions (RESOLVED)

1. **Should `findNearestSummaries` accept a single `scopeId` filter, a `scopeIds` array (any-of or all-of), or reuse `applyRetrievalBoundary`'s exact semantics (`(summary.scopeIds ?? ["personal"]).every((scopeId) => allowed.has(scopeId))`)?**
   - What we know: `applyRetrievalBoundary` (`memory-retriever.ts:113-167`) uses an "every allowed scope must be in the caller's allowed set" (AND) semantic with a `"personal"` default when `scopeIds` is absent. This is the existing, load-bearing boundary contract summaries already respect.
   - What's unclear: Whether `findNearestSummaries`'s scope filter should replicate this exact semantic (recommended, for consistency) or use a simpler any-match semantic since it's a new, narrower-purpose query surface.
   - Recommendation: Replicate `applyRetrievalBoundary`'s exact filter semantic (including the `["personal"]` default) so a future caller (Phase 13's semantic recall) gets identical boundary behavior whether it goes through `listSummaries()` + `applyRetrievalBoundary` or `findNearestSummaries`'s built-in filter — divergent scope semantics between the two paths would be a subtle correctness bug waiting to happen.

2. **Where should the BLOB codec's dimension-mismatch error surface — as a thrown `Error` from `unpackFloat32Vector`, or as a zod-validated schema failure?**
   - What we know: The rest of the domain layer (`EmbeddingSchema`) uses a zod `.refine()` for the equivalent "vector.length === dimensions" check on the JSON-array form.
   - What's unclear: Whether `summary_vectors` rows should have a corresponding zod schema (e.g. `SummaryVectorRowSchema`) for consistency with every other stored domain object, or whether a plain TypeScript interface + a thrown `Error` in the codec is sufficient given this table's typed-column (not JSON-blob) storage doesn't naturally validate through `.parse(JSON.parse(...))`.
   - Recommendation: A lightweight interface + explicit thrown `Error` (as shown in Pattern 4) is sufficient and consistent with how other typed-column tables (`daemon_contraction_job`) are handled — they don't have a corresponding "table row" zod schema either, only their JSON-payload sibling fields do.

## Environment Availability

Skipped — this phase has no new external dependencies. `node:sqlite` (already required by every other phase) and the existing TypeScript/vitest/tsx toolchain are the only requirements, all already verified present and in use throughout the codebase.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (`vitest.config.ts`, `environment: "node"`, `include: ["tests/**/*.test.ts"]`) |
| Config file | `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/vitest.config.ts` |
| Quick run command | `npx vitest run tests/storage/summary-vectors.test.ts` |
| Full suite command | `npm test` (== `vitest run`) |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|---------------------|--------------|
| REQ-041 | `saveSummaryVector` persists a vector tagged with provider/model/dimensions; `getSummaryVector` round-trips it exactly | unit | `npx vitest run tests/storage/summary-vectors.test.ts -t "round-trip"` | ❌ Wave 0 |
| REQ-041 (SC3, D-07) | `findNearestSummaries` returns byte-identical `(summaryId, score)` ranked arrays from `SqliteStore` and `InMemoryStore` for identical input vectors, including tie-break by `summary_id` ascending on equal scores | unit (backend-parameterized) | `npx vitest run tests/storage/summary-vectors.test.ts -t "exact parity"` | ❌ Wave 0 |
| REQ-041 (D-05) | `listSummaryIdsMissingVector(provider, model)` returns exactly the ids lacking a vector for that pair, in stable order, across repeated calls | unit (backend-parameterized) | `npx vitest run tests/storage/summary-vectors.test.ts -t "missing vector"` | ❌ Wave 0 |
| REQ-041 (D-06) | `findNearestSummaries` never returns a vector row outside the caller's authorized person/scope, even when an unauthorized row scores higher than every authorized row | unit (backend-parameterized, cross-scope fixture) | `npx vitest run tests/storage/summary-vectors.test.ts -t "scope isolation"` | ❌ Wave 0 |
| REQ-041 (D-09 tombstone) | `deleteSummaryVectors` (or chosen name) removes all `(provider, model)` rows for given summary ids; a subsequent `findNearestSummaries`/`getSummaryVector` no longer surfaces them | unit (backend-parameterized) | `npx vitest run tests/storage/summary-vectors.test.ts -t "tombstone"` | ❌ Wave 0 |
| REQ-041 (SC5, D-08) | Migration is additive: fresh DB reaches new `latestVersion`; pre-existing DB with data migrates forward without loss; re-running migrations is idempotent; a throwing migration leaves `schema_migrations`/`pragma user_version` unchanged | integration | `npx vitest run tests/storage/schema-migrations.test.ts` | ✅ (existing file automatically covers the new `version: 2` entry once added to `MIGRATIONS`) |

### Sampling Rate

- **Per task commit:** `npx vitest run tests/storage/summary-vectors.test.ts tests/storage/schema-migrations.test.ts`
- **Per wave merge:** `npm test` (full suite — confirms no existing test, especially `tests/storage/sqlite-store.test.ts` and daemon/sync tests, regresses from the new table/migration)
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `tests/storage/summary-vectors.test.ts` — new file, covers REQ-041's round-trip, exact-parity, missing-vector, scope-isolation, and tombstone behaviors via the backend-parameterized `backends` array idiom (Pattern 2).
- [ ] `src/embeddings/vector-codec.ts` — new module + its own focused unit test (`tests/embeddings/vector-codec.test.ts` or co-located) for `packFloat32Vector`/`unpackFloat32Vector` round-trip and the dimension-mismatch-throws case (Pitfall 3).
- [ ] No new test framework/config install needed — Vitest is already fully configured and this phase's tests are ordinary `.test.ts` files under the existing `tests/**/*.test.ts` glob.

## Security Domain

`security_enforcement` is absent from `.planning/config.json` — treated as enabled per protocol default.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|----------------|---------|--------------------|
| V2 Authentication | No | Out of scope — this phase adds no auth surface; existing `assertWriteAuthority`/authority checks are untouched. |
| V3 Session Management | No | Not applicable to a storage-layer addition. |
| V4 Access Control | Yes | D-06's filter-before-scoring is an access-control requirement (person/scope boundary enforcement) at the storage-query level — the standard control is denormalized `person_id`/`scope_ids` columns filtered in the `WHERE` clause / `.filter()` step before any data crosses the boundary, mirroring the existing `applyRetrievalBoundary` pattern (`memory-retriever.ts:113-167`). |
| V5 Input Validation | Yes | `dimensions` vs. decoded BLOB byte-length validation (D-03, Pitfall 3) is the input-validation control for this phase — reject/throw on mismatch rather than silently truncating. Zod (`EmbeddingSchema`'s existing `.refine()`) is the established project pattern for the equivalent JSON-array check; the BLOB path needs its own explicit length check since it bypasses zod. |
| V6 Cryptography | No | Not applicable — no new cryptographic operations in this phase. Note for future phases (not this one): PITFALLS.md Pitfall 8b flags that embedding vectors are not "opaque numbers" (inversion-attack research) and should eventually receive the same encryption/access-control treatment as summary text under ADR 0047's sync envelope — but that is a sync-integration-phase concern (Phase 11+), not Phase 8, since D-08/CONTEXT.md scope this phase to local storage only, and per the milestone's Sync Interaction research, embeddings are never synced (recomputed per-device), so the ADR-0047 envelope question doesn't arise for this phase's deliverable. |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|------------------------|
| Cross-scope vector leakage (a nearest-neighbor query for one person/scope surfaces another's summary) | Information Disclosure | D-06: filter by `person_id`/`scope_ids` before scoring, not after — enforced at the SQL `WHERE` clause / `InMemoryStore` filter step, verified by a required cross-scope fixture test (see Validation Architecture above). This directly closes PITFALLS.md's Pitfall 8a for the storage layer (the retrieval-layer half of that pitfall is out of scope for Phase 8 per CONTEXT.md). |
| BLOB dimension mismatch causing silent data corruption/misread | Tampering (accidental, not necessarily malicious) | Explicit byte-length check in `unpackFloat32Vector` before constructing the `Float32Array` view (Pitfall 3 above). |
| Orphaned vectors surviving summary deletion (not exploited in this phase, but the capability being built here is the prerequisite fix) | Information Disclosure (deferred to Phase 14) | D-09's tombstone/`deleteSummaryVectors` method is built and tested in this phase specifically so Phase 14 has a ready-made, already-parity-tested primitive to wire into `commitSourceDeletion`'s effects list — this phase's job is only to make sure that primitive exists and works correctly in isolation. |

## Sources

### Primary (HIGH confidence — direct source read, this session)
- `src/storage/sqlite-store.ts` (2111 lines, read in full-relevant-section) — DDL block (`migrate()`, lines 1720-1985), `upsertPayload`/`listPayloads`/`getPayload`/`deleteIds` helpers (2059-2110), `commitSourceDeletion` (555-592), constructor/`DatabaseSync` open path (111-165), `getSchemaVersion` reference (177).
- `src/storage/schema-migrations.ts` (84 lines, read in full) — `MIGRATIONS` array, `runSchemaMigrations`, versioning contract doc comment.
- `src/storage/in-memory-store.ts` (partial read: 1-100, 116-186, 795-820) — field declarations, `saveSummary`/`listSummaries` idiom, `structuredClone`/`upsertById` pattern.
- `src/storage/memory-store.ts` (163 lines, read in full) — the `MemoryStore` interface this phase extends.
- `src/embeddings/embedder.ts` (84 lines, read in full) — `cosineSimilarity`, `DeterministicEmbedder`, `Embedder` interface.
- `src/domain/types.ts` (lines 75-200 read) — `EmbeddingSchema`, `SummarySchema` (with `personId`/`scopeIds`).
- `src/retrieval/memory-retriever.ts` (lines 108-175, 325-355 read) — `applyRetrievalBoundary` (scope filter semantics), `rankMemories`'s tie-break comparator.
- `tests/storage/sync-store.test.ts` (lines 95-180 read) — the `backends` array contract-test harness idiom.
- `tests/daemon/daemon-store.test.ts` (lines 85-125 read) — the `for (const backend of [...])` alternative harness idiom.
- `tests/storage/schema-migrations.test.ts` (150 lines, read in full) — the migration-correctness test suite that automatically covers a new `version: 2` entry.
- `.planning/phases/08-vector-storage-foundation/08-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `.planning/research/ARCHITECTURE.md`, `.planning/research/PITFALLS.md` — upstream milestone research and locked decisions.
- Live verification in this session: `node -e '...'` against `node:sqlite` v24.7.0 confirming `DatabaseSync` BLOB column write (`Buffer`) / read (`Uint8Array`) round-trip fidelity.

### Secondary (MEDIUM confidence)
- None — every claim in this document traces to a direct source read or a live command run in this session.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new dependencies; every referenced utility (`cosineSimilarity`, `schema-migrations.ts`, `DatabaseSync`) is existing, read code, and the BLOB round-trip was verified live in this session.
- Architecture: HIGH — the typed-column-table pattern, the migration-versioning mechanism, and the backend-parameterized contract-test harness are all existing, proven idioms in this exact codebase, cited by file:line.
- Pitfalls: HIGH for codebase-specific pitfalls (filter-before-scoring, migration versioning, BLOB validation — all directly traceable to read code and PITFALLS.md's project-specific findings); the milestone-level PITFALLS.md document itself rates general ANN/ONNX determinism claims as MEDIUM, but none of those apply to Phase 8's scope (no ANN, no embedding computation in this phase).

**Research date:** 2026-07-21
**Valid until:** No fixed expiry — this research is grounded entirely in the current state of a private, non-externally-versioned codebase, not a third-party library whose docs might drift. Re-verify only if `sqlite-store.ts`, `in-memory-store.ts`, `memory-store.ts`, or `schema-migrations.ts` are substantially modified by another phase before Phase 8 executes.
