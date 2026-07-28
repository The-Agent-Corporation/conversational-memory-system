# Phase 12 — Daemon Incremental Embedding: Context and Locked Decisions

**Created:** 2026-07-28, after Phase 11 closed. Decisions below were made by the owner in session before
planning, and are LOCKED inputs to the planner — not open questions.

## Goal (ROADMAP, unchanged)

The daemon embeds every newly contracted summary automatically, per device, without recomputing
embeddings for the existing corpus and without ever syncing embeddings across devices.

Requirements: REQ-043, REQ-045.

## State of the world, measured 2026-07-28 (not assumed)

| fact | value |
|---|---|
| live corpus | `~/.memory/aaron.db`, person `aaron` |
| canonical events | 292,407 |
| active summaries | **49,314** (was 135,366 before Phase 11 — backfill is ~64% cheaper than originally scoped) |
| `summary_vectors` rows | **0** |
| embeddings sidecar `${db}.embeddings.json` | **absent** → `DeterministicEmbedder` (hash) is active |
| vendored ONNX model | present, `tests/fixtures/models/Xenova/bge-small-en-v1.5` |
| golden gate | `npm run test:golden` **passes** (16 passed / 1 skipped) 2026-07-28 |
| daemon embedding path | **none** — `saveSummaryVectors` is called ONLY by `backfill-embeddings-command.ts` |

**The ROADMAP's stated dependency is inaccurate and the planner must not rely on it.** Phase 12's
"Depends on: Phase 10 (existing corpus already has vectors)" does not hold: Phase 10 shipped the backfill
command but it was never run against the live corpus, which has zero vectors.

## Locked decision 1 — target the ONNX bge-small embedder, not the hash embedder

**Owner decision 2026-07-28.** Enable `bge-small-en-v1.5` for the live corpus.

Rationale, as put to the owner: the deterministic hash embedder is keyword-shaped, and it is the direct
cause of the two recall defects recorded at Phase 11 sign-off — Q6's relevance shift and Q12's
expected-nothing false positive (`11-SC7-SIGNOFF.md`). Real semantic similarity is the point of the v1.1
milestone.

Consequences the planner must handle rather than discover:
- `memory embeddings enable` is the **only CLI path that touches the network**. It vendors the model to
  `${databasePath}.models` (i.e. `~/.memory/aaron.db.models`), hash-verified against
  `BGE_SMALL_EN_V1_5_MANIFEST`, and flips `enabled: true` ONLY after the vendor call resolves. A failed or
  partial vendor must leave the config disabled.
- The vendored copy under `tests/fixtures/models` is gitignored TEST fixture. Production resolution is the
  sidecar path above; do not couple the daemon to the fixture path.
- **Mixed-provider vector stores are hard-errored by design** (D-05, `embedder-resolver.ts`). Once enabled,
  every vector — backfilled and incremental — must come from the same (provider, model, revision).
  Enabled-but-broken must hard-error, never silently fall back to the hash embedder.
- Phase 9's locked embedder decisions still bind: **cls-pooling** (the Xenova model card's mean-pooling
  example is wrong; BAAI config says cls), **asymmetric** bge prefixing (queries prefixed, passages bare),
  pinned HF revision `ea104dacec62c0de699686887e3f920caeb4f3e3`.

## Locked decision 2 — backfill the live corpus as part of this phase

**Owner decision 2026-07-28.** Run `memory backfill-embeddings` against the live corpus so incremental
embedding has a populated baseline to extend.

- 49,314 summaries. Phase 10's success criteria already require the command to be resume-safe (SC2) and
  idempotent on a second full run (SC3) — this phase should USE those properties, and verify them at real
  scale rather than re-implement them.
- The live corpus is 5,031,448,576 bytes. Adding ~49k × 384-dim float32 vectors is a material write.
  **A fresh backup is mandatory before the backfill run**, following the discipline Phase 11 used
  throughout (`cp -c` APFS clone, verified by inode/size/mtime with correctly labelled timezones).
- Four Phase 11 backups exist in `~/.memory/` (`pre-v4`, `pre-rebuild-v3`, `pre-anchor-prune`,
  `pre-phase11`). None may be deleted, moved, or overwritten.

