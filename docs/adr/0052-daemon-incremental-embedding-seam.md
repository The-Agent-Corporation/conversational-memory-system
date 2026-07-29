# ADR 0052: The Daemon's Incremental Embedding Seam

## Status

Accepted, with two readings marked **pending owner confirmation** (decisions 4 and 5).

## Context

Before Phase 12 the daemon had no embedding path at all. `saveSummaryVectors` had exactly one
caller — `src/operations/backfill-embeddings-command.ts:122` — so a summary formed by a running
daemon acquired a vector only if someone later re-ran `memory backfill-embeddings` by hand. REQ-043
requires the opposite: the daemon embeds every newly contracted summary automatically, per device,
without recomputing embeddings for the existing corpus and without ever syncing them.

Phases 8, 9, and 10 shipped the vector table, the ONNX embedder, and the backfill command with **no
ADR between them**, against this repository's own convention that each subsystem records its
decisions. This ADR covers the decisions Phase 12 makes and, where they depend on unrecorded earlier
choices, states them explicitly rather than leaving them inferable only from code.

Two defects found by Phase 12's research shape what follows. `12-GAP-12-A` — the embedder's
advertised `model` differed from the `model` it stamped on every row it wrote, so the missing-set
query key and the write key could never agree and the missing set never shrank. `12-GAP-12-B` —
`listSummaryIdsMissingVector` had no state predicate, so 89,059 superseded summaries were backfill
candidates. Both were fixed in Plans 12-01 and 12-02 before this seam was built.

## Decision

### 1. The seam: a post-commit stage inside `ContractionRunner.drainSlice`

The embed stage runs **after `commitContractionSlice` resolves**, inside `drainSlice`, driven by the
summary array the slice just committed. Its cost is `summaries.length` embed calls and one batched
`saveSummaryVectors`, **with no query of any kind** — which is how the "embed calls per slice are
independent of corpus size" property holds by construction rather than by a tuned scan budget.

Three options were on the table.

**Option A — inside the commit transaction. Rejected.** It couples memory formation to embedder
health: a corrupt ONNX file would stop the daemon forming summaries at all. Memory formation is the
product; vectors are a derived cache over it. The dependency must not run in that direction.

**Option C — a separate scheduler driven by the missing set. Rejected, and for the more
interesting reason.** Beyond needing a per-tick corpus query, it **cannot see upserts**. A
continuing topic's trailing active span is re-emitted every slice under the *same* deterministic id
(`summaryId(personId, firstEventId, topicLabel)`, `contraction-runner.ts:720`) with *changed* text —
documented at `contraction-runner.ts:296-298`. The row already exists, so a missing-set-driven
scheduler would never select it and its vector would go stale permanently. Embedding the set the
slice handed to `commitContractionSlice` refreshes it for free.

**Option B — post-commit, the chosen one.**

**Departure from `12-RESEARCH.md`, recorded rather than made silently.** The research placed this
stage in the daemon's contraction *work item* (`daemon.ts:136-149`). It went one boundary lower,
inside `drainSlice`, for three reasons:

1. `DaemonLoopDependencies.contractionRunner` is a deliberately narrow structural type returning
   `Promise<{complete?: boolean} | unknown>` (`daemon.ts:31-33`). Placing the stage above it means
   widening that seam to carry `Summary[]` out to a caller with no other use for it.
2. Failure isolation becomes one `try`/`catch` in one function rather than a rule the daemon has to
   remember at two call sites (`daemon.ts:141` and `:253`).
3. `daemon.ts:145-148` maps any contraction throw to `storage_failure`. Keeping the stage **below**
   that line makes it structurally impossible for an embedder fault to be reported as a storage
   fault.

The stage is enabled by an **optional** `summaryEmbedder` on `ContractionRunnerOptions`. Absent
means off, which is why `rebuild-derivations-command.ts` and `historical-bootstrapper.ts` — the
other two production callers of `drainSlice` — keep their previous behavior with no edit, and a
bulk rebuild does not embed.

