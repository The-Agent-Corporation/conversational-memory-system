# Pitfalls Research: Local Embeddings + ANN for a Deterministic Memory System

**Domain:** Adding local vector embeddings, ANN nearest-neighbor search, and semantic recall to an
existing deterministic, local-first, zero-knowledge-syncing personal memory system (v1.1 milestone).
**Researched:** 2026-07-21
**Confidence:** MEDIUM-HIGH (project-specific findings from source read are HIGH; general ONNX/HNSW
determinism claims are MEDIUM — corroborated by known ONNX Runtime / hnswlib issue reports rather than
a single authoritative spec, since determinism guarantees for these libraries are usually undocumented
or documented as *not* guaranteed).

This document assumes familiarity with the current codebase:
- `src/traces/trace-candidate-core.ts` — the all-pairs, discriminating-term inverted-index trace algorithm being replaced.
- `src/embeddings/embedder.ts` — the existing `DeterministicEmbedder` (SHA-256 keyword-hash, 64-dim, REQ-040-safe but weak).
- `src/daemon/contraction-runner.ts` — the forward/rewind contraction runner whose "reparse everything" cost model is exactly what a naive ANN rebuild would reintroduce.
- `src/storage/sqlite-store.ts` — `commitSourceDeletion` supersedes (rewrites) summaries rather than hard-deleting them; there is no existing "embedding" table/lifecycle to hook invalidation into yet.
- REQ-040 (deterministic, fully local, no external models/services) and the zero-knowledge sync protocol (ADR 0047, `cms-sync-v1`) are hard constraints on any new derived artifact.

---

## Critical Pitfalls

### Pitfall 1: Embedding runtime nondeterminism silently breaks REQ-040

**What goes wrong:**
The model swaps from the current `DeterministicEmbedder` (pure SHA-256 hash, byte-for-byte reproducible)
to a real ONNX sentence-transformer. ONNX Runtime is *not* guaranteed bit-reproducible across: (a) CPU
vs GPU/CoreML/Metal execution providers, (b) thread count (parallel reduction order for matmul/softmax
changes float rounding), (c) graph-optimization level (`ORT_ENABLE_ALL` may fuse ops differently than
`ORT_DISABLE_ALL`), (d) ONNX Runtime version/build (MKL vs oneDNN vs XNNPACK kernels), and (e) tokenizer
version/normalization (NFC vs NFKC, whitespace collapsing) producing different token IDs for the same
text. Any of these can produce a different float vector for the identical summary text on a different
machine or a different day, which then produces a different nearest-neighbor set, a different trace,
and a different set of proposals — this is a direct REQ-040 violation and it will not show up in a
single-machine test run; it only surfaces on a second device via sync, or after a runtime upgrade.

**Why it happens:**
Developers test determinism by re-running the same binary on the same machine, which *is* deterministic
(same EP, same thread count, same build). Cross-device/cross-version determinism is a different property
entirely and is easy to assume rather than verify.

**How to avoid:**
- Pin the ONNX Runtime execution provider explicitly to CPU-only (never CoreML/CUDA/DirectML) and pin
  `intra_op_num_threads`/`inter_op_num_threads` to a fixed value (e.g. 1) rather than "auto" — thread-count
  affects float reduction order in matmul.
- Pin `graph_optimization_level` explicitly (e.g. `ORT_DISABLE_ALL` or a specific fixed level) rather than
  leaving it at "all" default, since optimizer fusion changes across ORT versions.
- Bundle an exact-pinned ONNX Runtime version and exact-pinned tokenizer (vocab + merges file) as part of
  the shipped model artifact, hashed and checked at load time — never resolve "latest available" runtime.
- Add a corpus-level determinism contract test: embed a fixed golden set of summaries, hash the resulting
  vectors (rounded to a fixed decimal precision, e.g. 6 places, to absorb legitimate platform float noise
  without absorbing real drift), and assert the hash matches a committed golden value. Run this test in CI
  on more than one OS/arch runner if possible (macOS arm64 + linux x64) to catch cross-platform drift before
  users do.
- Treat determinism as *bounded*, not absolute: pin a tolerance (e.g. cosine similarity of any given
  vector across two conformant runs must be > 0.999999) rather than requiring bit-identical floats, and
  make the trace/ANN threshold logic tolerant to that bound so tiny float noise never flips a trace
  membership decision at the boundary.
- If real bit-for-bit determinism cannot be guaranteed for the ONNX path, gate it as an *optional* upgrade
  behind the existing `DeterministicEmbedder` default, and document the tradeoff explicitly (matches the
  "Key open decision" already flagged in PROJECT.md) rather than silently swapping the default.

**Warning signs:** Trace membership or proposal counts differ between a freshly-restored backup and the
original device; CI is green on one OS but a user reports different results on another; embedding
regeneration after an ONNX Runtime version bump changes existing vectors without a migration being run.

**Phase to address:** Embedding-model integration phase (the phase that decides/implements the ONNX
sentence-transformer option) — before it becomes the default, not after.

---

### Pitfall 2: ANN index construction order (HNSW) produces different neighbor sets than exact/brute-force cosine

