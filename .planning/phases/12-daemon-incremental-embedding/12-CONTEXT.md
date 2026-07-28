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