## Explicitly out of scope

- **Semantic recall / retrieval changes.** Q6 and Q12 are recorded as inputs but fixing ranking is a later
  phase. This phase populates vectors and keeps them current; it does not change how retrieval uses them.
- **Syncing embeddings.** ADR 0047 treats vectors as a per-device cache and `SyncOperationKind` is a closed
  enum. SC3 requires embeddings never appear in any sync payload or outbox operation.
- **GAP-11-F's remaining halves** — the 151 contaminated corpus rows (owner declined redaction) and
  `~/cms-pre-rewrite-backup/`, which still holds the credential by design.

## Known hazards carried from Phase 11

- `gsd-sdk` state verbs are broken in this repo: `state.advance-plan` and `state.update-progress` error,
  and `record-session` corrupts `current_plan`. Hand-edit STATE.md and say so.
- A pre-existing full-suite flake: `tests/mcp/mutation-tools.test.ts` and `tests/mcp/stdio-server.test.ts`
  can time out at 5000 ms under parallel load; they pass in ~2.3 s isolated.
- Executors on Phase 11 stalled **eight times** after launching background jobs without a poll loop.
  Long-running work (a 49k-summary backfill qualifies) must be backgrounded to a log file and POLLED.
- Only one agent may hold write access to the worktree at a time, and no agent may use `git add -A`/`.` —
  a broad stage during Phase 11 swept another agent's in-flight edits into an unrelated commit.

---

## Addendum 2026-07-28 — corrections and a third locked decision, after research

Research (`12-RESEARCH.md`) found two blocking defects, both reproduced by running real code and both
independently verified in source by the orchestrator. They change this document.

### Correction to the measured state above

The "49,314 summaries" figure recorded as the backfill scope is the **retrievable** count.
`listSummaryIdsMissingVector` has no state predicate, so as written the backfill would process all
**138,373** rows (49,314 `compacted` + 89,059 `superseded`). See `12-GAP-12-B.md`. The corrected figures:

| | rows | est. time @ 24.2 ms |
|---|---:|---|
| as the query is written today | 138,373 | ≈56 min |
| **after the state-predicate fix (the plan)** | **49,314** | **≈20 min** |

### Locked decision 3 — add a state predicate; do NOT prune superseded rows

**Owner decision 2026-07-28.** Fix `listSummaryIdsMissingVector` so superseded summaries are never
backfill candidates. Do **not** run `memory prune-superseded`.

Rationale, as put to the owner: this corrects the product defect on any corpus rather than only on this
one, preserves ADR 0050's supersede-not-delete auditability, and avoids an irreversible operation that
would not shrink the file without a `VACUUM` anyway. It also keeps the owner's earlier "superseded prune
unneeded" decision intact — that decision was sound; it simply predated the knowledge that those rows
would be embedded.

Implementation notes the planner must carry:
- **`MemoryStore` behavior must match in BOTH stores.** CLAUDE.md is explicit: `sqlite-store.ts` and
  `in-memory-store.ts` both implement the interface in full, and any change means editing both. A state
  predicate added to only one is a parity break of exactly the kind Phase 8 spent a gap-closure plan on.
- Which states count as backfill-eligible must be stated explicitly and tested, not left implicit. Note
  `findNearestSummaries` already filters superseded (`sqlite-store.ts:1712-1725`) — align with it rather
  than inventing a second definition of "retrievable".

### Locked decision 4 — GAP-12-A is fixed BEFORE any backfill runs

The model-identity mismatch (`12-GAP-12-A.md`) makes the missing set never shrink. Running the backfill
first would produce a run that cannot resume, cannot be verified complete, and reports
`missingVectors == totalSummaries` forever. Fix the identity first, pin it with a regression test that
exercises an embedder whose class `model` differs from its emitted `model`, then backfill.

Decide deliberately whether the canonical identity includes `@revision`. REQ-045 requires recording
provider/model/**version** so stale-model vectors are detectable, which argues that it should — a
revision-less key cannot distinguish a stale model from a current one, and SC4 depends on that distinction.