**What goes wrong:**
HNSW (used by hnswlib, usearch, sqlite-vec's ANN mode, faiss-HNSW) is an *approximate* algorithm whose
graph structure depends on insertion order and on random layer assignment (typically seeded from a PRNG).
Two builds of the "same" index from the same vectors but different insertion order (e.g. backfill order
vs incremental-append order, or single-threaded vs sharded-worker insertion) can return different
top-k neighbors for the same query, especially near the similarity threshold boundary. This directly
threatens the "same corpus produces same traces" determinism requirement, independent of embedding
generation determinism (Pitfall 1) — even if the vectors themselves are bit-identical, the *index* built
over them may not deterministically yield the same neighbor set.

**Why it happens:** ANN libraries optimize for recall/speed, not reproducibility; determinism is rarely
a documented guarantee and insertion-order sensitivity is usually only visible in edge cases (near-tie
similarity scores), which is exactly the trace-threshold regime this system operates in.

**How to avoid:**
- Fix and pin the RNG seed used for HNSW layer assignment if the chosen library exposes one (usearch and
  hnswlib both expose a seed parameter — verify and pin it explicitly rather than relying on the default).
- Fix insertion order deterministically: always insert vectors in a stable, corpus-derived order (e.g.
  summary ID lexicographic order or creation-timestamp order), never in "whatever order the backfill
  workers finished" order. Sharded/parallel backfill must still commit to the index in a canonical
  sequential order, or use an index structure that is insertion-order-invariant.
  a exact rather than approximate mode as the fallback comparator.
- For the trace/proposal decision path specifically (where determinism matters more than for read-only
  semantic recall), consider using exact brute-force top-k over a fixed batch (not full corpus — see
  Pitfall 4) rather than ANN, since exact cosine is deterministic and the "not O(n²)" requirement is
  about avoiding all-pairs-of-summaries, not about avoiding a per-summary top-k scan of a bounded
  candidate set (blocking/sharding can bound this — see Pitfall 5).
- Add a golden-index regression test: build the ANN index twice from the same vector set via two
  different code paths (fresh backfill vs incremental append-by-append), and assert neighbor results for
  a fixed query set match exactly (or within a tight, explicitly-justified tolerance).

**Warning signs:** Re-running a full backfill after a `memory reset`/rebuild produces different trace
groupings than the original incremental history; test flakiness in trace tests that only reproduces
depending on test execution order; sync-restored device shows different traces than origin device even
though embeddings match.

**Phase to address:** ANN index selection/integration phase — this is a design decision (library choice,
seed policy, insertion-order policy) that must be locked before the trace algorithm depends on it, and it
needs its own reproducibility test alongside the embedding determinism test from Pitfall 1.

---

### Pitfall 3: ANN integration secretly stays O(n²) via "rebuild the whole index" per daemon run

**What goes wrong:**
The entire motivation for this milestone (per PROJECT.md) is that the current all-pairs shared-term trace
algorithm is combinatorially pathological at 135k+ summaries. It would be easy to "fix" this on paper by
adding an ANN library while still (a) rebuilding the full index from scratch on every daemon tick because
that's the simplest integration, or (b) computing traces by querying the ANN index for every summary
against the *entire* index every run rather than only new-vs-existing, or (c) loading and re-embedding
all 135k+ summaries on every daemon invocation because embedding isn't cached/persisted. Any of these
reintroduces O(n) or O(n log n) *per daemon tick* work proportional to full corpus size — better than
O(n²) but still unacceptable at scale as a steady-state cost for what should be an incremental step, and
directly contradicts the stated goal: "Daemon trace step becomes forward-only/incremental (new-vs-existing),
never all-pairs post-bootstrap."

**Why it happens:** Rebuilding-from-scratch is the simplest possible integration and often what example
code for ANN libraries shows (build index, query index) without any persistence/append story. It "works"
in dev with small corpora and only becomes visibly wrong at production scale, by which time it's load-bearing.

**How to avoid:**
- Persist the ANN index itself (not just the vectors) across daemon runs — either via a library with native
  serialize/deserialize (hnswlib `saveIndex`/`loadIndex`, usearch's save/load, or sqlite-vec's table-backed
  storage) or by re-deriving it from persisted vectors using a bounded, incremental `add()` call for only
  new vectors since the last checkpoint.
- Mirror the existing `contraction-runner.ts` cost model exactly: it already solved this problem for
  contraction (forward path processes only the new event slice; full-rewind-and-reparse is the deliberately
  rare/expensive path, explicitly commented as costly in the source). Apply the same forward/rewind split to
  trace-finding: forward daemon ticks call `index.add(newVectors)` + `index.query(newVectors, k)` only;
  a full rebuild is an explicit, rare, operator-triggered path (analogous to `memory tune`/`memory health`),
  never the default nightly behavior.
  For trace membership specifically, this means: only *new* summaries need to find neighbors among *existing +
  new* summaries; existing summaries never need to be re-queried unless their own trace membership can be
  invalidated by a new arrival (define explicitly whether that's in scope — if not, document it as an
  accepted approximation).
- Add a scale regression test/benchmark analogous to the ones already fixed post-dogfooding (import 37x,
  contraction hours→60s per memory) — assert daemon per-tick trace cost is O(new summaries), not O(corpus
  size), by asserting wall-clock/operation-count stays flat as corpus size in the benchmark fixture grows
  while the per-tick delta stays constant.
- Watch memory footprint too: loading all 135k-1M vectors into process memory (e.g. 1M x 384-dim x 4 bytes
  float32 ≈ 1.5GB) on every daemon tick is itself a scale trap even if it's not O(n²) CPU-wise — the index
  must be persisted on disk (mmap-backed where the library supports it) rather than reloaded/rehydrated
  from a full vector scan every run.

**Warning signs:** Daemon tick duration grows linearly with corpus size instead of staying flat as new
summaries trickle in; daemon process RSS grows to gigabytes on a laptop; nightly daemon run time
regresses noticeably after N more summaries land, mirroring the exact class of bug already found and
fixed in dogfooding for import/contraction.

**Phase to address:** ANN index integration phase, paired with a scale/benchmark validation step (mirror
`scripts/benchmark-sync-padding.mjs` pattern — add an equivalent embedding/trace benchmark script) before
sign-off.

---

### Pitfall 4: The 135,366-summary backfill OOMs or isn't resumable

**What goes wrong:**
A one-shot script that loads all summaries, embeds them, and writes them out in a single transaction will
either OOM (holding 135k+ text blobs + vectors in memory simultaneously, worse if a heavier ONNX model is
loaded with its own memory overhead per inference) or, if it crashes/is interrupted partway (laptop sleep,
process kill, disk full), has to restart from zero — burning CPU/battery redundantly and risking a
half-written index. At the target scale (~1M), this is the same class of problem the project already
solved for import checkpoints (`import_checkpoints` table) and contraction checkpoints
(`daemon_contraction_checkpoint`) — but embeddings/backfill has no existing checkpoint precedent yet in
`sqlite-store.ts` and it would be easy to skip that pattern "just this once."

**Why it happens:** Backfill feels like a one-time migration script, so it's tempting to write it as an
unresumable batch job rather than reusing the checkpoint-resume architecture the rest of the system relies
on (import checkpoints, contraction checkpoints, bootstrap checkpoints all already exist for exactly this
reason).

**How to avoid:**
- Model backfill as a first-class resumable job with its own checkpoint table (mirroring
  `bootstrap_checkpoints`/`import_checkpoints`), storing last-processed summary ID/cursor, so a killed
  process resumes from the last committed batch rather than restarting.
- Batch the work: embed in fixed-size chunks (e.g. 500-1000 summaries), write+commit each chunk, and free
  the chunk's memory before starting the next — never hold all 135k+ vectors in memory to build the final
  index in one shot; use the ANN library's incremental `add()` API per chunk instead of a single bulk-load
  call requiring all vectors resident at once.
- Make backfill idempotent and interruption-safe at the SQLite transaction level, consistent with the
  existing `begin immediate` / `commit` / `rollback` pattern already used throughout `sqlite-store.ts`.
- Surface backfill progress through the existing operator surface (Phase 7's `memory health`/`memory tune`
  CLI) rather than a silent background process, so a stalled/OOMing backfill is diagnosable by the user.
- Load-test the backfill path against a synthetic ~1M-summary fixture (10x headroom over the known 135,366)
  before shipping, not just the real 135k corpus — scale should be validated with margin given the stated
  target of ~1M.

**Warning signs:** Backfill script's RSS climbs unbounded and doesn't plateau; killing and restarting the
backfill re-embeds already-embedded summaries; backfill takes hours with no progress indication and no
way to tell if it's stuck or just slow.

**Phase to address:** Backfill implementation phase, built on the checkpoint-resume pattern used by
`historical bootstrap` / `import` — should reuse, not reinvent, that architecture.

---

### Pitfall 5: Similarity threshold either floods proposals or finds nothing (no principled tuning)

**What goes wrong:**
The current pain point (per milestone context) is proposal flood from the shared-term algorithm. A naive
port to "cosine similarity > threshold" has the same failure mode in a different guise: pick the threshold
too low (e.g. 0.5 for a real sentence-transformer, whose within-domain similarity distribution is often
compressed into a narrow high range like 0.6-0.95) and nearly everything in a coherent professional/work
corpus looks "related," reproducing the flood; pick it too high (e.g. 0.9+) and legitimate same-topic
summaries phrased differently fall below threshold and no traces form, reproducing silence. Unlike keyword
overlap, cosine similarity has no natural interpretable cutoff and its distribution is highly dependent on
which embedding model is used — the weak `DeterministicEmbedder` (SHA-256 keyword hash) and a real
ONNX sentence-transformer will have *completely different* similarity distributions, so a threshold tuned
for one is meaningless for the other.

**Why it happens:** Threshold values get hardcoded from an initial gut-check on a small sample, without
validating against the actual full-corpus similarity distribution, and without separating "same embedder,
different threshold" tuning from "different embedder, need to re-derive threshold entirely."

**How to avoid:**
- Derive the threshold empirically from the corpus's own similarity distribution rather than a fixed
  constant: e.g. compute the similarity distribution over a sample of same-box (already known-related,
  via `matchingBoxIds`) vs random pairs, and pick a threshold that separates them, analogous to how
  `maxDocumentFrequencyFor` already derives a corpus-size-relative floor rather than a hardcoded absolute
  document-frequency cutoff — reuse that pattern for similarity thresholding.
  Consider top-k-nearest-neighbor with a floor rather than pure threshold (e.g. "up to K nearest neighbors
  above threshold T"), since this bounds worst-case fan-out (preventing flood) independently of the
  absolute similarity value's calibration quality, and is a natural extension of using an ANN library's
  `k`-NN query interface anyway.
- Make the threshold configurable/tunable per embedder (do not share one constant across
  `DeterministicEmbedder` and any future ONNX embedder) — key it by `provider`/`model` name (both already
  present in the `Embedding` type) so a model swap can't silently reuse a miscalibrated threshold.
- Since traces are "PROPOSALS with confidence" (existing review flow), map similarity score to the
  confidence field explicitly, and validate the flood/silence balance using confidence-bucketed acceptance
  rates from the existing trace review flow as ground truth for retuning, rather than guessing.
- Explicitly test threshold behavior against the real 135k dogfood corpus, not synthetic fixtures — the
  problem being fixed (pathological trace explosion) only manifested at real dogfooding scale, so the fix
  must be validated at the same scale before being declared correct.

**Warning signs:** Number of trace proposals after switching to vector-based traces is order-of-magnitude
higher or lower than before; almost all proposals get the same confidence score (threshold isn't
discriminating); user acceptance rate in the review flow drops sharply after the switch.

**Phase to address:** Trace-threshold tuning phase, explicitly separated from the "wire up ANN" phase —
should be validated against real dogfood data as an acceptance gate, similar to how the O(n²) fixes were
validated against the 292k-event corpus.

---

### Pitfall 6: Keeping the weak `DeterministicEmbedder` as the silent default produces meaningless "semantic" recall

**What goes wrong:**
`DeterministicEmbedder` (SHA-256 keyword hash into 64 dims) is a bag-of-tokens signature, not a semantic
embedding — it captures exact lexical overlap (like the old shared-term algorithm, just projected into a
vector), not meaning. If it ships as the default "semantic recall" backend without being clearly framed
as REQ-040-safe-but-lexical, users will get "semantic recall" that fails on paraphrase (query "car
trouble" won't match summary "vehicle broke down") while looking, from the API/UX surface, exactly like
real semantic search — this is a quality regression disguised as a feature, and 64 dimensions is also
low enough to cause frequent hash collisions/cancellation for longer summaries (many tokens mapping into
the same 64 buckets with sign cancellation), further degrading signal at higher token counts.

**Why it happens:** REQ-040 makes the deterministic hash embedder the "safe" choice, and it already
exists and passes existing tests, so it's tempting to ship it as the default rather than resolving the
"Key open decision" flagged in PROJECT.md (hash embedder vs. bundled ONNX sentence-transformer) before
launch.

**How to avoid:**
- Resolve the model decision explicitly as a phase deliverable, not an implicit default — PROJECT.md
  already frames this as the key open decision; the roadmap should not let "semantic recall" ship without
  an explicit choice and rationale recorded (likely an ADR, following the project's existing pattern of
  ADR 0047 for sync).
  the deterministic hash embedder is being kept as the default, document to users/tests that "semantic"
  recall is lexical-overlap-in-vector-form, not meaning-based, and gate marketing/UX copy accordingly to
  avoid overpromising.
- If dimensionality is a concern independent of the model choice, raise `dimensions` for
  `DeterministicEmbedder` from 64 (e.g. to 256+) if it remains in use for anything beyond tests/fixtures —
  64 buckets over the token vocabulary of real conversational summaries is small enough to cause meaningful
  hash-collision noise; validate empirically (are two known-unrelated summaries scoring anomalously high
  due to collision at 64 dims?) rather than assuming it's fine because tests pass.
- Add an explicit quality benchmark: a small labeled set of paraphrase pairs (same meaning, different
  wording) and near-miss pairs (shared keywords, different meaning) run through whichever embedder is
  shipped, asserting paraphrase pairs score above near-miss pairs — this is the only way to catch "the
  hash embedder can't do semantics" before a user does.

**Warning signs:** Semantic recall queries only ever return results sharing an exact keyword with the
query; user-reported "I know I mentioned this but search can't find it" when the summary uses different
words for the same concept; two summaries about clearly different topics but with keyword overlap surface
as top "semantic" neighbors.

**Phase to address:** Embedding-model decision phase (same phase as Pitfall 1) — this is the actual
product decision underlying the milestone's stated open question, and semantic-recall quality validation
should be a phase acceptance gate, not a follow-up.

---

### Pitfall 7: Everything collapses into one mega-trace (or traces churn every night)

**What goes wrong:**
Two related failure modes at scale:
(a) **Mega-trace collapse:** if trace-building groups any two summaries whose similarity exceeds threshold
into the same connected component (transitive closure via union-find, a natural simplification when
porting from the current keyed-by-shared-term grouping), then in a corpus with a broadly-similar domain
(e.g. lots of work-related conversations that share generic vocabulary/topic drift), transitive similarity
chains (A~B~C~D...) can merge an enormous number of otherwise-unrelated summaries into one giant trace
via a chain of loosely-related intermediate links — this is the vector-space analog of the
`BROAD_TRACE_TERMS`/document-frequency-floor problem the current code already had to solve for keyword terms
(`maxDocumentFrequencyFor`, `NON_DISCRIMINATING_DOCUMENT_FLOOR`), and the equivalent guard doesn't
automatically exist for cosine similarity without deliberate design.
(b) **Nightly churn:** if trace assignment isn't stable under new-summary arrival (e.g. adding one new
summary shifts which existing summaries a nearby cluster's neighbors are, causing trace membership,
titles, or IDs to be recomputed and shift night to night), the trace review flow becomes untrustworthy —
users reviewing/approving a trace one night see it renamed or restructured the next, breaking the
existing proposal review UX which assumes trace identity (`traceId`) is stable once assigned.

**Why it happens:** Naive ports of "connect anything above threshold" from a graph/union-find mental
model don't carry over the discriminating-term safeguards already present in the shared-term algorithm;
nightly incremental updates that recompute cluster membership from scratch for affected neighborhoods
(rather than only ever *adding* to existing stable trace assignments) reintroduce instability.

**How to avoid:**
- Do not use unbounded transitive closure for trace membership; use a capped-degree or medoid/centroid-based
  grouping (e.g. star-clustering: a new summary joins an existing trace only if it's similar to the trace's
  centroid/representative summary above threshold, not merely to *any* member) — this bounds mega-trace
  growth the same way the document-frequency floor bounds bad shared-term postings today.
- Impose an explicit max-trace-size guard, analogous in spirit to `NON_DISCRIMINATING_DOCUMENT_FLOOR`: if
  a trace would exceed some size (e.g. `maxTraceSizeFor(summaryCount)`), that's a signal the grouping
  criterion is non-discriminating for this cluster and needs either a stricter local threshold or should be
  split/flagged for review rather than silently merged.
- Make trace assignment append-only / monotonic where possible: once a summary is assigned `traceId` X, a
  later daemon run should not reassign it to a different trace unless an explicit merge operation is
  triggered (mirroring how `traceId` is already a stable derived key via `slugify(title)` + namespace hash
  in the current code) — this preserves the "forward-only/incremental" goal from PROJECT.md and keeps trace
  identity stable across nights for the review flow.
- Add a stability regression test: run the trace step twice with one extra summary added between runs,
  assert that all pre-existing trace assignments from run 1 are unchanged in run 2 (only new
  memberships/traces may appear).

**Warning signs:** One trace contains summaries spanning wildly different topics/time periods/people; a
trace's title or membership changes between consecutive daemon runs with no corresponding new summary
that plausibly explains the change; review queue shows the same conceptual trace re-proposed under a
different ID.

**Phase to address:** Trace-algorithm redesign phase (the phase implementing vector-based trace-finding
itself) — the grouping strategy (star/centroid vs. transitive closure) is a core design decision, not a
tuning parameter, and needs its own stability test before the daemon incremental-run phase builds on top
of it.

---

### Pitfall 8: Embeddings leak private content past scope/sensitivity boundaries or via inversion

**What goes wrong:**
Two distinct privacy failure modes:
(a) **Scope bypass:** the existing domain model gates recall by person/workspace/case/sensitivity
(`personId`, `scopeId`/`scopeIds`, `caseId` fields already present in `src/domain/types.ts`). A vector
index built as one flat global ANN structure across all summaries — for query performance/simplicity —
can trivially leak: a nearest-neighbor query for a summary in one case/workspace can surface a
semantically-similar summary from a *different*, supposedly-isolated case/workspace/sensitivity level,
because the ANN index itself has no concept of those boundaries unless explicitly filtered. This is worse
than a naive keyword search bypass because vector similarity crosses topic boundaries by design (that's
the point of semantic recall), making unintentional cross-scope leakage more likely, not less.
(b) **Embedding inversion:** embeddings are lossy but not content-free — published research on embedding
inversion attacks demonstrates that dense sentence embeddings can be partially inverted to recover
substantial fragments of the original text, especially for short texts like conversation summaries. If
embeddings for sensitive summaries are treated as "just numbers" (e.g. logged, cached in less-protected
locations, or synced with weaker protection than the summaries themselves), that assumption is false —
an embedding vector is a derived-but-recoverable representation of private content, not an opaque hash.

**Why it happens:** Scope filtering is naturally applied at the *query result* stage in traditional
search, so it's easy to assume "filter after ANN query" is sufficient — but filtering after retrieval
still runs the similarity computation over data outside the caller's authority, and depending on how the
ANN library's index is structured, may require querying with a larger `k` "then filter down," which is
inefficient and still means unauthorized-scope vectors participated in ranking. Embedding inversion is a
research-adjacent concern that's easy to dismiss as "not a real risk" without checking current literature.

**How to avoid:**
- Structure the ANN index (or a set of indices) so that scope boundaries are enforced *at the index
  level*, not just filtered post-query: e.g. maintain per-scope-partition indices (one HNSW/usearch index
  per person, or per person+sensitivity-tier) rather than one global index with post-hoc filtering, so a
  query physically cannot traverse graph edges into another scope's vectors. If a single flat index is
  used for engineering simplicity, the library must support metadata-filtered search that excludes
  ineligible vectors from graph traversal (not just from the returned result set) — verify this is how the
  chosen library's filtered-search actually works before relying on it (some libraries' "filtered kNN"
  still traverses the full graph and only filters output).
- Treat embedding vectors as equally sensitive as the summary text they're derived from for every
  handling decision: same encryption-at-rest requirements, same access control, same "must not sync in
  plaintext" requirement under the zero-knowledge sync protocol (ADR 0047's `cms-sync-v1` envelope scheme,
  which already encrypts every operation payload) — embeddings must be sealed inside the same
  `cms.sync.v1/operation` envelope machinery as other derived memory (summaries, boxes, proposals), never
  as a separate lower-protection sync channel or a local-only unencrypted cache assumed to never leave the
  device.