### 2. Both halves of the supersession precedent, in a decided order

`rebuild-derivations-command.ts:167-175` already tombstones vectors post-commit from
`slice.supersessions`. The daemon takes **both** halves: it writes vectors for the new summaries and
calls `deleteSummaryVectors(supersededSummaryIds)` in the same post-commit stage.

Taking only the write would not have been a correctness bug — `findNearestSummaries`' GAP-11-A state
filter already drops vectors whose summary is non-retrievable — but stale rows would accumulate
unboundedly and, after Plan 12-02 gave the missing-set query a state predicate, become unreachable
by the only query that could still find them.

**The write runs first and the tombstone second.** The ordering is decided, not incidental: if an id
is both re-emitted and superseded within one slice, the tombstone wins and no orphan vector
survives. Production's `preserveIds` keeps a re-emitted id out of `supersessions`, so that overlap
does not occur today; the ordering is pinned by an explicit test that injects it, because "does not
occur today" is not a property anyone should have to rediscover.

### 3. Failure isolation: a summary without a vector is a recoverable state

The embed stage **never throws**. Any embedder fault, any `saveSummaryVectors` rejection, and any
missing `personId` is recorded in the additive slice result
`embedded: { attempted, persisted, failed }` and nothing else happens: the checkpoint is untouched,
the job is untouched, and the contraction reports exactly what it would have reported.

Two `daemon.ts` lines it must never reach, named so the rule is checkable:

- **`daemon.ts:145-148`** — classifies any contraction throw as `storage_failure`. An embedder fault
  reported as a storage fault is a misdiagnosis that would stall contraction (T-12-10).
- **`daemon.ts:158-161`** — the `proposalScheduler.runDue` path, whose throw calls `loseAuthority()`.
  The embed stage is never wired there; a model file problem must not cost the daemon its writer
  lease (T-12-11).

A summary without a vector is recoverable by design: the repair pass heals it and `memory status`
reports it. A summary that was never formed is not.

Two further rules of the stage:

- **A falsy `personId` is skipped and counted `failed`, never substituted** (T-10-05/T-12-12). A
  vector row carries the summary's own `personId` and `scopeIds` or it is not written. A sentinel
  would be cross-person retrieval.
- **Logging carries counts, provider, and model only** (V7/T-12-15) — never summary text, never a
  summary id alongside its text, never an error message quoting the input. Same discipline as
  `backfill-embeddings-command.ts:125-133`.

### 4. The daemon probes; it does not hard-error — **pending owner confirmation**

`12-CONTEXT.md` locks two things: an enabled-but-broken embedder must hard-error, and there must
never be a silent fallback to the hash embedder.

The hard error stays exactly where it is. `resolveEmbedder` still rejects on enabled-but-broken
(D-05), which is what the backfill and retrieval paths see. The **daemon** calls
`probeEmbedderHealth` first (D-06, which never throws) and resolves only when the config is
`enabled && healthy`. A corrupt model file therefore degrades the daemon to "no new vectors, reason
written once to stderr" rather than "memory formation stops".

Nothing silently falls back: when the embedder is unhealthy, or when embeddings are disabled, **zero
vectors are written by anything**. Not writing at all is the only safe non-ONNX behavior, because a
mixed-provider vector store is hard-errored by design.

**The alternative reading is defensible and is not being dismissed:** that the daemon should refuse
to start when an enabled embedder is broken, on the grounds that a silently vector-less daemon is a
failure an operator may not notice. It is flagged here for the owner rather than decided silently.

### 5. SC4's "detectable relative to its peers" — the A3 reading, **pending owner confirmation**

ROADMAP SC4 requires stale-model vectors to be "detectable relative to peers". Taken literally, peer
comparison would need a sync-carried field naming each device's embedder identity. **That is not
merely expensive, it is self-contradictory with SC3**, which requires that embeddings never appear
in any sync payload, and with ADR 0047's closed `SyncOperationKind` enum, which has no kind that
could carry one.