- Do not log raw embedding vectors in plaintext debug/telemetry output, and do not expose raw vectors
  through any MCP tool surface without the same scope authority checks applied to summary text itself.
- Explicitly test cross-scope isolation: construct a fixture with two people/cases with semantically
  similar but scope-isolated summaries, and assert an ANN query scoped to person/case A never returns
  person/case B's summaries regardless of similarity score, as a required acceptance test (not just unit
  test for the happy path).

**Warning signs:** A semantic recall query for one case surfaces a result from an unrelated case/client in
manual testing; embeddings appear in a sync payload without going through the existing envelope encryption
path; embedding vectors are stored in a table/cache without the same access-control wrapper the summaries
table already has.

**Phase to address:** Two phases: (1) vector-index/storage-schema phase must bake in per-scope
partitioning from the start — retrofitting scope isolation into a flat index later is a rewrite, not a
patch; (2) sync-integration phase must route embeddings through the existing ADR-0047 envelope machinery
rather than inventing a parallel channel.

---

### Pitfall 9: Embeddings persist after source deletion, undermining the deletion guarantee

**What goes wrong:**
`commitSourceDeletion` in `src/storage/sqlite-store.ts` today supersedes/rewrites summaries (via
`saveSummary` on `parsed.nextSummaries`) rather than hard-deleting the summary rows outright — deletion
is expressed as content redaction/supersession plus cascade-deletion of the lower-level artifacts
(injections, anchors, turns, canonical events, sources). There is currently no embeddings table or
lifecycle at all in the store. If embeddings are bolted on without hooking into this exact deletion path,
the *old* (pre-redaction) embedding vector for a summary will silently persist in the ANN index and vector
store after the source text has been redacted/deleted — meaning: (a) the ANN index can still surface
near-duplicates of deleted content via similarity to its lingering vector, (b) an inversion attack (Pitfall
8b) against the stale vector recovers content the user explicitly deleted, and (c) the product invariant
"every recalled fact traces to its source" is broken because the vector now points at nothing (or at
stale/superseded content).

**Why it happens:** Deletion cascades are usually designed against the *primary* content tables that
exist at implementation time; a new derived artifact (embeddings) added later is easy to miss unless
deletion-effect computation (`computeSourceDeletionEffects`/`sourceDeletionEffectsMatch`) is explicitly
extended to include it, and because embeddings are stored in a separate structure (ANN index files, not
just SQLite rows), they need distinct handling: SQLite `delete` cascades don't automatically clean up
external ANN index files.

**How to avoid:**
- Extend `computeSourceDeletionEffects` (and the `CommitSourceDeletionInput`/effects schema) to explicitly
  include a `embeddingIds` (or reuse `summaryIds` since embeddings should be keyed 1:1 to summary ID)
  deletion/invalidation list, and require the ANN index to support point-deletion/tombstoning of a vector
  by ID (verify the chosen library supports this — hnswlib supports `markDelete`, usearch supports
  removal; libraries lacking deletion support are disqualified for this system specifically because of
  this deletion-guarantee requirement).
- Re-embedding on supersession: when a summary is redacted/superseded (not just hard-deleted), the new
  summary content needs a *new* embedding and the *old* vector must be removed/tombstoned in the same
  transaction — treat "embedding" as a derived artifact with the same lifecycle rules as summaries/boxes/
  traces already enumerated in `commitSourceDeletion` (`parsed.nextSummaries`, `parsed.nextBoxes`,
  `parsed.nextProposals`, `parsed.nextTraces` — embeddings needs to join that list).
  entry can be found before authorizing a hard hardware wipe (`memory tune`/`memory health` style
  diagnostic), so silent drift between the summaries table and the embedding store is detectable rather
  than only discovered when a stale result surfaces.