The reading adopted: SC4 is satisfied by each device reporting its **own** `(provider, model,
revision)` and its own completeness through `memory status`, so an operator diffing two devices'
output sees the divergence. The mechanical half is testable and tested — the reported model contains
the pinned revision `ea104dacec62c0de699686887e3f920caeb4f3e3`, and a revision-less key could not
distinguish a stale model from a current one. Plan 12-07 amends the ROADMAP text to match.

Recorded **pending owner confirmation**, because `12-RESEARCH.md` Open Question 4 would otherwise be
answered only by omission.

### 6. Model identity: one composed `provider` + `repo@revision` key

The vector key is one expression, `composeModelIdentity(repo, revision)`
(`src/embeddings/embedder-identity.ts`, Plan 12-01), used for both the missing-set query and every
written row. That is the GAP-12-A fix: the query key and the write key are the same expression
rather than two strings that happen to agree.

Including `@revision` is deliberate. REQ-045 requires recording provider/model/**version** so that
stale-model vectors are detectable; a revision-less key cannot distinguish a stale model from a
current one, and decision 5 above depends on that distinction.

**Rejected alternative — a schema-v4 `revision` column on `summary_vectors`.** It would ripple
through `MemoryStore`, `SummaryVectorRecord`, both store implementations, and every vector call
site for a schema migration, and it would **not** have fixed the second instance of the same bug in
`memory-retriever.ts:584-585`, which compares embedder identities in memory and never touches the
table. Note that composing was cheapest at this exact moment precisely because the corpus had
**zero** vector rows; a future revisit, after ~49k rows exist under the composed key, is more
expensive than this one was.

### 7. The repair pass heals MISSING vectors, never STALE ones — accepted limitation

A continuing topic's active-span summary is re-emitted under the same id with changed text. If the
embed stage's upsert fails on such a re-emission, **the row still exists** — so it is never in the
missing set, `memory status` reports `missingVectors: 0`, and the vector silently no longer matches
its text. The primary path self-heals while the topic keeps producing slices; once the topic closes,
it is permanent until the next full backfill.

**Why the obvious detector is not available, verified rather than assumed:** `SummarySchema`
(`src/domain/types.ts:104-129`) carries `createdAt`, `version`, and `lastAccessedAt` but has **no
`updatedAt`**, and `contraction-runner.ts` sets `version: 1` unconditionally on every emit.
`lastAccessedAt` is a read-time field, not a write marker. There is therefore no monotonic field to
compare a vector's `createdAt` against. Detecting staleness needs a schema change — an `updatedAt`
or a stored content hash — which belongs with the vector-native work, not with daemon wiring.

**Accepted for this phase with that reason stated. No heuristic is permitted here**: any guess built
on the fields that do exist would be wrong in a way that is harder to notice than the limitation
itself. Tracked as D-12-1 in `12-DEFERRED.md`.

### 8. Revived summaries are vector-less until a repair tick — measured property, not a bug

`RETRIEVAL_CANDIDATE_STATES` includes `stale`, because `prepareInjection` can promote a `stale`
summary to `revived` (`src/retrieval/retrievable-state.ts:28-31`). Plan 12-02 correctly excludes
`stale` from the missing set — an unpromoted stale summary should not be embedded — so a
just-promoted summary has no vector for up to one repair interval plus backlog.

This is self-healing and consistent with how `findNearestSummaries` already behaves. It is recorded
here so that it is not rediscovered later as a defect.

### 9. The mixed-provider protection is structural, not enforced

Stated plainly because the phrasing elsewhere invites the opposite reading:
**`embedder-resolver.ts` does not detect mixed-provider vector stores.** Nothing scans
`summary_vectors` for rows written under a second identity, at resolve time or at any other time.

D-05 means only **"never silently fall back"**: `resolveEmbedder` rejects rather than quietly
returning `DeterministicEmbedder` when an enabled model is broken. The single-provider property
follows from every write path composing its key through one function and from no path substituting a
different embedder — it is a consequence of the code's shape, not a checked invariant. A mixed store
produced some other way (a hand-edited sidecar, a partial migration) would not be reported.

## Consequences

- A daemon-formed summary has a vector by the time its work item returns, on the device that formed
  it, with no corpus query and no second scheduler.
- A re-emitted active-span summary's vector is refreshed on every slice that re-emits it, which is
  the case no missing-set-driven design can cover.
- The contraction path cannot be broken, stalled, or de-authorized by an embedder fault. The worst
  case is a summary without a vector, which the repair pass heals and `memory status` counts.
- Vectors remain a strictly per-device cache. The outbox is byte-unchanged across a vector-writing
  slice, `Summary.embedding` stays null on every daemon-written summary, and the closed seven-value
  `SyncOperationKind` enum is now pinned by an assertion that fails the day an eighth kind is added.
- `rebuild-derivations`, the historical bootstrap, and every pre-existing test are unaffected: they
  pass no `summaryEmbedder`, so the stage does not run for them.
- One ONNX session per daemon process, not one per tick (72-121 ms each).
- ADRs 0047, 0049, 0050, and 0051 are unchanged by this decision.

## Requirement Traceability

| Requirement | Where |
|---|---|
| REQ-043 (daemon embeds newly contracted summaries incrementally, per device) | The post-commit stage in `src/daemon/contraction-runner.ts`; wiring in `src/daemon/daemon-command.ts`; `tests/daemon/contraction-runner.test.ts` |
| REQ-045 (provider/model/version recorded so stale-model vectors are detectable) | `composeModelIdentity` (`src/embeddings/embedder-identity.ts`, Plan 12-01); the pinned-revision assertion in `tests/bootstrap/status-command.test.ts` (Plan 12-02) |
| SC3 (embeddings never cross the wire) | `tests/sync/embeddings-never-sync.test.ts` — outbox deep-equality, the closed-enum tripwire, `embedding === null`, and a labelled defence-in-depth byte scan |
| GAP-12-A (one canonical embedder identity) | Decision 6; fixed by Plan 12-01 |
| GAP-12-B (the missing set means "embeddable and unembedded") | Decision 8's interaction; fixed by Plan 12-02 |
| D-12-1 (stale-vector detection needs a write marker) | Decision 7; deferred in `12-DEFERRED.md` |

---

## Addendum, 2026-07-29 — GAP-12-C: the vendor path, and what a skipped test costs

`memory embeddings --action enable` — the only CLI path in this product that reaches the network —
could not succeed in shipped code. Two deterministic defects in `src/embeddings/model-vendor.ts`,
found by the Plan 12-05 executor running the real command against the live corpus:

1. **The write path and the read path were different places.** `vendorModel` set
   `env.localModelPath` and downloaded through `pipeline()`. In transformers.js `localModelPath` is
   where local models are *read from*; remote downloads land in `env.cacheDir`, in a
   **revision-nested** `<repo>/<revision>/<file>` layout. `verifyManifest` reads a **flat**
   `${localModelPath}/${repo}/${relPath}`. Nothing ever wrote what it read. Repointing `cacheDir` at
   the target would not have fixed it — the layouts differ.
2. **One manifest file was never fetched.** `BGE_SMALL_EN_V1_5_MANIFEST` pins five files;
   `pipeline("feature-extraction", …)` requests four. `special_tokens_map.json` was absent from the
   cache entirely. Fixing only defect 1 would have converted one `ENOENT` into another.

The manifest was never in question: the gitignored fixture at
`tests/fixtures/models/Xenova/bge-small-en-v1.5` holds all five files and every one hashes to its
pinned value. The manifest is right; the code meant to reproduce it was not. It is unedited.

### The fix

`vendorModel` now fetches each of the five pinned files directly from
`{baseUrl}/{repo}/resolve/{revision}/{file}` and writes them straight into the flat layout
`verifyManifest` already expected. Consequences worth recording:

- **The revision is pinned in the URL**, not delegated to library cache semantics. That indirection
  is what produced the defect, and five explicit URLs are the most auditable shape for the one path
  in the product that reaches the network.
- **Writes are atomic** (T-12-30). Every file is streamed into a staging directory and hash- and
  byte-length-verified there; the staged set is moved into place only once all five verify. A failed
  or partial vendor leaves nothing a later `verifyManifest` could pass on — which matters because
  `embeddings-command.ts` flips `enabled: true` purely on `vendorModel` resolving.
- **`env.allowRemoteModels` disposition.** The direct fetch no longer routes through transformers.js,
  so the flag is irrelevant to the download itself. It is not deleted: it is deliberately never
  switched on, and is asserted `false`, so D-04/T-09-02's invariant — transformers.js never loads
  from the network in this process — still holds for the load proof and for everything after it.
- **Load is proven separately from integrity.** `pipeline()` proved loadability only as a side effect
  of fetching, and that coupling is exactly what produced the layout mismatch. A post-vendor
  `TransformerEmbedder.init()` now proves it explicitly, against an isolated `env.cacheDir` — because
  measured on 2026-07-29, with the stale `node_modules/@huggingface/transformers/.cache` present,
  loading a model root **that does not exist** succeeds, and with the cache empty the same call
  throws `file was not found locally`. A load proof served from that cache would prove nothing about
  what was just vendored. This is the same cache-hit mechanism that let the defect ship: the 12-05
  run downloaded nothing at all, every cached file still dated 2026-07-21.

### The part worth keeping: a default-skipped test is worse than a missing one

`tests/embeddings/model-vendor.test.ts` had, as its **first case**, *"writes the pinned fp32 file set
under localModelPath"* — precisely the assertion that failed. It sat behind
`describe.runIf(MEMORY_RUN_NETWORK_TESTS)`. Those were the **4 skipped tests** in an otherwise-green
1,106-passed suite. A missing test leaves a visible hole; a skipped one reports a number that implies
the path is covered.

This was the third time in two phases that the test which would have caught a defect did not run.
The shared mechanism is not "bad tests" — each of the three is a *correct* assertion that never
evaluated against the code under change:

| gap | the coverage that existed | why it did not catch the defect |
|---|---|---|
| GAP-11-G | two passing tests | they actively pinned the **pre-reversal** rule — green while encoding the defect |
| GAP-12-A | backfill fixtures | every one hardcoded the ONE embedder whose class name and emitted `model` coincide |
| GAP-12-C | the exact failing assertion | **skipped by default** behind a network flag |

**The rule.** When a code path can only be tested behind a flag, either give it an offline seam that
runs unconditionally, or treat the flag as a known coverage hole and record it as one. It is not a
ban on network-gated tests: the real-Hub cases are retained and are still the only thing exercising
the actual Hub. They are simply no longer the *only* coverage.

Here the seam is a `baseUrl` injection point on `vendorModel`.
`tests/embeddings/model-vendor.offline.test.ts` stands up a loopback `node:http` server over the
vendored fixture — whose bytes hash exactly to the manifest — so the test exercises the real fetch,
the real flatten, and the real sha256 verification rather than a mock of them. Injecting a URL was
preferred to mocking `fetch` for that reason. Its only gate is fixture presence, mirroring the golden
test's idiom, so a fresh clone without the gitignored fixture stays green.

| Requirement | Where |
|---|---|
| REQ-044 (explicit, hash-verified vendoring; no implicit network fetch) | `vendorModel`/`verifyManifest` (`src/embeddings/model-vendor.ts`); `tests/embeddings/model-vendor.offline.test.ts` (default suite, loopback); `tests/embeddings/model-vendor.test.ts` (network-gated, real Hub) |
| GAP-12-C (the vendor produces the layout it verifies, and all five files) | This addendum; Plan 12-08 |