- Extend the existing source-deletion test suite (which already tests cascade correctness for injections/
  anchors/turns/events/sources) with an embedding-specific case: delete a source, assert its summary's old
  vector is unreachable from the ANN index post-deletion (not just that the summary row itself changed).

**Warning signs:** A deleted/redacted source's content still surfaces via semantic recall or trace
membership after deletion; ANN index file size never shrinks despite deletions; a reconciliation script
finds vector-store entries with no corresponding live summary ID.

**Phase to address:** Storage/schema phase that introduces the embeddings table/index (must extend the
`commitSourceDeletion` effects schema in the same phase, not as a follow-up) — this is a correctness gate,
not a nice-to-have, given the project's existing emphasis on source lifecycle controls (already a shipped
v1.0 phase).

---

### Pitfall 10: Breaking the existing proposal shape / review flow contract

**What goes wrong:**
Traces today are `TraceCandidate` objects (`title`, `traceId`, `summaries`, `keywords`, `continuityTerms`,
`boxIds`) built from shared terms, and flow into a review process as "PROPOSALS with confidence" per the
milestone context. A vector-based rewrite can easily change the *shape* of what a trace proposal contains
(no more natural `keywords`/`continuityTerms` fields from a pure-vector approach) or the *meaning* of
`confidence` (previously perhaps derived from term-overlap count/specificity, now from cosine similarity) —
if this shape change isn't reconciled with whatever downstream consumes `TraceCandidate` (review UI/CLI,
MCP tool responses, stored `Trace` records materialized via `materializeTraceCandidates`), the review flow
either breaks outright (missing fields) or silently degrades (e.g. `keywords`/`continuityTerms` become
empty arrays, making the review UI's "why was this proposed" explanation disappear, which undermines
traceability — an explicit product invariant in this milestone's context).

**Why it happens:** It's tempting to treat trace-finding as purely an internal algorithm swap ("same
output shape, different computation"), but a vector-based approach doesn't naturally produce
human-readable "why" terms the way shared-term matching does, and that gap is easy to leave unaddressed
until a human reviewer actually looks at a proposal and finds no explanation.

**How to avoid:**
- Decide explicitly what replaces `keywords`/`continuityTerms` for explainability: e.g. surface the top
  contributing tokens/phrases per pair (using the existing `significantTerms` utility already available in
  `proposal-utils.js` as a supplementary explanation even when membership is vector-driven), or surface the
  raw similarity score alongside a short excerpt/snippet comparison, so the review flow retains a "why"
  even though matching is no longer keyword-based.
- Preserve `TraceCandidate`'s field contract (or extend it, never silently narrow it) and add compatibility
  tests asserting existing consumers (review CLI, MCP tool schema, `materializeTraceCandidates`-derived
  `Trace` records) still receive non-empty, meaningful values for every field the review flow depends on.
- Map cosine similarity into the existing confidence semantics deliberately (calibrated, not just
  raw score passthrough) so proposal confidence remains comparable/interpretable against historical
  proposals reviewed under the old algorithm, avoiding a discontinuity in review UX (e.g. "why did
  everything's confidence suddenly change scale").

**Warning signs:** Review UI/CLI shows trace proposals with no explanatory keywords; MCP tool consumers
error or receive empty arrays where they expect populated fields; confidence values cluster suspiciously
around a single value.

**Phase to address:** Trace-algorithm redesign phase, in lockstep with whichever phase owns the review-flow/
MCP contract — treat proposal-shape compatibility as an explicit acceptance criterion, not an afterthought.

---

### Pitfall 11: InMemoryStore and SqliteStore diverge on embedding/ANN behavior, so tests pass but production differs

**What goes wrong:**
This codebase clearly maintains a dual-store pattern (an in-memory test double alongside `SqliteStore`).
Embeddings + ANN indexing introduce genuinely new persistence/behavior surface (vector storage, index
build/query, tombstoning on deletion) that's easy to implement fully in `SqliteStore` while the in-memory
test double gets a naive/simplified stand-in (e.g. brute-force cosine scan instead of real ANN, or no
deletion-tombstoning at all) — tests then validate against the simplified in-memory behavior and pass,
while production (SQLite-backed ANN) has different scale characteristics, different determinism properties
(Pitfall 2), or a missed deletion-invalidation path (Pitfall 9) that the in-memory double never exercised.

**Why it happens:** The in-memory store exists for fast unit tests, and ANN-specific behaviors (index
build order, tombstoning, persistence across restarts) are exactly the kind of thing that's tedious to
replicate faithfully in a simplified double, so implementers take a shortcut "since it's just for tests."

**How to avoid:**
- Define a shared contract test suite (store-interface-level, not implementation-level) that both
  `InMemoryStore` and `SqliteStore` must pass identically for embedding/ANN behaviors specifically:
  deletion invalidation (Pitfall 9), determinism-under-reinsertion (Pitfall 2), and scope-partition
  isolation (Pitfall 8a) — run the exact same test bodies against both store implementations via a
  parameterized test harness, which appears to already be this project's convention for store parity
  (verify and reuse the existing pattern if `sqlite-store.ts` has a sibling in-memory store already tested
  this way).
- Do not let `InMemoryStore`'s ANN behavior silently be "just do brute-force cosine, it's fine for tests"
  without also having a real-ANN-backed test path (even if slower) that exercises the actual index library
  at least in an integration/E2E test tier, so index-specific bugs (insertion order, tombstoning API
  quirks) are caught before production.
- Explicitly test the *scale-relevant* behavior (Pitfall 3's O(n²) regression) against `SqliteStore` with
  a resumable/incremental workload, since `InMemoryStore` won't reveal persistence-related scale bugs
  (index rebuild cost, disk I/O) at all by construction.

**Warning signs:** A bug (stale embedding after deletion, wrong neighbor set after restart) reproduces
only against the real SQLite-backed store, never in the fast unit test suite; `InMemoryStore`'s
embedding/ANN logic diverges structurally from `SqliteStore`'s (e.g. one does exact cosine, the other real
HNSW) without an explicit contract test forcing them to agree on results.

**Phase to address:** Storage/schema phase — contract tests should be written alongside the `SqliteStore`
embedding implementation, not bolted on later once divergence has already crept in.

---

### Pitfall 12: Native ANN library / model-file distribution breaks REQ-040's "fully local, no external services" on real user machines

**What goes wrong:**
Popular ANN libraries with best performance (hnswlib, usearch, faiss) ship as native (C++/Rust) bindings
requiring prebuilt binaries per platform/arch/Node-ABI, or a build step (node-gyp) at install time. Users
on less-common platform/arch/Node-version combinations hit install failures (missing prebuilt binary,
failed native compile due to missing build toolchain) — this is a distribution/reliability pitfall
distinct from the algorithmic ones above, but directly threatens "fully local, no external services" if
the fallback for a failed native install is "silently disable semantic features" (degrading REQ-040's
promise without the user knowing) or worse, "fall back to a remote API" (an outright REQ-040 violation).
Separately, the ONNX model file itself (tens to hundreds of MB) has to be bundled or downloaded — if it's
fetched from a remote CDN/registry at first run rather than bundled with the package, that's also a
"no external services" violation (or at minimum an undocumented network dependency), and if the model file
isn't content-hash-verified at load time, a corrupted or tampered model file changes embeddings silently
(compounding Pitfall 1).

**Why it happens:** Native-binding libraries are chosen for performance without validating the full
distribution matrix (macOS arm64/x64, Linux x64/arm64, Windows, various Node major versions) that real
users actually run, and "just download the model on first run" is the path of least resistance for
keeping package size small, without registering that as a REQ-040 boundary violation.

**How to avoid:**
- Pick an ANN library with prebuilt binaries covering this project's actual supported platform matrix (check
  npm prebuild coverage explicitly for hnswlib-node/usearch/sqlite-vec before committing — do not assume
  based on GitHub stars), and add a pure-JS or WASM fallback path (even if slower) for platforms lacking a
  prebuilt binary, so semantic features degrade in *performance*, not silently disappear or fall back to a
  remote service.
- Bundle the ONNX model file directly in the package/release artifact (or a first-party-hosted-but-optional
  download that is explicitly gated behind a user-visible "no local model found, semantic recall requires
  downloading N MB, install manually or skip" prompt) rather than a silent network fetch — align with
  REQ-040's "no external models or services" wording literally: bundling is the only interpretation that
  requires zero network trust.
- Content-hash-verify the bundled model file (and pin the exact model file, not "latest compatible") at
  daemon startup, refusing to embed with a mismatched-hash model file rather than silently using whatever's
  on disk — this also closes a supply-chain integrity gap.
- Add install/CI smoke tests across the actual target platform matrix (at minimum macOS arm64 given the
  project's dev environment, plus Linux x64 for any server/CI deployment) that assert the native binding
  loads and produces the golden-vector determinism result from Pitfall 1's test, not just "npm install
  succeeds."

**Warning signs:** GitHub issues/support reports of install failures tied to specific OS/arch/Node
combinations; first-run network activity in a strace/network-monitor when no explicit remote API is
configured; package size or postinstall step silently fetches from an external URL.

**Phase to address:** Embedding-model integration phase (library/model selection) — platform-coverage and
distribution strategy should be a selection criterion up front, not discovered after a library is already
load-bearing elsewhere in the codebase.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|-----------------|------------------|
| Keep `DeterministicEmbedder` (hash) as permanent default instead of resolving the ONNX decision | Ships fastest, zero new native deps | Semantic recall never actually does semantics (Pitfall 6); user-facing feature underdelivers | Only as an explicit, documented interim default for a bounded milestone, not a silent permanent choice |
| Flat global ANN index, filter scope post-query | Simpler index management | Cross-scope leakage risk (Pitfall 8a), and re-filtering wastes query budget | Never for sensitivity-tiered data; maybe acceptable short-term if only a single person/scope exists in the corpus (not true here — dogfood corpus already spans workspaces) |
| Full index rebuild on every daemon run instead of incremental persistence | Simplest ANN integration code | Reintroduces the exact O(n)-per-tick cost this milestone exists to remove (Pitfall 3) | Never post-bootstrap; acceptable only for the one-time initial backfill |
| Transitive-closure trace grouping (any-to-any above threshold) | Reuses simple union-find, quick to implement | Mega-trace collapse (Pitfall 7) | Never at real corpus scale; maybe fine for small demo fixtures only |
| Skip embedding-deletion invalidation in v1 (embed once, never invalidate) | Less work in the deletion-cascade path | Breaks the deletion guarantee / traceability invariant (Pitfall 9) | Never — this is a correctness requirement given the existing source-deletion feature, not an optional polish item |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|-----------------|-------------------|
| ONNX Runtime (Node binding) | Leaving execution provider / thread count / graph-opt level at library defaults | Pin CPU EP, fixed thread count, fixed graph-opt level explicitly; golden-vector hash test in CI |
| hnswlib-node / usearch (ANN) | Relying on default/unset RNG seed for HNSW layer assignment | Pin seed explicitly; verify library exposes one before adopting it |
| sqlite-vec (SQLite ANN extension) | Assuming it auto-handles deletion/tombstoning like normal SQLite `delete` | Verify vector-specific deletion semantics explicitly; may require separate reindex/vacuum step |
| Tokenizer (for ONNX sentence-transformer) | Using a tokenizer library version not pinned to the exact one the model was trained/exported with | Bundle exact vocab/merges file with the model artifact, version-pinned and hash-checked |
| Zero-knowledge sync (ADR 0047 envelope) | Building a separate lower-protection channel for syncing embeddings "because they're just vectors" | Route embeddings through the same `cms.sync.v1/operation` envelope encryption as summaries/boxes/traces |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|-----------------|
| Full ANN index rebuild per daemon tick | Daemon tick time grows with corpus size | Persist/serialize index across runs; incremental `add()` only | Noticeable already at 135k; severe at ~1M |
| Loading all vectors into process memory per run | Daemon RSS climbs to GB range | Disk-backed/mmap index; batch-loaded backfill | ~1M vectors x 384 dims x 4 bytes ≈ 1.5GB+ |
| Brute-force cosine as the production "ANN" fallback left in place after milestone ships | Query latency degrades linearly with corpus size | Real ANN structure (HNSW/IVF) with sublinear query cost; brute-force only for small-corpus test fixtures | Beyond low tens of thousands of vectors |
| Backfill without checkpointing | Restart re-embeds everything from zero after any interruption | Chunked, checkpointed, resumable backfill job (Pitfall 4) | Any interruption during the ~135k-1M initial backfill |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Flat ANN index without scope partitioning | Cross-person/case/sensitivity semantic leakage | Per-scope index partitioning or verified index-level filtered search (Pitfall 8a) |
| Treating embedding vectors as non-sensitive "just numbers" | Embedding-inversion recovers private text fragments; weaker handling than summary text | Same encryption/access-control treatment as summary text everywhere (Pitfall 8b) |
| Syncing embeddings outside the ADR-0047 envelope scheme | Zero-knowledge guarantee broken for a whole class of derived data | Route through existing `cms.sync.v1/operation` encrypted envelope |
| No content-hash verification of bundled ONNX model file | Silent tampering/corruption changes embeddings undetected | Pin exact model version, hash-check at load, refuse mismatched files (Pitfall 12) |
| No deletion-invalidation for embeddings | Deleted/redacted source content still recoverable via stale vector | Extend `commitSourceDeletion` effects to include embedding tombstoning (Pitfall 9) |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-------------------|
| Trace proposals lose explanatory keywords after vector-based rewrite | Reviewer can't tell "why" a trace was proposed, undermining trust/traceability | Surface top contributing terms/snippet alongside similarity score (Pitfall 10) |
| Trace membership churns night to night | Reviewer sees the "same" trace repeatedly under different shape/ID | Stable, append-only trace assignment (Pitfall 7) |
| Semantic recall silently degrades to keyword-only matching (weak embedder) | User trusts "semantic" search that can't handle paraphrase | Resolve and disclose the embedder choice explicitly; benchmark paraphrase recall (Pitfall 6) |
| Backfill runs silently for hours with no progress signal | User can't tell if it's stuck, and battery/CPU usage is unexplained | Surface backfill progress via existing `memory health`/`memory tune` CLI (Pitfall 4) |

## "Looks Done But Isn't" Checklist

- [ ] **Embedding determinism:** Verify with a golden-vector hash test run on more than one OS/arch, not
      just "it passed once on my machine" — pin ONNX Runtime EP/threads/graph-opt-level explicitly.
- [ ] **ANN index reproducibility:** Verify neighbor results are stable across a fresh full rebuild vs.
      incremental append-by-append of the same vectors — not just that the index "builds successfully."
- [ ] **Daemon incremental cost:** Verify per-tick trace-step cost is flat as corpus size grows in a
      benchmark, not just that "it completed in dev with the small fixture."
- [ ] **Backfill resumability:** Verify killing the backfill process partway and restarting it does not
      re-embed already-completed summaries — not just that "it finished once."
- [ ] **Scope isolation:** Verify with an explicit cross-scope fixture that ANN queries never surface
      results outside the caller's person/case/sensitivity authority — not just "it returns results."
- [ ] **Deletion invalidation:** Verify a deleted/redacted source's old embedding is unreachable from the
      ANN index post-deletion — not just that the summary row was superseded.
- [ ] **Sync integration:** Verify embeddings are actually inside the ADR-0047 encrypted envelope on the
      wire (e.g. via a network capture / relay-visibility test), not just that sync "completes."
- [ ] **Store parity:** Verify `InMemoryStore` and `SqliteStore` agree on embedding/ANN-specific behavior
      via shared contract tests, not just that each has its own passing test suite.
- [ ] **Threshold calibration:** Verify proposal flood/silence balance against the real 135k dogfood
      corpus, not just a small synthetic fixture.
- [ ] **Native binding distribution:** Verify install succeeds (or falls back gracefully) across the
      project's actual supported platform matrix, not just the primary dev machine's OS/arch.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|-----------------|------------------|
| Embedding nondeterminism discovered post-ship | HIGH | Requires a migration: pin runtime config, re-embed entire corpus under the pinned config, invalidate/rebuild all traces derived from the old (nondeterministic) vectors — essentially a forced full backfill re-run |
| Flat ANN index found to leak across scopes | HIGH | Requires re-architecting to per-scope partitioned indices and a full reindex; audit any cached/logged query results for leaked cross-scope data in the interim |
| Mega-trace collapse found in production | MEDIUM | Add max-trace-size guard and centroid-based regrouping; requires recomputing/splitting existing offending traces, but doesn't require re-embedding |
| Missing deletion-invalidation found in production | MEDIUM-HIGH | Requires a reconciliation pass: diff embedding-store IDs against live summary IDs, tombstone orphans; audit whether any leaked recall already occurred for deleted content in the gap window |
| Threshold miscalibration (flood or silence) found in production | LOW | Threshold/top-k tuning is a config change plus a one-time recompute of trace proposals; no re-embedding needed if only the comparison policy changes |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|-------------------|-----------------|
| 1. Embedding runtime nondeterminism | Embedding-model integration phase | Golden-vector hash test across OS/arch in CI |
| 2. ANN index insertion-order nondeterminism | ANN index selection/integration phase | Rebuild-vs-incremental neighbor-result parity test |
| 3. Secretly-O(n²) ANN integration | ANN index integration phase | Flat-cost benchmark as corpus size grows (script analogous to `scripts/benchmark-sync-padding.mjs`) |
| 4. Backfill OOM / non-resumable | Backfill implementation phase | Kill-and-resume test against ~1M synthetic fixture |
| 5. Threshold flood/silence | Trace-threshold tuning phase (post ANN wiring) | Proposal-count and confidence-distribution check against real 135k dogfood corpus |
| 6. Weak embedder shipped as silent default | Embedding-model decision phase (ADR) | Paraphrase-vs-near-miss labeled benchmark |
| 7. Mega-trace / nightly churn | Trace-algorithm redesign phase | Two-run stability test (existing assignments unchanged when one summary added) |
| 8. Scope/sensitivity leakage + inversion risk | Vector-index/storage-schema phase + sync-integration phase | Cross-scope isolation fixture test; envelope-wire inspection for sync |
| 9. Embeddings persist after deletion | Storage/schema phase (embeddings table introduction) | Extended source-deletion cascade test asserting vector unreachability |
| 10. Broken proposal shape / review flow | Trace-algorithm redesign phase + review-flow/MCP contract owner | Compatibility test on `TraceCandidate`/`Trace` consumers |
| 11. InMemoryStore/SqliteStore divergence | Storage/schema phase | Shared parameterized contract test suite across both stores |
| 12. Native binding / model distribution failures | Embedding-model integration phase (library selection) | Install/CI smoke test across full supported platform matrix |

## Sources

- Direct source read (HIGH confidence, this repo): `src/traces/trace-candidate-core.ts`,
  `src/embeddings/embedder.ts`, `src/daemon/contraction-runner.ts`, `src/storage/sqlite-store.ts`,
  `.planning/PROJECT.md`, `docs/adr/0047-zero-knowledge-sync-threat-model-and-protocol.md`.
- General ONNX Runtime determinism caveats (execution provider / thread count / graph optimization
  affecting floating-point reduction order): MEDIUM confidence, based on well-known, widely-reported
  behavior of BLAS/matmul-backed inference runtimes rather than a single authoritative doc citation —
  flagged for validation against the specific ONNX Runtime version chosen during implementation.
- HNSW insertion-order / seed sensitivity: MEDIUM confidence, based on the well-documented approximate
  nature of HNSW graph construction (layer assignment via random level generator, edge selection
  depending on insertion sequence) as described in the original HNSW literature and reflected in
  hnswlib/usearch API surfaces exposing explicit seed parameters — flagged for validation against the
  specific library chosen.
- Embedding-inversion risk for short-text sentence embeddings: MEDIUM confidence, general finding
  well-established in NLP privacy research community discussion; specific inversion-attack effectiveness
  depends on the exact embedding model chosen and is not separately verified for this milestone's not-yet-
  selected ONNX model.

---
*Pitfalls research for: local embeddings + ANN in a deterministic, local-first, zero-knowledge-syncing
personal memory system.*
*Researched: 2026-07-21*
